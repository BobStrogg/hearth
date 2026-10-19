# Hearth

**Your coding agents, at home, from anywhere.** Hearth is a small self-hosted daemon plus a phone-friendly web UI for
[Agent Client Protocol (ACP)](https://agentclientprotocol.com) agents such as Claude Code, Grok Build, Codex, Gemini CLI,
Cursor and Devin.

- **Finds your agents.** It probes for the ACP agents installed on the machine.
- **Persistent sessions.** Start a session with any agent in any folder. The agent keeps running on the machine when you
  close the browser, and you can reopen it from another device.
- **History stays on the machine.** Every ACP message is appended to a per-session JSONL transcript. Clients replay by
  sequence number, so reconnects are lossless even for agents without `session/load`. Agents that support
  `session/load` are reloaded after a restart.
- **Import existing sessions.** List the sessions an agent already has (from its own CLI) and continue one in Hearth.
  It uses ACP `session/list`, then `session/load` (which replays the history into Hearth's transcript) or `session/resume`.
  If `session/list` isn't available, Claude Code and Codex sessions are listed read-only from their local files.
- **Phone-first chat UI.** Streaming markdown, tool-call cards, diffs, plans, approve/deny buttons for permission requests,
  stop and rename. It also works as a PWA.
- **Private by design.** It listens on 127.0.0.1 only. Each session belongs to the identity that created it, with no
  admin view. It has Host, Origin and CSRF checks and an optional password unlock (including the OS account password).

Status: early MVP. MIT licensed.

## Install

Requires Node.js 20+ (on macOS the installer will `brew install node` if needed).

```bash
curl -fsSL https://raw.githubusercontent.com/BobStrogg/hearth/main/scripts/install.sh | bash
```

This installs into `~/.hearth/app`, writes `~/.hearth/env` (first run only), and registers a LaunchAgent on macOS or a
`systemd --user` service on Linux. Then open <http://127.0.0.1:7682>. Uninstall with `scripts/uninstall.sh [--purge]`.

Sign in to each agent once in a terminal on the machine (for example `claude` then `/login`, or `grok login`). Hearth
doesn't handle agent credentials.

## Supported agents

`hearth probe` shows what's installed, and `hearth probe --deep` also runs ACP `initialize` against each one.

| Agent | Launch command | Status |
|---|---|---|
| Claude Code | `npx -y @agentclientprotocol/claude-agent-acp@0.93.0` (needs `claude`) | tested |
| Grok Build | `grok agent stdio` | tested |
| Codex | `npx -y @agentclientprotocol/codex-acp` (needs `codex`) | listed |
| Gemini CLI | `gemini --acp` | listed |
| Cursor | `cursor-agent acp` | listed |
| Devin | `devin acp` | listed |
| GitHub Copilot | `copilot --acp --stdio` | listed |
| OpenCode, Qwen, Kimi, Goose, Junie, Kiro, Droid, Qoder, Pi, OpenClaw, Kilo Code, fast-agent | see `src/agents.ts` | listed |

Add or override agents in `~/.hearth/agents.json`:

```json
[{ "id": "myagent", "name": "My Agent", "detect": ["myagent"], "command": "myagent", "args": ["acp"], "env": {} }]
```

## Configuration (`~/.hearth/env`)

| Variable | Default | Meaning |
|---|---|---|
| `HEARTH_PORT` | `7682` | Port on 127.0.0.1 |
| `HEARTH_ALLOWED_ORIGINS` | `http://127.0.0.1:PORT,http://localhost:PORT` | Exact origins allowed (also used for Host checks). Add your public URL when you put a proxy in front. |
| `HEARTH_IDENTITY` | `single:` | `single:<name>` (one local user), `header:<Header-Name>` (trust a header set by your proxy), or `cloudflare` (verify the Cloudflare Access JWT) |
| `HEARTH_CF_TEAM_DOMAIN`, `HEARTH_CF_AUD` | | Required for `cloudflare` identity |
| `HEARTH_ALLOWED_USERS` | | Optional comma-separated allow-list of identities |
| `HEARTH_PASSWORD` | `os` on macOS, else `off` | `off`, `os` (checks the account password of the user running Hearth: `dscl . -authonly` on macOS, `pamtester` on Linux), or `scrypt:...` from `hearth hash-password <pw>` |
| `HEARTH_UNLOCK_TTL_HOURS` | `12` | How long an unlock lasts (per identity, signed cookie) |
| `HEARTH_ROOTS` | `$HOME` | Comma-separated folders that sessions and the folder picker may use |
| `HEARTH_DATA_DIR` | `~/.hearth` | Where transcripts live |

## Security model

- **Network:** Hearth binds to 127.0.0.1 only and is meant to sit behind something that authenticates people, such as a
  Cloudflare Tunnel with Access, Tailscale Serve or oauth2-proxy. See [docs/cloudflare.md](docs/cloudflare.md).
- **Identity:** with `header:` identity, any local process can forge the header, so prefer `cloudflare` (JWT verified
  against your team's keys and the app's AUD) or another verifiable scheme on shared machines.
- **Requests:** Host and Origin must match `HEARTH_ALLOWED_ORIGINS`. State-changing requests also need `X-Hearth-CSRF: 1`.
  WebSockets check Origin. A strict CSP is set, with no third-party scripts.
- **Agents run as you.** An agent can do anything your account can, which is why the password unlock is on by default on
  macOS. ACP `fs/*` and `terminal/*` requests are confined to the session folder (symlink-aware), but agents that use
  their own built-in tools aren't limited by Hearth. Use each agent's own permission settings as well.
- **Privacy:** sessions and transcripts are stored per identity (`~/.hearth/users/<hash>/sessions/<id>/`, mode 0700/0600).
  Other users get 404 for them. There is no admin view.

## Storage

```
~/.hearth/users/<sha256(identity)[:16]>/sessions/<uuid>/
  meta.json         { id, owner, agentId, cwd, title, state, agentSessionId, seq, ... }
  transcript.jsonl  {"seq":1,"ts":"...","dir":"out|in|sys","msg":{...raw JSON-RPC or daemon event...}}
~/.hearth/users/<sha256(identity)[:16]>/prefs.json   last chosen agent settings, per agent (defaults for new sessions)
```

## Agent settings (model, mode, …)

Hearth shows whatever settings the agent advertises: ACP session config options (`configOptions` from
`session/new|load|resume`, changed with `session/set_config_option`, live `config_option_update`), or, for agents that
only use the older shapes, `modes` (`session/set_mode`, `current_mode_update`) and `models` (`session/set_model`). When
an agent sends `configOptions` the older shapes are ignored, as the spec recommends. The model and mode appear as small
pills above the message box; everything else (reasoning level, toggles, …) is behind the ⚙ button, grouped by category.
Your last choice per agent becomes the default for new sessions with that agent (only choices you make, not changes the
agent makes on its own); values the agent no longer offers are skipped.

## API

All under the daemon origin, scoped to the caller's identity.

- `GET /api/me` and `POST /api/unlock {password}`
- `GET /api/agents` and `GET /api/agents?deep=<id>`
- `GET /api/fs?path=` (folders only, within `HEARTH_ROOTS`)
- `GET|POST /api/sessions {agentId, cwd, title?}`, `GET|PATCH|DELETE /api/sessions/:id` (`?purge=1` deletes history),
  and `POST /api/sessions/:id/resume`
- `GET /api/agents/:id/sessions?cwd=`: the agent's own sessions (`source`: `acp`, `files` or `none`; `canLoad`,
  `canResume`, `importable`; each session has `hearthId` if you've already imported it, and `allowed` if its folder is
  inside `HEARTH_ROOTS`)
- `POST /api/sessions/import {agentId, agentSessionId, cwd, title?}`: creates a Hearth session for you bound to that
  agent session, and seeds the transcript through `session/load`, falling back to `session/resume` with no history
- `WS /ws?session=<id>&since=<seq>`
  - **Server to client:** `replay {items}`, `entry {entry}`, `state`, `permission {id, params}`,
    `permission_resolved`, `prompt_done {stopReason}`, `settings {options}`, `error`
  - **Client to server:** `prompt {content|text}`, `cancel`, `permission {id, optionId|null}`, `setOption {configId, value}`,
    `setMode {modeId}`, `resume`

Pending permission requests are re-sent to every client that connects.

## Develop

```bash
npm install && npm test        # unit + end-to-end tests against a mock ACP agent
HEARTH_ROOTS=$PWD npm start    # http://127.0.0.1:7682
```

Prior art and inspiration: [acpx](https://github.com/openclaw/acpx) (agent registry),
[acp-ui](https://github.com/formulahendry/acp-ui) and [grok-remote](https://github.com/daniel-farina/grok-remote).
