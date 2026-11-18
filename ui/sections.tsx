// Presentational sections of the Orble page. Each takes the overview data and
// callbacks; no RPC calls happen here.
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { BoxDto, ExecResultDto, NetworkDto, OverviewDto, SecretDto, SnapshotDto } from "../src/dashboard.ts";
import { ago, bytes, idleText, money, specText, stateBadge, type Tone } from "./format.ts";

const TONE: Record<Tone, string> = {
  ok: "bg-secondary text-foreground",
  busy: "bg-secondary text-muted-foreground",
  idle: "text-muted-foreground",
  warn: "border border-border text-foreground",
  bad: "border border-destructive text-destructive",
};

export function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-xs", TONE[tone])}>
      {children}
    </span>
  );
}

export function SectionFrame({ title, count, error, right, children }: { title: string; count?: number; error?: string | null; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          {title}
          {count !== undefined ? <span className="ml-1.5 text-muted-foreground">{count}</span> : null}
        </h2>
        {right}
      </div>
      {error ? (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm">{value}</div>
      {detail ? <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

export function AccountSection({ data }: { data: OverviewDto }) {
  const a = data.account;
  const boxes = data.boxes.items ?? [];
  const spent = boxes.reduce((n, b) => n + (b.spentUSD ?? 0), 0);
  return (
    <SectionFrame title="Account" error={data.accountError}>
      {a === null ? (
        <Empty>No account data.</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Plan" value={<span className="capitalize">{a.plan}</span>} detail={a.planEnds ? `ends ${new Date(a.planEnds).toLocaleDateString()}` : a.email} />
          <Stat label="Credit" value={money(a.balanceUSD)} detail={a.email} />
          <Stat label="Boxes" value={`${boxes.filter((b) => b.state === "running").length} running / ${boxes.length}`} detail={`${money(spent)} spent by these boxes`} />
          <Stat label="New runners" value={`size ${data.defaults.size}`} detail={data.defaults.snapshot ? `from ${data.defaults.snapshot}` : "from Orble's base image"} />
          <Stat label="Idle suspend" value={idleText(data.defaults.idlePauseSeconds)} detail="bb runners, applied by this plugin" />
        </div>
      )}
    </SectionFrame>
  );
}

export type BoxAction = "suspend" | "resume" | "snapshot" | "rename" | "resize" | "delete" | "fork" | "ports" | "egress";

function ActionButton({ icon, label, onClick, destructive, disabled }: { icon: string; label: string; onClick: () => void; destructive?: boolean; disabled?: boolean }) {
  return (
    <span title={label} className="inline-flex">
      <Button variant="ghost" size="sm" className={cn("h-7 px-1.5", destructive && "text-destructive hover:text-destructive")} onClick={onClick} disabled={disabled} aria-label={label}>
        <Icon name={icon} className="size-4" />
      </Button>
    </span>
  );
}

export function BoxesSection({ data, now, onAction, onNew }: { data: OverviewDto; now: number; onAction: (action: BoxAction, box: BoxDto) => void; onNew: () => void }) {
  const boxes = data.boxes.items;
  return (
    <SectionFrame
      title="Boxes"
      count={boxes?.length}
      error={data.boxes.error}
      right={
        <Button size="sm" variant="outline" onClick={onNew}>
          <Icon name="Plus" className="size-4" />
          New box
        </Button>
      }
    >
      {boxes === null ? (
        <Empty>No box data.</Empty>
      ) : boxes.length === 0 ? (
        <Empty>No boxes on this account.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-normal">Box</th>
                <th className="px-3 py-2 font-normal">State</th>
                <th className="hidden px-3 py-2 font-normal md:table-cell">Size</th>
                <th className="hidden px-3 py-2 font-normal lg:table-cell">Source</th>
                <th className="hidden px-3 py-2 font-normal lg:table-cell">bb machine</th>
                <th className="hidden px-3 py-2 font-normal xl:table-cell">Spent</th>
                <th className="hidden px-3 py-2 font-normal xl:table-cell">Active</th>
                <th className="px-3 py-2 text-right font-normal">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {boxes.map((b) => {
                const s = stateBadge(b.state);
                const running = b.state === "running";
                const suspended = b.state === "suspended";
                const busy = s.tone === "busy";
                return (
                  <tr key={b.id} className="align-middle">
                    <td className="px-3 py-2">
                      <div className="truncate font-medium">{b.name}</div>
                      {b.name !== b.id ? <div className="font-mono text-xs text-muted-foreground">{b.id}</div> : null}
                      {b.egress || b.networks.length ? (
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {b.egress ? (
                            <Badge tone="warn" title={`allow: ${b.egress.allow.join(", ") || "—"}\ndeny: ${b.egress.deny.join(", ") || "—"}`}>
                              {b.egress.block ? `egress blocked · ${b.egress.allow.length} allowed` : `${b.egress.deny.length} denied`}
                            </Badge>
                          ) : null}
                          {b.networks.map((n) => (
                            <Badge key={n} tone="idle" title={`Box network ${n}`}>
                              net {n}
                            </Badge>
                          ))}
                        </div>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <Badge tone={s.tone}>{s.label}</Badge>
                    </td>
                    <td className="hidden whitespace-nowrap px-3 py-2 md:table-cell">
                      <div>
                        {b.size ?? "?"} · {specText(b.vcpus, b.memMiB)}
                      </div>
                      <div className="text-xs text-muted-foreground">{b.diskGiB} GiB disk</div>
                    </td>
                    <td className="hidden px-3 py-2 font-mono text-xs lg:table-cell">{b.snapshot ?? (b.forkedFrom ? `fork of ${b.forkedFrom}` : "base")}</td>
                    <td className="hidden whitespace-nowrap px-3 py-2 lg:table-cell">
                      {b.bbMachine ? (
                        <a className="underline-offset-4 hover:underline" href={`/settings/machines/${encodeURIComponent(b.bbMachine.hostId)}`}>
                          {b.bbMachine.name} <span className="text-xs text-muted-foreground">{b.bbMachine.status}</span>
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="hidden px-3 py-2 text-xs xl:table-cell">{money(b.spentUSD)}</td>
                    <td className="hidden px-3 py-2 text-xs text-muted-foreground xl:table-cell">{ago(b.lastActiveAt, now)}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-0.5">
                        {running && !b.bbMachine ? <ActionButton icon="Pause" label="Suspend (keep memory and processes)" onClick={() => onAction("suspend", b)} disabled={busy} /> : null}
                        {suspended ? <ActionButton icon="Play" label="Resume" onClick={() => onAction("resume", b)} disabled={busy} /> : null}
                        {!busy ? <ActionButton icon="Layers" label="Save snapshot" onClick={() => onAction("snapshot", b)} /> : null}
                        {!busy && !b.bbMachine ? <ActionButton icon="Fork" label="Fork (copies running programs)" onClick={() => onAction("fork", b)} /> : null}
                        {!busy ? <ActionButton icon="Globe" label="Shared ports" onClick={() => onAction("ports", b)} /> : null}
                        {!busy ? <ActionButton icon="Lock" label="Outbound rules (egress)" onClick={() => onAction("egress", b)} /> : null}
                        {!busy && !b.bbMachine ? <ActionButton icon="Edit" label="Rename" onClick={() => onAction("rename", b)} /> : null}
                        {!busy && !b.bbMachine ? <ActionButton icon="Maximize2" label="Resize (restarts the box)" onClick={() => onAction("resize", b)} /> : null}
                        {!busy && !b.bbMachine ? <ActionButton icon="Trash2" label="Delete box" onClick={() => onAction("delete", b)} destructive /> : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionFrame>
  );
}

export function SnapshotsSection({
  data,
  now,
  onNewFrom,
  onRename,
  onDelete,
}: {
  data: OverviewDto;
  now: number;
  onNewFrom: (s: SnapshotDto) => void;
  onRename: (s: SnapshotDto) => void;
  onDelete: (s: SnapshotDto) => void;
}) {
  const snaps = data.snapshots.items;
  return (
    <SectionFrame title="Snapshots" count={snaps?.length} error={data.snapshots.error}>
      {snaps === null ? (
        <Empty>No snapshot data.</Empty>
      ) : snaps.length === 0 ? (
        <Empty>No snapshots on this account.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-normal">Snapshot</th>
                <th className="px-3 py-2 font-normal">State</th>
                <th className="hidden px-3 py-2 font-normal md:table-cell">Source box</th>
                <th className="hidden px-3 py-2 font-normal lg:table-cell">Disk</th>
                <th className="px-3 py-2 font-normal">Created</th>
                <th className="px-3 py-2 text-right font-normal">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {snaps.map((s) => (
                <tr key={s.name}>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{s.label}</span>
                      {s.configured ? <Badge tone="ok" title="New runners are made from this snapshot">runner source</Badge> : null}
                      {s.gallery ? <Badge tone="idle" title="One of Orble's own images">gallery</Badge> : null}
                    </div>
                    {s.label !== s.name ? <div className="font-mono text-xs text-muted-foreground">{s.name}</div> : null}
                    {s.about ? <div className="text-xs text-muted-foreground">{s.about}</div> : null}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={s.state === "ready" ? "ok" : s.state === "failed" ? "bad" : "busy"}>{s.state}</Badge>
                  </td>
                  <td className="hidden px-3 py-2 font-mono text-xs md:table-cell">{s.sourceBox ?? "—"}</td>
                  <td className="hidden px-3 py-2 text-xs lg:table-cell">{s.gallery ? "—" : bytes(s.diskBytes)}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{ago(s.createdAt, now)}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-0.5">
                      <ActionButton icon="Plus" label="New box from this snapshot" onClick={() => onNewFrom(s)} disabled={s.state !== "ready"} />
                      {!s.gallery ? <ActionButton icon="Edit" label="Rename snapshot" onClick={() => onRename(s)} /> : null}
                      {!s.gallery ? <ActionButton icon="Trash2" label="Delete snapshot" onClick={() => onDelete(s)} destructive /> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionFrame>
  );
}

export function NetworksSection({
  data,
  onNew,
  onJoin,
  onLeave,
  onDelete,
}: {
  data: OverviewDto;
  onNew: () => void;
  onJoin: (n: NetworkDto) => void;
  onLeave: (n: NetworkDto, box: string, boxName: string) => void;
  onDelete: (n: NetworkDto) => void;
}) {
  const nets = data.networks.items;
  return (
    <SectionFrame
      title="Box networks"
      count={nets?.length}
      error={data.networks.error}
      right={
        <Button size="sm" variant="outline" onClick={onNew}>
          <Icon name="Plus" className="size-4" />
          New network
        </Button>
      }
    >
      <p className="mb-2 text-xs text-muted-foreground">
        Boxes in a network reach each other on any port at <code className="font-mono">&lt;box&gt;.&lt;network&gt;.internal</code>; a connection to a suspended box wakes it.
        Forks join their source's networks. Up to 10 networks of 50 boxes (Pro).
      </p>
      {nets === null ? (
        <Empty>No network data.</Empty>
      ) : nets.length === 0 ? (
        <Empty>No box networks yet.</Empty>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {nets.map((n) => (
            <div key={n.name} className="rounded-lg border border-border bg-card px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <span className="text-sm font-medium">{n.name}</span> <span className="font-mono text-xs text-muted-foreground">{n.prefix}</span>
                </div>
                <div className="flex gap-0.5">
                  <ActionButton icon="Plus" label={`Add a box to ${n.name}`} onClick={() => onJoin(n)} />
                  <ActionButton icon="Trash2" label={`Delete network ${n.name}`} onClick={() => onDelete(n)} destructive />
                </div>
              </div>
              {n.members.length === 0 ? (
                <div className="mt-1 text-xs text-muted-foreground">No boxes.</div>
              ) : (
                <ul className="mt-1 space-y-0.5 text-xs">
                  {n.members.map((m) => (
                    <li key={m.box} className="flex items-center justify-between gap-2">
                      <span>
                        {m.boxName} <span className="font-mono text-muted-foreground">{m.addr} · {m.box}.{n.name}.internal</span>
                      </span>
                      <ActionButton icon="Minus" label={`Take ${m.boxName} out of ${n.name}`} onClick={() => onLeave(n, m.box, m.boxName)} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </SectionFrame>
  );
}

export function SecretsSection({ data, now, onNew, onEdit, onDelete }: { data: OverviewDto; now: number; onNew: () => void; onEdit: (s: SecretDto) => void; onDelete: (s: SecretDto) => void }) {
  const secrets = data.secrets.items;
  return (
    <SectionFrame
      title="Secrets"
      count={secrets?.length}
      error={data.secrets.error}
      right={
        <Button size="sm" variant="outline" onClick={onNew}>
          <Icon name="Plus" className="size-4" />
          New secret
        </Button>
      }
    >
      <p className="mb-2 text-xs text-muted-foreground">
        Boxes get <code className="font-mono">$NAME</code> as a placeholder; requests to <code className="font-mono">$NAME_URL/&lt;path&gt;</code> reach the first host with the real
        value added on the way out (with intercept, direct requests that send $NAME do too). Values and placeholders are never shown here. Pro; up to 50 secrets, HTTP headers only.
      </p>
      {secrets === null ? (
        <Empty>No secret data.</Empty>
      ) : secrets.length === 0 ? (
        <Empty>No secrets yet.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-normal">Name</th>
                <th className="px-3 py-2 font-normal">Hosts</th>
                <th className="hidden px-3 py-2 font-normal md:table-cell">Header</th>
                <th className="hidden px-3 py-2 font-normal lg:table-cell">Boxes</th>
                <th className="hidden px-3 py-2 font-normal xl:table-cell">Last used</th>
                <th className="px-3 py-2 text-right font-normal">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {secrets.map((s) => (
                <tr key={s.name}>
                  <td className="px-3 py-2 font-mono text-xs">
                    {s.name}
                    {s.intercept ? (
                      <span className="ml-1.5">
                        <Badge tone="idle" title="Also filled in on direct HTTPS requests to its hosts that send $NAME in the header">
                          intercept
                        </Badge>
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-xs">{s.hosts.join(", ")}</td>
                  <td className="hidden px-3 py-2 font-mono text-xs md:table-cell">{s.header ? `${s.header}: ${s.format ?? "{}"}` : "—"}</td>
                  <td className="hidden px-3 py-2 text-xs lg:table-cell">{s.allBoxes ? "all boxes" : s.boxes.map((b) => b.name).join(", ") || "—"}</td>
                  <td className="hidden px-3 py-2 text-xs text-muted-foreground xl:table-cell">{ago(s.lastUsedAt, now)}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-0.5">
                      <ActionButton icon="Edit" label="Replace value or settings" onClick={() => onEdit(s)} />
                      <ActionButton icon="Trash2" label="Delete secret" onClick={() => onDelete(s)} destructive />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionFrame>
  );
}

export function RunCommandSection({ data, result, onRun, onClear }: { data: OverviewDto; result: ExecResultDto | null; onRun: (box: string, cmd: string, timeoutSeconds: number) => void; onClear: () => void }) {
  const boxes = data.boxes.items ?? [];
  const [boxId, setBoxId] = useState("");
  const [cmd, setCmd] = useState("");
  const [timeout, setTimeoutText] = useState("60");
  const selected = boxId || boxes[0]?.id || "";
  const box = boxes.find((b) => b.id === selected);
  return (
    <SectionFrame title="Run a command" error={null}>
      <div className="rounded-lg border border-border bg-card p-3">
        <p className="mb-2 text-xs text-muted-foreground">
          Runs <code className="font-mono">bash -lc</code> on the box as <code className="font-mono">agent</code>, over SSH from this hub. A suspended box wakes up. Orble keys and Secret
          placeholders are redacted from the output; other secrets are not detected.
        </p>
        {boxes.length === 0 ? (
          <Empty>No boxes to run on.</Empty>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Box"
                className="h-9 min-w-48 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={selected}
                onChange={(e) => setBoxId(e.target.value)}
              >
                {boxes.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} · {b.state}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                timeout
                <Input className="h-8 w-16 px-2 py-0" type="number" min={1} max={600} value={timeout} onChange={(e) => setTimeoutText(e.target.value)} />s
              </label>
              <Button size="sm" onClick={() => onRun(selected, cmd, Math.max(1, Math.min(600, Number(timeout) || 60)))} disabled={cmd.trim() === "" || !box}>
                <Icon name="Terminal" className="size-4" />
                Run…
              </Button>
            </div>
            <textarea
              aria-label="Command"
              className="min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder={"e.g. uname -a\nls -la ~"}
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
            />
          </div>
        )}
        {result ? (
          <div className="mt-3 rounded-md border border-border">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
              <Badge tone={result.exitCode === 0 ? "ok" : "bad"}>exit {result.exitCode}</Badge>
              <span className="text-muted-foreground">{result.boxName}</span>
              {result.timedOut ? <Badge tone="bad">timed out</Badge> : null}
              {result.truncated ? <Badge tone="warn">output truncated</Badge> : null}
              {result.woke ? <Badge tone="warn">woke the box</Badge> : null}
              {result.redacted > 0 ? <Badge tone="warn">{result.redacted} secret{result.redacted === 1 ? "" : "s"} redacted</Badge> : null}
              <Button variant="ghost" size="sm" className="ml-auto h-6 px-1.5 text-xs" onClick={onClear}>
                Clear
              </Button>
            </div>
            {result.output ? (
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs">{result.output}</pre>
            ) : (
              <div className="px-3 py-2 text-xs text-muted-foreground">No output.</div>
            )}
          </div>
        ) : null}
      </div>
    </SectionFrame>
  );
}
