# Hearth

**Your coding agents, at home, from anywhere.** Hearth is a small self-hosted daemon plus a phone-friendly web UI for
[Agent Client Protocol (ACP)](https://agentclientprotocol.com) agents such as Claude Code, Grok Build, Codex, Gemini CLI,
Cursor and Devin.

- **Finds your agents.** It probes for the ACP agents installed on the machine.
- **Persistent sessions.** Start a session with any agent in any folder. The agent keeps running when you close the
  browser, and you can reopen it from another device.
- **History stays on the machine.** Every ACP message is appended to a per-session JSONL transcript. Clients replay by
  sequence number. Agents that support `session/load` are reloaded after a restart.
- **Import existing sessions.** List the sessions an agent already has and continue one in Hearth
  (`session/list` → `session/load` / `session/resume`, with a read-only file fallback for Claude Code and Codex).
- **Phone-first chat UI.** Streaming markdown, inline images (from agent messages, tool results and markdown; tap to
  enlarge), tool-call cards, diffs, plans, approve/deny buttons, stop and rename. It also works as a PWA.
- **Prompt queue.** Send while the agent is busy and the prompt waits in a per-session queue on the machine
  (`sessions/<id>/queue.json`, up to 10 prompts), shown above the composer on every device. Whenever the agent is idle
  the next one runs by itself, in order: after a turn ends (including a Stop), after the agent restarts, when Hearth
  starts, and on a periodic check (`HEARTH_QUEUE_CHECK_MS`, default 15 s), so nothing is left waiting. If a prompt fails
  (for example the agent crashed) the queue pauses and tries again by itself after 15 s, 1 min and 5 min, restarting the
  agent; after that it waits for Resume. Tap a queued prompt's text to edit it in place (Enter or tapping away saves,
  Esc cancels), drag its handle to reorder (mouse, touch, or the arrow keys on the focused handle), send it now (stops
  the current turn first) or delete it.
- **Notifications.** Each phone or computer can opt in (🔔 on the session list) to Web Push notifications when an
  agent finishes a turn or is waiting for your approval, even with Hearth closed. Skipped while you're looking at that
  session. Standard VAPID Web Push, encrypted end to end, no third-party account; on iPhone/iPad add Hearth to the
  Home Screen first.
