// Everything SSH: the hub's key, the ProxyCommand that reaches a box through
// Orble's /v1/connect, the MachineExecutor bb's bootstrap uses, and the reverse
// tunnel that gives the box's bb daemon a loopback URL for the hub.
//
// Orble boxes have no public SSH on IPv4: the orble CLI's `proxy` subcommand
// opens `GET /v1/connect?host=<box>.<account>.orble.tech&port=22` with
// `Upgrade: sbx-tcp`, the API key as Bearer, and the client's SSH banner in an
// `SSH-Hello` header, then pipes the raw TCP stream. PROXY_JS does the same in
// node, so the hub needs no orble CLI. Orble's sshd allows remote forwarding,
// so one `ssh -N -R` per box is the whole tunnel (no chisel, no relay).
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MachineExecutor, MachineExecutorRequest } from "@get-bb/plugin-sdk";
import type { Box, OrbleApi } from "./orble-api.ts";

/** ssh ProxyCommand program (node). Env: ORBLE_TOKEN, ORBLE_API_URL. Args: host port. */
export const PROXY_JS = String.raw`
const { request } = require(process.env.ORBLE_API_URL.startsWith("http:") ? "node:http" : "node:https");
const [host, port] = process.argv.slice(2);
let buf = Buffer.alloc(0);
const onData = (d) => {
  buf = Buffer.concat([buf, d]);
  const nl = buf.indexOf(10);
  if (nl < 0) return;
  process.stdin.off("data", onData);
  process.stdin.pause();
  const hello = buf.subarray(0, nl).toString().replace(/\r$/, "");
  const rest = buf.subarray(nl + 1);
  const u = new URL("/v1/connect?host=" + encodeURIComponent(host) + "&port=" + encodeURIComponent(port), process.env.ORBLE_API_URL);
  const req = request(u, { headers: { Authorization: "Bearer " + process.env.ORBLE_TOKEN, "SSH-Hello": hello, Connection: "Upgrade", Upgrade: "sbx-tcp" } });
  req.on("upgrade", (_res, sock, head) => {
    if (head.length) process.stdout.write(head);
    if (rest.length) sock.write(rest);
    sock.pipe(process.stdout);
    process.stdin.pipe(sock);
    process.stdin.resume();
    sock.on("close", () => process.exit(0));
    sock.on("error", () => process.exit(1));
  });
  req.on("response", (res) => {
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => { process.stderr.write("orble connect: HTTP " + res.statusCode + " " + b.trim().slice(0, 200) + "\n"); process.exit(1); });
  });
  req.on("error", (e) => { process.stderr.write("orble connect: " + e.message + "\n"); process.exit(1); });
  req.end();
};
process.stdin.on("data", onData);
`;

export const MAX_COMMAND_MS = 3_600_000;

