// Server side of the Orble page: a typed RPC contract and its handlers.
//
// The Orble API key stays here. Every output is built from an explicit zod
// schema, so box IPv6 addresses, host keys, shared-port URLs and Secret
// placeholders cannot reach the frontend even if the API starts returning
// more. The run-command box is the one place output passes through; it is
// redacted before it leaves the server.
import { defineRpcContract, type MachineExecutor } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { type Box, type Egress, isNotFound, isRunning, isSuspended, type OrbleApi, OrbleApiError, SIZES, type Size, sizeOf } from "./orble-api.ts";
import type { BranchListResult, RepoListResult } from "./github-repos.ts";
import type { ProjectStore } from "./project-store.ts";
import { PROJECT_NAME_RE, repoInputSchema } from "./projects.ts";
import { PROVIDER_ID } from "./provider.ts";
import { redact } from "./ssh.ts";

/** Realtime channel the page and sidebar badge listen on; published after every change. */
export const ORBLE_CHANGED = "orble-changed";

const boxRef = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "not an Orble box name");
const snapshotName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, "lowercase letters, digits, dots, dashes and underscores");
const boxName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "lowercase letters, digits and dashes, starting with a letter or digit");
const networkName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "network names: lowercase letters, digits and dashes");
const secretName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "secret names are env var names: letters, digits and _");
const hostName = z.string().regex(/^(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/, "a host name such as api.example.com");
/** Egress entries: IPv4, IPv4 CIDR, example.com or *.example.com. */
const egressEntry = z
  .string()
  .regex(/^((\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?|(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+)$/, "IPv4, CIDR, example.com or *.example.com");
export const MAX_EGRESS_ENTRIES = 100;

export const boxDto = z.object({
  /** Orble's immutable id ("bqd4"). */
  id: z.string(),
  /** The alias when it has one, else the id. */
  name: z.string(),
  state: z.string(),
  size: z.enum(SIZES).nullable(),
  vcpus: z.number(),
  memMiB: z.number(),
  diskGiB: z.number(),
  spentUSD: z.number().nullable(),
  snapshot: z.string().nullable(),
  forkedFrom: z.string().nullable(),
  createdAt: z.string().nullable(),
  lastActiveAt: z.string().nullable(),
  egress: z.object({ block: z.boolean(), allow: z.array(z.string()), deny: z.array(z.string()) }).nullable(),
  networks: z.array(z.string()),
  bbMachine: z.object({ hostId: z.string(), name: z.string(), status: z.string(), phase: z.string() }).nullable(),
});
export type BoxDto = z.infer<typeof boxDto>;

export const snapshotDto = z.object({
  /** What the API takes (the original name); `label` is the alias after a rename. */
  name: z.string(),
  label: z.string(),
  sourceBox: z.string().nullable(),
  state: z.string(),
  vcpus: z.number(),
  memMiB: z.number(),
  diskBytes: z.number(),
  createdAt: z.string().nullable(),
  gallery: z.boolean(),
  about: z.string().nullable(),
  /** The plugin's configured runner snapshot. */
  configured: z.boolean(),
});
export type SnapshotDto = z.infer<typeof snapshotDto>;

export const accountDto = z.object({
  email: z.string(),
  account: z.string(),
  plan: z.string(),
  planEnds: z.string().nullable(),
  balanceUSD: z.number(),
  sshKeys: z.number(),
});
export type AccountDto = z.infer<typeof accountDto>;

export const networkDto = z.object({
  name: z.string(),
  prefix: z.string(),
  members: z.array(z.object({ box: z.string(), boxName: z.string(), addr: z.string() })),
  createdAt: z.string().nullable(),
});
export type NetworkDto = z.infer<typeof networkDto>;

/** Never the value, never the placeholder. */
export const secretDto = z.object({
  name: z.string(),
  hosts: z.array(z.string()),
  header: z.string().nullable(),
  format: z.string().nullable(),
  intercept: z.boolean(),
  allBoxes: z.boolean(),
  boxes: z.array(z.object({ id: z.string(), name: z.string() })),
  lastUsedAt: z.string().nullable(),
});
export type SecretDto = z.infer<typeof secretDto>;

export const portDto = z.object({ port: z.number(), access: z.enum(["private", "public"]), url: z.string() });
export type PortDto = z.infer<typeof portDto>;

const section = <T extends z.ZodType>(item: T) => z.object({ items: item.nullable(), error: z.string().nullable() });

export const overviewDto = z.object({
  configured: z.boolean(),
  setupMessage: z.string().nullable(),
  hubWarning: z.string().nullable(),
  fetchedAt: z.string(),
  account: accountDto.nullable(),
  accountError: z.string().nullable(),
  boxes: section(z.array(boxDto)),
  snapshots: section(z.array(snapshotDto)),
  networks: section(z.array(networkDto)),
  secrets: section(z.array(secretDto)),
  defaults: z.object({ size: z.enum(SIZES), snapshot: z.string().nullable(), idlePauseSeconds: z.number() }),
});
export type OverviewDto = z.infer<typeof overviewDto>;

const actionResult = z.object({ ok: z.literal(true), message: z.string() });

export const execResultDto = z.object({
  ok: z.literal(true),
  boxName: z.string(),
  exitCode: z.number(),
  timedOut: z.boolean(),
  output: z.string(),
  truncated: z.boolean(),
  redacted: z.number(),
  /** The command ran on a suspended box, which SSH woke (billing). */
  woke: z.boolean(),
});
export type ExecResultDto = z.infer<typeof execResultDto>;

const projectDto = z.object({ name: z.string(), repos: z.array(z.object({ name: z.string(), url: z.string(), branch: z.string().optional() })) });
const repoListDto = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    owners: z.array(z.string()),
    repos: z.array(z.object({ owner: z.string(), name: z.string(), url: z.string(), isPrivate: z.boolean(), defaultBranch: z.string().nullable() })),
    fetchedAt: z.number(),
    cached: z.boolean(),
  }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);
const importListDto = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    checkoutDir: z.string(),
    repos: z.array(z.object({ owner: z.string(), name: z.string(), url: z.string(), isPrivate: z.boolean(), bbProject: z.object({ id: z.string(), name: z.string() }).nullable() })),
  }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);
