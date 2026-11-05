/**
 * Streamable-HTTP MCP facade for Hearth sessions.
 *
 * One path, `/mcp`, on the same port as the web UI, so an existing tunnel can
 * carry it. Off unless HEARTH_MCP_TOKEN is set. The token is the credential
 * (Authorization: Bearer, or X-Hearth-Mcp-Token). It does not replace the web
 * UI's identity, CSRF, or password unlock, and it is not a Cloudflare Access check.
 *
 * Agent turns are long. send_prompt only queues or starts the turn and returns.
 * The client polls poll_events. Protocol: the 2025 initialize handshake
 * (2025-03-26, 2025-06-18, 2025-11-25) and 2026-07-28 server/discover, both
 * answered as one JSON object (or one SSE event when the client accepts only
 * text/event-stream). No MCP session id: each POST stands alone.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { osUser, type AgentDef } from "./agents.js";
import { canonicalUser } from "./auth.js";
import { QueueError } from "./queue.js";
import { within, type LiveSession } from "./session.js";
import { dedupeFanout, type SessionMeta, type Store, type TranscriptEntry } from "./store.js";
import { VERSION } from "./version.js";

export const MCP_LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const MCP_MODERN_VERSION = "2026-07-28";
export const MCP_PROTOCOL_VERSIONS = [MCP_MODERN_VERSION, ...MCP_LEGACY_VERSIONS];
export const MCP_TOKEN_MIN = 16;
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";
const PROTO_KEY = "io.modelcontextprotocol/protocolVersion";

export const MCP_INSTRUCTIONS = [
  "Hearth runs ACP coding agents on this computer. You drive them with tools; the work stays on this machine.",
  "Turns are asynchronous. send_prompt returns as soon as the prompt is accepted or queued. Then call poll_events with that sessionId and since set to the returned cursor until busy is false.",
  "awaiting is running, starting, permission, queued, paused, idle, stopped, or exited. When awaiting is permission, call answer_permission with a pendingPermissions optionId (omit optionId to refuse).",
  "Use an installed agent id from list_agents. create_session needs a folder inside roots. cancel_prompt stops the current turn. close_session ends the agent. resume_queue continues a queue that paused after an error.",
  "The computer must be awake and Hearth must be running.",
].join(" ");

export interface McpHost {
  cfg: {
    roots: string[];
    allowedOrigins: string[];
    identity: string;
    allowedUsers?: string[];
    userAliases?: Record<string, string>;
    mcpToken?: string;
    mcpUser?: string;
  };
  auth: { hostOk(req: IncomingMessage): boolean };
  store: Store;
  live: Map<string, LiveSession>;
  agentById(id: unknown): AgentDef | undefined;
  listAgentCatalog(): Promise<Record<string, unknown>[]>;
  openSession(m: SessionMeta): LiveSession;
}

/** Why /mcp is off, or null when the token is usable. */
export function mcpAvailability(token: string | undefined): { status: number; error: string } | null {
  if (!token) return { status: 404, error: "MCP is off. Set HEARTH_MCP_TOKEN to enable /mcp." };
  if (token.length < MCP_TOKEN_MIN) return { status: 503, error: `MCP is off. HEARTH_MCP_TOKEN must be at least ${MCP_TOKEN_MIN} characters.` };
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(token)) return { status: 503, error: "MCP is off. HEARTH_MCP_TOKEN may only use letters, digits, and ._~+/=- so it can live in the env file and in a header." };
  return null;
}

/** Compare secrets without leaking the length or the matching prefix through timing. */
export function tokenMatches(expected: string, got: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(got).digest();
  return timingSafeEqual(a, b);
}

export function resolveMcpOwner(cfg: { identity: string; mcpUser?: string; userAliases?: Record<string, string>; allowedUsers?: string[] }): { owner: string } | { error: string } {
  let raw = cfg.mcpUser?.trim() ?? "";
  if (!raw && cfg.identity.startsWith("single:")) raw = cfg.identity.slice("single:".length) || osUser();
  if (!raw) return { error: "Set HEARTH_MCP_USER to the identity that should own sessions opened over MCP (required unless HEARTH_IDENTITY is single:)." };
  const owner = canonicalUser(raw, cfg.userAliases);
  const allow = cfg.allowedUsers ?? [];
  if (allow.length && !allow.includes(owner) && !allow.includes(raw.trim().toLowerCase())) return { error: "HEARTH_MCP_USER is not in HEARTH_ALLOWED_USERS." };
  return { owner };
}

