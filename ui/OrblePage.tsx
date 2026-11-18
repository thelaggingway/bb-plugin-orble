// The Orble page (navPanel component): account, boxes, snapshots, networks,
// secrets, projects,
// import from GitHub, run command. Every action opens ActionDialog first;
// destructive actions need the name typed.
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { BoxDto, ExecResultDto, NetworkDto, SecretDto, SnapshotDto } from "../src/dashboard.ts";
import { ActionDialog, type DialogSpec, type DialogValues } from "./dialogs.tsx";
import { ago, suggestSnapshotName } from "./format.ts";
import { AccountSection, type BoxAction, BoxesSection, NetworksSection, RunCommandSection, SecretsSection, SnapshotsSection } from "./sections.tsx";
import { ImportSection } from "./ImportSection.tsx";
import { NO_PROJECTS_TEXT } from "./NoProjectsHint.tsx";
import { ProjectsSection } from "./ProjectsSection.tsx";
import { useOrbleOverview, useOrbleRunning, useProjectNames } from "./useOrble.ts";

function useNow(ms = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SNAP_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const NET_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const SECRET_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Split a textarea or comma list into trimmed, non-empty entries. */
const list = (v: unknown) =>
  String(v ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
const SIZE_OPTIONS = [
  { value: "s", label: "s · 2 vCPU · 4 GiB" },
  { value: "m", label: "m · 4 vCPU · 8 GiB" },
  { value: "l", label: "l · 8 vCPU · 16 GiB" },
];

type Notice = { message: string; hostId?: string | null };

export function OrblePage(_props: PluginNavPanelProps) {
  const { rpc, data, error, loading, refetch } = useOrbleOverview();
  const projectNames = useProjectNames();
  const [spec, setSpec] = useState<DialogSpec | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [execResult, setExecResult] = useState<ExecResultDto | null>(null);
  const now = useNow();

  const open = useCallback((s: DialogSpec) => {
    setNotice(null);
    setSpec(s);
  }, []);
  const run = useCallback(
    async (s: DialogSpec, values: DialogValues) => {
      const result = await s.run(values);
      if (result.message) setNotice({ message: result.message, hostId: result.hostId ?? null });
      refetch();
    },
    [refetch],
  );

  const lifecycle = (b: BoxDto, action: "suspend" | "resume"): DialogSpec => ({
    title: `${action === "suspend" ? "Suspend" : "Resume"} ${b.name}`,
    description:
      action === "suspend"
        ? "Suspend keeps memory, processes and files and stops compute billing. SSH or Resume wakes it."
        : "Resume wakes the box with its processes intact. Running time is billed per second.",
    confirmLabel: action === "suspend" ? "Suspend" : "Resume",
    fields: [],
    run: async () => ({ message: (await rpc.call("orble_lifecycle", { box: b.id, action })).message }),
  });

  const snapshot = (b: BoxDto): DialogSpec => ({
    title: `Snapshot ${b.name}`,
    description: (
      <>
        <p>Saves the box's disk and running programs. Boxes made from it carry on from there.</p>
        <p className="text-destructive">The snapshot includes the home directory, so agent logins, keys and a bb runner identity go with it.</p>
      </>
    ),
    confirmLabel: "Save snapshot",
    fields: [{ kind: "text", key: "name", label: "Snapshot name", initial: suggestSnapshotName(b.name), hint: "lowercase letters, digits, dots and dashes", required: true }],
    run: async (v) => {
      const name = String(v.name).trim();
      if (!SNAP_RE.test(name)) throw new Error("Snapshot name: lowercase letters, digits, dots, dashes and underscores");
      return { message: (await rpc.call("orble_snapshot", { box: b.id, name })).message };
    },
  });

  const rename = (b: BoxDto): DialogSpec => ({
    title: `Rename ${b.name}`,
    description: "The id, the old name and its hostname keep working.",
    confirmLabel: "Rename",
    fields: [{ kind: "text", key: "name", label: "Name", initial: b.name, required: true }],
    run: async (v) => {
      const name = String(v.name).trim();
      if (!NAME_RE.test(name)) throw new Error("Name: lowercase letters, digits and dashes, starting with a letter or digit");
      return { message: (await rpc.call("orble_rename", { box: b.id, name })).message };
    },
  });

  const resize = (b: BoxDto): DialogSpec => ({
    title: `Resize ${b.name}`,
    description: <p className="text-destructive">Restarts the box at the new size. Files stay; running programs stop.</p>,
    confirmLabel: "Resize",
    destructive: true,
    fields: [{ kind: "select", key: "size", label: "Size", initial: b.size ?? "m", options: SIZE_OPTIONS }],
    run: async (v) => ({ message: (await rpc.call("orble_resize", { box: b.id, size: String(v.size) as "s" | "m" | "l" })).message }),
  });

  const deleteBox = (b: BoxDto): DialogSpec => ({
    title: `Delete ${b.name}`,
    description: <p className="font-medium text-destructive">Permanent. The box and its disk are deleted; its snapshots are kept.</p>,
    confirmLabel: "Delete box",
    destructive: true,
    fields: [{ kind: "confirm", key: "confirm", label: `Type ${b.name} to confirm`, expected: b.name }],
    run: async (v) => ({ message: (await rpc.call("orble_delete_box", { box: b.id, confirmName: String(v.confirm) })).message }),
  });

  const deleteSnapshot = (s: SnapshotDto): DialogSpec => ({
    title: `Delete snapshot ${s.label}`,
    description: (
      <>
        <p className="font-medium text-destructive">Permanent. Boxes already made from it are not affected.</p>
        {s.configured ? <p className="font-medium">This is the configured runner snapshot; new runners fall back to Orble's base image.</p> : null}
      </>
    ),
    confirmLabel: "Delete snapshot",
    destructive: true,
    fields: [{ kind: "confirm", key: "confirm", label: `Type ${s.label} to confirm`, expected: s.label }],
    run: async (v) => ({ message: (await rpc.call("orble_delete_snapshot", { name: s.name, confirmName: String(v.confirm) })).message }),
  });

  const fork = (b: BoxDto): DialogSpec => ({
    title: `Fork ${b.name}`,
    description: (
      <>
        <p>Makes copies of the box with its disk, memory and running programs, in about a second. Each copy bills on its own and joins the source's networks.</p>
        <p className="text-destructive">Copies include the home directory: logins, keys and anything secret on the disk.</p>
      </>
    ),
    confirmLabel: "Fork",
    fields: [{ kind: "number", key: "count", label: "Copies", initial: "1", hint: "1 to 10", required: true }],
    run: async (v) => {
      const count = Number(v.count);
      if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error("Copies: a whole number from 1 to 10");
      return { message: (await rpc.call("orble_fork", { box: b.id, count })).message };
    },
  });

  const ports = async (b: BoxDto) => {
    let shared;
    try {
      shared = (await rpc.call("orble_ports_list", { box: b.id })).ports;
    } catch (e) {
      setNotice({ message: e instanceof Error ? e.message : String(e) });
      return;
    }
    open({
      title: `Shared ports on ${b.name}`,
      description: (
        <>
          {shared.length === 0 ? (
            <p>No ports are shared.</p>
          ) : (
            <ul className="space-y-0.5">
              {shared.map((p) => (
                <li key={p.port} className="font-mono text-xs">
                  {p.port} · {p.access} ·{" "}
                  <a className="underline underline-offset-4" href={p.url} target="_blank" rel="noreferrer">
                    {p.url}
                  </a>
                </li>
              ))}
            </ul>
          )}
          <p>Private links need an Orble login; public links work for anyone. Set access to off to stop sharing.</p>
          <p className="text-destructive">A public port is open to the whole internet.</p>
        </>
      ),
      confirmLabel: "Apply",
      fields: [
        { kind: "number", key: "port", label: "Port", initial: shared[0] ? String(shared[0].port) : "8080", required: true },
        {
          kind: "select",
          key: "access",
          label: "Access",
          initial: "private",
          options: [
            { value: "private", label: "private (Orble login)" },
            { value: "public", label: "public (anyone with the link)" },
            { value: "off", label: "off (stop sharing)" },
          ],
        },
      ],
      run: async (v) => {
        const port = Number(v.port);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Port: 1 to 65535");
        const r = await rpc.call("orble_port_set", { box: b.id, port, access: String(v.access) as "private" | "public" | "off" });
        return { message: r.url ? `${r.message} ${r.url}` : r.message };
      },
    });
  };

  const egress = (b: BoxDto): DialogSpec => ({
    title: `Outbound rules for ${b.name}`,
    description: (
      <>
        <p>
          Entries are IPv4 addresses, CIDRs, <code className="font-mono">example.com</code> or <code className="font-mono">*.example.com</code>. With block on, only the allow list is
          reachable; otherwise everything except the deny list is. Empty lists with block off clear all rules.
        </p>
      </>
    ),
    confirmLabel: "Save rules",
    fields: [
      { kind: "checkbox", key: "block", label: "Block all outbound traffic except the allow list", initial: b.egress?.block ?? false },
      { kind: "textarea", key: "allow", label: "Allow", initial: b.egress?.allow.join("\n") ?? "", rows: 4, hint: "one per line" },
      { kind: "textarea", key: "deny", label: "Deny", initial: b.egress?.deny.join("\n") ?? "", rows: 4, hint: "one per line" },
    ],
    run: async (v) => {
      const allow = list(v.allow);
      const deny = list(v.deny);
      if (allow.length > 100 || deny.length > 100) throw new Error("At most 100 entries per list");
      return { message: (await rpc.call("orble_egress_set", { box: b.id, block: Boolean(v.block), allow, deny })).message };
    },
  });

  const renameSnapshot = (s: SnapshotDto): DialogSpec => ({
    title: `Rename snapshot ${s.label}`,
    description: "Orble keeps the original name working as well.",
    confirmLabel: "Rename",
    fields: [{ kind: "text", key: "name", label: "New name", initial: s.label, required: true }],
    run: async (v) => {
      const newName = String(v.name).trim();
      if (!SNAP_RE.test(newName)) throw new Error("Snapshot name: lowercase letters, digits, dots, dashes and underscores");
      return { message: (await rpc.call("orble_snapshot_rename", { name: s.name, newName })).message };
    },
  });

  const boxOptions = () => (data?.boxes.items ?? []).map((b) => ({ value: b.id, label: `${b.name}${b.bbMachine ? " (bb runner)" : ""}` }));

  const createNetwork = (): DialogSpec => ({
    title: "New box network",
    description: "A private network for boxes on this account. Add boxes to it afterwards, or pick it when creating a box.",
    confirmLabel: "Create network",
    fields: [{ kind: "text", key: "name", label: "Name", initial: "", placeholder: "my-net", required: true, hint: "lowercase letters, digits and dashes, up to 31" }],
    run: async (v) => {
      const name = String(v.name).trim();
      if (!NET_RE.test(name)) throw new Error("Network name: lowercase letters, digits and dashes, up to 31");
      return { message: (await rpc.call("orble_network_create", { name })).message };
    },
  });

  const joinNetwork = (n: NetworkDto): DialogSpec => {
    const opts = boxOptions().filter((o) => !n.members.some((m) => m.box === o.value));
    return {
      title: `Add a box to ${n.name}`,
      description: opts.length === 0 ? "Every box is already in this network." : `The box becomes reachable as <box>.${n.name}.internal from the other members.`,
      confirmLabel: "Add box",
      fields: opts.length === 0 ? [] : [{ kind: "select", key: "box", label: "Box", initial: opts[0].value, options: opts }],
      run: async (v) => {
        if (opts.length === 0) return { message: "" };
        return { message: (await rpc.call("orble_network_join", { network: n.name, box: String(v.box) })).message };
      },
    };
  };

  const leaveNetwork = (n: NetworkDto, box: string, boxName: string): DialogSpec => ({
    title: `Take ${boxName} out of ${n.name}`,
    description: "Other members can no longer reach it over this network.",
    confirmLabel: "Remove",
    fields: [],
    run: async () => ({ message: (await rpc.call("orble_network_leave", { network: n.name, box })).message }),
  });

  const deleteNetwork = (n: NetworkDto): DialogSpec => ({
    title: `Delete network ${n.name}`,
    description: <p className="font-medium text-destructive">Permanent. Its {n.members.length} box(es) stay but lose this network.</p>,
    confirmLabel: "Delete network",
    destructive: true,
    fields: [{ kind: "confirm", key: "confirm", label: `Type ${n.name} to confirm`, expected: n.name }],
    run: async (v) => ({ message: (await rpc.call("orble_network_delete", { name: n.name, confirmName: String(v.confirm) })).message }),
  });

  const setSecret = (s?: SecretDto): DialogSpec => {
    const names = (data?.boxes.items ?? []).map((b) => b.name);
    return {
      title: s ? `Replace secret ${s.name}` : "New secret",
      description: (
        <>
          <p>
            Boxes get <code className="font-mono">$NAME</code> as a placeholder and <code className="font-mono">$NAME_URL</code>; a request to{" "}
            <code className="font-mono">$NAME_URL/&lt;path&gt;</code> goes to the first host with the real value added on the way out, so the value never reaches the box.
          </p>
          {s ? <p className="font-medium">Orble never returns a value, so enter it again to change any setting.</p> : null}
        </>
      ),
      confirmLabel: s ? "Replace" : "Create secret",
      fields: [
        ...(s ? [] : [{ kind: "text" as const, key: "name", label: "Name", initial: "", placeholder: "OPENAI_API_KEY", required: true, hint: "an env var name" }]),
        { kind: "secret", key: "value", label: "Value", initial: "", required: true },
        { kind: "text", key: "hosts", label: "Hosts", initial: s?.hosts.join(", ") ?? "", placeholder: "api.openai.com", required: true, hint: "comma-separated; *.example.com allowed" },
        { kind: "text", key: "header", label: "Header (optional)", initial: s?.header ?? "", placeholder: "Authorization", hint: "default Authorization" },
        { kind: "text", key: "format", label: "Header format (optional)", initial: s?.format ?? "", placeholder: "Bearer {}", hint: "default Bearer {}; {} is replaced by the value" },
        {
          kind: "text",
          key: "boxes",
          label: "Boxes",
          initial: s && !s.allBoxes ? s.boxes.map((b) => b.name).join(", ") : "",
          placeholder: "all boxes",
          hint: `Empty means every box, including new ones. Boxes: ${names.join(", ") || "none"}`,
        },
        { kind: "checkbox", key: "intercept", label: "Intercept: also fill it in on direct HTTPS requests to its hosts that send $NAME in the header (adds Orble's CA to the box)", initial: s?.intercept ?? false },
      ],
      run: async (v) => {
        const name = s ? s.name : String(v.name).trim();
        if (!SECRET_RE.test(name)) throw new Error("Name: letters, digits and _, not starting with a digit");
        const hosts = list(v.hosts);
        if (hosts.length === 0) throw new Error("At least one host");
        const boxes = list(v.boxes);
        const header = String(v.header ?? "").trim();
        const format = String(v.format ?? "").trim();
        return {
          message: (
            await rpc.call("orble_secret_set", {
              name,
              value: String(v.value),
              hosts,
              header: header || null,
              format: format || null,
              boxes: boxes.length ? boxes : null,
              intercept: Boolean(v.intercept),
            })
          ).message,
        };
      },
    };
  };

  const deleteSecret = (s: SecretDto): DialogSpec => ({
    title: `Delete secret ${s.name}`,
    description: <p className="font-medium text-destructive">Permanent. Requests from boxes stop getting the value.</p>,
    confirmLabel: "Delete secret",
    destructive: true,
    fields: [{ kind: "confirm", key: "confirm", label: `Type ${s.name} to confirm`, expected: s.name }],
    run: async (v) => ({ message: (await rpc.call("orble_secret_delete", { name: s.name, confirmName: String(v.confirm) })).message }),
  });

  const createBox = (preset?: SnapshotDto): DialogSpec => {
    const snaps = (data?.snapshots.items ?? []).filter((s) => s.state === "ready");
    const initialSnap = preset?.name ?? data?.defaults.snapshot ?? "";
    const options = [{ value: "", label: "Orble base image" }, ...snaps.map((s) => ({ value: s.name, label: `${s.name}${s.gallery ? " (gallery)" : ""}${s.configured ? " (runner source)" : ""}` }))];
    return {
      title: preset ? `New box from ${preset.name}` : "New Orble box",
      description: (
        <>
          <p>Creates a box on this Orble account (ready in about a second). It bills per second while it runs.</p>
          <p>
            With <strong>as bb runner</strong> the box is enrolled through bb's provider path and appears in Machines. A plain box is just a VM.
          </p>
        </>
      ),
      confirmLabel: "Create",
      fields: [
        { kind: "select", key: "snapshot", label: "Start from", initial: initialSnap, options },
        { kind: "select", key: "size", label: "Size", initial: data?.defaults.size ?? "s", options: SIZE_OPTIONS },
        { kind: "text", key: "name", label: "Name", initial: "", placeholder: "lowercase-name", hint: "Required for a plain box; a bb runner gets bb-<hash>" },
        { kind: "checkbox", key: "asRunner", label: "Create as a bb runner (enroll it)", initial: false },
        {
          kind: "select",
          key: "network",
          label: "Box network",
          initial: "",
          options: [{ value: "", label: "None" }, ...(data?.networks.items ?? []).map((n) => ({ value: n.name, label: n.name }))],
        },
        {
          kind: "select",
          key: "project",
          label: "Project (bb runners only)",
          initial: "",
          options: [{ value: "", label: "None" }, ...projectNames.map((n) => ({ value: n, label: n }))],
          hint: projectNames.length === 0 ? NO_PROJECTS_TEXT : "Clones each repo of the project into ~/workspace/repos and registers it as a bb project source on the runner.",
        },
      ],
      run: async (v) => {
        const asRunner = Boolean(v.asRunner);
        const name = String(v.name ?? "").trim();
        if (!asRunner && name === "") throw new Error("A box name is required");
        if (name !== "" && !NAME_RE.test(name)) throw new Error("Name: lowercase letters, digits and dashes, starting with a letter or digit");
        const project = String(v.project ?? "");
        if (project !== "" && !asRunner) throw new Error('A project needs "Create as a bb runner" checked');
        const network = String(v.network ?? "");
        const r = await rpc.call("orble_create", {
          name: name === "" ? null : name,
          snapshot: String(v.snapshot ?? "") || null,
          size: String(v.size) as "s" | "m" | "l",
          asRunner,
          ...(project !== "" ? { project } : {}),
          ...(network !== "" ? { network } : {}),
          requestId: crypto.randomUUID(),
        });
        return { message: r.message, hostId: r.hostId };
      },
    };
  };

  const runCommand = (box: string, cmd: string, timeoutSeconds: number): DialogSpec => {
    const b = (data?.boxes.items ?? []).find((x) => x.id === box);
    return {
      title: `Run on ${b?.name ?? box}`,
      description: (
        <>
          <p>
            The command runs as <code className="font-mono">agent</code> with <code className="font-mono">bash -lc</code>; output is returned when it exits (max 600 s).
          </p>
          {b && b.state !== "running" ? <p className="font-medium">This box is {b.state}; running wakes it.</p> : null}
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-secondary/40 px-2 py-1 font-mono text-xs text-foreground">{cmd}</pre>
        </>
      ),
      confirmLabel: "Run command",
      fields: [],
      run: async () => {
        setExecResult(await rpc.call("orble_exec", { box, cmd, timeoutSeconds }));
        return { message: "" };
      },
    };
  };

  const onBoxAction = (action: BoxAction, b: BoxDto) => {
    if (action === "snapshot") open(snapshot(b));
    else if (action === "rename") open(rename(b));
    else if (action === "resize") open(resize(b));
    else if (action === "delete") open(deleteBox(b));
    else if (action === "fork") open(fork(b));
    else if (action === "ports") void ports(b);
    else if (action === "egress") open(egress(b));
    else open(lifecycle(b, action));
  };

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-6xl px-4 pb-8 pt-3 md:px-5 md:pt-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="max-w-2xl text-sm text-muted-foreground">Orble boxes, snapshots, networks and secrets on this account. Suspend keeps memory; deletes need the name typed. The API key stays on the server.</p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {data ? <span>updated {ago(data.fetchedAt, now)}</span> : null}
            <Button variant="ghost" size="sm" onClick={refetch} disabled={loading} aria-label="Refresh">
              <Icon name="ArrowReloadHorizontal" className={loading ? "size-4 animate-spin" : "size-4"} />
            </Button>
          </div>
        </div>

        {error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="mt-3 rounded-md border border-border bg-secondary/40 px-3 py-2 text-sm">
            {notice.message}
            {notice.hostId ? (
              <>
                {" "}
                <a className="underline underline-offset-4" href={`/settings/machines/${encodeURIComponent(notice.hostId)}`}>
                  Open the new machine
                </a>
              </>
            ) : null}
          </p>
        ) : null}
        {data?.hubWarning ? (
          <div role="alert" className="mt-3 rounded-md border border-destructive px-3 py-2 text-sm text-destructive">
            {data.hubWarning}
          </div>
        ) : null}

        {data === null ? (
          <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
        ) : !data.configured ? (
          <div className="mt-6 rounded-lg border border-dashed border-border px-4 py-6 text-sm">
            <p>{data.setupMessage}</p>
            <p className="mt-2 text-muted-foreground">Settings → Plugins → Orble. Then hand machines the tunnel:</p>
            <pre className="mt-2 overflow-x-auto rounded bg-secondary/50 px-2 py-1 font-mono text-xs">bb settings general defaultMachineAccess orble-tunnel</pre>
          </div>
        ) : (
          <>
            <AccountSection data={data} />
            <BoxesSection data={data} now={now} onAction={onBoxAction} onNew={() => open(createBox())} />
            <SnapshotsSection data={data} now={now} onNewFrom={(s) => open(createBox(s))} onRename={(s) => open(renameSnapshot(s))} onDelete={(s) => open(deleteSnapshot(s))} />
            <NetworksSection
              data={data}
              onNew={() => open(createNetwork())}
              onJoin={(n) => open(joinNetwork(n))}
              onLeave={(n, box, boxName) => open(leaveNetwork(n, box, boxName))}
              onDelete={(n) => open(deleteNetwork(n))}
            />
            <SecretsSection data={data} now={now} onNew={() => open(setSecret())} onEdit={(s) => open(setSecret(s))} onDelete={(s) => open(deleteSecret(s))} />
            <ProjectsSection />
            <ImportSection />
            <RunCommandSection data={data} result={execResult} onRun={(id, cmd, t) => open(runCommand(id, cmd, t))} onClear={() => setExecResult(null)} />
          </>
        )}
      </div>
      <ActionDialog spec={spec} onClose={() => setSpec(null)} onRun={run} />
    </div>
  );
}

/** Sidebar badge: running Orble boxes. */
export function useOrbleBadge(): { count: number; label: string } | null {
  const running = useOrbleRunning();
  return running === null || running === 0 ? null : { count: running, label: `${running} Orble box${running === 1 ? "" : "es"} running` };
}