const importResultDto = z.discriminatedUnion("status", [
  z.object({ repo: z.string(), status: z.literal("exists"), projectId: z.string(), projectName: z.string() }),
  z.object({ repo: z.string(), status: z.literal("created"), projectId: z.string(), path: z.string(), checkout: z.enum(["existing", "cloned"]), gitRemoteUrl: z.string() }),
  z.object({ repo: z.string(), status: z.literal("failed"), message: z.string() }),
]);
const branchListDto = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), defaultBranch: z.string().nullable(), branches: z.array(z.string()) }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);

export const dashboardRpc = defineRpcContract({
  projects_list: { input: z.null(), output: z.object({ projects: z.array(projectDto) }) },
  project_create: { input: z.object({ name: z.string() }), output: projectDto },
  project_rename: { input: z.object({ name: z.string(), newName: z.string() }), output: projectDto },
  project_delete: { input: z.object({ name: z.string(), confirmName: z.string() }), output: z.object({ ok: z.literal(true) }) },
  project_repo_add: { input: z.object({ project: z.string(), repo: repoInputSchema }), output: projectDto },
  project_repo_update: { input: z.object({ project: z.string(), repoName: z.string(), repo: repoInputSchema }), output: projectDto },
  project_repo_remove: { input: z.object({ project: z.string(), repoName: z.string() }), output: projectDto },
  repos_list: { input: z.object({ refresh: z.boolean() }), output: repoListDto },
  repo_branches: { input: z.object({ owner: z.string(), repo: z.string(), refresh: z.boolean() }), output: branchListDto },
  github_import_list: { input: z.object({ refresh: z.boolean() }), output: importListDto },
  github_import: {
    input: z.object({ repos: z.array(z.object({ owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/), name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/) })).min(1).max(20) }),
    output: z.object({ results: z.array(importResultDto) }),
  },
  orble_overview: { input: z.null(), output: overviewDto },
  orble_summary: { input: z.null(), output: z.object({ running: z.number().nullable(), total: z.number().nullable() }) },
  orble_lifecycle: { input: z.object({ box: boxRef, action: z.enum(["suspend", "resume"]) }), output: actionResult },
  orble_snapshot: { input: z.object({ box: boxRef, name: snapshotName }), output: actionResult },
  orble_rename: { input: z.object({ box: boxRef, name: boxName }), output: actionResult },
  orble_resize: { input: z.object({ box: boxRef, size: z.enum(SIZES) }), output: actionResult },
  orble_create: {
    input: z.object({
      /** Required for a plain box; a bb runner is named bb-<hash>. */
      name: boxName.nullable(),
      snapshot: snapshotName.nullable(),
      size: z.enum(SIZES),
      asRunner: z.boolean(),
      project: z.string().regex(PROJECT_NAME_RE).nullable().optional(),
      /** Put the new box in this box network. */
      network: networkName.nullable().optional(),
      requestId: z.string().uuid(),
    }),
    output: actionResult.extend({ hostId: z.string().nullable() }),
  },
  orble_fork: { input: z.object({ box: boxRef, count: z.number().int().min(1).max(10) }), output: actionResult },
  orble_snapshot_rename: { input: z.object({ name: snapshotName, newName: snapshotName }), output: actionResult },
  orble_ports_list: { input: z.object({ box: boxRef }), output: z.object({ ports: z.array(portDto) }) },
  orble_port_set: { input: z.object({ box: boxRef, port: z.number().int().min(1).max(65_535), access: z.enum(["private", "public", "off"]) }), output: actionResult.extend({ url: z.string().nullable() }) },
  orble_egress_set: {
    input: z.object({ box: boxRef, block: z.boolean(), allow: z.array(egressEntry).max(MAX_EGRESS_ENTRIES), deny: z.array(egressEntry).max(MAX_EGRESS_ENTRIES) }),
    output: actionResult,
  },
  orble_network_create: { input: z.object({ name: networkName }), output: actionResult },
  orble_network_delete: { input: z.object({ name: networkName, confirmName: z.string() }), output: actionResult },
  orble_network_join: { input: z.object({ network: networkName, box: boxRef }), output: actionResult },
  orble_network_leave: { input: z.object({ network: networkName, box: boxRef }), output: actionResult },
  orble_secret_set: {
    input: z.object({
      name: secretName,
      value: z.string().min(1).max(16_384),
      hosts: z.array(hostName).min(1).max(20),
      header: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).nullable(),
      format: z.string().max(200).nullable(),
      /** null: every box. */
      boxes: z.array(boxRef).min(1).max(50).nullable(),
      intercept: z.boolean(),
    }),
    output: actionResult,
  },
  orble_secret_delete: { input: z.object({ name: secretName, confirmName: z.string() }), output: actionResult },
  orble_delete_box: { input: z.object({ box: boxRef, confirmName: z.string() }), output: actionResult },
  orble_delete_snapshot: { input: z.object({ name: snapshotName, confirmName: z.string() }), output: actionResult },
  orble_exec: { input: z.object({ box: boxRef, cmd: z.string().min(1).max(65_536), timeoutSeconds: z.number().int().min(1).max(600).default(60) }), output: execResultDto },
});