export function mcpDoctorCheck(cfg: { mcpToken?: string; mcpUser?: string; identity: string; allowedUsers?: string[]; userAliases?: Record<string, string> }): { level: "ok" | "warn" | "fail" | "info"; title: string; fix?: string } {
  const gate = mcpAvailability(cfg.mcpToken);
  if (!gate) {
    const o = resolveMcpOwner(cfg);
    if ("error" in o) return { level: "fail", title: "MCP token is set, but it has no session owner", fix: o.error };
    const who = cfg.mcpUser ? "HEARTH_MCP_USER" : "the single-user identity";
    return { level: "ok", title: `MCP endpoint on at /mcp (sessions belong to ${who})` };
  }
  if (gate.status === 404) return { level: "info", title: "MCP endpoint off (/mcp)", fix: "Optional. Set HEARTH_MCP_TOKEN to let a remote MCP client drive sessions. See docs/mcp.md." };
  return { level: "fail", title: gate.error, fix: "See docs/mcp.md. Generate one with `openssl rand -hex 32`." };
}

// ---- transcript → short events a model can read ----

export interface McpEvent {
  seq: number;
  at: string;
  kind: "user" | "assistant" | "thought" | "tool" | "plan" | "permission" | "done" | "error" | "system";
  text?: string;
  toolCallId?: string;
  title?: string;
  status?: string;
  stopReason?: string;
}

const clip = (s: string, n: number) => { const t = s.replace(/\s+$/g, ""); return t.length > n ? t.slice(0, n) + "… (truncated)" : t; };
const asObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
const textOf = (content: unknown): string => {
  const one = asObj(content);
  if (one?.type === "text") return String(one.text ?? "");
  if (!Array.isArray(content)) return "";
  return content.map((c) => { const o = asObj(c); return o?.type === "text" ? String(o.text ?? "") : ""; }).join("");
};

/**
 * Collapse a transcript page into a few events. `cursor` is the seq the client should pass back as `since`
 * (the last raw line consumed, or the last event when the page was cut short). `hasMore` means call again.
 */
export function summarizeTranscript(entries: TranscriptEntry[], maxEvents = 40): { events: McpEvent[]; cursor: number; hasMore: boolean } {
  const RAW_CAP = 400;
  const slice = entries.slice(0, RAW_CAP);
  const items = dedupeFanout(slice);
  const events: McpEvent[] = [];
  let buf: { kind: "assistant" | "thought"; seq: number; at: string; text: string } | null = null;
  const flush = () => {
    const cur = buf; buf = null;
    if (!cur?.text.trim()) return;
    events.push({ seq: cur.seq, at: cur.at, kind: cur.kind, text: clip(cur.text, cur.kind === "thought" ? 1500 : 8000) });
  };
  const push = (e: McpEvent | null) => { if (!e) return; flush(); events.push(e); };
  for (const e of items) {
    const msg = asObj(e.msg) ?? {};
    const update = msg.method === "session/update" ? asObj(asObj(msg.params)?.update) : null;
    const chunk = update?.sessionUpdate === "agent_message_chunk" ? "assistant" : update?.sessionUpdate === "agent_thought_chunk" ? "thought" : null;
    if (chunk) {
      const text = textOf(update?.content);
      if (!text) continue;
      const same: string = buf !== null && buf.kind === chunk ? buf.text : "";
      if (buf && buf.kind !== chunk) flush();
      buf = { kind: chunk, seq: e.seq, at: e.ts, text: same + text };
      continue;
    }
    if (e.dir === "out" && msg.method === "session/prompt") { push({ seq: e.seq, at: e.ts, kind: "user", text: clip(textOf(asObj(msg.params)?.prompt), 8000) }); continue; }
    if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") {
      const title = typeof update.title === "string" ? update.title : undefined;
      const status = typeof update.status === "string" ? update.status : undefined;
      const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
      const kind = typeof update.kind === "string" ? update.kind : undefined;
      push({ seq: e.seq, at: e.ts, kind: "tool", toolCallId, title, status, text: [kind, title, status].filter(Boolean).join(" · ") || toolCallId });
      continue;
    }
    if (update?.sessionUpdate === "plan" && Array.isArray(update.entries)) {
      const text = update.entries.map((x) => { const o = asObj(x); return o ? `${o.status ?? ""} ${o.content ?? ""}`.trim() : ""; }).filter(Boolean).join("\n");
      push({ seq: e.seq, at: e.ts, kind: "plan", text: clip(text, 4000) });
      continue;
    }
    if (e.dir === "in" && msg.method === "session/request_permission") {
      const tool = asObj(asObj(msg.params)?.toolCall);
      const title = typeof tool?.title === "string" ? tool.title : "an action";
      push({ seq: e.seq, at: e.ts, kind: "permission", title, text: `Needs a decision: ${title}` });
      continue;
    }
    const stop = asObj(msg.result)?.stopReason;
    if (e.dir === "in" && typeof stop === "string") { push({ seq: e.seq, at: e.ts, kind: "done", stopReason: stop, text: stop }); continue; }
    const err = asObj(msg.error);
    if (e.dir === "in" && typeof err?.message === "string") { push({ seq: e.seq, at: e.ts, kind: "error", text: clip(err.message, 2000) }); continue; }
    if (e.dir === "sys") {
      const ev = msg.event;
      if (ev === "agent_exit" && msg.intended) continue;
      if (ev === "agent_start_failed" || ev === "agent_exit" || ev === "context_reset" || ev === "session_load_failed" || ev === "session_resume_failed") {
        const text = ev === "agent_exit" ? `agent exited (${msg.code ?? msg.signal ?? "?"})` : String(msg.error ?? msg.reason ?? ev);
        push({ seq: e.seq, at: e.ts, kind: "system", text: clip(text, 2000) });
      }
    }
  }
  flush();
  if (events.length > maxEvents) {
    const kept = events.slice(0, maxEvents);
    return { events: kept, cursor: kept[kept.length - 1].seq, hasMore: true };
  }
  return { events, cursor: slice.at(-1)?.seq ?? 0, hasMore: entries.length > slice.length };
}

