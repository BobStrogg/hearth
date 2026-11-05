# MCP: drive Hearth sessions from a remote client

Hearth can speak [MCP](https://modelcontextprotocol.io) over streamable HTTP on the same port as the web UI
(`http://127.0.0.1:7682/mcp`). A client such as Grok lists agents, opens a session, sends a prompt, and polls for the
reply. The agent keeps running on this computer. The Mac (or whichever machine runs Hearth) has to be awake, and any
tunnel in front of it has to be up.

The endpoint is **off** until you set a token. Nothing here is on by default.

## Enable

Generate a token and put it in the env file (mode 600), then restart Hearth (`hearth service restart`):

```bash
openssl rand -hex 32
```

```
HEARTH_MCP_TOKEN=<that token>
```

The token is at least 16 characters and uses only letters, digits, and `._~+/=-`, so it fits the env file and a header.
`hearth doctor` says whether `/mcp` is on. `hearth service install --mcp-token …` writes the same key, but the value
then sits in your shell history. Editing the env file is the better default.

Who owns the sessions:

| `HEARTH_IDENTITY` | Session owner |
|---|---|
| `single:` (optionally `single:some-name`) | That user. `HEARTH_MCP_USER` overrides it. |
| `header:…` or `cloudflare` | `HEARTH_MCP_USER` is required. Use the same identity the web UI would (after `HEARTH_USER_ALIASES`), and one that `HEARTH_ALLOWED_USERS` allows if you set that list. |

The token does not unlock the web UI, and the web UI's password cookie does not call `/mcp`. Agents still run as the
account Hearth runs as. Anyone who has the token can start them.

## Call it

Locally:

```bash
curl -sS http://127.0.0.1:7682/mcp \
  -H "Authorization: Bearer $HEARTH_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

`X-Hearth-Mcp-Token: $HEARTH_MCP_TOKEN` works instead of the Bearer header. Don't put the token in the query string.

From another machine, use the same hostname as the web UI (no second public name). Example with a tunnel already
described in [cloudflare.md](cloudflare.md):

```bash
curl -sS https://agents.example.com/mcp \
  -H "Authorization: Bearer $HEARTH_MCP_TOKEN" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

In an MCP client that only has static headers, set:

| Header | Value |
|---|---|
| `Authorization` | `Bearer <HEARTH_MCP_TOKEN>` |
| `CF-Access-Client-Id` | Access service token id, if Access is in front |
| `CF-Access-Client-Secret` | Access service token secret |

Hearth checks the bearer. Access, if you use it, checks the service token before the request reaches the machine.
Create the service token in Cloudflare Zero Trust, and add a Service Auth rule on the application that already
protects the hostname. `Host` must be an origin in `HEARTH_ALLOWED_ORIGINS` (the public URL you already added for the
web UI). Browsers send `Origin`; MCP clients usually don't. A present `Origin` that isn't in the allowed list is
rejected.

Point the client at `https://agents.example.com/mcp` (or `http://127.0.0.1:7682/mcp` on the machine itself).

## Tools

Turns are asynchronous. `send_prompt` returns as soon as the prompt is accepted or queued. Call `poll_events` with
the returned `cursor` as `since` until `busy` is false.

| Tool | What it does |
|---|---|
| `list_agents` | Agents Hearth can start, plus `roots` (folders a session may use). |
| `list_sessions` | This MCP user's sessions. Closed ones are hidden unless `includeEnded` is true. |
| `get_session` | Status, pending permission requests, and a short recent transcript. |
| `create_session` | `agentId`, `cwd`, optional `title`. Returns immediately while the agent starts. |
| `rename_session` | New title. |
| `close_session` | Stop the agent. `purge: true` deletes the transcript too. |
| `send_prompt` | `sessionId` and `text`. Does not wait for the agent. |
| `poll_events` | New messages and status after `since`. |
| `cancel_prompt` | Stop the current turn. |
| `answer_permission` | Choose a `pendingPermissions` `optionId`. Omit it to refuse. |
| `resume_queue` | Continue a queue that paused after an error. |

`awaiting` is `running`, `starting`, `permission`, `queued`, `paused`, `idle`, `stopped`, or `exited`. While it is
`permission`, the agent is waiting on `answer_permission`.

## Protocol

Streamable HTTP, one JSON-RPC message per POST. The response is a single JSON object, or one `text/event-stream`
event when the client does not accept JSON. `GET` and `DELETE` are `405` (there is no standalone event stream and no
MCP session id).

Supported protocol versions: `2025-03-26`, `2025-06-18`, `2025-11-25` (the `initialize` handshake), and `2026-07-28`
(`server/discover`, then the same tools). A missing `MCP-Protocol-Version` header is treated as `2025-03-26`.
