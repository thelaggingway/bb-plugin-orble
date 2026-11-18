import { test } from "node:test";
import assert from "node:assert/strict";
import { type Box, OrbleApi, OrbleApiError } from "../src/orble-api.ts";
import { boxAliasFor, OrbleMachineOps, tunnelGrant } from "../src/provider.ts";
import { createDashboardHandlers, redactText } from "../src/dashboard.ts";
import { shellQuote } from "../src/ssh.ts";

/** A fake Orble account behind the real client, so routes and error mapping are exercised too. */
function fakeOrble(opts: { dropFirstCreateResponse?: boolean } = {}) {
  const boxes = new Map<string, Box>();
  const calls: string[] = [];
  /** Bodies of writes outside /v1/boxes/{b}, keyed by "METHOD path". */
  const bodies = new Map<string, unknown>();
  const networks = new Map<string, { name: string; prefix: string; members: { box: string; addr: string }[] }>();
  const secrets = new Map<string, Record<string, unknown>>();
  let n = 0;
  let dropped = false;
  const find = (ref: string) => [...boxes.values()].find((b) => b.name === ref || b.alias === ref);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchImpl = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push(`${method} ${u.pathname}`);
    if (new Headers(init.headers).get("Authorization") !== "Bearer orble_test") return json(401, { error: "not signed in" });
    if (init.body) bodies.set(`${method} ${u.pathname}`, JSON.parse(String(init.body)));
    const net = u.pathname.match(/^\/v1\/networks\/([^/]+)\/boxes\/([^/]+)$/);
    if (net) {
      const nw = networks.get(net[1]!);
      if (!nw) return json(404, { error: "no such network" });
      if (method === "PUT") nw.members.push({ box: net[2]!, addr: `10.240.0.${nw.members.length + 2}` });
      return json(200, nw);
    }
    if (u.pathname === "/v1/secrets" && method === "GET") return json(200, [...secrets.values()]);
    const sec = u.pathname.match(/^\/v1\/secrets\/(\w+)$/);
    if (sec && method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      // Like Orble: the stored secret carries the value; the response and list carry only a placeholder.
      const { value: _v, ...rest } = body;
      const s = { name: sec[1], ...rest, placeholder: "orbph_aaaaaaaaaaaaaaaa", all_boxes: !body.boxes };
      secrets.set(sec[1]!, s);
      return json(200, s);
    }
    if (u.pathname === "/v1/networks" && method === "GET") return json(200, [...networks.values()]);
    if (u.pathname === "/v1/snapshots" && method === "GET") return json(200, []);
    if (u.pathname === "/v1/me") return json(200, { email: "a@b.c", slug: "acct", plan: "pro", balance_micros: 0, ssh_keys: 1 });
    const m = u.pathname.match(/^\/v1\/boxes(?:\/([^/]+))?(?:\/(\w+))?$/);
    if (!m) return new Response("404 page not found", { status: 404 });
    const [, ref, action] = m;
    if (!ref && method === "POST") {
      const body = JSON.parse(String(init.body)) as { name: string; size?: string };
      if (find(body.name)) return json(409, { error: "that name is taken" });
      const b: Box = { name: `b${++n}`, alias: body.name, hostname: `b${n}.acct.orble.tech`, state: "running", vcpus: 2, mem_mib: 4096, disk_gib: 64, host_key: "ssh-ed25519 AAAA root@b" };
      boxes.set(b.name, b);
      if (opts.dropFirstCreateResponse && !dropped) {
        dropped = true;
        throw new TypeError("fetch failed");
      }
      return json(200, b);
    }
    if (!ref && method === "GET") return json(200, [...boxes.values()]);
    const b = ref ? find(decodeURIComponent(ref)) : undefined;
    if (!b) return json(404, { error: "no such box" });
    if (method === "GET") return json(200, b);
    if (method === "DELETE") {
      boxes.delete(b.name);
      return json(200, { ok: true });
    }
    if (action === "egress" && method === "PUT") b.egress = JSON.parse(String(init.body));
    if (action === "fork") return json(200, { boxes: [{ ...b, name: `b${++n}`, alias: "" }] });
    if (action === "suspend") b.state = "suspended";
    return json(200, b);
  };
  return { api: new OrbleApi("orble_test", fetchImpl, "https://orble.test"), boxes, calls, bodies, networks, secrets };
}