// ---- tools ----

interface ToolDef { name: string; description: string; inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] }; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean } }
const str = (description: string) => ({ type: "string", description });
const bool = (description: string) => ({ type: "boolean", description });
const num = (description: string) => ({ type: "integer", minimum: 0, description });

/**
 * 2026-07-28 list results are a CacheableResult: `ttlMs` (a number, ≥ 0) and
 * `cacheScope` are required. A portal that validates tools/list with that schema
 * rejects a missing `ttlMs` as `invalid_type` / expected number — the whole sync
 * fails before it looks at tool schemas. 0 means the list is already stale.
 * `private` matches server/discover: the catalog is the same for every caller,
 * and the endpoint is still credential-gated. 2025 results are an open object,
 * so the same fields are sent on every list response; older clients ignore them.
 */
const LIST_CACHE = { ttlMs: 0, cacheScope: "private" as const };

export const MCP_TOOLS: ToolDef[] = [
  { name: "list_agents", description: "List ACP agents Hearth can start, including profiles and variants it already knows (for example Goose providers). Prefer an entry with installed true. Also returns the folders (roots) create_session may use.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "list_sessions", description: "List this MCP user's Hearth sessions: id, title, agent, folder, and whether a turn is running. Closed sessions are omitted unless includeEnded is true.", inputSchema: { type: "object", properties: { includeEnded: bool("Include sessions that were closed.") } }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "get_session", description: "One session: status, pending permission requests, and a short summary of recent messages. cursor is the seq to pass as poll_events since, to read only what is newer.", inputSchema: { type: "object", properties: { sessionId: str("Hearth session id.") }, required: ["sessionId"] }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "create_session", description: "Open a Hearth session for an installed agent in a folder inside roots. Returns immediately; the agent process starts in the background. Then send_prompt.", inputSchema: { type: "object", properties: { agentId: str("Id from list_agents."), cwd: str("Existing folder inside roots."), title: str("Optional title, up to 120 characters.") }, required: ["agentId", "cwd"] } },
  { name: "rename_session", description: "Rename a session.", inputSchema: { type: "object", properties: { sessionId: str("Hearth session id."), title: str("New title, up to 120 characters.") }, required: ["sessionId", "title"] }, annotations: { idempotentHint: true } },
  { name: "close_session", description: "Stop the agent and mark the session closed. History remains until purge is true, which deletes it.", inputSchema: { type: "object", properties: { sessionId: str("Hearth session id."), purge: bool("Delete the session and its transcript.") }, required: ["sessionId"] }, annotations: { destructiveHint: true } },
  { name: "send_prompt", description: "Send text to a session. Returns as soon as the prompt is accepted or queued. Does not wait for the agent. Call poll_events with the returned cursor until busy is false.", inputSchema: { type: "object", properties: { sessionId: str("Hearth session id."), text: str("The prompt. Plain text.") }, required: ["sessionId", "text"] } },
  { name: "poll_events", description: "Messages and status newer than since (a cursor from send_prompt, get_session, or a previous poll). Read events, then call again with the returned cursor while hasMore or busy is true.", inputSchema: { type: "object", properties: { sessionId: str("Hearth session id."), since: num("Return transcript events with seq greater than this. 0 reads from the start.") }, required: ["sessionId"] }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "cancel_prompt", description: "Ask the agent to stop the turn it is running. Returns immediately; poll_events reports the cancelled stop reason.", inputSchema: { type: "object", properties: { sessionId: str("Hearth session id.") }, required: ["sessionId"] }, annotations: { destructiveHint: true } },
  { name: "answer_permission", description: "Answer a permission the agent is waiting on (see pendingPermissions on the session). Pass optionId from that list. Omit optionId to refuse.", inputSchema: { type: "object", properties: { sessionId: str("Hearth session id."), permissionId: str("Id from pendingPermissions."), optionId: str("optionId to select. Omit to refuse.") }, required: ["sessionId", "permissionId"] } },
  { name: "resume_queue", description: "Continue a session whose prompt queue paused after an error.", inputSchema: { type: "object", properties: { sessionId: str("Hearth session id.") }, required: ["sessionId"] } },
];

class ToolFail extends Error {}

function permissionView(id: string, params: unknown) {
  const p = asObj(params);
  const tool = asObj(p?.toolCall);
  const options = Array.isArray(p?.options) ? p.options.flatMap((o) => {
    const x = asObj(o);
    return typeof x?.optionId === "string" ? [{ optionId: x.optionId, name: typeof x.name === "string" ? x.name : x.optionId, kind: typeof x.kind === "string" ? x.kind : null }] : [];
  }) : [];
  return { id, title: typeof tool?.title === "string" ? tool.title : "an action", toolCallId: typeof tool?.toolCallId === "string" ? tool.toolCallId : null, options };
}

type Awaiting = "running" | "starting" | "permission" | "queued" | "paused" | "idle" | "stopped" | "exited";
function awaitingOf(state: SessionMeta["state"], l?: LiveSession): Awaiting {
  if ((l?.meta.state ?? state) === "exited") return "exited";
  if (l && l.pending.size > 0) return "permission";
  if (l?.turnActive || (l?.meta.state ?? state) === "running") return "running";
  if (l?.isStarting) return "starting";
  if (l && l.queue.items.length && l.queue.paused) return "paused";
  if (l && l.queue.items.length) return "queued";
  if ((l?.meta.state ?? state) === "stopped") return "stopped";
  return "idle";
}

function sessionStatus(h: McpHost, m: SessionMeta, full: boolean) {
  const l = h.live.get(m.id);
  const meta = l?.meta.owner === m.owner ? l.meta : m;
  const awaiting = awaitingOf(meta.state, l?.meta.id === meta.id ? l : undefined);
  const live = l?.meta.id === meta.id ? l : undefined;
  const pending = live ? [...live.pending.entries()].map(([id, p]) => permissionView(id, p.params)) : [];
  return {
    id: meta.id, title: meta.title, agentId: meta.agentId, agentName: h.agentById(meta.agentId)?.name ?? meta.agentId,
    cwd: meta.cwd, state: meta.state, awaiting,
    busy: awaiting === "running" || awaiting === "starting" || awaiting === "permission" || awaiting === "queued",
    queued: live?.queue.items.length ?? 0, queuePaused: !!live?.queue.paused, queueReason: live?.queue.paused ? live.queue.reason : null,
    pendingPermissions: full ? pending : pending.length,
    createdAt: meta.createdAt, lastActivity: meta.lastActivity, cursor: meta.seq,
  };
}

function findSession(h: McpHost, owner: string, id: unknown): SessionMeta {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new ToolFail("sessionId must be a Hearth session id.");
  const live = h.live.get(id);
  if (live) { if (live.meta.owner !== owner) throw new ToolFail("No such session."); return live.meta; }
  const m = h.store.get(owner, id);
  if (!m) throw new ToolFail("No such session.");
  return m;
}

function needOwner(h: McpHost): string {
  const r = resolveMcpOwner(h.cfg);
  if ("error" in r) throw new ToolFail(r.error);
  return r.owner;
}

async function callTool(h: McpHost, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "list_agents") {
    const agents = (await h.listAgentCatalog()).flatMap((row) => {
      if (row.hidden) return [];
      const item: Record<string, unknown> = { id: row.id, name: row.name, installed: !!row.installed };
      if (typeof row.status === "string") item.status = row.status;
      if (typeof row.parent === "string") item.parent = row.parent;
      if (typeof row.profile === "string") item.profile = row.profile;
      return [item];
    });
    return { agents, roots: h.cfg.roots };
  }
  const owner = needOwner(h);
  if (name === "list_sessions") {
    const includeEnded = args.includeEnded === true;
    const sessions = h.store.list(owner).filter((m) => includeEnded || m.state !== "exited").map((m) => sessionStatus(h, m, false));
    return { sessions };
  }
  if (name === "get_session") {
    const m = findSession(h, owner, args.sessionId);
    const page = h.store.readPage(m, { turns: 4 });
    return { session: sessionStatus(h, m, true), recent: summarizeTranscript(page.items).events };
  }
  if (name === "create_session") {
    const agent = h.agentById(args.agentId);
    if (!agent) throw new ToolFail("Unknown agent. Call list_agents and use an id from that list.");
    const cwd = resolve(String(args.cwd ?? ""));
    if (!h.cfg.roots.some((r) => within(r, cwd)) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new ToolFail("cwd must be an existing folder inside roots (see list_agents).");
    const title = String(args.title ?? "").trim().slice(0, 120);
    const m = h.store.create(owner, agent.id, cwd, title || "New session");
    const l = h.openSession(m);
    l.ensureRunning().catch((e) => l.emit({ type: "error", message: String((e as Error)?.message ?? e) }));
    return { session: sessionStatus(h, m, true) };
  }
  if (name === "rename_session") {
    const m = findSession(h, owner, args.sessionId);
    const title = typeof args.title === "string" ? args.title.trim().slice(0, 120) : "";
    if (!title) throw new ToolFail("title is required.");
    m.title = title;
    h.store.save(m);
    h.live.get(m.id)?.emit({ type: "state", state: m.state, title: m.title });
    return { session: sessionStatus(h, m, true) };
  }
  if (name === "close_session") {
    const m = findSession(h, owner, args.sessionId);
    const l = h.live.get(m.id);
    if (l && l.meta.owner === owner) { await l.terminate(); h.live.delete(m.id); }
    else if (m.state !== "exited") { m.state = "exited"; h.store.save(m); }
    if (args.purge === true) h.store.remove(m);
    return { ok: true, id: m.id, purged: args.purge === true };
  }
  if (name === "send_prompt") {
    const m = findSession(h, owner, args.sessionId);
    if (m.state === "exited") throw new ToolFail("That session is closed. create_session to start another.");
    const text = typeof args.text === "string" ? args.text : "";
    if (!text.trim()) throw new ToolFail("text is required.");
    if (text.length > 100_000) throw new ToolFail("text is too long (100000 characters).");
    const l = h.openSession(m);
    let queued = false;
    try { queued = l.submit([{ type: "text", text }]).queued; }
    catch (e) { if (e instanceof QueueError) throw new ToolFail(e.message); throw e; }
    const session = sessionStatus(h, l.meta, true);
    return { accepted: true, queued, cursor: session.cursor, session, next: "Call poll_events with this sessionId and since set to cursor until busy is false." };
  }
  if (name === "poll_events") {
    const m = findSession(h, owner, args.sessionId);
    const since = args.since === undefined ? 0 : args.since;
    if (typeof since !== "number" || !Number.isInteger(since) || since < 0) throw new ToolFail("since must be an integer cursor, 0 or greater.");
    const sum = summarizeTranscript(h.store.read(m, since));
    const session = sessionStatus(h, m, true);
    const cursor = sum.events.length > 0 || sum.hasMore ? sum.cursor : Math.max(since, sum.cursor);
    return { ...session, events: sum.events, cursor, hasMore: sum.hasMore };
  }
  if (name === "cancel_prompt") {
    const m = findSession(h, owner, args.sessionId);
    if (m.state === "exited") throw new ToolFail("That session is closed.");
    const l = h.openSession(m);
    // Don't sit on a wedged agent. A late failure is swallowed so it can't become an unhandled rejection.
    const done = l.cancel().then(() => "ok" as const, (e) => e);
    const winner = await Promise.race([done, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 3000))]);
    if (winner !== "ok" && winner !== "timeout") throw new ToolFail(String((winner as Error)?.message ?? winner));
    return { ok: true, session: sessionStatus(h, l.meta, true) };
  }
  if (name === "answer_permission") {
    const m = findSession(h, owner, args.sessionId);
    const l = h.live.get(m.id);
    if (!l) throw new ToolFail("That session has no permission waiting.");
    const id = typeof args.permissionId === "string" ? args.permissionId : "";
    const optionId = typeof args.optionId === "string" && args.optionId ? args.optionId : null;
    if (!l.answerPermission(id, optionId)) throw new ToolFail("That permission is no longer waiting. poll_events to see the current ones.");
    return { ok: true, session: sessionStatus(h, l.meta, true) };
  }
  if (name === "resume_queue") {
    const m = findSession(h, owner, args.sessionId);
    if (m.state === "exited") throw new ToolFail("That session is closed.");
    const l = h.openSession(m);
    l.resumeQueue();
    return { ok: true, session: sessionStatus(h, l.meta, true) };
  }
  return null;
}

