# bb-plugin-orble (experimental)

> **Status: experimental, v0.1.0.** Live acceptance passed on 2026-11-18 (bb 0.49.0);
> see [Live acceptance](#live-acceptance-2026-11-18).

A bb machine provider that runs bb threads on [Orble](https://orble.tech) boxes. It has
the same shape as [`bb-plugin-instabox`](https://github.com/WyrdWerk/bb-plugin-instabox),
and adds an **Orble** page to bb's sidebar. It needs only the Orble API key: no
Tailscale, no bb Connect, no relay and no chisel.

## How the box reaches the hub

Orble boxes have no public IPv4 SSH. The `orble` CLI reaches them through the API
(`GET /v1/connect?host=<box>.<account>.orble.tech&port=22` with `Upgrade: sbx-tcp`,
the key as Bearer and the client's SSH banner in an `SSH-Hello` header). The plugin
ships the same proxy as a small node script, so the hub needs no `orble` CLI. Orble's
sshd allows remote forwarding, so one process per box is the whole tunnel:

```text
hub: ssh -N -R 127.0.0.1:38886:127.0.0.1:<bb port> agent@<box>.<account>.orble.tech
       (ProxyCommand: node orble-proxy.cjs → orble.tech/v1/connect)
box: bb daemon → http://127.0.0.1:38886 ──tunnel──▶ hub
```

The hub's Ed25519 key is generated once and registered on the Orble account as
`bb-plugin-orble`. Each box's SSH host key comes from the API and is pinned
(`StrictHostKeyChecking=yes`). The API key reaches the proxy through its environment,
never argv. The same SSH path is bb's `MachineExecutor` for bootstrap and for the
plugin's own scripts, with output streamed and no 600 s command cap.

## Setup

1. **Hub:** bb ≥ 0.45 with `node`, `ssh` and `ssh-keygen` on the server's PATH.
   `gh auth login` on the hub if runners should clone private repos (bb passes that
   login to remote machines).
2. **Install:**
   ```bash
   git clone <this repo> && cd bb-plugin-orble
   npm ci && bb plugin build . && bb plugin install "$PWD" --yes
   ```
3. **Key:** Settings → Plugins → Orble → **Orble API key** (an `orble_…` token, the
   one `orble login` writes to `~/.config/orble/config.json`). Stored as a secret.
   CLI: `bb plugin config orble set apiKey "$ORBLE_API_KEY"`.
4. **Machine access:** Settings → Machines → Machine access → **Orble tunnel**, or
   `bb settings general defaultMachineAccess orble-tunnel`.
5. **Use it:**
   ```bash
   bb machine create --provider orble --key <stable-key> [--inputs '{"size":"m","snapshot":"<name>"}']
   bb thread spawn --project <id> --machine <hostId> --provider pi --model zai/glm-5.3 --prompt '…'
   bb machine suspend <hostId>   # bb resumes it on the next message
   bb machine remove <hostId> --yes
   ```
   In the web UI the environment picker offers **Orble box** (Git worktree) and
   **Orble box (project checkout)**, with a **Repos: …** button for a plugin project,
   a snapshot and a size.

| Setting | Default | Notes |
|---|---|---|
| `apiKey` (secret) | empty | Required |
| `snapshot` | empty | Make runners from this Orble snapshot instead of the base image |
| `size` | `s` | `s` 2 vCPU/4 GiB, `m` 4/8, `l` 8/16 |
| `idlePauseSeconds` | `600` | The plugin's idle suspend for runners (see below); `0` = never |
| `opencodeProviders` | the eight defaults | Same format and defaults as bb-plugin-instabox |
| `githubOwners`, `createMissingProjects`, `hubCheckoutDir` | | Projects and Import from GitHub, same as bb-plugin-instabox |
| `boxHubPort` | `38886` | Port of the tunnel on each box; reload the plugin after changing it |

## Keys on runners

Orble Secrets (Pro) reach every box as placeholders (`orbph_…`) in `/etc/environment`
and `/etc/orble/secrets.env`; Orble swaps the real value in on HTTPS requests to each
Secret's hosts. The plugin adds nothing to them. On create and resume it writes Pi's
`~/.pi/agent/models.json` and OpenCode's `opencode.json` from each provider's live
`/models`, with only env var references (`$ZRO_API_KEY`, `{env:ZRO_API_KEY}`), before
bb starts the daemon. A user's own files are never overwritten (sha256 ownership under
`~/.config/bb-orble/`). Claude Code, Codex and Grok are not configured: log in to them
on the box yourself. Note that an Orble Secret for `api.anthropic.com` also sets
`ANTHROPIC_BASE_URL` on the box.

Projects (InstaBox page → Projects in the other plugin) work the same here: a set of
GitHub repos cloned into `~/workspace/repos` on a new runner, through the `GH_TOKEN`
Secret placeholder in a one-off credential helper, and registered as bb project sources.

## Lifecycle

- **create:** the box is named `bb-<sha256(key)[:12]>`. Orble names are unique per
  account (409 on a duplicate), which makes create retry-safe without an
  Idempotency-Key: a retry finds the box by that name. Then: kill any copied bb daemon
  and remove `~/.bb-machines` (snapshots and forks carry running programs), write the
  Pi/OpenCode configs, open the tunnel, require the hub's `/health` from the box, and
  `bootstrap`. About 18 s from nothing to a connected runner.
- **suspend:** stop the tunnel and the bb daemon, then Orble suspend (memory kept).
- **resume:** Orble resume, stop any daemon left from before, close outbound HTTP(S)
  connections, rewrite configs, reopen the tunnel, `bootstrap` with the same key.
- **remove / reconcileCleanup:** delete the box (by the recorded id and by the key's
  name) and wait for a 404, then drop its pinned host key.
- **supervisor (every 30 s):** reopens dropped tunnels (after a plugin reload or bb
  restart), applies the idle suspend, and marks a box Orble suspended on its own as
  suspended in bb, so the next message resumes it.

Orble boxes run `tini` as PID 1, not systemd, so bb's installer starts the daemon with
`nohup` (it prints "Service installation skipped"); a reboot of the box needs a resume
from bb. The plugin finds daemons by process, not by unit.

### Idle suspend

Orble suspends a box within about 40 s of its last SSH connection closing, but never
while one is open: a box holding only an idle `ssh -R` stayed running for 18 min. A
connected runner therefore never suspends by itself. The plugin suspends it through bb
once no bb thread on it has been starting or active for `idlePauseSeconds`; a long
turn keeps its thread active and is never cut off. Plain boxes made on the Orble page
have no tunnel and use Orble's own suspend.

## The Orble page

Account (plan, credit, spend), boxes (with the bb machine each one backs), snapshots
(yours and Orble's gallery), projects, Import from GitHub and a run-command box. Actions:
new box (plain or as a bb runner, optionally in a box network), suspend, resume,
snapshot, rename, resize, fork (plain boxes only: a fork would copy a runner's bb
identity), shared ports (private, public or off), outbound rules (block plus allow and
deny lists of IPv4, CIDR, `example.com` or `*.example.com`), rename a snapshot, delete
a box or a snapshot (type its name to confirm). **Box networks:** create, add or remove
boxes, delete (typed confirm). **Secrets:** list name, hosts, header, boxes and last use;
create or replace (value in a masked field, sent straight to Orble and never returned,
logged or kept), delete (typed confirm). Boxes get `$NAME` as a placeholder; requests to
`$NAME_URL/<path>` reach the first host with the value added, and with intercept so do
direct requests that send `$NAME`. The machine picker also takes a box network, which a
new runner joins before setup. Boxes bb manages can only be snapshotted
here; suspend, resize and remove go through bb. Run-command uses the hub's SSH and
redacts Orble keys and Secret placeholders from the output. Every response is built
from a zod schema, so IPv6 addresses, host keys, shared-port URLs and placeholders
never reach the browser.

## The Orble API

Orble documents its CLI and MCP server, not a REST API. The routes in
`src/orble-api.ts` are the ones the `orble` CLI (Nov 2026 build) calls, recorded through
a logging proxy: `GET /v1/me`, `GET|POST /v1/boxes`, `GET|DELETE /v1/boxes/{box}`,
`POST /v1/boxes/{box}/{suspend,resume,rename,resize,snapshot}`, `GET|PUT|DELETE
/v1/boxes/{box}/ports[/{port}]`, `GET|DELETE /v1/snapshots[/{name}]`, `GET|POST
/v1/ssh-keys`, `DELETE /v1/ssh-keys/{fingerprint}`, `GET /v1/secrets`,
`PUT|DELETE /v1/secrets/{NAME}` (`{value,hosts,header?,format?,boxes?,intercept?}`;
no `boxes` means every box), `POST /v1/boxes/{box}/fork` (`{count}` → `{boxes}`),
`POST /v1/snapshots/{name}/rename` (`{name}`; the new name is the `alias`),
`GET|PUT /v1/boxes/{box}/egress` (PUT replaces the whole set; `{}` clears it),
`GET /v1/networks`, `PUT|DELETE /v1/networks/{net}`, `PUT|DELETE
/v1/networks/{net}/boxes/{box}`, and `GET /v1/connect` (upgrade). `POST
/v1/boxes/{box}/vnc` returns a signed desktop URL; the plugin does not use it. Errors are `{"error": "…"}` with 401/404/409. Every call
is synchronous (create returns a running box in about 0.5 s). Orble can change any of
this without notice.

## Tests

`npm test` (node --test): create retry after a lost response and key-scoped cleanup
against a fake Orble behind the real client, error mapping, suspend, tunnel grants,
redaction, argv quoting, a secret's value never echoed (reply, overview,
placeholder), egress body shape and clearing, fork refused for a bb runner, a runner
joining its network on create, plus the projects, clone script, GitHub import and format tests
from bb-plugin-instabox. `npx tsc --noEmit -p .` checks types.

## Live acceptance (2026-11-18)

bb 0.49.0 hub in an Amp orb (4 GiB), Orble Pro account, Orble base image.

| Path | Result |
|---|---|
| `bb machine create --provider orble` → connected | Passed, 17.7 s |
| Box side: daemon running, hub `/health` 200 through the tunnel, Pi config with 8 providers from live `/models`, no placeholder in the file | Passed |
| Pi thread (`zai/glm-5.3`): read a fixture file and `hostname` | Passed (both matched) |
| `bb machine suspend` (2.9 s, Orble `suspended`) → `bb thread tell` → resumed → follow-up answer | Passed |
| Idle suspend at 120 s → plugin suspended the runner → message resumed it → answer | Passed |
| Plugin reload → supervisor reconnects the runner | Passed (within 5 s) |
| Orble page: overview, badge, new plain box, run command with redaction, typed-name delete (wrong name refused) | Passed |
| `bb machine remove` → Orble 404, no tunnel left, host key dropped | Passed |

Second pass (same day): on one throwaway plain box, through the page: network create
→ box created in it (resolves as `<box>.<net>.internal`, 10.240.0.2); egress block with
2 allowed (github.com 200, example.com blocked, from inside the box) then cleared;
port 8080 shared private then off; fork (the fork kept the rules and the network);
secret scoped to the box (`$NAME_URL/headers` on httpbin received the value, the box
held only the placeholder); snapshot, rename, delete by its new name; secret and
network deleted with typed confirms. All passed; everything test-made was deleted.
Runner + network was tested only against the fake Orble.

Not tested live: the one-step `--new-machine orble` / environment compositions,
project runners (clone + source registration) on Orble, snapshots as runner source,
a bb server restart, and OpenCode threads.