export type DashboardRpc = typeof dashboardRpc;

export interface DashboardHost {
  id: string;
  name: string;
  status: string;
  machineProviderId: string | null;
  phase: string;
}

export interface DashboardDeps {
  client(): Promise<{ api: OrbleApi } | { error: string }>;
  defaults(): Promise<{ size: Size; snapshot: string | null; idlePauseSeconds: number; apiKey: string }>;
  hosts(): Promise<DashboardHost[]>;
  getResource(hostId: string): Promise<unknown | null>;
  createMachine?(args: { key: string; inputs: Record<string, unknown> }): Promise<{ hostId: string; name: string | null }>;
  /** An SSH executor for a box (for the run-command box). */
  executor(api: OrbleApi, box: string): MachineExecutor;
  /** Drop the hub's pinned host key for a deleted box. */
  forgetBox(box: string): void;
  publish(): void;
  now(): number;
  hubWarning?(): Promise<string | null>;
  cacheMs?: number;
  projectStore?: ProjectStore;
  githubImport?: {
    list(force: boolean): Promise<z.infer<typeof importListDto>>;
    run(repos: { owner: string; name: string }[]): Promise<z.infer<typeof importResultDto>[]>;
  };
  github?: { repos(force: boolean): Promise<RepoListResult>; branches(owner: string, repo: string, force: boolean): Promise<BranchListResult> };
}

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const MAX_OUTPUT = 1024 * 1024;

/** Replace the hub's key, then any Orble key or Secret placeholder. */
export function redactText(text: string, apiKey: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  if (apiKey.length >= 8) {
    const parts = out.split(apiKey);
    count += parts.length - 1;
    out = parts.join("[redacted Orble key]");
  }
  const after = redact(out);
  count += (after.match(/\[redacted (Orble key|Secret placeholder)\]/g)?.length ?? 0) - (out.match(/\[redacted (Orble key|Secret placeholder)\]/g)?.length ?? 0);
  return { text: after, count };
}