// ---- JSON-RPC / streamable HTTP ----

const BASE_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY" };
const hdr = (req: IncomingMessage, name: string) => { const v = req.headers[name]; return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined; };

function decodeHeader(v: string): string | { error: string } {
  const m = /^=\?base64\?([A-Za-z0-9+/]+=*)\?=$/.exec(v);
  if (!m) return /[\u0000-\u001f\u007f]/.test(v) ? { error: "header value has invalid characters" } : v;
  try { return Buffer.from(m[1], "base64").toString("utf8"); } catch { return { error: "header value is not valid base64" }; }
}

function serverMeta() { return { [SERVER_INFO_KEY]: { name: "hearth", version: VERSION } }; }
function stamp(era: "legacy" | "modern", result: Record<string, unknown>) {
  if (era !== "modern") return result;
  return { resultType: "complete", ...result, _meta: { ...serverMeta(), ...asObj(result._meta) } };
}

type RpcErr = { status: number; code: number; message: string; data?: unknown };
function metaVersion(msg: Record<string, unknown>): string | undefined {
  const v = asObj(asObj(msg.params)?._meta)?.[PROTO_KEY];
  return typeof v === "string" ? v : undefined;
}

function classify(req: IncomingMessage, msg: Record<string, unknown>): { era: "legacy" | "modern"; version: string } | { error: RpcErr } {
  const header = hdr(req, "mcp-protocol-version");
  const metaV = metaVersion(msg);
  const method = typeof msg.method === "string" ? msg.method : "";
  const mismatch = (message: string): RpcErr => ({ status: 400, code: -32020, message });
  const methodHeader = () => {
    const raw = hdr(req, "mcp-method");
    if (!raw) return undefined;
    const d = decodeHeader(raw);
    return typeof d === "string" ? d : { error: d.error };
  };
  if (header && metaV && header !== metaV) return { error: mismatch("MCP-Protocol-Version does not match the _meta protocol version.") };
  const mh = methodHeader();
  if (mh && typeof mh !== "string") return { error: mismatch(mh.error) };
  if (typeof mh === "string" && mh !== method) return { error: mismatch(`Mcp-Method header '${mh}' does not match body method '${method}'.`) };
  if (method === "initialize" || method === "notifications/initialized") {
    const asked = asObj(msg.params)?.protocolVersion;
    const version = typeof asked === "string" && (MCP_LEGACY_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_LEGACY_VERSIONS[0];
    return { era: "legacy", version };
  }
  if (method === "server/discover") {
    const v = header || metaV;
    if (v && !MCP_PROTOCOL_VERSIONS.includes(v)) return { error: { status: 400, code: -32022, message: `Unsupported protocol version ${v}.`, data: { supported: [...MCP_PROTOCOL_VERSIONS], requested: v } } };
    return { era: "modern", version: MCP_MODERN_VERSION };
  }
  const version = header || metaV || "2025-03-26";
  if (!MCP_PROTOCOL_VERSIONS.includes(version)) return { error: { status: 400, code: -32022, message: `Unsupported protocol version ${version}.`, data: { supported: [...MCP_PROTOCOL_VERSIONS], requested: version } } };
  const modernSignal = version === MCP_MODERN_VERSION && (!!hdr(req, "mcp-method") || metaV === MCP_MODERN_VERSION);
  if (!modernSignal) return { era: "legacy", version: version === MCP_MODERN_VERSION ? MCP_LEGACY_VERSIONS[0] : version };
  if (!hdr(req, "mcp-method")) return { error: mismatch("Mcp-Method header is required for protocol 2026-07-28.") };
  if (method === "tools/call" || method === "prompts/get") {
    const name = asObj(msg.params)?.name;
    if (typeof name === "string") {
      const raw = hdr(req, "mcp-name");
      if (!raw) return { error: mismatch("Mcp-Name header is required when params.name is set.") };
      const d = decodeHeader(raw);
      if (typeof d !== "string") return { error: mismatch(d.error) };
      if (d !== name) return { error: mismatch(`Mcp-Name header '${d}' does not match params.name '${name}'.`) };
    }
  }
  return { era: "modern", version: MCP_MODERN_VERSION };
}

function presentedToken(req: IncomingMessage, url: URL): { token?: string; reject?: "query" | "bearer" | "mismatch" } {
  if ([...url.searchParams.keys()].some((k) => /^(token|access_token|mcp_token)$/i.test(k))) return { reject: "query" };
  const x = hdr(req, "x-hearth-mcp-token")?.trim() ?? "";
  const auth = hdr(req, "authorization")?.trim() ?? "";
  let bearer = "";
  if (/^Bearer\b/i.test(auth)) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
    if (!m) return { reject: "bearer" };
    bearer = m[1];
  }
  if (x && bearer && x !== bearer) return { reject: "mismatch" };
  const token = x || bearer;
  return token ? { token } : {};
}

