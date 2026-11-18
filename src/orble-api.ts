// Minimal Orble REST client (https://orble.tech, the API the `orble` CLI uses).
//
// Orble documents its CLI and MCP server, not this REST API; the routes here are
// the ones the CLI calls (recorded 2026-11-18). The API key goes in
// `Authorization: Bearer` and is never logged. Box names are unique per account
// (a duplicate create returns 409 "that name is taken"), which is what makes
// create retry-safe: there is no Idempotency-Key.

export const DEFAULT_API_URL = "https://orble.tech";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface Box {
  /** Immutable generated id, such as "bqd4". Any route takes it or the alias. */
  name: string;
  /** <name>.<account>.orble.tech */
  hostname: string;
  /** "running" or "suspended" seen live; anything else is treated as in transition. */
  state: string;
  desktop?: boolean;
  vcpus: number;
  mem_mib: number;
  disk_gib: number;
  /** `ssh-ed25519 AAAA… root@<name>`: pinned in known_hosts for every SSH connection. */
  host_key?: string;
  spent_micros?: number;
  created_at?: string;
  last_active_at?: string;
  /** The name chosen at create or rename. */
  alias?: string;
  alias_hostname?: string;
  /** Outbound rules; absent or null when the box may reach anything. */
  egress?: Egress | null;
  /** Snapshot the box was made from. */
  snapshot?: string | null;
  forked_from?: string;
}

export interface Snapshot {
  name: string;
  /** Source box id; empty for Orble's gallery images. */
  box: string;
  /** Set by a rename; the original name keeps working. */
  alias?: string;
  state: string;
  vcpus: number;
  mem_mib: number;
  disk_bytes: number;
  created_at?: string;
  gallery?: boolean;
  about?: string;
}

export interface Me {
  email: string;
  slug: string;
  domain: string;
  balance_micros: number;
  ssh_keys: number;
  plan: string;
  plan_ends?: string;
}

export interface SshKey {
  name: string;
  public_key: string;
  fingerprint: string;
}

export interface Secret {
  name: string;
  hosts: string[];
  header?: string;
  format?: string;
  intercept?: boolean;
  /** `orbph_…`: what boxes see instead of the value. */
  placeholder?: string;
  all_boxes?: boolean;
  boxes?: string[];
}

/** A box's outbound rules (Pro). block: deny everything `allow` does not name. */
export interface Egress {
  block?: boolean;
  allow?: string[];
  deny?: string[];
}

export interface Network {
  name: string;
  /** Such as 10.240.0.0/24. */
  prefix: string;
  members: { box: string; addr: string }[];
  created_at?: string;
}

/** Body of PUT /v1/secrets/{name}: add or replace. Omitting `boxes` gives the secret to every box. */
export interface SecretInput {
  value: string;
  hosts: string[];
  header?: string;
  format?: string;
  boxes?: string[];
  intercept?: boolean;
}

export interface SharedPort {
  port: number;
  access: "private" | "public";
  url: string;
}

export const SIZES = ["s", "m", "l"] as const;
export type Size = (typeof SIZES)[number];
/** vCPU and memory per size (orble new --help: s 2/4, m 4/8, l 8/16). */
export const SIZE_SPECS: Record<Size, { vcpus: number; memGiB: number }> = { s: { vcpus: 2, memGiB: 4 }, m: { vcpus: 4, memGiB: 8 }, l: { vcpus: 8, memGiB: 16 } };
export const sizeOf = (b: Pick<Box, "vcpus">): Size | null => SIZES.find((s) => SIZE_SPECS[s].vcpus === b.vcpus) ?? null;

export const isRunning = (b: Box) => b.state === "running";
export const isSuspended = (b: Box) => b.state === "suspended";

export class OrbleApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "OrbleApiError";
    this.status = status;
  }
}

export const isNotFound = (err: unknown) => err instanceof OrbleApiError && err.status === 404;
export const isConflict = (err: unknown) => err instanceof OrbleApiError && err.status === 409;

const seg = (s: string) => encodeURIComponent(s);

export class OrbleApi {
  private readonly key: string;
  private readonly fetch: FetchLike;
  readonly baseUrl: string;

