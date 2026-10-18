import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { type AgentDef, deepProbe, loadAgents, probe } from "./agents.js";
import { Auth, type AuthConfig } from "./auth.js";
import { listExternal } from "./importer.js";
import { LiveSession, within } from "./session.js";
import { type SessionMeta, Store } from "./store.js";

export interface Config extends AuthConfig {
  port: number;
  bind: string;
  roots: string[];
  agentsFile?: string;
  webDir: string;
}

export function configFromEnv(env = process.env): Config {
  const port = Number(env.HEARTH_PORT ?? 7682);
  const dataDir = env.HEARTH_DATA_DIR ?? join(homedir(), ".hearth");
  const list = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    port, bind: env.HEARTH_BIND ?? "127.0.0.1", dataDir,
    roots: list(env.HEARTH_ROOTS).length ? list(env.HEARTH_ROOTS).map((r) => resolve(r)) : [homedir()],
    agentsFile: env.HEARTH_AGENTS_FILE ?? join(dataDir, "agents.json"),
    webDir: env.HEARTH_WEB_DIR ?? fileURLToPath(new URL("../web", import.meta.url)),
    identity: env.HEARTH_IDENTITY ?? "single:",
    cfTeamDomain: env.HEARTH_CF_TEAM_DOMAIN, cfAud: env.HEARTH_CF_AUD,
    allowedUsers: list(env.HEARTH_ALLOWED_USERS).map((u) => u.toLowerCase()),
    password: env.HEARTH_PASSWORD ?? "off",
    unlockTtlHours: Number(env.HEARTH_UNLOCK_TTL_HOURS ?? 12),
    allowedOrigins: list(env.HEARTH_ALLOWED_ORIGINS).length ? list(env.HEARTH_ALLOWED_ORIGINS) : [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
  };
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const SEC_HEADERS = {
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
};

export class Hearth {
  store: Store; auth: Auth; agents: AgentDef[];
  live = new Map<string, LiveSession>();
  server = createServer((q, s) => { this.http(q, s).catch((e) => this.send(s, 500, { error: String(e?.message ?? e) })); });
  wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });
  private deepCache = new Map<string, unknown>();

  constructor(readonly cfg: Config) {
    this.store = new Store(cfg.dataDir);
    this.auth = new Auth(cfg);
    this.agents = loadAgents(cfg.agentsFile);
    // Daemon restart: nothing is running any more.
    for (const m of this.store.all()) if (m.state === "running" || m.state === "idle") { m.state = "stopped"; this.store.save(m); }
    this.server.on("upgrade", (req, sock, head) => { this.upgrade(req, sock as never, head).catch(() => sock.destroy()); });
  }

  listen(): Promise<number> {
    return new Promise((res) => this.server.listen(this.cfg.port, this.cfg.bind, () => res((this.server.address() as { port: number }).port)));
  }
  async close() {
    await Promise.all([...this.live.values()].map((l) => l.shutdown().catch(() => {})));
    for (const c of this.wss.clients) c.terminate();
    this.wss.close(); this.server.closeAllConnections(); await new Promise((r) => this.server.close(r));
  }

  private send(s: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) {
    s.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...SEC_HEADERS, ...headers });
    s.end(JSON.stringify(body));
  }

  private async body(q: IncomingMessage): Promise<Record<string, unknown>> {
    let n = 0; const chunks: Buffer[] = [];
    for await (const c of q) { n += c.length; if (n > 1e6) throw new Error("body too large"); chunks.push(c as Buffer); }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  }

  private liveFor(m: SessionMeta): LiveSession {
    let l = this.live.get(m.id);
    if (!l) {
      const a = this.agents.find((x) => x.id === m.agentId);
      if (!a) throw new Error(`unknown agent ${m.agentId}`);
      l = new LiveSession(m, a, this.store);
      this.live.set(m.id, l);
    }
    return l;
  }

  private view(m: SessionMeta) {
    const l = this.live.get(m.id);
    return { id: m.id, title: m.title, agentId: m.agentId, cwd: m.cwd, createdAt: m.createdAt, lastActivity: m.lastActivity,
      state: l?.meta.state ?? m.state, importedFrom: m.importedFrom ?? null, pendingPermissions: l?.pending.size ?? 0, seq: l?.meta.seq ?? m.seq };
  }

  private async http(q: IncomingMessage, s: ServerResponse) {
    if (!this.auth.hostOk(q)) return this.send(s, 421, { error: "host not allowed" });
    const url = new URL(q.url ?? "/", "http://x");
    if (!url.pathname.startsWith("/api/")) return this.static(url.pathname, s);

    const who = await this.auth.identify(q);
    if (!who) return this.send(s, 401, { error: "unauthenticated" });
    const mutating = q.method !== "GET" && q.method !== "HEAD";
    if (mutating && !this.auth.csrfOk(q)) return this.send(s, 403, { error: "csrf/origin check failed" });

    if (url.pathname === "/api/me") return this.send(s, 200, { user: who, needsPassword: this.auth.needsPassword, unlocked: this.auth.unlocked(q, who) });
    if (url.pathname === "/api/unlock" && q.method === "POST") {
      const b = await this.body(q);
      if (!(await this.auth.checkPassword(who, String(b.password ?? "")))) return this.send(s, 403, { error: "wrong password" });
      return this.send(s, 200, { ok: true }, { "set-cookie": this.auth.makeCookie(who) });
    }
    if (!this.auth.unlocked(q, who)) return this.send(s, 423, { error: "locked" });

    if (url.pathname === "/api/agents") {
      const deep = url.searchParams.get("deep");
      if (deep) {
        const a = this.agents.find((x) => x.id === deep);
        if (!a) return this.send(s, 404, { error: "no such agent" });
        const r = await deepProbe(a); this.deepCache.set(a.id, r);
        return this.send(s, 200, r);
      }
      return this.send(s, 200, probe(this.agents).map((p) => ({ ...p, path: undefined, deep: this.deepCache.get(p.id) })));
    }
    const em = /^\/api\/agents\/([a-z0-9_.-]+)\/sessions$/.exec(url.pathname);
    if (em && q.method === "GET") {
      const a = this.agents.find((x) => x.id === em[1]);
      if (!a) return this.send(s, 404, { error: "no such agent" });
      const cwd = url.searchParams.get("cwd") || undefined;
      if (cwd && !this.cfg.roots.some((r) => within(r, cwd))) return this.send(s, 403, { error: "outside allowed roots" });
      const r = await listExternal(a, { cwd });
      const mine = new Map(this.store.list(who).filter((m) => m.agentId === a.id && m.agentSessionId).map((m) => [m.agentSessionId!, m.id]));
      return this.send(s, 200, { ...r, importable: r.canLoad || r.canResume,
        sessions: r.sessions.map((x) => ({ ...x, hearthId: mine.get(x.sessionId) ?? null, allowed: !!x.cwd && this.cfg.roots.some((root) => within(root, x.cwd)) })) });
    }
    if (url.pathname === "/api/sessions/import" && q.method === "POST") {
      const b = await this.body(q);
      const agent = this.agents.find((a) => a.id === b.agentId);
      const sidExt = String(b.agentSessionId ?? "");
      if (!agent || !sidExt || sidExt.length > 200) return this.send(s, 400, { error: "agentId and agentSessionId required" });
      const cwd = resolve(String(b.cwd ?? ""));
      if (!this.cfg.roots.some((r) => within(r, cwd)) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) return this.send(s, 400, { error: "the session's folder must exist inside the allowed roots" });
      const existing = this.store.list(who).find((m) => m.agentId === agent.id && m.agentSessionId === sidExt && m.state !== "exited");
      if (existing) return this.send(s, 200, this.view(existing));
      const m = this.store.create(who, agent.id, cwd, String(b.title || "Imported session").slice(0, 120));
      m.agentSessionId = sidExt; m.seeded = false; m.importedFrom = { agentSessionId: sidExt, via: "pending" }; this.store.save(m);
      const l = this.liveFor(m);
      try { await l.ensureRunning(); }
      catch (e) {
        await l.terminate().catch(() => {}); this.live.delete(m.id); this.store.remove(m);
        return this.send(s, 502, { error: `import failed: ${String((e as Error)?.message ?? e)}` });
      }
      return this.send(s, 201, this.view(m));
    }
    if (url.pathname === "/api/fs") {
      const p = resolve(url.searchParams.get("path") || this.cfg.roots[0]);
      if (!this.cfg.roots.some((r) => within(r, p))) return this.send(s, 403, { error: "outside allowed roots", roots: this.cfg.roots });
      const dirs = readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort((a, b) => a.localeCompare(b));
      const parent = this.cfg.roots.some((r) => within(r, resolve(p, "..")) && resolve(p) !== resolve(r)) ? resolve(p, "..") : null;
      return this.send(s, 200, { path: p, parent, dirs, roots: this.cfg.roots });
    }
    if (url.pathname === "/api/sessions") {
      if (q.method === "GET") return this.send(s, 200, this.store.list(who).map((m) => this.view(m)));
      if (q.method === "POST") {
        const b = await this.body(q);
        const agent = this.agents.find((a) => a.id === b.agentId);
        if (!agent) return this.send(s, 400, { error: "unknown agent" });
        const cwd = resolve(String(b.cwd ?? ""));
        if (!this.cfg.roots.some((r) => within(r, cwd)) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) return this.send(s, 400, { error: "cwd must be an existing folder inside the allowed roots" });
        const m = this.store.create(who, agent.id, cwd, String(b.title || "New session").slice(0, 120));
        const l = this.liveFor(m);
        l.ensureRunning().catch((e) => l.emit({ type: "error", message: String(e?.message ?? e) }));
        return this.send(s, 201, this.view(m));
      }
    }
    const sm = /^\/api\/sessions\/([a-f0-9-]{36})(\/resume)?$/.exec(url.pathname);
    if (sm) {
      const m = this.live.get(sm[1])?.meta.owner === who ? this.live.get(sm[1])!.meta : this.store.get(who, sm[1]);
      if (!m || m.owner !== who) return this.send(s, 404, { error: "not found" });
      if (sm[2] && q.method === "POST") { const l = this.liveFor(m); await l.ensureRunning(); return this.send(s, 200, this.view(m)); }
      if (q.method === "GET") return this.send(s, 200, this.view(m));
      if (q.method === "PATCH") {
        const b = await this.body(q);
        if (typeof b.title === "string" && b.title.trim()) m.title = b.title.trim().slice(0, 120);
        this.store.save(m); this.live.get(m.id)?.emit({ type: "state", state: m.state, title: m.title });
        return this.send(s, 200, this.view(m));
      }
      if (q.method === "DELETE") {
        const l = this.live.get(m.id);
        if (l) { await l.terminate(); this.live.delete(m.id); } else { m.state = "exited"; this.store.save(m); }
        if (url.searchParams.get("purge") === "1") this.store.remove(m);
        return this.send(s, 200, { ok: true });
      }
    }
    return this.send(s, 404, { error: "not found" });
  }

  private static(path: string, s: ServerResponse) {
    const rel = path === "/" ? "index.html" : path.slice(1);
    const file = resolve(this.cfg.webDir, rel);
    if (!within(this.cfg.webDir, file) || !statSync(file, { throwIfNoEntry: false })?.isFile()) { s.writeHead(404, SEC_HEADERS); return s.end("not found"); }
    s.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache", ...SEC_HEADERS });
    s.end(readFileSync(file));
  }

  private async upgrade(req: IncomingMessage, sock: import("node:net").Socket, head: Buffer) {
    const deny = (code: number, msg: string) => { sock.end(`HTTP/1.1 ${code} ${msg}\r\n\r\n`); };
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/ws") return deny(404, "Not Found");
    if (!this.auth.hostOk(req) || !this.auth.originOk(req)) return deny(403, "Forbidden");
    const who = await this.auth.identify(req);
    if (!who) return deny(401, "Unauthorized");
    if (!this.auth.unlocked(req, who)) return deny(423, "Locked");
    const id = url.searchParams.get("session") ?? "";
    const m = /^[a-f0-9-]{36}$/.test(id) ? (this.live.get(id)?.meta.owner === who ? this.live.get(id)!.meta : this.store.get(who, id)) : null;
    if (!m || m.owner !== who) return deny(404, "Not Found");
    const since = Number(url.searchParams.get("since") ?? 0) || 0;
    this.wss.handleUpgrade(req, sock, head, (ws) => this.attach(ws, m, since));
  }

  private attach(ws: WebSocket, m: SessionMeta, since: number) {
    const l = this.liveFor(m);
    const send = (o: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o), { compress: false }); };
    // Replay from the transcript first, then go live. Buffer live events during replay to avoid gaps.
    const buffered: unknown[] = []; let replaying = true;
    const listener = (e: unknown) => { if (replaying) buffered.push(e); else send(e); };
    l.listeners.add(listener);
    const items = this.store.read(l.meta, since);
    const last = items.at(-1)?.seq ?? since;
    send({ type: "replay", items, agent: l.meta.agentId, cwd: l.meta.cwd, loadSession: !!l.caps?.agentCapabilities?.loadSession });
    send({ type: "state", state: l.meta.state, title: l.meta.title });
    for (const [pid, p] of l.pending) send({ type: "permission", id: pid, params: p.params });
    replaying = false;
    for (const e of buffered) { const ent = (e as { entry?: { seq: number } }).entry; if (!ent || ent.seq > last) send(e); }

    const ping = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, 25000);
    ws.on("close", () => { clearInterval(ping); l.listeners.delete(listener); });
    ws.on("message", async (raw) => {
      let msg: { type?: string; content?: unknown; id?: string; optionId?: string | null; text?: string; modeId?: string };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      try {
        if (msg.type === "prompt") {
          const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.text ?? "") }];
          l.prompt(content as never).then((r) => l.emit({ type: "prompt_done", stopReason: r.stopReason }))
            .catch((e) => send({ type: "error", message: String(e?.message ?? e) }));
        } else if (msg.type === "cancel") await l.cancel();
        else if (msg.type === "permission" && msg.id) l.answerPermission(msg.id, msg.optionId ?? null);
        else if (msg.type === "setMode" && msg.modeId && l.conn) await l.conn.setSessionMode({ sessionId: l.meta.agentSessionId!, modeId: msg.modeId });
        else if (msg.type === "resume") await l.ensureRunning();
      } catch (e) { send({ type: "error", message: String((e as Error)?.message ?? e) }); }
    });
  }
}