const sseOnly = (accept: string | undefined) => !!accept && accept.includes("text/event-stream") && !accept.includes("application/json") && !accept.includes("*/*");
const acceptsRpc = (accept: string | undefined) => !accept || accept.includes("*/*") || accept.includes("application/json") || accept.includes("text/event-stream");

function writeRpc(res: ServerResponse, status: number, payload: unknown, accept: string | undefined, version?: string, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...BASE_HEADERS, ...extra };
  if (version) headers["mcp-protocol-version"] = version;
  if (sseOnly(accept)) {
    res.writeHead(status, { ...headers, "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no" });
    res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    return;
  }
  res.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
function rpcError(id: unknown, err: RpcErr) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) } };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let n = 0; const chunks: Buffer[] = [];
  for await (const c of req) { n += (c as Buffer).length; if (n > 1_000_000) throw new ToolFail("body too large"); chunks.push(c as Buffer); }
  if (!chunks.length) throw new SyntaxError("empty");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** HTTP entry for POST/GET/DELETE /mcp. Host is already the Hearth server. */
export async function handleMcp(h: McpHost, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const accept = hdr(req, "accept");
  if (!h.auth.hostOk(req)) { writeRpc(res, 421, { error: "host not allowed" }, accept); return; }
  const gate = mcpAvailability(h.cfg.mcpToken);
  if (gate) { writeRpc(res, gate.status, { error: gate.error }, accept); return; }
  const origin = hdr(req, "origin");
  if (origin && !h.cfg.allowedOrigins.includes(origin)) { writeRpc(res, 403, rpcError(null, { status: 403, code: -32000, message: "origin not allowed" }), accept); return; }
  const presented = presentedToken(req, url);
  if (presented.reject === "query") { writeRpc(res, 400, { error: "Send the MCP token in Authorization: Bearer or X-Hearth-Mcp-Token, not the query string." }, accept); return; }
  if (!presented.token || presented.reject || !tokenMatches(h.cfg.mcpToken!, presented.token)) {
    writeRpc(res, 401, { error: "unauthorized" }, accept, undefined, { "www-authenticate": 'Bearer realm="hearth"' });
    return;
  }
  if (req.method === "GET" || req.method === "DELETE" || req.method === "HEAD" || req.method === "OPTIONS") {
    res.writeHead(405, { ...BASE_HEADERS, allow: "POST", "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "This MCP endpoint accepts POST. It does not open a standalone event stream." }));
    return;
  }
  if (req.method !== "POST") { res.writeHead(405, { ...BASE_HEADERS, allow: "POST" }); res.end(); return; }
  if (!acceptsRpc(accept)) { writeRpc(res, 406, rpcError(null, { status: 406, code: -32600, message: "Accept must include application/json or text/event-stream." }), accept); return; }
  const ctype = hdr(req, "content-type");
  if (ctype && !ctype.includes("application/json")) { writeRpc(res, 415, rpcError(null, { status: 415, code: -32600, message: "Content-Type must be application/json." }), accept); return; }

  let parsed: unknown;
  try { parsed = await readBody(req); }
  catch (e) {
    const tooBig = e instanceof ToolFail;
    writeRpc(res, tooBig ? 413 : 400, rpcError(null, { status: 400, code: tooBig ? -32600 : -32700, message: tooBig ? e.message : "Parse error" }), accept);
    return;
  }
  const msg = asObj(parsed);
  if (Array.isArray(parsed) || !msg) { writeRpc(res, 400, rpcError(null, { status: 400, code: -32600, message: "Expected one JSON-RPC object." }), accept); return; }
  const id = msg.id;
  const hasId = "id" in msg && (typeof id === "string" || typeof id === "number");
  if ("id" in msg && msg.id === null) { writeRpc(res, 400, rpcError(null, { status: 400, code: -32600, message: "Invalid Request" }), accept); return; }
  if (typeof msg.method !== "string") {
    // A client response (result/error, no method): the 2025 transport accepts it and returns 202.
    if ("result" in msg || "error" in msg || !("id" in msg)) { res.writeHead(202, { ...BASE_HEADERS, "content-length": "0" }); res.end(); return; }
    writeRpc(res, 400, rpcError(null, { status: 400, code: -32600, message: "Invalid Request" }), accept);
    return;
  }
  if (!hasId) { res.writeHead(202, { ...BASE_HEADERS, "content-length": "0" }); res.end(); return; }

  const cls = classify(req, msg);
  if ("error" in cls) { writeRpc(res, cls.error.status, rpcError(id, cls.error), accept); return; }
  const era = cls.era;
  const finish = (status: number, result: Record<string, unknown>) => writeRpc(res, status, { jsonrpc: "2.0", id, result: stamp(era, result) }, accept, cls.version);
  const fail = (status: number, code: number, message: string) => writeRpc(res, status, rpcError(id, { status, code, message }), accept, cls.version);
  const params = asObj(msg.params) ?? {};
  try {
    if (msg.method === "initialize") {
      finish(200, { protocolVersion: cls.version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "hearth", version: VERSION }, instructions: MCP_INSTRUCTIONS });
      return;
    }
    if (msg.method === "server/discover") {
      finish(200, { supportedVersions: [...MCP_PROTOCOL_VERSIONS], capabilities: { tools: { listChanged: false } }, instructions: MCP_INSTRUCTIONS, ...LIST_CACHE });
      return;
    }
    if (msg.method === "ping") { if (era === "modern") { fail(404, -32601, "Method not found: ping"); return; } finish(200, {}); return; }
    if (msg.method === "tools/list") { finish(200, { ...LIST_CACHE, tools: params.cursor ? [] : MCP_TOOLS }); return; }
    if (msg.method === "prompts/list") { finish(200, { ...LIST_CACHE, prompts: [] }); return; }
    if (msg.method === "resources/list") { finish(200, { ...LIST_CACHE, resources: [] }); return; }
    if (msg.method === "tools/call") {
      const name = params.name;
      if (typeof name !== "string" || !MCP_TOOLS.some((t) => t.name === name)) { finish(200, { content: [{ type: "text", text: "Unknown tool." }], isError: true }); return; }
      const args = params.arguments === undefined ? {} : asObj(params.arguments);
      if (!args) { fail(200, -32602, "tools/call arguments must be an object."); return; }
      try {
        const data = await callTool(h, name, args);
        finish(200, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data, isError: false });
      } catch (e) {
        if (e instanceof ToolFail) { finish(200, { content: [{ type: "text", text: e.message }], structuredContent: { message: e.message }, isError: true }); return; }
        throw e;
      }
      return;
    }
    fail(era === "modern" ? 404 : 200, -32601, `Method not found: ${msg.method}`);
  } catch (e) {
    fail(200, -32603, String((e as Error)?.message ?? e).slice(0, 500));
  }
}