const egressDto = (e: Egress | null | undefined): BoxDto["egress"] =>
  e && (e.block || e.allow?.length || e.deny?.length) ? { block: e.block === true, allow: e.allow ?? [], deny: e.deny ?? [] } : null;

function toBoxDto(b: Box, bb: BoxDto["bbMachine"], networks: string[]): BoxDto {
  return boxDto.parse({
    id: b.name,
    name: b.alias || b.name,
    state: b.state,
    size: sizeOf(b),
    vcpus: b.vcpus,
    memMiB: b.mem_mib,
    diskGiB: b.disk_gib,
    spentUSD: typeof b.spent_micros === "number" ? b.spent_micros / 1e6 : null,
    snapshot: b.snapshot ?? null,
    forkedFrom: b.forked_from ?? null,
    createdAt: b.created_at ?? null,
    lastActiveAt: b.last_active_at ?? null,
    egress: egressDto(b.egress),
    networks,
    bbMachine: bb,
  });
}

/** Orble box id → the bb machine using it (provider resource, never names). */
async function boxIndex(deps: DashboardDeps): Promise<Map<string, NonNullable<BoxDto["bbMachine"]>>> {
  const index = new Map<string, NonNullable<BoxDto["bbMachine"]>>();
  for (const h of await deps.hosts()) {
    if (h.machineProviderId !== PROVIDER_ID || h.phase === "destroyed") continue;
    const r = (await deps.getResource(h.id)) as { box?: unknown } | null;
    if (r && typeof r.box === "string") index.set(r.box, { hostId: h.id, name: h.name, status: h.status, phase: h.phase });
  }
  return index;
}