function ops(api: OrbleApi) {
  const kv = new Map<string, unknown>();
  return new OrbleMachineOps({
    config: async () => ({ api, snapshot: null, size: "s", opencodeProviders: [] }),
    ssh: { forget() {} } as never,
    tunnels: { stop() {} } as never,
    boxHubPort: 38886,
    bootstrap: async () => ({ hostId: "host_1" }),
    intents: { get: async (k) => kv.get(k) as never, set: async (k, v) => void kv.set(k, v), delete: async (k) => void kv.delete(k) },
    log: () => {},
    sleep: async () => {},
  });
}

test("a create whose response was lost leaves one box, which cleanup deletes by the key's alias", async () => {
  const o = fakeOrble({ dropFirstCreateResponse: true });
  const m = ops(o.api);
  // The first attempt fails after Orble made the box; bb then retries or cleans up.
  await assert.rejects(m.create("key-1", null, async () => {}, { step() {}, log() {} }, AbortSignal.timeout(5000)), /fetch failed/);
  assert.equal(o.boxes.size, 1);
  assert.equal([...o.boxes.values()][0]!.alias, boxAliasFor("key-1"));
  await m.reconcileCleanup("key-1", AbortSignal.timeout(5000));
  assert.equal(o.boxes.size, 0);
  // A different key's box is never touched by this key's cleanup.
  await o.api.createBox({ name: boxAliasFor("key-2") });
  await m.reconcileCleanup("key-1", AbortSignal.timeout(5000));
  assert.equal(o.boxes.size, 1);
});

test("the client maps Orble errors to their HTTP statuses", async () => {
  const o = fakeOrble();
  assert.equal(await o.api.findBox("nope"), null);
  await o.api.createBox({ name: "dup" });
  await assert.rejects(o.api.createBox({ name: "dup" }), (e: unknown) => e instanceof OrbleApiError && e.status === 409 && /name is taken/.test(e.message));
  await assert.rejects(o.api.getBox("dup", undefined).then(() => new OrbleApi("orble_wrong", (o.api as unknown as { fetch: never }).fetch, "https://orble.test").me()), (e: unknown) => e instanceof OrbleApiError && e.status === 401);
});

test("suspend waits for Orble to report the box suspended", async () => {
  const o = fakeOrble();
  const b = await o.api.createBox({ name: "s1" });
  const m = ops(o.api);
  // The box is running, so the daemon stop runs first (stubbed executor).
  (m as unknown as { executor: () => unknown }).executor = () => ({ exec: async () => ({ exitCode: 0 }) });
  await m.suspend({ box: b.name, key: "k" }, { step() {}, log() {} }, AbortSignal.timeout(5000));
  assert.equal(o.boxes.get(b.name)!.state, "suspended");
  assert.ok(o.calls.includes(`POST /v1/boxes/${b.name}/suspend`));
});

test("tunnel grants go only to machines this plugin created", () => {
  assert.deepEqual(tunnelGrant("orble", JSON.stringify(["orble", "k"]), "h1", "http://127.0.0.1:38886"), { id: "orble-tunnel:h1", serverUrl: "http://127.0.0.1:38886" });
  assert.equal("status" in tunnelGrant("orble", JSON.stringify(["instabox", "k"]), "h1", "x"), true);
  assert.equal("status" in tunnelGrant("orble", "not json", "h1", "x"), true);
});

test("redaction hides the hub's key, other Orble keys and Secret placeholders", () => {
  const key = "orble_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";
  const r = redactText(`k=${key} other=orble_zzzzzzzzzzzz ph=orbph_testtesttesttest ok=orbital`, key);
  assert.equal(r.text, "k=[redacted Orble key] other=[redacted Orble key] ph=[redacted Secret placeholder] ok=orbital");
  assert.equal(r.count, 3);
});

