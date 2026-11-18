// Inputs control for the Orble machine provider: the New Thread / machine
// picker can carry a project, a snapshot override, a size and a box network. All are
// non-secret and persisted with the machine selection; the plugin settings
// hold the defaults and the API key.
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import type { JsonValue, PluginMachineProviderInputsProps } from "@get-bb/plugin-sdk/app";
import { Input } from "@/components/ui/input";
import { NoProjectsHint } from "./NoProjectsHint.tsx";
import { useProjectNames } from "./useOrble.ts";

const SIZES = [
  { value: "", label: "Plugin default" },
  { value: "s", label: "s · 2 vCPU · 4 GiB" },
  { value: "m", label: "m · 4 vCPU · 8 GiB" },
  { value: "l", label: "l · 8 vCPU · 16 GiB" },
];

export function OrbleMachineInputs({ value, onChange }: PluginMachineProviderInputsProps) {
  const v = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const [snapshot, setSnapshot] = useState(typeof v.snapshot === "string" ? v.snapshot : "");
  const [size, setSize] = useState(typeof v.size === "string" ? v.size : "");
  const [project, setProject] = useState(typeof v.project === "string" ? v.project : "");
  const [network, setNetwork] = useState(typeof v.network === "string" ? v.network : "");
  const projectNames = useProjectNames();
  const change = useRef(onChange);
  change.current = onChange;

  useEffect(() => {
    const next: Record<string, unknown> = {};
    if (snapshot.trim() !== "") next.snapshot = snapshot.trim();
    if (size !== "") next.size = size;
    if (project !== "") next.project = project;
    const net = network.trim();
    if (net !== "" && !/^[a-z0-9][a-z0-9-]{0,30}$/.test(net)) {
      change.current({ status: "blocked", reason: "Box network: lowercase letters, digits and dashes" });
      return;
    }
    if (net !== "") next.network = net;
    change.current({ status: "ready", value: next as JsonValue });
  }, [snapshot, size, project, network]);

  // Inline in the New Thread toolbar: one small trigger that opens a panel.
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const summary = [project !== "" ? project : "no repos", snapshot.trim() !== "" ? "snapshot" : null, size !== "" ? size : null, network.trim() !== "" ? `net ${network.trim()}` : null].filter(Boolean).join(" · ");
  const select = "h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        className="flex h-8 max-w-56 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
        aria-expanded={open}
        title="Orble runner options: repos to clone, snapshot, size"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="truncate">Repos: {summary}</span>
        <Icon name="ChevronDown" className="size-3.5 shrink-0" />
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-50 mt-1 w-80 space-y-3 rounded-lg border border-border bg-popover p-3 text-sm text-popover-foreground shadow-lg">
          <label className="flex flex-col gap-1">
            <span>Repos (Orble project)</span>
            <select className={select} value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">None</option>
              {projectNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
              {project !== "" && !projectNames.includes(project) ? <option value={project}>{project}</option> : null}
            </select>
            {projectNames.length === 0 ? (
              <NoProjectsHint link />
            ) : (
              <span className="text-xs text-muted-foreground">Clones each repo of the project at its branch into ~/workspace/repos and registers it as a bb project source on the new runner.</span>
            )}
          </label>
          <label className="flex flex-col gap-1">
            <span>Snapshot (optional)</span>
            <Input className="h-8" autoComplete="off" placeholder="snapshot name (empty: the plugin's default)" value={snapshot} onChange={(e) => setSnapshot(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span>Size</span>
            <select className={select} value={size} onChange={(e) => setSize(e.target.value)}>
              {SIZES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>Box network (optional)</span>
            <Input className="h-8" autoComplete="off" placeholder="network name (must exist)" value={network} onChange={(e) => setNetwork(e.target.value)} />
          </label>
        </div>
      ) : null}
    </div>
  );
}
