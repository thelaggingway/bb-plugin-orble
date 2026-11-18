// bb-plugin-orble — Orble boxes (orble.tech) as bb machines.
//
// Experimental. Same shape as bb-plugin-instabox, but simpler: Orble's sshd
// allows remote forwarding, so the box → hub route is one `ssh -N -R` per box
// (src/ssh.ts), reached through Orble's /v1/connect with only the API key. No
// Tailscale, relay or chisel. Machines must be handed the tunnel's loopback URL
// http://127.0.0.1:<boxHubPort> (default 38886): the plugin registers the
// "Orble tunnel" machine access for it (bb setting defaultMachineAccess
// orble-tunnel). See README.md.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { BbPluginApi, JsonValue } from "@get-bb/plugin-sdk";
import { DEFAULT_API_URL, type FetchLike, isRunning, isSuspended, OrbleApi, SIZES, type Size } from "./src/orble-api.ts";
import { ACCESS_PROVIDER_ID, type AllocationIntent, inputsSchema, OrbleMachineOps, PROVIDER_ID, type ProviderConfig, resourceSchema, tunnelGrant } from "./src/provider.ts";
import { SshClient, TunnelManager } from "./src/ssh.ts";
import { parseOpencodeProviders } from "./src/box-scripts.ts";
import { IdleWatch } from "./src/idle.ts";
import { createDashboardHandlers, dashboardRpc, ORBLE_CHANGED } from "./src/dashboard.ts";
import { createRepoLister, type GhRun, resolveOwners } from "./src/github-repos.ts";
import { ProjectStore } from "./src/project-store.ts";
import { hubCloneArgs, importListing, importRepo } from "./src/github-import.ts";

const COMPOSITIONS = [
  {
    id: "orble",
    displayName: "Orble box",
    description: "A NEW Orble box for this thread, enrolled as a bb machine, with an isolated Git worktree. Remove the machine when done.",
    environmentProviderId: "git-worktree",
  },
  {
    id: "orble-checkout",
    displayName: "Orble box (project checkout)",
    description: "A NEW Orble box for this thread, working directly in the project checkout on it.",
    environmentProviderId: "project-checkout",
  },
] as const;

