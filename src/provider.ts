// bb machine provider backed by Orble boxes. Resource operations only: bb core
// owns enrollment (bootstrap), checkouts, retries and the machine record.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { MachineBootstrapApi, MachineExecutor } from "@get-bb/plugin-sdk";
import { daemonStopScript, hubHealthScript, identityResetScript, type OpencodeProvider, opencodeSyncScript, staleConnectionsScript } from "./box-scripts.ts";
import { type Box, isConflict, isNotFound, isRunning, isSuspended, type OrbleApi, SIZES, type Size } from "./orble-api.ts";
import { branchMismatch, cloneInput, cloneRepoScript, type ClonedRepo, parseCloneResult, PROJECT_NAME_RE, type Project, type ProjectLite, planSources } from "./projects.ts";
import { runScript, type SshClient, SshExecutor, type TunnelManager } from "./ssh.ts";

export const PROVIDER_ID = "orble";

export interface Progress {
  step(text: string): void;
  log(text: string): void;
}

/** Persisted by core and readable by every plugin: ids only, never secrets. `box` is Orble's immutable box id. */
export const resourceSchema = z.object({ box: z.string(), key: z.string() });
export type OrbleResource = z.infer<typeof resourceSchema>;

/** Non-secret per-machine overrides of the plugin settings. */
export const inputsSchema = z
  .object({
    /** Make the box from this snapshot (yours or Orble's gallery) instead of Orble's base image. */
    snapshot: z.string().min(1).max(128).optional(),
    size: z.enum(SIZES).optional(),
    /** A plugin project (Orble page → Projects): its repos are cloned on the box and registered as bb project sources. */
    project: z.string().regex(PROJECT_NAME_RE).optional(),
    /** Put the runner in this Orble box network, so it reaches other members as <box>.<network>.internal. */
    network: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/).optional(),
  })
  .strict();
export type OrbleInputs = z.infer<typeof inputsSchema>;

export interface ProviderConfig {
  api: OrbleApi;
  snapshot: string | null;
  size: Size;
  /** OpenAI-compatible providers whose live model lists go into OpenCode's and Pi's configs on the box. */
  opencodeProviders: OpencodeProvider[];
  createMissingProjects?: boolean;
}

/** bb's project API, as far as project runners need it. */
export interface ProjectsDeps {
  getProject(name: string): Promise<Project | null>;
  listProjects(): Promise<ProjectLite[]>;
  addProjectSource(a: { projectId: string; hostId: string; path: string }): Promise<void>;
  createProject(a: { name: string; hostId: string; path: string }): Promise<{ id: string }>;
}

/** Recorded before the create call so a crash in between can still be cleaned up. */
export interface AllocationIntent {
  box: string | null;
}

export interface ProviderDeps {
  config(): Promise<ProviderConfig>;
  ssh: SshClient;
  tunnels: TunnelManager;
  boxHubPort: number;
  bootstrap: MachineBootstrapApi["bootstrap"];
  intents: {
    get(key: string): Promise<AllocationIntent | undefined>;
    set(key: string, v: AllocationIntent): Promise<void>;
    delete(key: string): Promise<void>;
  };
  projects?: ProjectsDeps;
  log(m: string): void;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  pollMs?: number;
  stateTimeoutMs?: number;
  hubGateMs?: number;
}

export const keyHash = (key: string) => createHash("sha256").update(key).digest("hex");
/** Orble box names are unique per account: derive one from bb's stable key, so a retried create finds its box. */
export const boxAliasFor = (key: string) => `bb-${keyHash(key).slice(0, 12)}`;

export class OrbleMachineOps {
  private readonly d: ProviderDeps;
  /** Boxes with a create or resume in progress: their tunnel belongs to that call, not the supervisor. */
  readonly inFlight = new Set<string>();
  constructor(deps: ProviderDeps) {
    this.d = deps;
  }

  executor(api: OrbleApi, box: string): MachineExecutor {
    let cached: Promise<Box> | null = null;
    return new SshExecutor(this.d.ssh, api, () => {
      cached ??= api.getBox(box).catch((err) => {
        cached = null;
        throw err;
      });
      return cached;
    });
  }

