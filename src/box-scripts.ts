// Shell scripts run on the Orble box over SSH (as its user, agent).
// Secrets never come from the hub; scripts print names, counts and booleans.
//
// Orble boxes run tini as PID 1, not systemd: there is no user bus, so bb's
// installer starts the host daemon with nohup instead of a unit. These scripts
// therefore find daemons by process, not by unit.

/** Matches bb's host-daemon processes on the box (the [p] keeps pgrep from matching itself). */
const DAEMON_RE = "bb-ap[p](\\.js)? host-daemon";

/**
 * A new box must not carry a bb runner identity (one made from a snapshot or
 * fork of another runner would impersonate it, and forks even carry its
 * running daemon). Kills daemons and removes ~/.bb-machines.
 * Last line: `identity=clean removed=<n>`.
 */
export function identityResetScript(): string {
  return `set -uo pipefail
n=0
pids=$(pgrep -u "$(id -u)" -f '${DAEMON_RE}' || true)
[ -n "$pids" ] && { kill -KILL $pids 2>/dev/null; n=$((n + 1)); }
[ -d "$HOME/.bb-machines" ] && { rm -rf "$HOME/.bb-machines"; n=$((n + 1)); }
echo "identity=clean removed=$n"
`;
}

/**
 * Stop the bb daemon before a pause and before re-enrolling after one, so the
 * resumed box does not keep a stale daemon holding its port (bootstrap starts
 * a fresh one). Last line: `daemon=stopped killed=<n>`.
 */
export function daemonStopScript(): string {
  return `set -uo pipefail
stale() { pgrep -u "$(id -u)" -f '${DAEMON_RE}' || true; }
pids=$(stale)
killed=$(printf '%s' "$pids" | grep -c . || true)
[ -n "$pids" ] && kill -TERM $pids 2>/dev/null
for i in $(seq 1 20); do [ -z "$(stale)" ] && break; sleep 0.5; done
left=$(stale); [ -n "$left" ] && kill -KILL $left 2>/dev/null
echo "daemon=stopped killed=$killed"
`;
}

/**
 * After a suspend, outbound TCP connections that were open are dead, but
 * clients reuse them (claude-code hung on a stale keep-alive socket on
 * InstaBox, and would here). Destroy outbound HTTP(S) connections so clients reconnect.
 * Best effort (passwordless sudo). Last line: `stale-conns closed=<n> left=<n>`.
 */
export function staleConnectionsScript(): string {
  return `set -uo pipefail
count() { ss -Htn state established '( dport = :443 or dport = :80 )' 2>/dev/null | wc -l; }
before=$(count)
sudo -n ss -K state established '( dport = :443 or dport = :80 )' >/dev/null 2>&1
after=$(count)
echo "stale-conns closed=$((before - after)) left=$after"
`;
}

/** An OpenAI-compatible provider OpenCode should offer. Never holds a key: only the env var name. */
export interface OpencodeProvider {
  id: string;
  name?: string;
  baseURL: string;
  /** Env var (in the bb daemon env on the machine) that holds this provider's key. */
  keyEnv: string;
}

/** Defaults for the `opencodeProviders` setting. A provider whose key env is unset is skipped. */
export const DEFAULT_OPENCODE_PROVIDERS: OpencodeProvider[] = [
  { id: "zai-coding-plan", name: "Z.AI Coding Plan", baseURL: "https://api.z.ai/api/coding/paas/v4", keyEnv: "ZAI_API_KEY" },
  { id: "zro", name: "ZRO", baseURL: "https://zro.moonmath.ai/v1", keyEnv: "ZRO_API_KEY" },
  { id: "coralbricks", name: "Coral Bricks", baseURL: "https://inference.coralbricks.ai/v1", keyEnv: "CORALBRICKS_API_KEY" },
  { id: "neuralwatt", name: "Neuralwatt", baseURL: "https://api.neuralwatt.com/v1", keyEnv: "NEURALWATT_API_KEY" },
  { id: "deepseek", name: "DeepSeek", baseURL: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY" },
  { id: "hypercharm", name: "HyperCharm", baseURL: "https://hyper.charm.land/v1", keyEnv: "HYPERCHARM_API_KEY" },
  { id: "singularity", name: "Singularity", baseURL: "https://api.singularityapi.dev/v1", keyEnv: "SINGULARITY_API_KEY" },
  { id: "runinfra", name: "RunInfra", baseURL: "https://api.runinfra.ai/v1", keyEnv: "RUNINFRA_GATEWAY_KEY" },
];

/** Parse and check the `opencodeProviders` setting (JSON array). Empty: the defaults. */
export function parseOpencodeProviders(raw: string): OpencodeProvider[] {
  if (!raw.trim()) return DEFAULT_OPENCODE_PROVIDERS;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error("opencodeProviders must be a JSON array");
  }
  if (!Array.isArray(v)) throw new Error("opencodeProviders must be a JSON array");
  return v.map((x, i) => {
    const p = x as Partial<OpencodeProvider>;
    if (typeof p.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(p.id)) throw new Error(`opencodeProviders[${i}].id: lowercase letters, digits, _ and -`);
    if (typeof p.keyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.keyEnv)) throw new Error(`opencodeProviders[${i}].keyEnv must be an env var name`);
    let u: URL;
    try {
      u = new URL(String(p.baseURL));
    } catch {
      throw new Error(`opencodeProviders[${i}].baseURL is not a URL`);
    }
    if (u.protocol !== "https:" || u.username || u.password || u.search) throw new Error(`opencodeProviders[${i}].baseURL: https, no credentials or query`);
    return { id: p.id, name: typeof p.name === "string" ? p.name : p.id, baseURL: u.toString().replace(/\/+$/, ""), keyEnv: p.keyEnv };
  });
}