test("shellQuote round-trips argv through a shell", async () => {
  const { spawnSync } = await import("node:child_process");
  const argv = ["printf", "%s|", "a b", "it's", "$HOME", "`x`", ""];
  const out = spawnSync("sh", ["-c", shellQuote(argv)], { encoding: "utf8" }).stdout;
  assert.equal(out, "a b|it's|$HOME|`x`||");
});

function dashboard(api: OrbleApi, hosts: { id: string; box: string }[] = []) {
  return createDashboardHandlers({
    client: async () => ({ api }),
    defaults: async () => ({ size: "s", snapshot: null, idlePauseSeconds: 600, apiKey: "orble_test" }),
    hosts: async () => hosts.map((h) => ({ id: h.id, name: h.id, status: "connected", machineProviderId: "orble", phase: "ready" })),
    getResource: async (id) => ({ box: hosts.find((h) => h.id === id)?.box }),
    executor: () => ({}) as never,
    forgetBox() {},
    publish() {},
    now: () => 0,
    cacheMs: 0,
  });
}

test("a secret's value goes to Orble only: not in the reply, the overview or the placeholder", async () => {
  const o = fakeOrble();
  const b = await o.api.createBox({ name: "web" });
  const h = dashboard(o.api);
  const value = "sk-live-VALUE-123";
  const r = await h.orble_secret_set({ name: "OPENAI_KEY", value, hosts: ["API.openai.com"], header: "Authorization", format: "Bearer {}", boxes: ["web"], intercept: false });
  assert.deepEqual(o.bodies.get("PUT /v1/secrets/OPENAI_KEY"), { value, hosts: ["api.openai.com"], header: "Authorization", format: "Bearer {}", boxes: [b.name] });
  const overview = JSON.stringify(await h.orble_overview());
  for (const out of [JSON.stringify(r), overview]) {
    assert.ok(!out.includes(value));
    assert.ok(!out.includes("orbph_"));
  }
  assert.match(overview, /OPENAI_KEY/);
  await assert.rejects(h.orble_secret_set({ name: "X", value, hosts: ["a.example.com"], header: "Authorization", format: "Bearer", boxes: null, intercept: false }), /\{\}/);
});

test("egress replaces the whole rule set, deduplicated, and empty lists clear it", async () => {
  const o = fakeOrble();
  const b = await o.api.createBox({ name: "web" });
  const h = dashboard(o.api);
  await h.orble_egress_set({ box: "web", block: true, allow: ["GitHub.com", "github.com", "10.0.0.0/8"], deny: [] });
  assert.deepEqual(o.bodies.get(`PUT /v1/boxes/${b.name}/egress`), { block: true, allow: ["github.com", "10.0.0.0/8"] });
  await h.orble_egress_set({ box: "web", block: false, allow: [], deny: [] });
  assert.deepEqual(o.bodies.get(`PUT /v1/boxes/${b.name}/egress`), {});
});

test("fork works for a plain box and is refused for a bb runner", async () => {
  const o = fakeOrble();
  const plain = await o.api.createBox({ name: "plain" });
  const runner = await o.api.createBox({ name: "bb-abc" });
  const h = dashboard(o.api, [{ id: "host_1", box: runner.name }]);
  await assert.rejects(h.orble_fork({ box: "bb-abc", count: 1 }), /bb machine/);
  assert.ok(!o.calls.includes(`POST /v1/boxes/${runner.name}/fork`));
  await h.orble_fork({ box: "plain", count: 2 });
  assert.deepEqual(o.bodies.get(`POST /v1/boxes/${plain.name}/fork`), { count: 2 });
});

test("a runner created with a network joins it before setup continues", async () => {
  const o = fakeOrble();
  o.networks.set("lab", { name: "lab", prefix: "10.240.0.0/24", members: [] });
  const m = ops(o.api);
  // Stop right after the join: SSH setup is out of scope here.
  (m as unknown as { executor: () => unknown }).executor = () => {
    throw new Error("stop here");
  };
  await assert.rejects(m.create("key-n", { network: "lab" }, async () => {}, { step() {}, log() {} }, AbortSignal.timeout(5000)), /stop here/);
  const box = [...o.boxes.values()][0]!;
  assert.deepEqual(o.networks.get("lab")!.members.map((x) => x.box), [box.name]);
});