  async create(key: string, inputs: OrbleInputs | null, checkpoint: (r: OrbleResource) => Promise<void>, report: Progress, signal: AbortSignal) {
    const c = await this.d.config();
    const snapshot = inputs?.snapshot ?? c.snapshot;
    const size = inputs?.size ?? c.size;
    let project: Project | null = null;
    if (inputs?.project) {
      if (!this.d.projects) throw new Error("Project runners are not available in this plugin build");
      project = await this.d.projects.getProject(inputs.project);
      if (!project) throw new Error(`Unknown project "${inputs.project}" (Orble page → Projects lists them)`);
      if (project.repos.length === 0) throw new Error(`Project "${project.name}" has no repos yet (Orble page → Projects)`);
    }
    const alias = boxAliasFor(key);
    await this.d.intents.set(key, { box: (await this.d.intents.get(key))?.box ?? null });
    let box = await c.api.findBox((await this.d.intents.get(key))?.box ?? alias, signal);
    if (!box) {
      report.step(snapshot ? `Creating an Orble box (${size}) from snapshot ${snapshot}` : `Creating an Orble box (${size})`);
      try {
        box = await c.api.createBox({ name: alias, size, ...(snapshot ? { from: snapshot } : {}) }, signal);
      } catch (err) {
        // A retry after a lost response: the name is ours (derived from the key).
        if (!isConflict(err)) throw err;
        box = await c.api.getBox(alias, signal);
      }
    } else {
      report.log(`Reusing box ${box.name} (${alias}) from an earlier attempt`);
    }
    await this.d.intents.set(key, { box: box.name });
    if (inputs?.network) {
      report.step(`Joining box network ${inputs.network}`);
      const id = box.name;
      const n = await c.api.joinNetwork(inputs.network, id, signal);
      report.log(`${id} is ${n.members.find((m) => m.box === id)?.addr ?? "?"} in ${n.name}`);
    }
    const resource: OrbleResource = { box: box.name, key };
    await checkpoint(resource);
    this.inFlight.add(box.name);
    try {
      box = await this.waitFor(c.api, box.name, isRunning, signal);
      const executor = this.executor(c.api, box.name);
      report.step("Checking the box over SSH");
      report.log(lastLine(await runScript(executor, identityResetScript(), signal, { what: "identity reset" })));
      await this.prepare(c, executor, report, signal);
      await this.connect(c, box, executor, report, signal);
      report.step("Enrolling the box in bb");
      const { hostId } = await this.d.bootstrap({ key, executor, report, signal });
      if (project) await this.provisionProject(c, executor, hostId, project, report, signal);
      return { name: box.alias ?? box.name, resource };
    } finally {
      this.inFlight.delete(box.name);
    }
  }

  async suspend(resource: OrbleResource, report: Progress, signal: AbortSignal): Promise<OrbleResource> {
    const { api } = await this.d.config();
    this.d.tunnels.stop(resource.box);
    const b = await api.findBox(resource.box, signal);
    if (!b) throw new Error(`Orble box ${resource.box} is gone; its state is lost`);
    if (isRunning(b)) {
      report.step("Stopping the bb daemon on the box");
      report.log(lastLine(await runScript(this.executor(api, b.name), daemonStopScript(), signal, { what: "daemon stop", timeoutMs: 60_000 }).catch((err) => `daemon stop skipped: ${(err as Error).message}`)));
      report.step(`Suspending ${b.name} (memory, files and processes are kept)`);
      await api.suspend(b.name, signal);
    }
    await this.waitFor(api, resource.box, isSuspended, signal);
    return resource;
  }

  async resume(resource: OrbleResource, report: Progress, signal: AbortSignal): Promise<OrbleResource> {
    this.inFlight.add(resource.box);
    try {
      const c = await this.d.config();
      const b = await c.api.findBox(resource.box, signal);
      if (!b) throw new Error(`Orble box ${resource.box} is gone; it cannot be resumed`);
      if (!isRunning(b)) {
        report.step(`Resuming ${b.name}`);
        await c.api.resume(b.name, signal);
      }
      const box = await this.waitFor(c.api, b.name, isRunning, signal);
      const executor = this.executor(c.api, box.name);
      // bb rejects this host's daemon until bootstrap below; whatever survived the pause is stale.
      report.step("Stopping any bb daemon left from before the pause");
      report.log(lastLine(await runScript(executor, daemonStopScript(), signal, { what: "daemon stop", timeoutMs: 60_000 })));
      report.step("Closing network connections that did not survive the pause");
      report.log(lastLine(await runScript(executor, staleConnectionsScript(), signal, { what: "stale connection reset" })));
      await this.prepare(c, executor, report, signal);
      await this.connect(c, box, executor, report, signal);
      // Same key: bb reconnects the existing identity rather than enrolling anew.
      await this.d.bootstrap({ key: resource.key, executor, report, signal });
      return resource;
    } finally {
      this.inFlight.delete(resource.box);
    }
  }