/** Files an Orble image writes itself that the plugin may take over (none known). */
export const OPENCODE_TEMPLATE_HASHES: string[] = [];

/** Marks a provider entry as written by this plugin (so a user's own opencode.json is never overwritten). */
export const OPENCODE_MARK = "(bb-plugin-orble)";

/**
 * Node program run on the machine. stdin: JSON array of OpencodeProvider.
 * For each provider whose key env is set, GET <baseURL>/models with that key
 * and build an @ai-sdk/openai-compatible provider entry from the returned ids
 * (apiKey stays "{env:NAME}", so no secret is written). A failed fetch keeps
 * that provider's models from the previous file. Leaves a user-owned file alone.
 * Last lines: `opencode-config=written|unchanged|kept-user-file …` and
 * `pi-models=written|unchanged|kept-user-file …`.
 */
export const OPENCODE_SYNC_JS = String.raw`
const fs = require("node:fs"), path = require("node:path");
const home = process.env.HOME;
const file = process.env.OPENCODE_CONFIG_FILE || path.join(home, ".config/opencode/opencode.json");
const piFile = path.join(home, ".pi/agent/models.json");
const MARK = ${JSON.stringify(OPENCODE_MARK)};
const providers = JSON.parse(fs.readFileSync(0, "utf8"));
// Keys: Orble's Secret placeholders. Boxes get them from /etc/environment
// (pam_env), so they are already in this process's environment; the file is
// read as well in case a shell started without pam_env (parsed, never sourced).
const env = { ...process.env };
try {
  for (const line of fs.readFileSync("/etc/orble/secrets.env", "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !env[line.slice(0, i)]) env[line.slice(0, i)] = line.slice(i + 1);
  }
} catch {}
// Ownership: the sha256 of exactly what this plugin last wrote. The config is
// ours only if it is missing, matches that hash, is a file the Orble
// image itself writes (TEMPLATE_HASHES), or (older plugin) carries MARK.
const TEMPLATE_HASHES = ${JSON.stringify(OPENCODE_TEMPLATE_HASHES)};
const crypto = require("node:crypto");
const ownFile = path.join(process.env.HOME, ".config/bb-orble/opencode.owned");
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
let raw = null, prev = null, owned = null;
try { raw = fs.readFileSync(file, "utf8"); } catch {}
try { prev = JSON.parse(raw); } catch {}
try { owned = fs.readFileSync(ownFile, "utf8").trim(); } catch {}
const ours = raw === null || (owned !== null && owned === sha(raw)) || (raw !== null && TEMPLATE_HASHES.includes(sha(raw))) ||
  (owned === null && prev !== null && Object.values(prev.provider || {}).some((p) => String(p && p.name).endsWith(MARK)));
const report = [], piReport = [];
const piOwnFile = path.join(home, ".config/bb-orble/pi-models.owned");
let piRaw = null, piPrev = null, piOwned = null;
try { piRaw = fs.readFileSync(piFile, "utf8"); } catch {}
try { piPrev = JSON.parse(piRaw); } catch {}
try { piOwned = fs.readFileSync(piOwnFile, "utf8").trim(); } catch {}
const piOurs = piRaw === null || (piOwned !== null && piOwned === sha(piRaw));
// Keep everything else in the file (the template's MCP servers, autoupdate); only "provider" is ours.
const { provider: _oldProvider, ...base } = ours && prev && typeof prev === "object" ? prev : {};
const out = { $schema: "https://opencode.ai/config.json", ...base, provider: {} };
const piOut = { providers: {} };
function save(f, text, own, current, mode) {
  let state = "unchanged";
  if (current !== text) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp" + process.pid;
    fs.writeFileSync(tmp, text, { mode });
    fs.renameSync(tmp, f);
    state = "written";
  }
  fs.mkdirSync(path.dirname(own), { recursive: true });
  const hash = sha(text) + "\n";
  let have = null;
  try { have = fs.readFileSync(own, "utf8"); } catch {}
  if (have !== hash) fs.writeFileSync(own, hash, { mode: 0o600 });
  return state;
}
(async () => {
  for (const p of providers) {
    const piId = p.id === "zai-coding-plan" ? "zai" : p.id;
    const key = env[p.keyEnv];
    if (!key) { report.push(p.id + ":skip-no-key"); piReport.push(p.id + ":skip-no-key"); continue; }
    let ids = null;
    try {
      const r = await fetch(p.baseURL + "/models", { headers: { Authorization: "Bearer " + key }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error("http " + r.status);
      const j = await r.json();
      ids = [...new Set((j.data || j.models || []).map((m) => (typeof m === "string" ? m : m && m.id)).filter((x) => typeof x === "string" && x))].sort();
      if (!ids.length) throw new Error("empty");
    } catch (e) {
      const old = prev && prev.provider && prev.provider[p.id] && prev.provider[p.id].models;
      const oldPi = piPrev && piPrev.providers && piPrev.providers[piId] && piPrev.providers[piId].models;
      if (old && Object.keys(old).length) {
        // Keep the last good list rather than dropping the provider on a transient failure.
        out.provider[p.id] = prev.provider[p.id];
        report.push(p.id + ":" + Object.keys(old).length + "-kept(" + e.message + ")");
        if (Array.isArray(oldPi) && oldPi.length) {
          piOut.providers[piId] = piPrev.providers[piId];
          piReport.push(piId + ":" + oldPi.length + "-kept(" + e.message + ")");
        } else {
          piReport.push(piId + ":skip-" + String(e.message).replace(/\s+/g, "-"));
        }
      } else {
        report.push(p.id + ":skip-" + String(e.message).replace(/\s+/g, "-"));
        piReport.push(p.id + ":skip-" + String(e.message).replace(/\s+/g, "-"));
      }
      continue;
    }
    if (!report.some((x) => x.startsWith(p.id + ":"))) report.push(p.id + ":" + ids.length);
    out.provider[p.id] = {
      npm: "@ai-sdk/openai-compatible",
      name: (p.name || p.id) + " " + MARK,
      options: { baseURL: p.baseURL, apiKey: "{env:" + p.keyEnv + "}" },
      models: Object.fromEntries(ids.map((id) => [id, { name: id }])),
    };
    const oldPi = piPrev && piPrev.providers && piPrev.providers[piId] && Array.isArray(piPrev.providers[piId].models) ? piPrev.providers[piId].models : [];
    const piModels = ids.map((id) => {
      const old = oldPi.find((m) => m && m.id === id);
      return old ? { ...old, id, name: old.name || id } : { id, name: id };
    });
    piOut.providers[piId] = piId === "zai"
      ? { ...(piPrev && piPrev.providers && piPrev.providers.zai ? piPrev.providers.zai : {}), models: piModels }
      : { baseUrl: p.baseURL, api: "openai-completions", apiKey: "$" + p.keyEnv, models: piModels };
    if (!piReport.some((x) => x.startsWith(piId + ":"))) piReport.push(piId + ":" + piModels.length);
  }
  const ocText = JSON.stringify(out, null, 2) + "\n";
  const piText = JSON.stringify(piOut, null, 2) + "\n";
  const ocState = ours ? save(file, ocText, ownFile, raw, 0o644) : "kept-user-file";
  const piState = piOurs ? save(piFile, piText, piOwnFile, piRaw, 0o600) : "kept-user-file";
  console.log("opencode-config=" + ocState + " " + report.join(" "));
  console.log("pi-models=" + piState + " " + piReport.join(" "));
})().catch((e) => { console.log("agent-config=failed " + e.message); process.exit(1); });
`;

/**
 * Bash wrapper that runs the sync on the machine (keys stay on the box).
 * Run before bb's bootstrap starts the daemon, so it reads the new lists;
 * a daemon already running sees them after its next restart (resume).
 * stdin: providers JSON.
 */
export function opencodeSyncScript(): string {
  if (OPENCODE_SYNC_JS.includes("BB_OPENCODE_SYNC_EOF")) throw new Error("heredoc marker in script");
  return `set -euo pipefail
umask 077
js=$(mktemp)
trap 'rm -f "$js"' EXIT
cat > "$js" <<'BB_OPENCODE_SYNC_EOF'
${OPENCODE_SYNC_JS}
BB_OPENCODE_SYNC_EOF
PATH=$HOME/.local/share/mise/shims:/usr/local/bin:$PATH node "$js"
`;
}

/** Exit 0 when the hub answers /health on the box's loopback end of the tunnel. */
export function hubHealthScript(boxHubPort: number): string {
  return `curl -fsS -m 5 -o /dev/null http://127.0.0.1:${boxHubPort}/health`;
}