/** POSIX single-quote each argument. */
export function shellQuote(argv: string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/** Strip API keys and Secret placeholders from anything that may reach a log. */
export function redact(s: string): string {
  return s.replace(/\borb(le|ph)_[A-Za-z0-9_-]{6,}/g, (_m, k: string) => (k === "le" ? "[redacted Orble key]" : "[redacted Secret placeholder]"));
}

export interface SshOptions {
  /** Plugin-private directory for the key, known_hosts files and the proxy script. */
  dir: string;
  log: (m: string) => void;
}

/** The hub's SSH identity and per-box connection files. */
export class SshClient {
  private readonly o: SshOptions;
  readonly keyPath: string;
  private readonly proxyPath: string;
  /** Public keys already confirmed on the Orble account in this process. */
  private registered = false;

  constructor(o: SshOptions) {
    this.o = o;
    mkdirSync(join(o.dir, "ssh"), { recursive: true, mode: 0o700 });
    chmodSync(o.dir, 0o700);
    this.keyPath = join(o.dir, "ssh", "id_ed25519");
    this.proxyPath = join(o.dir, "orble-proxy.cjs");
    writePrivate(this.proxyPath, PROXY_JS);
  }

  /** One Ed25519 key for this hub, registered on the Orble account once. */
  async ensureKey(api: OrbleApi, signal?: AbortSignal): Promise<void> {
    if (!existsSync(this.keyPath) || !existsSync(`${this.keyPath}.pub`)) {
      rmSync(this.keyPath, { force: true });
      rmSync(`${this.keyPath}.pub`, { force: true });
      const r = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "bb-plugin-orble", "-f", this.keyPath], { stdio: "ignore" });
      if (r.status !== 0) throw new Error("ssh-keygen failed (is OpenSSH installed on the bb server?)");
      this.registered = false;
    }
    // ssh refuses a key others can read; an inherited default ACL can leave it 0640.
    chmodSync(this.keyPath, 0o600);
    if (this.registered) return;
    const pub = readFileSync(`${this.keyPath}.pub`, "utf8").trim();
    const body = pub.split(/\s+/).slice(0, 2).join(" ");
    const keys = await api.listSshKeys(signal);
    if (!keys.some((k) => k.public_key.split(/\s+/).slice(0, 2).join(" ") === body)) {
      await api.addSshKey("bb-plugin-orble", pub, signal);
      this.o.log("registered this hub's SSH key on the Orble account (name bb-plugin-orble)");
    }
    this.registered = true;
  }

  /** Pin the box's host key; returns the file. A box without one is refused. */
  knownHosts(box: Box): string {
    if (!box.host_key) throw new Error(`Orble box ${box.name} reported no SSH host key`);
    const path = join(this.o.dir, "ssh", `${safe(box.name)}.known_hosts`);
    const want = `${box.hostname} ${box.host_key.split(/\s+/).slice(0, 2).join(" ")}\n`;
    if (!existsSync(path) || readFileSync(path, "utf8") !== want) writePrivate(path, want);
    return path;
  }

  forget(boxName: string): void {
    rmSync(join(this.o.dir, "ssh", `${safe(boxName)}.known_hosts`), { force: true });
  }

  /** ssh argv (without the remote command) and the environment for the proxy. */
  args(api: OrbleApi, box: Box, extra: string[] = []): { argv: string[]; env: Record<string, string> } {
    const kh = this.knownHosts(box);
    const argv = [
      "-F", "/dev/null",
      "-i", this.keyPath,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${kh}`,
      "-o", `ProxyCommand=${shellQuote([process.execPath, this.proxyPath])} %h %p`,
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=4",
      "-o", "ConnectTimeout=30",
      ...extra,
      `agent@${box.hostname}`,
    ];
    // The key travels in the environment, not argv (argv is visible in ps).
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", ORBLE_TOKEN: api.token, ORBLE_API_URL: api.baseUrl };
    // Under the bb desktop app process.execPath is Electron, which runs the proxy as Node only with this set
    // (without it: "The platform failed to initialize").
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
    return { argv, env };
  }
}

/**
 * bb's MachineExecutor over SSH: argv is quoted into one remote command (run
 * by the box user's login shell), stdin is piped, output streams as it comes.
 */
export class SshExecutor implements MachineExecutor {
  private readonly ssh: SshClient;
  private readonly api: OrbleApi;
  private readonly box: () => Promise<Box>;

  constructor(ssh: SshClient, api: OrbleApi, box: () => Promise<Box>) {
    this.ssh = ssh;
    this.api = api;
    this.box = box;
  }

  async exec(req: MachineExecutorRequest): Promise<{ exitCode: number }> {
    req.signal.throwIfAborted();
    if (req.command.length === 0) throw new Error("empty command");
    await this.ssh.ensureKey(this.api, req.signal);
    const { argv, env } = this.ssh.args(this.api, await this.box());
    return new Promise((resolve, reject) => {
      const child = spawn("ssh", [...argv, "--", shellQuote(req.command)], { stdio: ["pipe", "pipe", "pipe"], env });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, Math.min(MAX_COMMAND_MS, Math.max(1000, req.timeoutMs)));
      const abort = () => child.kill("SIGTERM");
      req.signal.addEventListener("abort", abort, { once: true });
      let sshErr = "";
      child.stdout.on("data", (d: Buffer) => req.onOutput(d.toString()));
      child.stderr.on("data", (d: Buffer) => {
        const t = d.toString();
        sshErr = (sshErr + t).slice(-400);
        req.onOutput(t);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(req.stdin);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        req.signal.removeEventListener("abort", abort);
        if (req.signal.aborted) return reject(req.signal.reason);
        if (timedOut) return resolve({ exitCode: 124 });
        // 255 is ssh's own failure (connect, auth, host key): say why.
        if (code === 255 && /orble connect|Permission denied|Host key verification|Connection closed|timed out/i.test(sshErr)) {
          return reject(new Error(`SSH to the Orble box failed: ${redact(sshErr.trim().split("\n").slice(-2).join(" | "))}`));
        }
        resolve({ exitCode: code ?? 1 });
      });
    });
  }
}

/** Run a script (as `bash -c`) and collect its output; throws on a non-zero exit. */
export async function runScript(executor: MachineExecutor, script: string, signal: AbortSignal, opts: { stdin?: string; timeoutMs?: number; what?: string } = {}): Promise<string> {
  let out = "";
  const { exitCode } = await executor.exec({
    command: ["bash", "-c", script],
    stdin: opts.stdin ?? "",
    timeoutMs: opts.timeoutMs ?? 120_000,
    signal,
    onOutput: (c) => {
      out += c;
    },
  });
  if (exitCode !== 0) throw new Error(`${opts.what ?? "box script"} failed (exit ${exitCode}): ${redact(out.trim().split("\n").slice(-3).join(" | ")).slice(0, 400)}`);
  return out;
}

export interface TunnelOptions {
  ssh: SshClient;
  hubPort: () => number;
  boxHubPort: number;
  log: (m: string) => void;
}

/** One `ssh -N -R 127.0.0.1:<boxHubPort>:127.0.0.1:<hubPort>` per running box. */
export class TunnelManager {
  private readonly o: TunnelOptions;
  private readonly tunnels = new Map<string, { child: ChildProcess; stopping: boolean }>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(o: TunnelOptions) {
    this.o = o;
  }

  healthy(boxName: string): boolean {
    const t = this.tunnels.get(boxName);
    return !!t && t.child.exitCode === null && t.child.signalCode === null;
  }

  active(): string[] {
    return [...this.tunnels.keys()];
  }

  /** Start (or repair) the tunnel for a running box. Idempotent; one at a time per box. */
  ensure(api: OrbleApi, box: Box, signal?: AbortSignal): Promise<void> {
    if (this.healthy(box.name)) return Promise.resolve();
    const running = this.pending.get(box.name);
    if (running) return running;
    const p = this.open(api, box, signal).finally(() => this.pending.delete(box.name));
    this.pending.set(box.name, p);
    return p;
  }

  private async open(api: OrbleApi, box: Box, signal?: AbortSignal): Promise<void> {
    this.kill(box.name);
    await this.o.ssh.ensureKey(api, signal);
    const { argv, env } = this.o.ssh.args(api, box, ["-N", "-o", "ExitOnForwardFailure=yes", "-R", `127.0.0.1:${this.o.boxHubPort}:127.0.0.1:${this.o.hubPort()}`]);
    const child = spawn("ssh", argv, { stdio: ["ignore", "ignore", "pipe"], env });
    const t = { child, stopping: false };
    this.tunnels.set(box.name, t);
    let tail = "";
    child.stderr?.on("data", (d: Buffer) => {
      tail = (tail + d.toString()).slice(-600);
    });
    child.on("exit", (code, sig) => {
      if (!t.stopping) this.o.log(`tunnel ${box.name}: ssh exited (${sig ?? code}); last output: ${redact(tail.trim().split("\n").slice(-2).join(" | "))}`);
    });
    // ssh -N gives no "ready" signal; a forward failure exits within seconds.
    await new Promise((r) => setTimeout(r, 2500));
    if (!this.healthy(box.name)) throw new Error(`Reverse tunnel to ${box.name} failed: ${redact(tail.trim().split("\n").slice(-2).join(" | ")) || "ssh exited"}`);
    this.o.log(`tunnel ${box.name}: box 127.0.0.1:${this.o.boxHubPort} → hub 127.0.0.1:${this.o.hubPort()}`);
  }

  stop(boxName: string): void {
    this.kill(boxName);
    this.tunnels.delete(boxName);
  }

  stopAll(): void {
    for (const id of this.active()) this.stop(id);
  }

  private kill(boxName: string) {
    const t = this.tunnels.get(boxName);
    if (!t) return;
    t.stopping = true;
    t.child.kill("SIGTERM");
  }
}

function safe(id: string) {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

function writePrivate(path: string, content: string) {
  writeFileSync(`${path}.tmp`, content, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