  async remove(resource: OrbleResource, report: Progress, signal: AbortSignal): Promise<void> {
    const { api } = await this.d.config();
    this.d.tunnels.stop(resource.box);
    report.step(`Deleting Orble box ${resource.box}`);
    await this.deleteAndWait(api, resource.box, signal);
    this.d.ssh.forget(resource.box);
    await this.d.intents.delete(resource.key);
  }

  /** Find and delete whatever an interrupted create left, by bb's key only. */
  async reconcileCleanup(key: string, signal: AbortSignal): Promise<void> {
    const { api } = await this.d.config();
    const ids = new Set<string>();
    const intent = await this.d.intents.get(key);
    if (intent?.box) ids.add(intent.box);
    const byAlias = await api.findBox(boxAliasFor(key), signal);
    if (byAlias) ids.add(byAlias.name);
    for (const id of ids) {
      this.d.tunnels.stop(id);
      await this.deleteAndWait(api, id, signal);
      this.d.ssh.forget(id);
      this.d.log(`cleanup ${key}: deleted ${id}`);
    }
    await this.d.intents.delete(key);
  }

  /** Clone every repo of the project under ~/workspace/repos, then register the clones as bb project sources on this host. */
  async provisionProject(c: ProviderConfig, executor: MachineExecutor, hostId: string, project: Project, report: Progress, signal: AbortSignal): Promise<void> {
    const cloned: ClonedRepo[] = [];
    for (const repo of project.repos) {
      report.step(`Cloning ${repo.name}${repo.branch ? ` at ${repo.branch}` : " (default branch)"} for project ${project.name}`);
      let out = "";
      const { exitCode } = await executor.exec({
        command: ["bash", "-c", cloneRepoScript()],
        stdin: cloneInput(repo),
        timeoutMs: 600_000,
        signal,
        onOutput: (t) => {
          out += t;
        },
      });
      const res = parseCloneResult(out);
      if (exitCode !== 0 || !res || res.state === "failed") throw new Error(`Cloning ${repo.name} (${repo.url}) failed: ${res?.detail ?? `exit ${exitCode}`}`);
      report.log(`${repo.name}: ${res.state} on ${res.branch ?? "?"} at ${res.sha ?? "?"} → ${res.detail}`);
      const mismatch = branchMismatch(repo, res);
      if (mismatch) report.log(mismatch);
      cloned.push({ name: repo.name, url: repo.url, path: res.detail });
    }
    const p = this.d.projects!;
    const plan = planSources(cloned, await p.listProjects(), hostId, c.createMissingProjects ?? false);
    for (const a of plan) {
      if (a.kind === "add") {
        await p.addProjectSource({ projectId: a.projectId, hostId, path: a.path });
        report.log(`bb project ${a.projectName}: source added on this machine at ${a.path}`);
      } else if (a.kind === "present") {
        report.log(`bb project ${a.projectName}: already has a source on this machine (${a.path})`);
      } else if (a.kind === "create") {
        const created = await p.createProject({ name: a.repo, hostId, path: a.path });
        report.log(`bb project ${a.repo} created (${created.id}) from ${a.path}`);
      } else if (a.kind === "unmatched") {
        report.log(`${a.repo}: no bb project has the remote ${a.url}; cloned but not registered (setting createMissingProjects creates one)`);
      } else {
        report.log(`${a.repo}: several bb projects share its remote (${a.projectNames.join(", ")}); not registered`);
      }
    }
    this.d.log(`project sources on ${hostId}: ${plan.map((a) => `${a.repo}=${a.kind}`).join(" ")}`);
  }