const SUPERVISE_MS = 30_000;
/** This plugin's bb id (from the package name bb-plugin-orble); bb keys machine-access grants by it. */
const PLUGIN_ID = "orble";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    apiKey: {
      type: "string",
      label: "Orble API key",
      description: "An orble_… token (the one `orble login` stores in ~/.config/orble/config.json). Required. Stored as a secret on this hub and masked after saving.",
      secret: true,
    },
    snapshot: {
      type: "string",
      label: "Snapshot (optional)",
      description: "Make new runners from this Orble snapshot instead of Orble's base image. A runner snapshot should hold no logins or bb identity: snapshots include the home directory and running programs.",
      default: "",
    },
    size: {
      type: "string",
      label: "Box size",
      description: "s = 2 vCPU / 4 GiB, m = 4 / 8, l = 8 / 16.",
      default: "s",
      experimental_schema: z.enum(SIZES),
    },
    idlePauseSeconds: {
      type: "number",
      label: "Idle suspend for runners (seconds)",
      description:
        "A connected runner is never idle to Orble (the tunnel stays open), so the plugin suspends it through bb once no bb thread on it has been starting or active for this long; the next message resumes it. 0 = never.",
      default: 600,
      experimental_schema: z.number().int().min(0).max(86_400),
    },
    opencodeProviders: {
      type: "string",
      label: "OpenCode / Pi providers (model lists fetched live)",
      description:
        'JSON array of OpenAI-compatible providers: [{"id":"zro","baseURL":"https://zro.moonmath.ai/v1","keyEnv":"ZRO_API_KEY"}]. On each box the plugin calls <baseURL>/models with the Orble Secret placeholder in that env var and writes OpenCode\'s and Pi\'s configs; providers without a Secret are skipped. Empty: the eight defaults (Z.ai, zro, coralbricks, neuralwatt, deepseek, hypercharm, singularity, runinfra).',
      experimental_multiline: true,
      default: "",
    },
    githubOwners: {
      type: "string",
      label: "GitHub owners for the repo picker",
      description: "Comma list of GitHub users/orgs whose repos the Projects editor offers (`gh repo list` on this bb server). Empty: WyrdWerk plus the account gh is logged in as.",
      default: "",
    },
    createMissingProjects: {
      type: "boolean",
      label: "Create bb projects for unmatched repos",
      description: "When a repo cloned for a project runner matches no bb project by git remote, create a bb project from the clone on the runner.",
      default: false,
    },
    hubCheckoutDir: {
      type: "string",
      label: "Hub checkout directory (Import from GitHub)",
      description: "Absolute directory on this bb server for the checkouts of repos imported as bb projects. Empty: ~/bb-github.",
      default: "",
    },
    boxHubPort: {
      type: "number",
      label: "Hub port on the box's loopback",
      description: "The tunnel opens this port on each box; the Orble tunnel machine access hands boxes http://127.0.0.1:<this port>. Changing it needs a plugin reload.",
      default: 38886,
    },
  });

  const s0 = await settings.get();
  const boxHubPort = Math.round(s0.boxHubPort);
  const tunnelUrl = `http://127.0.0.1:${boxHubPort}`;
  const apiUrl = process.env.ORBLE_API_URL || DEFAULT_API_URL;

  async function configOrError(): Promise<(ProviderConfig & { idlePauseSeconds: number }) | { error: string }> {
    const s = await settings.get();
    const apiKey = s.apiKey || "";
    if (!apiKey) return { error: "Add your Orble API key in Settings → Plugins → Orble." };
    return {
      api: new OrbleApi(apiKey, fetch as unknown as FetchLike, apiUrl),
      snapshot: (s.snapshot ?? "").trim() || null,
      size: (SIZES as readonly string[]).includes(s.size) ? (s.size as Size) : "s",
      opencodeProviders: parseOpencodeProviders(s.opencodeProviders ?? ""),
      createMissingProjects: s.createMissingProjects === true,
      idlePauseSeconds: Math.round(s.idlePauseSeconds ?? 600),
    };
  }

  async function config(): Promise<ProviderConfig & { idlePauseSeconds: number }> {
    const c = await configOrError();
    if ("error" in c) throw Object.assign(new Error(c.error), { name: "NeedsConfigurationError" });
    return c;
  }

  const chooseTunnel = `In Settings → Machines → Machine access choose "Orble tunnel", or run: bb settings general defaultMachineAccess ${ACCESS_PROVIDER_ID}`;
  async function wrongAccess(): Promise<string | null> {
    const access = (await bb.sdk.system.config()).serverAccess;
    if (access.defaultProviderId === ACCESS_PROVIDER_ID) return null;
    if (access.defaultProviderId === "direct" && access.effectiveUrl === tunnelUrl) return null;
    return `bb is handing machines ${access.effectiveUrl ?? "(no URL)"} (${access.defaultProviderId ?? "no provider"}), not the Orble tunnel ${tunnelUrl}. ${chooseTunnel}`;
  }
  async function setupProblem(): Promise<string | null> {
    const c = await configOrError();
    if ("error" in c) return c.error;
    return wrongAccess();
  }

  const dir = join(bb.server.experimental_dataDir, "plugins", bb.pluginId, "runtime");
  const ssh = new SshClient({ dir, log: (m) => bb.log.info(m) });
  const tunnels = new TunnelManager({
    ssh,
    hubPort: () => Number(new URL(bb.server.loopbackBaseUrl).port || 80),
    boxHubPort,
    log: (m) => bb.log.info(m),
  });

  // Project runners and Import from GitHub (same as bb-plugin-instabox).
  const projectStore = new ProjectStore(bb.storage.kv);
  const runGh: GhRun = (args) =>
    new Promise((resolve, reject) => {
      execFile("gh", args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(err);
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  const github = createRepoLister({
    runGh,
    now: () => Date.now(),
    owners: async () =>
      resolveOwners((await settings.get()).githubOwners ?? "", async () => {
        const r = await runGh(["api", "user", "--jq", ".login"]);
        return r.code === 0 ? r.stdout.trim() || null : null;
      }),
  });
  type BbProject = { id: string; name: string; gitRemoteUrl: string | null; sources?: { hostId: string; path: string }[] };
  const git = (args: string[], cwd?: string) =>
    new Promise<string>((resolve, reject) => {
      execFile("git", args, { cwd, timeout: 600_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) =>
        err ? reject(new Error(String(stderr).trim().split("\n").pop() || err.message)) : resolve(String(stdout)),
      );
    });
  const checkoutDir = async () => {
    const d = ((await settings.get()).hubCheckoutDir ?? "").trim();
    return d.startsWith("/") ? d : join(homedir(), "bb-github");
  };
  const bbProjects = async () => ((await bb.sdk.projects.list()) as unknown as BbProject[]).map((p) => ({ id: p.id, name: p.name, gitRemoteUrl: p.gitRemoteUrl }));
  const createBbProject = async ({ name, hostId, path }: { name: string; hostId: string; path: string }) => ({
    id: ((await bb.sdk.projects.create({ name, source: { type: "local_path", hostId, path } })) as unknown as { id: string }).id,
  });
  const githubImport = {
    async list(force: boolean) {
      const r = await github.repos(force);
      if (r.status !== "ok") return r;
      return { status: "ok" as const, checkoutDir: await checkoutDir(), repos: importListing(r.repos, await bbProjects()) };
    },
    async run(repos: { owner: string; name: string }[]) {
      const listed = await github.repos(false);
      const hostId = (await bb.sdk.system.config()).primaryHostId;
      const cdir = await checkoutDir();
      const results = [];
      for (const r of repos) {
        if (listed.status !== "ok" || !listed.repos.some((x) => x.owner.toLowerCase() === r.owner.toLowerCase() && x.name === r.name)) {
          results.push({ repo: `${r.owner}/${r.name}`, status: "failed" as const, message: "not in the repo list for the configured GitHub owners" });
          continue;
        }
        if (!hostId) {
          results.push({ repo: `${r.owner}/${r.name}`, status: "failed" as const, message: "bb has no primary host to keep the checkout on" });
          continue;
        }
        const res = await importRepo(
          { owner: r.owner, name: r.name, url: `https://github.com/${r.owner}/${r.name}.git` },
          {
            checkoutDir: cdir,
            listProjects: bbProjects,
            originOf: async (path) => (existsSync(path) ? (await git(["-C", path, "remote", "get-url", "origin"]).catch(() => "")).trim() : null),
            clone: async (url, path) => {
              await mkdir(dirname(path), { recursive: true });
              await git(hubCloneArgs(url, path));
            },
            createProject: ({ name, path }) => createBbProject({ name, hostId, path }),
            sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)),
          },
        );
        bb.log.info(`github import ${res.repo}: ${res.status}`);
        results.push(res);
      }
      return results;
    },
  };

  const intentKey = (key: string) => `alloc/${key}`;
  const ops = new OrbleMachineOps({
    config,
    ssh,
    tunnels,
    boxHubPort,
    bootstrap: (req) => bb.experimental_machines.bootstrap(req),
    intents: {
      get: (key) => bb.storage.kv.get<AllocationIntent>(intentKey(key)),
      set: (key, v) => bb.storage.kv.set(intentKey(key), v),
      delete: (key) => bb.storage.kv.delete(intentKey(key)),
    },
    projects: {
      getProject: (name) => projectStore.get(name),
      listProjects: async () =>
        ((await bb.sdk.projects.list()) as unknown as BbProject[]).map((p) => ({
          id: p.id,
          name: p.name,
          gitRemoteUrl: p.gitRemoteUrl,
          sources: (p.sources ?? []).map((x) => ({ hostId: x.hostId, path: x.path })),
        })),
      addProjectSource: async ({ projectId, hostId, path }) => void (await bb.sdk.projects.sources.add({ projectId, type: "local_path", hostId, path })),
      createProject: createBbProject,
    },
    log: (m) => bb.log.info(m),
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
      }),
  });

  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  bb.experimental_machines.register({
    id: PROVIDER_ID,
    displayName: "Orble",
    description: "Run bb threads on Orble boxes, connected by a reverse SSH tunnel (no Tailscale).",
    icon: "./orble.svg",
    ephemeral: false,
    inputs: inputsSchema,
    async availability() {
      const p = await setupProblem();
      return p ? { status: "setup-required", message: p } : { status: "available" };
    },
    async create({ inputs, key, checkpoint, report, signal }) {
      try {
        const p = await setupProblem();
        if (p) return { status: "failed", message: p };
        const { name, resource } = await ops.create(key, inputs ?? null, checkpoint, report, signal);
        return { status: "created", name, resource };
      } catch (err) {
        signal.throwIfAborted();
        return { status: "failed", message: message(err) };
      }
    },
    async reconcileCleanup({ key, signal }) {
      try {
        await ops.reconcileCleanup(key, signal);
        return { status: "removed" };
      } catch (err) {
        signal.throwIfAborted();
        return { status: "failed", message: `Orble cleanup failed: ${message(err)}` };
      }
    },
    async suspend({ resource, report, signal }) {
      return { resource: await ops.suspend(resourceSchema.parse(resource), report, signal) };
    },
    async resume({ resource, report, signal }) {
      return { resource: await ops.resume(resourceSchema.parse(resource), report, signal) };
    },
    async remove({ resource, report, signal }) {
      try {
        await ops.remove(resourceSchema.parse(resource), report, signal);
        return { status: "removed" };
      } catch (err) {
        signal.throwIfAborted();
        return { status: "failed", message: `Orble remove failed: ${message(err)}` };
      }
    },
  });

  bb.experimental_serverAccess.register({
    id: ACCESS_PROVIDER_ID,
    displayName: "Orble tunnel",
    description: `Orble boxes reach this hub through the plugin's reverse SSH tunnel at ${tunnelUrl} on the box. Other machines are refused.`,
    async availability() {
      const c = await configOrError();
      return "error" in c ? { status: "setup-required", message: c.error } : { status: "available", serverUrl: tunnelUrl };
    },
    async acquire({ key, hostId }) {
      return tunnelGrant(PLUGIN_ID, key, hostId, tunnelUrl);
    },
    async release() {},
  });

  for (const c of COMPOSITIONS) bb.experimental_environments.register({ ...c, icon: "./orble.svg", machineProviderId: PROVIDER_ID });

  // Supervisor: keep a tunnel up for every running Orble box bb knows, apply the
  // idle suspend, and mark boxes Orble suspended on its own as suspended in bb.
  const idle = new IdleWatch();
  let busy = false;
  const busyThreads = async (hostId: string) =>
    (await bb.sdk.threads.count({ hostId, status: "starting" })).total + (await bb.sdk.threads.count({ hostId, status: "active" })).total;
  const supervise = async () => {
    if (busy) return;
    busy = true;
    const ours = new Set<string>();
    try {
      const c = await config();
      for (const h of await bb.sdk.hosts.list()) {
        if (h.machineProviderId !== PROVIDER_ID) continue;
        const parsed = resourceSchema.safeParse(await bb.experimental_machines.getResource(h.id));
        if (!parsed.success) continue;
        const id = parsed.data.box;
        const phase = h.lifecycle.phase;
        if (phase === "destroyed" || phase === "removing") continue;
        ours.add(id);
        if (phase !== "active") {
          idle.forget(id);
          continue;
        }
        const b = await c.api.findBox(id);
        if (b && isRunning(b)) {
          await tunnels.ensure(c.api, b).catch((err) => bb.log.warn(`tunnel ${id}: ${message(err)}`));
          const n = await busyThreads(h.id);
          if (idle.observe(id, n > 0, c.idlePauseSeconds, Date.now())) {
            idle.forget(id);
            bb.log.info(`${id}: no bb thread busy for ${c.idlePauseSeconds}s; suspending ${h.id}`);
            await bb.sdk.hosts.experimental_suspend({ hostId: h.id }).catch((err) => bb.log.warn(`idle suspend ${h.id}: ${message(err)}`));
            bb.realtime.publish(ORBLE_CHANGED, {});
          }
        } else if (b && isSuspended(b)) {
          idle.forget(id);
          tunnels.stop(id);
          bb.log.info(`${id} is suspended on Orble; marking ${h.id} suspended in bb`);
          await bb.sdk.hosts.experimental_suspend({ hostId: h.id }).catch((err) => bb.log.warn(`suspend ${h.id}: ${message(err)}`));
          bb.realtime.publish(ORBLE_CHANGED, {});
        }
      }
      for (const id of tunnels.active()) if (!ours.has(id) && !ops.inFlight.has(id)) tunnels.stop(id);
      idle.retain(ours);
    } catch (err) {
      if ((err as Error).name !== "NeedsConfigurationError") bb.log.warn(`Orble supervisor: ${message(err)}`);
    } finally {
      busy = false;
    }
  };
  settings.onChange((next, prev) => {
    if (next.opencodeProviders === prev.opencodeProviders) return;
    void (async () => {
      for (const h of await bb.sdk.hosts.list()) {
        if (h.machineProviderId !== PROVIDER_ID || h.lifecycle.phase !== "active") continue;
        const parsed = resourceSchema.safeParse(await bb.experimental_machines.getResource(h.id));
        if (!parsed.success) continue;
        await ops
          .applyAgentConfig(parsed.data.box, AbortSignal.timeout(120_000))
          .then((line) => bb.log.info(`${h.id}: ${line} (bb sees new models after the runner's next resume)`))
          .catch((err) => bb.log.warn(`agent config ${h.id}: ${message(err)}`));
      }
    })();
  });

  const timer = setInterval(() => void supervise(), SUPERVISE_MS);
  setTimeout(() => void supervise(), 2000);
  bb.onDispose(() => {
    clearInterval(timer);
    tunnels.stopAll();
  });

  bb.rpc.register(
    dashboardRpc,
    createDashboardHandlers({
      client: async () => {
        const c = await configOrError();
        return "error" in c ? c : { api: c.api };
      },
      defaults: async () => {
        const s = await settings.get();
        return {
          size: (SIZES as readonly string[]).includes(s.size) ? (s.size as Size) : "s",
          snapshot: (s.snapshot ?? "").trim() || null,
          idlePauseSeconds: Math.round(s.idlePauseSeconds ?? 600),
          apiKey: s.apiKey || "",
        };
      },
      hosts: async () =>
        (await bb.sdk.hosts.list()).map((h) => ({ id: h.id, name: h.name, status: h.status, machineProviderId: h.machineProviderId, phase: h.lifecycle.phase })),
      getResource: (hostId) => bb.experimental_machines.getResource(hostId),
      createMachine: async ({ key, inputs }) => {
        const h = await bb.sdk.hosts.experimental_create({ machineProviderId: PROVIDER_ID, key, inputs: inputs as JsonValue, wait: false });
        return { hostId: h.id, name: h.name ?? null };
      },
      executor: (api, box) => ops.executor(api, box),
      forgetBox: (box) => ssh.forget(box),
      publish: () => bb.realtime.publish(ORBLE_CHANGED, {}),
      now: () => Date.now(),
      hubWarning: wrongAccess,
      projectStore,
      github,
      githubImport,
    }),
  );

  const c = await configOrError();
  if ("error" in c) bb.status.needsConfiguration(c.error);
}