- **Voice (opt-in).** A mic button by the message box dictates into it (the words appear as you speak, so you can edit
  before sending), a speaker toggle reads finished replies aloud (code, tool output and diffs are skipped), each reply
  has its own speaker button, and an optional hands-free mode listens again after a reply is read. It uses the
  browser's own speech recognition and voices where they exist. Where they don't (the Tesla browser, Firefox), or if
  you'd rather your voice stayed private, the browser records and **this computer** transcribes it with
  [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and reads replies with macOS `say` (or piper / espeak-ng on
  Linux). In a Tesla the browser's microphone needs software 2026.26 or later on an AMD Ryzen car. Set it up from *Voice settings* (⋯ in a session) or with `hearth voice install`. Settings are per device.
- **Files in the browser.** Browse, download and upload files (📁 Files) in your home folder, with nothing to install.
  Downloads stream; uploads are chunked and resume after a dropped connection.
- **Updates itself.** `hearth update` (and the optional auto-update) pulls a verified release from GitHub, restarts the
  service and rolls back if the health check fails. The web UI shows the installed version and an "Update now" button.
- **Private by design.** It listens on 127.0.0.1 only. Each session belongs to the identity that created it. Host,
  Origin and CSRF checks, plus an optional password unlock (including the OS account password).

Status: early. MIT licensed.

## Quick start

Requires Node.js 22+ (use a patched release: 22.23.4, 24.22.1, 26.12.1 or newer). Pick one:

```bash
# npm (global)
npm install -g hearth-acp
hearth service install
# then open http://127.0.0.1:7682

# one-liner (installs Node via Homebrew/apt when needed, then the service)
curl -fsSL https://raw.githubusercontent.com/BobStrogg/hearth/main/scripts/install.sh | bash

# Homebrew
brew tap BobStrogg/hearth && brew install hearth
brew services start hearth

# single-file binary (no Node needed at runtime): grab the asset for your OS from
# https://github.com/BobStrogg/hearth/releases , then:
chmod +x hearth-* && ./hearth-* service install
```

Sign in to each agent once in a terminal on the machine (for example `claude` then `/login`, or `grok login`). Hearth
doesn't handle agent credentials.

## CLI

```
hearth                         run the server (same as `hearth serve`)
hearth service install […]    background service at login (launchd / systemd --user / Task Scheduler)
hearth service uninstall|start|stop|restart|status|logs
hearth doctor [--offline]      check the install, config, agents, port and service
hearth update [--check]        update from GitHub Releases (sha256-verified), restart, roll back if unhealthy
hearth probe [--deep]          list the ACP agents found on this machine
hearth voice [status|install]  private speech to text on this computer (whisper.cpp + a 60 MB model)
hearth hash-password <pw>      make a HEARTH_PASSWORD=scrypt:… value
```

`hearth service install` accepts `--port`, `--public-origin`, `--identity`, `--cf-team-domain`, `--cf-aud`,
`--password`, `--roots`, `--auto-update on|off`, and `--system` (a LaunchDaemon / system unit that needs sudo and runs
as you at boot).

## Configuration

Written on first `hearth service install` (or by the one-liner). Locations:

| OS | Config | Data (sessions, logs) |
|---|---|---|
| macOS | `~/.hearth/env` | `~/.hearth` |
| Linux | `$XDG_CONFIG_HOME/hearth/env` (default `~/.config/hearth/env`) | `$XDG_DATA_HOME/hearth` |
| Windows | `%APPDATA%\hearth\env` | `%APPDATA%\hearth` |

An existing `~/.hearth` is kept on every OS. Override with `HEARTH_HOME` / `HEARTH_DATA_DIR` / `HEARTH_ENV_FILE`.

| Variable | Default | Meaning |
|---|---|---|
| `HEARTH_PORT` | `7682` | Port on 127.0.0.1 |
| `HEARTH_ALLOWED_ORIGINS` | `http://127.0.0.1:PORT,http://localhost:PORT` | Exact origins allowed (also used for Host checks). Add your public URL when you put a proxy in front. |
| `HEARTH_IDENTITY` | `single:` | `single:<name>`, `header:<Header-Name>`, or `cloudflare` (verify the Cloudflare Access JWT) |
| `HEARTH_CF_TEAM_DOMAIN`, `HEARTH_CF_AUD` | | Required for `cloudflare` identity |
| `HEARTH_ALLOWED_USERS` | | Optional comma-separated allow-list of identities |
| `HEARTH_USER_ALIASES` | | Optional `alias=canonical` pairs (comma-separated) so one person signing in with different identities (e.g. a GitHub or Google login next to an email one-time PIN) gets the same sessions. One hop, case-insensitive. Set it with `hearth service install --user-aliases …` |
| `HEARTH_UPDATES_URL` | | Optional http(s) link for installs whose updates are managed elsewhere (a fleet dashboard, MDM…). Hearth then never checks for or applies updates itself (`HEARTH_AUTO_UPDATE` is ignored, `POST /api/update` is refused) and the version bar links there instead of offering *Update now*. Set with `hearth service install --updates-url …`. |
| `HEARTH_PASSWORD` | `os` on macOS, else `off` | `off`, `os` (account password: `dscl` on macOS, `pamtester` on Linux), or `scrypt:…` from `hearth hash-password` |
| `HEARTH_UNLOCK_TTL_HOURS` | `12` | How long an unlock lasts |
| `HEARTH_ROOTS` | `$HOME` | Comma-separated folders that sessions and the folder picker may use |
| `HEARTH_AUTO_UPDATE` | `off` | `on` = daily check against GitHub Releases; restarts when idle (force after 24h); rolls back if `/healthz` fails |
| `HEARTH_FILES` | `on` | `off` hides the file browser and its API |
| `HEARTH_FILES_ROOT` | `$HOME` | The only folder the file browser can see (symlinks are resolved; links leading out of it are hidden and refused) |
| `HEARTH_PUSH` | `on` | `off` turns notifications off. When on, nothing is sent until a device opts in |
| `HEARTH_PUSH_SUBJECT` | first `https://` allowed origin | VAPID contact (`mailto:` or `https:` URL) sent to push services |
| `HEARTH_PUSH_HOSTS` | | Extra push-service hosts to allow (Google, Mozilla, Apple and Microsoft are built in) |
| `HEARTH_VOICE` | `on` | `off` hides the mic's computer-side fallback and `/api/voice` (browser speech features still work) |
| `HEARTH_WHISPER_BIN` | `whisper-cli` on PATH or in Homebrew | whisper.cpp command for speech to text |
| `HEARTH_WHISPER_MODEL` | `<data>/models/ggml-base.en-q5_1.bin` | A whisper.cpp `ggml-*.bin` model (`hearth voice install` downloads the default, SHA-256 checked) |
| `HEARTH_TTS` | `on` | `off` = no computer-side text to speech |
| `HEARTH_SAY_VOICE` | system voice | macOS `say` voice for computer-side read-aloud (e.g. `Ava (Premium)`) |
| `HEARTH_PIPER_MODEL` | | Linux: a piper `.onnx` voice (used before espeak-ng when set) |

## Supported agents

`hearth probe` shows what's installed; `hearth probe --deep` also runs ACP `initialize` against each one.

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

Add or override agents in `agents.json` next to the data directory:

```json
[{ "id": "myagent", "name": "My Agent", "detect": ["myagent"], "command": "myagent", "args": ["acp"], "env": {} }]
```

`detect` entries may also be paths (`~/` is the home folder). An agent can have `profiles`: settings for one
particular install, each listed as its own entry ("My Agent · local model") while that binary (after following
symlinks) is the one found, its `envFile` gives at least one `KEY: value` / `KEY=value` setting, and its `healthUrl`
(if any; on this machine only: `localhost`, `127.x` or `::1`) answers. Starting one checks again and fails with the
reason rather than starting without the settings. Hearth's own `env` still wins.

```json
[{ "id": "goose", "profiles": [{ "name": "local model", "bin": "~/tools/goose/bin/goose",
   "envFile": "~/tools/goose/goose.env", "keys": ["OPENAI_HOST", "GOOSE_MODEL"], "healthUrl": "${OPENAI_HOST}/v1/models" }] }]
```

**Goose providers.** Each provider Goose reports set up (asked over its ACP extension) is its own entry,
"Goose · <provider>": custom providers you've defined (`~/.config/goose/custom_providers/*.json`, e.g. an
OpenAI-compatible Cloudflare Workers AI endpoint) unless their key is missing, and other providers once their key is
set. Each starts `goose acp` with that provider and its default model; the session's Model pill switches between that
provider's models. Goose also comes with one profile: an install from
[fm-serve-goose](https://github.com/BobStrogg/fm-serve-goose) adds "Goose · on-Mac (fm serve)" (Apple's on-device model
via `fm serve`, macOS 27) while its local proxy answers. Plain "Goose" starts with Goose's own config and is left out of
the picker when one of these is what it would start anyway. Hearth never reads Goose's keys.