export function createDashboardHandlers(deps: DashboardDeps) {
  const cacheMs = deps.cacheMs ?? 5_000;
  let cache: { at: number; value: OverviewDto } | null = null;

  async function configured() {
    const c = await deps.client();
    if (!("api" in c)) throw new Error(c.error);
    return c;
  }
  async function mustGet(api: OrbleApi, box: string): Promise<Box> {
    const b = await api.findBox(box);
    if (!b) throw new Error(`Orble box ${box} not found`);
    return b;
  }
  /** A box bb manages must be changed through bb, not behind its back. */
  async function refuseBb(b: Box, what: string) {
    const bb = (await boxIndex(deps)).get(b.name);
    if (bb) throw new Error(`${b.alias || b.name} is bb machine ${bb.name}. ${what} it from bb (Machines → ${bb.name}) so bb keeps its state.`);
  }
  function changed() {
    cache = null;
    deps.publish();
  }

  async function overview(): Promise<OverviewDto> {
    if (cache && deps.now() - cache.at < cacheMs) return cache.value;
    const fetchedAt = new Date(deps.now()).toISOString();
    const d = await deps.defaults();
    const defaults = { size: d.size, snapshot: d.snapshot, idlePauseSeconds: d.idlePauseSeconds };
    const empty = { items: null, error: null };
    const c = await deps.client();
    if (!("api" in c)) return overviewDto.parse({ configured: false, setupMessage: c.error, hubWarning: null, fetchedAt, account: null, accountError: null, boxes: empty, snapshots: empty, networks: empty, secrets: empty, defaults });
    const { api } = c;
    const [me, boxes, snapshots, index, hubWarning, networks, secrets] = await Promise.allSettled([
      api.me(),
      api.listBoxes(),
      api.listSnapshots(),
      boxIndex(deps),
      deps.hubWarning ? deps.hubWarning() : Promise.resolve(null),
      api.listNetworks(),
      api.listSecrets(),
    ]);
    if (me.status === "rejected" && me.reason instanceof OrbleApiError && me.reason.status === 401) {
      return overviewDto.parse({ configured: false, setupMessage: `Orble rejected the API key: ${msg(me.reason)}`, hubWarning: null, fetchedAt, account: null, accountError: null, boxes: empty, snapshots: empty, networks: empty, secrets: empty, defaults });
    }
    const idx = index.status === "fulfilled" ? index.value : new Map();
    const boxRows = boxes.status === "fulfilled" ? boxes.value : [];
    const label = (id: string) => {
      const b = boxRows.find((x) => x.name === id);
      return b ? b.alias || b.name : id;
    };
    const netRows = networks.status === "fulfilled" ? networks.value : [];
    const netsOf = (id: string) => netRows.filter((n) => n.members.some((m) => m.box === id)).map((n) => n.name);
    const value = overviewDto.parse({
      configured: true,
      setupMessage: null,
      hubWarning: hubWarning.status === "fulfilled" ? hubWarning.value : null,
      fetchedAt,
      account:
        me.status === "fulfilled"
          ? { email: me.value.email, account: me.value.slug, plan: me.value.plan, planEnds: me.value.plan_ends ?? null, balanceUSD: me.value.balance_micros / 1e6, sshKeys: me.value.ssh_keys }
          : null,
      accountError: me.status === "rejected" ? msg(me.reason) : null,
      boxes: boxes.status === "fulfilled" ? { items: boxRows.map((b) => toBoxDto(b, idx.get(b.name) ?? null, netsOf(b.name))), error: null } : { items: null, error: msg(boxes.reason) },
      networks:
        networks.status === "fulfilled"
          ? {
              items: netRows.map((n) =>
                networkDto.parse({ name: n.name, prefix: n.prefix, members: n.members.map((m) => ({ box: m.box, boxName: label(m.box), addr: m.addr })), createdAt: n.created_at ?? null }),
              ),
              error: null,
            }
          : { items: null, error: msg(networks.reason) },
      secrets:
        secrets.status === "fulfilled"
          ? {
              items: secrets.value.map((s) =>
                secretDto.parse({
                  name: s.name,
                  hosts: s.hosts ?? [],
                  header: s.header || null,
                  format: s.format || null,
                  intercept: s.intercept === true,
                  allBoxes: s.all_boxes === true,
                  boxes: (s.boxes ?? []).map((id) => ({ id, name: label(id) })),
                  lastUsedAt: (s as { last_used_at?: string }).last_used_at ?? null,
                }),
              ),
              error: null,
            }
          : { items: null, error: msg(secrets.reason) },
      snapshots:
        snapshots.status === "fulfilled"
          ? {
              items: snapshots.value.map((s) =>
                snapshotDto.parse({
                  name: s.name,
                  label: s.alias || s.name,
                  sourceBox: s.box || null,
                  state: s.state,
                  vcpus: s.vcpus,
                  memMiB: s.mem_mib,
                  diskBytes: s.disk_bytes,
                  createdAt: s.created_at ?? null,
                  gallery: s.gallery === true,
                  about: s.about ?? null,
                  configured: d.snapshot !== null && (s.name === d.snapshot || s.alias === d.snapshot),
                }),
              ),
              error: null,
            }
          : { items: null, error: msg(snapshots.reason) },
      defaults,
    });
    cache = { at: deps.now(), value };
    return value;
  }

  const withStore = async <T>(fn: (s: ProjectStore) => Promise<T>): Promise<T> => {
    if (!deps.projectStore) throw new Error("Project storage is not available in this plugin build");
    const r = await fn(deps.projectStore);
    deps.publish();
    return r;
  };
  const github = () => {
    if (!deps.github) throw new Error("The GitHub repo picker is not available in this plugin build");
    return deps.github;
  };
  const ok = (message: string) => ({ ok: true as const, message });

  return {
    projects_list: async () => ({ projects: deps.projectStore ? await deps.projectStore.list() : [] }),
    project_create: async ({ name }: { name: string }) => withStore((s) => s.create(name)),
    project_rename: async ({ name, newName }: { name: string; newName: string }) => withStore((s) => s.rename(name, newName)),
    project_delete: async ({ name, confirmName }: { name: string; confirmName: string }) => {
      await withStore((s) => s.delete(name, confirmName));
      return { ok: true as const };
    },
    project_repo_add: async ({ project, repo }: { project: string; repo: { name: string; url: string; branch?: string } }) => withStore((s) => s.addRepo(project, repo)),
    project_repo_update: async ({ project, repoName, repo }: { project: string; repoName: string; repo: { name: string; url: string; branch?: string } }) =>
      withStore((s) => s.updateRepo(project, repoName, repo)),
    project_repo_remove: async ({ project, repoName }: { project: string; repoName: string }) => withStore((s) => s.removeRepo(project, repoName)),
    repos_list: async ({ refresh }: { refresh: boolean }) => github().repos(refresh),
    repo_branches: async ({ owner, repo, refresh }: { owner: string; repo: string; refresh: boolean }) => github().branches(owner, repo, refresh),
    github_import_list: async ({ refresh }: { refresh: boolean }) => {
      if (!deps.githubImport) throw new Error("Import from GitHub is not available in this plugin build");
      return deps.githubImport.list(refresh);
    },
    github_import: async ({ repos }: { repos: { owner: string; name: string }[] }) => {
      if (!deps.githubImport) throw new Error("Import from GitHub is not available in this plugin build");
      const results = await deps.githubImport.run(repos);
      changed();
      return { results };
    },

    orble_overview: async () => overview(),
    orble_summary: async () => {
      const items = (await overview()).boxes.items;
      return items === null ? { running: null, total: null } : { running: items.filter((b) => b.state === "running").length, total: items.length };
    },

    orble_lifecycle: async ({ box, action }: { box: string; action: "suspend" | "resume" }) => {
      const { api } = await configured();
      const b = await mustGet(api, box);
      const label = b.alias || b.name;
      if (action === "suspend") {
        if (isSuspended(b)) return ok(`${label} is already suspended`);
        await refuseBb(b, "Suspend");
        await api.suspend(b.name);
        changed();
        return ok(`Suspended ${label} (memory and processes are kept; SSH or Resume wakes it)`);
      }
      if (isRunning(b)) return ok(`${label} is already running`);
      await api.resume(b.name);
      changed();
      return ok(`Resumed ${label}`);
    },

    orble_snapshot: async ({ box, name }: { box: string; name: string }) => {
      const { api } = await configured();
      const b = await mustGet(api, box);
      const s = await api.snapshot(b.name, name);
      changed();
      return ok(`Saved ${b.alias || b.name} as ${s.name} (${Math.round(s.disk_bytes / 1e6)} MB). It includes the home directory and running programs, so logins and a bb identity go with it.`);
    },

    orble_rename: async ({ box, name }: { box: string; name: string }) => {
      const { api } = await configured();
      const b = await mustGet(api, box);
      await refuseBb(b, "A bb runner keeps its name; manage");
      await api.rename(b.name, name);
      changed();
      return ok(`Renamed ${b.alias || b.name} → ${name} (the old name and hostname keep working)`);
    },

    orble_resize: async ({ box, size }: { box: string; size: Size }) => {
      const { api } = await configured();
      const b = await mustGet(api, box);
      if (sizeOf(b) === size) return ok(`${b.alias || b.name} is already size ${size}`);
      await refuseBb(b, "Suspend or remove");
      await api.resize(b.name, size);
      changed();
      return ok(`Restarted ${b.alias || b.name} at size ${size} (files kept; running programs stopped)`);
    },

    orble_create: async ({
      name,
      snapshot,
      size,
      asRunner,
      project,
      network,
      requestId,
    }: {
      name: string | null;
      snapshot: string | null;
      size: Size;
      asRunner: boolean;
      project?: string | null;
      network?: string | null;
      requestId: string;
    }) => {
      if (project && !asRunner) throw new Error('A project needs a bb runner: tick "Create as a bb runner"');
      if (asRunner) {
        if (!deps.createMachine) throw new Error("bb machine creation is not available in this plugin build");
        const inputs: Record<string, unknown> = { size };
        if (snapshot) inputs.snapshot = snapshot;
        if (network) inputs.network = network;
        if (project) {
          const p = deps.projectStore ? await deps.projectStore.get(project) : null;
          if (!p) throw new Error(`Unknown project "${project}"`);
          if (p.repos.length === 0) throw new Error(`Project "${p.name}" has no repos yet`);
          inputs.project = p.name;
        }
        const host = await deps.createMachine({ key: `orble-page-${requestId}`, inputs });
        changed();
        return { ...ok(`Creating bb machine ${host.name ?? host.hostId} on Orble (enrollment runs in Machines).`), hostId: host.hostId };
      }
      if (!name) throw new Error("A box name is required");
      const { api } = await configured();
      const b = await api.createBox({ name, size, ...(snapshot ? { from: snapshot } : {}) });
      let joined = "";
      if (network) {
        try {
          await api.joinNetwork(network, b.name);
          joined = `, in network ${network}`;
        } catch (err) {
          joined = `; joining network ${network} failed: ${msg(err)}`;
        }
      }
      changed();
      return { ...ok(`Created ${b.alias || b.name} (${b.name}), size ${size}${snapshot ? ` from ${snapshot}` : ""}${joined}`), hostId: null };
    },

    orble_fork: async ({ box, count }: { box: string; count: number }) => {
      const { api } = await configured();
      const b = await mustGet(api, box);
      // A fork carries the running bb daemon and identity; it must not join bb as the same machine.
      await refuseBb(b, "A bb runner cannot be forked here (the fork would copy its bb identity). Create another runner, or remove");
      const r = await api.fork(b.name, count);
      changed();
      return ok(`Forked ${b.alias || b.name} into ${r.boxes.length} box${r.boxes.length === 1 ? "" : "es"}: ${r.boxes.map((x) => x.name).join(", ")} (running programs included; forks join the source's networks)`);
    },

    orble_snapshot_rename: async ({ name, newName }: { name: string; newName: string }) => {
      const { api } = await configured();
      const snap = (await api.listSnapshots()).find((s) => s.name === name);
      if (!snap) throw new Error(`Orble snapshot ${name} not found`);
      if (snap.gallery) throw new Error(`${name} is one of Orble's gallery images, not yours`);
      await api.renameSnapshot(name, newName);
      const d = await deps.defaults();
      changed();
      const wasDefault = d.snapshot !== null && (d.snapshot === name || d.snapshot === snap.alias);
      return ok(`Renamed ${snap.alias || name} → ${newName} (its first name keeps working${wasDefault ? ", so the runner snapshot setting still matches" : ""})`);
    },

    orble_ports_list: async ({ box }: { box: string }) => {
      const { api } = await configured();
      const b = await mustGet(api, box);
      return { ports: (await api.listPorts(b.name)).map((p) => portDto.parse({ port: p.port, access: p.access, url: p.url })) };
    },

    orble_port_set: async ({ box, port, access }: { box: string; port: number; access: "private" | "public" | "off" }) => {
      const { api } = await configured();
      const b = await mustGet(api, box);
      const label = b.alias || b.name;
      if (access === "off") {
        try {
          await api.unsharePort(b.name, port);
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
        changed();
        return { ...ok(`Stopped sharing ${label}:${port}`), url: null };
      }
      const p = await api.sharePort(b.name, port, access);
      changed();
      return { ...ok(access === "public" ? `${label}:${port} is public: anyone with the address can open it` : `${label}:${port} is shared, private to your Orble account`), url: p.url };
    },

    orble_egress_set: async ({ box, block, allow, deny }: { box: string; block: boolean; allow: string[]; deny: string[] }) => {
      const { api } = await configured();
      const b = await mustGet(api, box);
      const uniq = (a: string[]) => [...new Set(a.map((x) => x.trim().toLowerCase()).filter(Boolean))];
      const rules: Egress = {};
      if (block) rules.block = true;
      if (allow.length) rules.allow = uniq(allow);
      if (deny.length) rules.deny = uniq(deny);
      if ((rules.allow?.length ?? 0) + (rules.deny?.length ?? 0) > MAX_EGRESS_ENTRIES) throw new Error(`Orble allows ${MAX_EGRESS_ENTRIES} entries per box`);
      await api.setEgress(b.name, rules);
      changed();
      const label = b.alias || b.name;
      if (!block && !rules.allow && !rules.deny) return ok(`${label} may reach anything again (no rules)`);
      return ok(`${label}: ${block ? `blocked except ${rules.allow?.length ?? 0} allowed` : "open"}${rules.deny ? `, ${rules.deny.length} denied` : ""}. Applied while it runs; forks and snapshots keep the rules.`);
    },

    orble_network_create: async ({ name }: { name: string }) => {
      const { api } = await configured();
      if ((await api.listNetworks()).some((n) => n.name === name)) throw new Error(`Network ${name} already exists`);
      const n = await api.createNetwork(name);
      changed();
      return ok(`Created network ${n.name} (${n.prefix}). Boxes in it reach each other as <box>.${n.name}.internal.`);
    },

    orble_network_delete: async ({ name, confirmName }: { name: string; confirmName: string }) => {
      const { api } = await configured();
      const n = (await api.listNetworks()).find((x) => x.name === name);
      if (!n) throw new Error(`Network ${name} not found`);
      if (confirmName !== name) throw new Error(`Confirmation does not match: type ${name} exactly to delete it`);
      await api.deleteNetwork(name);
      changed();
      return ok(`Deleted network ${name}${n.members.length ? `; its ${n.members.length} box${n.members.length === 1 ? "" : "es"} left it` : ""}`);
    },

    orble_network_join: async ({ network, box }: { network: string; box: string }) => {
      const { api } = await configured();
      const b = await mustGet(api, box);
      const n = await api.joinNetwork(network, b.name);
      const m = n.members.find((x) => x.box === b.name);
      changed();
      return ok(`${b.alias || b.name} joined ${network}${m ? ` at ${m.addr}` : ""} (${b.name}.${network}.internal)`);
    },

    orble_network_leave: async ({ network, box }: { network: string; box: string }) => {
      const { api } = await configured();
      const b = await mustGet(api, box);
      await api.leaveNetwork(network, b.name);
      changed();
      return ok(`${b.alias || b.name} left ${network}`);
    },

    orble_secret_set: async (input: { name: string; value: string; hosts: string[]; header: string | null; format: string | null; boxes: string[] | null; intercept: boolean }) => {
      const { api } = await configured();
      if (input.format !== null && !input.format.includes("{}")) throw new Error('The format must contain {} where the value goes, such as "Bearer {}"');
      let ids: string[] | undefined;
      if (input.boxes) ids = await Promise.all(input.boxes.map(async (x) => (await mustGet(api, x)).name));
      const existed = (await api.listSecrets()).some((s) => s.name === input.name);
      // The value goes straight to Orble and is never logged, returned or kept here.
      const s = await api.setSecret(input.name, {
        value: input.value,
        hosts: input.hosts.map((h) => h.toLowerCase()),
        ...(input.header ? { header: input.header } : {}),
        ...(input.format ? { format: input.format } : {}),
        ...(ids ? { boxes: ids } : {}),
        ...(input.intercept ? { intercept: true } : {}),
      });
      changed();
      const n = (s.boxes ?? []).length;
      return ok(`${existed ? "Replaced" : "Saved"} ${s.name} for ${s.hosts.join(", ")}; ${s.all_boxes ? "every box gets" : `${n} box${n === 1 ? " gets" : "es get"}`} $${s.name} as a placeholder; requests to $${s.name}_URL/<path> get the value${s.intercept ? ", and so do direct requests to its hosts that send the placeholder" : ""} (new shells on running boxes pick it up).`);
    },

    orble_secret_delete: async ({ name, confirmName }: { name: string; confirmName: string }) => {
      const { api } = await configured();
      if (!(await api.listSecrets()).some((s) => s.name === name)) throw new Error(`Secret ${name} not found`);
      if (confirmName !== name) throw new Error(`Confirmation does not match: type ${name} exactly to delete it`);
      await api.deleteSecret(name);
      changed();
      return ok(`Deleted secret ${name}; boxes' placeholders for it stop working`);
    },

    orble_delete_box: async ({ box, confirmName }: { box: string; confirmName: string }) => {
      const { api } = await configured();
      const b = await mustGet(api, box);
      const label = b.alias || b.name;
      if (confirmName !== label) throw new Error(`Confirmation does not match: type ${label} exactly to delete it`);
      await refuseBb(b, "Remove");
      try {
        await api.deleteBox(b.name);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      deps.forgetBox(b.name);
      changed();
      return ok(`Deleted ${label} and its disk; its snapshots are kept`);
    },

    orble_delete_snapshot: async ({ name, confirmName }: { name: string; confirmName: string }) => {
      const { api } = await configured();
      const snap = (await api.listSnapshots()).find((s) => s.name === name);
      if (!snap) throw new Error(`Orble snapshot ${name} not found`);
      if (snap.gallery) throw new Error(`${name} is one of Orble's gallery images, not yours`);
      const label = snap.alias || name;
      if (confirmName !== label) throw new Error(`Confirmation does not match: type ${label} exactly to delete it`);
      await api.deleteSnapshot(name);
      const d = await deps.defaults();
      changed();
      return ok(d.snapshot === name || d.snapshot === snap.alias ? `Deleted ${label}. It was the configured runner snapshot; new runners use Orble's base image until you set another.` : `Deleted snapshot ${label}`);
    },

    orble_exec: async ({ box, cmd, timeoutSeconds }: { box: string; cmd: string; timeoutSeconds: number }): Promise<ExecResultDto> => {
      const { api } = await configured();
      const before = await mustGet(api, box);
      let out = "";
      let truncated = false;
      const { exitCode } = await deps.executor(api, before.name).exec({
        command: ["bash", "-lc", cmd],
        stdin: "",
        timeoutMs: timeoutSeconds * 1000,
        signal: AbortSignal.timeout(timeoutSeconds * 1000 + 30_000),
        onOutput: (t) => {
          if (out.length < MAX_OUTPUT) out += t;
          else truncated = true;
        },
      });
      const r = redactText(out.slice(0, MAX_OUTPUT), (await deps.defaults()).apiKey);
      const woke = !isRunning(before);
      if (woke) changed();
      return execResultDto.parse({ ok: true, boxName: before.alias || before.name, exitCode, timedOut: exitCode === 124, output: r.text, truncated, redacted: r.count, woke });
    },
  };
}