  /** Rewrite Pi's and OpenCode's provider configs on a running box (after a settings change). */
  async applyAgentConfig(box: string, signal: AbortSignal): Promise<string> {
    const c = await this.d.config();
    return this.syncAgents(c, this.executor(c.api, box), signal);
  }

  private async syncAgents(c: ProviderConfig, executor: MachineExecutor, signal: AbortSignal): Promise<string> {
    return lastLines(await runScript(executor, opencodeSyncScript(), signal, { stdin: JSON.stringify(c.opencodeProviders), what: "agent config", timeoutMs: 120_000 }));
  }

  /** Pi/OpenCode provider configs from live /models (on the box, with its Secret placeholders). Before bootstrap, so the daemon starts with them. */
  private async prepare(c: ProviderConfig, executor: MachineExecutor, report: Progress, signal: AbortSignal) {
    report.step("Fetching model lists for Pi and OpenCode");
    report.log(await this.syncAgents(c, executor, signal));
  }

  /** Open the reverse tunnel and require the hub's /health from inside the box. */
  private async connect(c: ProviderConfig, box: Box, executor: MachineExecutor, report: Progress, signal: AbortSignal) {
    report.step("Opening the reverse SSH tunnel to the box");
    await this.d.tunnels.ensure(c.api, box, signal);
    const until = Date.now() + (this.d.hubGateMs ?? 60_000);
    for (;;) {
      const { exitCode } = await executor.exec({ command: ["bash", "-c", hubHealthScript(this.d.boxHubPort)], stdin: "", timeoutMs: 20_000, signal, onOutput: () => {} });
      if (exitCode === 0) {
        report.log(`The box reaches the bb hub at http://127.0.0.1:${this.d.boxHubPort} (tunnel)`);
        return;
      }
      if (Date.now() > until) throw new Error(`The box cannot reach the bb hub through the tunnel (http://127.0.0.1:${this.d.boxHubPort}/health)`);
      await this.d.tunnels.ensure(c.api, box, signal);
      await this.d.sleep(3000, signal);
    }
  }

  private async deleteAndWait(api: OrbleApi, box: string, signal: AbortSignal) {
    try {
      await api.deleteBox(box, signal);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    const until = Date.now() + 2 * 60_000;
    while ((await api.findBox(box, signal)) !== null) {
      if (Date.now() > until) throw new Error(`Orble box ${box} still exists 2 min after delete`);
      await this.d.sleep(this.d.pollMs ?? 2000, signal);
    }
  }

  private async waitFor(api: OrbleApi, box: string, ok: (b: Box) => boolean, signal: AbortSignal): Promise<Box> {
    const until = Date.now() + (this.d.stateTimeoutMs ?? 3 * 60_000);
    for (;;) {
      const b = await api.findBox(box, signal);
      if (!b) throw new Error(`Orble box ${box} disappeared`);
      if (ok(b)) return b;
      if (Date.now() > until) throw new Error(`Orble box ${box} stuck in ${b.state}`);
      await this.d.sleep(this.d.pollMs ?? 1000, signal);
    }
  }
}

function lastLine(s: string) {
  return s.trim().split("\n").pop() ?? "";
}
function lastLines(s: string) {
  return s.trim().split("\n").slice(-2).join(" · ");
}

/** bb's server-access provider id for the Orble tunnel (hub setting defaultMachineAccess). */
export const ACCESS_PROVIDER_ID = "orble-tunnel";

/**
 * The grant for one machine: Orble boxes reach the hub at the tunnel's loopback
 * port. bb passes `key` as JSON [ownerPluginId, launchKey] for machines a plugin
 * created; any other machine is refused, since the loopback URL means nothing there.
 */
export function tunnelGrant(pluginId: string, key: string, hostId: string, tunnelUrl: string): { id: string; serverUrl: string } | { status: "failed"; message: string } {
  let owner: unknown = null;
  try {
    const parsed: unknown = JSON.parse(key);
    if (Array.isArray(parsed)) owner = parsed[0];
  } catch {
    // not a plugin-created machine
  }
  if (owner !== pluginId) return { status: "failed", message: "The Orble tunnel only connects Orble boxes. Pick another machine access for this machine in Settings → Machines." };
  return { id: `orble-tunnel:${hostId}`, serverUrl: tunnelUrl };
}