  constructor(key: string, fetchImpl: FetchLike, baseUrl = DEFAULT_API_URL) {
    this.key = key;
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** The key, for the SSH proxy (passed to it in the environment, never argv). */
  get token(): string {
    return this.key;
  }

  private async call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json", Accept: "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: signal ?? AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text.trim().slice(0, 300);
      try {
        const j = JSON.parse(text) as { error?: unknown };
        if (typeof j.error === "string") message = j.error;
      } catch {
        // plain-text error (the router's "404 page not found")
      }
      throw new OrbleApiError(res.status, `Orble ${method} ${path.split("?")[0]}: HTTP ${res.status}${message ? ` ${message}` : ""}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  me(signal?: AbortSignal) {
    return this.call<Me>("GET", "/v1/me", undefined, signal);
  }
  listBoxes(signal?: AbortSignal) {
    return this.call<Box[]>("GET", "/v1/boxes", undefined, signal);
  }
  getBox(box: string, signal?: AbortSignal) {
    return this.call<Box>("GET", `/v1/boxes/${seg(box)}`, undefined, signal);
  }
  /** The box, or null when Orble has no box by that id or alias. */
  async findBox(box: string, signal?: AbortSignal): Promise<Box | null> {
    try {
      return await this.getBox(box, signal);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
  /** Synchronous: the box comes back running (about 0.5 s). 409 when the name is taken. */
  createBox(body: { name?: string; from?: string; size?: Size }, signal?: AbortSignal) {
    return this.call<Box>("POST", "/v1/boxes", body, signal);
  }
  deleteBox(box: string, signal?: AbortSignal) {
    return this.call<{ ok: boolean }>("DELETE", `/v1/boxes/${seg(box)}`, undefined, signal);
  }
  suspend(box: string, signal?: AbortSignal) {
    return this.call<Box>("POST", `/v1/boxes/${seg(box)}/suspend`, {}, signal);
  }
  resume(box: string, signal?: AbortSignal) {
    return this.call<Box>("POST", `/v1/boxes/${seg(box)}/resume`, {}, signal);
  }
  /** Sets the alias; the id, old alias and hostnames keep working. */
  rename(box: string, name: string, signal?: AbortSignal) {
    return this.call<Box>("POST", `/v1/boxes/${seg(box)}/rename`, { name }, signal);
  }
  /** Restarts the box at the new size: files stay, running programs stop. */
  resize(box: string, size: Size, signal?: AbortSignal) {
    return this.call<Box>("POST", `/v1/boxes/${seg(box)}/resize`, { size }, signal);
  }
  /** Saves disk and running programs; boxes made from it carry on from there. */
  snapshot(box: string, name: string, signal?: AbortSignal) {
    return this.call<Snapshot>("POST", `/v1/boxes/${seg(box)}/snapshot`, { name }, signal);
  }
  listSnapshots(signal?: AbortSignal) {
    return this.call<Snapshot[]>("GET", "/v1/snapshots", undefined, signal);
  }
  deleteSnapshot(name: string, signal?: AbortSignal) {
    return this.call<{ ok: boolean }>("DELETE", `/v1/snapshots/${seg(name)}`, undefined, signal);
  }
  listSshKeys(signal?: AbortSignal) {
    return this.call<SshKey[]>("GET", "/v1/ssh-keys", undefined, signal);
  }
  addSshKey(name: string, publicKey: string, signal?: AbortSignal) {
    return this.call<SshKey>("POST", "/v1/ssh-keys", { name, public_key: publicKey }, signal);
  }
  listSecrets(signal?: AbortSignal) {
    return this.call<Secret[]>("GET", "/v1/secrets", undefined, signal);
  }
  /** New boxes carrying on from this one, programs and all (1 to 10). */
  fork(box: string, count: number, signal?: AbortSignal) {
    return this.call<{ boxes: Box[] }>("POST", `/v1/boxes/${seg(box)}/fork`, { count }, signal);
  }
  renameSnapshot(name: string, newName: string, signal?: AbortSignal) {
    return this.call<Snapshot>("POST", `/v1/snapshots/${seg(name)}/rename`, { name: newName }, signal);
  }
  listPorts(box: string, signal?: AbortSignal) {
    return this.call<SharedPort[]>("GET", `/v1/boxes/${seg(box)}/ports`, undefined, signal);
  }
  sharePort(box: string, port: number, access: "private" | "public", signal?: AbortSignal) {
    return this.call<SharedPort>("PUT", `/v1/boxes/${seg(box)}/ports/${port}`, { access }, signal);
  }
  unsharePort(box: string, port: number, signal?: AbortSignal) {
    return this.call<{ ok: boolean }>("DELETE", `/v1/boxes/${seg(box)}/ports/${port}`, undefined, signal);
  }
  getEgress(box: string, signal?: AbortSignal) {
    return this.call<Egress>("GET", `/v1/boxes/${seg(box)}/egress`, undefined, signal);
  }
  /** Replaces the whole rule set; {} removes every rule. */
  setEgress(box: string, egress: Egress, signal?: AbortSignal) {
    return this.call<Box>("PUT", `/v1/boxes/${seg(box)}/egress`, egress, signal);
  }
  listNetworks(signal?: AbortSignal) {
    return this.call<Network[]>("GET", "/v1/networks", undefined, signal);
  }
  createNetwork(name: string, signal?: AbortSignal) {
    return this.call<Network>("PUT", `/v1/networks/${seg(name)}`, undefined, signal);
  }
  deleteNetwork(name: string, signal?: AbortSignal) {
    return this.call<{ deleted: boolean }>("DELETE", `/v1/networks/${seg(name)}`, undefined, signal);
  }
  joinNetwork(name: string, box: string, signal?: AbortSignal) {
    return this.call<Network>("PUT", `/v1/networks/${seg(name)}/boxes/${seg(box)}`, undefined, signal);
  }
  leaveNetwork(name: string, box: string, signal?: AbortSignal) {
    return this.call<Network>("DELETE", `/v1/networks/${seg(name)}/boxes/${seg(box)}`, undefined, signal);
  }
  /** The value goes to Orble only; boxes see a placeholder. */
  setSecret(name: string, input: SecretInput, signal?: AbortSignal) {
    return this.call<Secret>("PUT", `/v1/secrets/${seg(name)}`, input, signal);
  }
  deleteSecret(name: string, signal?: AbortSignal) {
    return this.call<{ deleted: boolean }>("DELETE", `/v1/secrets/${seg(name)}`, undefined, signal);
  }
}