## Security model

- **Network:** Hearth binds to 127.0.0.1 only and is meant to sit behind something that authenticates people, such as a
  Cloudflare Tunnel with Access (see [docs/cloudflare.md](docs/cloudflare.md)), Tailscale Serve or oauth2-proxy.
- **Identity:** with `header:` identity, any local process can forge the header, so prefer `cloudflare` (JWT verified
  against your team's keys and the app's AUD) or another verifiable scheme on shared machines.
- **Requests:** Host and Origin must match `HEARTH_ALLOWED_ORIGINS`. State-changing requests also need `X-Hearth-CSRF: 1`.
  WebSockets check Origin. A strict CSP is set, with no third-party scripts. Images from the session folder are served
  only through an authenticated endpoint that restricts to image types inside that folder.
- **Files:** the file browser only sees `HEARTH_FILES_ROOT` (real paths are checked, so `..` and symlinks can't leave
  it). Downloads are always sent as attachments with a sandbox CSP, never rendered on Hearth's origin. Uploads need the
  CSRF header and write through a hidden temp file that is renamed into place; an existing file is only replaced
  after you confirm.
- **Notifications:** the VAPID key pair lives in the data dir (`vapid.json`, mode 600) and subscriptions per user in
  `users/<id>/push.json`. Payloads (session title, the end of the reply or the tool awaiting approval) are encrypted
  for the subscribing device (RFC 8291); Hearth only posts to known push-service hosts.
- **Voice:** `/api/voice/*` sits behind the same identity, unlock and CSRF checks. Recordings must be 16-bit PCM WAV,
  at most 8 MB and 120 s; text to speak at most 6,000 characters; one job runs at a time with a deadline. Audio and
  text go to temp files in a private temp folder that is deleted as soon as the job ends; nothing is sent anywhere
  else. No macOS microphone or Speech Recognition permission is involved: the browser records, and whisper.cpp and
  `say` only read and write files. (The browser's built-in recognition is the browser vendor's service: Safari uses
  Apple's, Chrome uses Google's. Choose "This computer (private)" in Voice settings to avoid it.)
- **Agents run as you.** An agent can do anything your account can, which is why the password unlock is on by default on
  macOS.
- **Updates:** release assets are checked against the release's `SHA256SUMS` before anything is installed. The web UI's
  "Update now" button only runs the fixed `hearth update` command (no arbitrary input).

## Development

```bash
npm install && npm test
npm start                 # or: node dist/main.js
npm run build:sea         # single-file binary into build/
```

## License

MIT. See [CHANGELOG.md](CHANGELOG.md) for release notes.
