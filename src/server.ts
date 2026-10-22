import { readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { type AgentDef, deepProbe, loadAgents, probe } from "./agents.js";
import { Auth, type AuthConfig, parseUserAliases } from "./auth.js";
import { listExternal } from "./importer.js";
import { installInfo, isSea } from "./install-info.js";
import { dataDir } from "./platform.js";
import { pidFile } from "./service.js";
import { cmpVer, latestRelease, plan, type Release, spawnUpdater } from "./update.js";
import { VERSION } from "./version.js";
import { LiveSession, within } from "./session.js";
import { Files, FilesError, readError } from "./files.js";
import { DEFAULT_PUSH_HOSTS, endpointOk, Push, replyTail, snippet, validSubscription } from "./push.js";
const HISTORY_TURNS = 8;
import { dedupeFanout, type SessionMeta, Store } from "./store.js";

export interface Config extends AuthConfig {
  port: number;
  bind: string;
  roots: string[];
  agentsFile?: string;
  webDir: string;
  autoUpdate: boolean;
  /** Browser file manager (list/download/upload/new folder) confined to filesRoot. HEARTH_FILES=off disables it. */
  files: boolean;
  filesRoot: string;
  /** Deadline for one file-system call in the file browser (HEARTH_FILES_TIMEOUT_MS, default 15 s). */
  filesTimeoutMs: number;
  /** Web Push notifications (each device opts in from the UI). HEARTH_PUSH=off disables them. */
  push: boolean;
  pushSubject?: string;
  pushHosts: string[];
}

export function configFromEnv(env = process.env): Config {
  const port = Number(env.HEARTH_PORT ?? 7682);
  const dataDir = dataDirFor(env);
  const list = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    port, bind: env.HEARTH_BIND ?? "127.0.0.1", dataDir,
    roots: list(env.HEARTH_ROOTS).length ? list(env.HEARTH_ROOTS).map((r) => resolve(r)) : [homedir()],
    agentsFile: env.HEARTH_AGENTS_FILE ?? join(dataDir, "agents.json"),
    webDir: env.HEARTH_WEB_DIR ?? defaultWebDir(),
    autoUpdate: /^(on|1|true|yes)$/i.test(env.HEARTH_AUTO_UPDATE ?? ""),
    files: !/^(off|0|false|no)$/i.test(env.HEARTH_FILES ?? ""),
    filesRoot: resolve(env.HEARTH_FILES_ROOT || homedir()),
    filesTimeoutMs: Math.max(1000, Number(env.HEARTH_FILES_TIMEOUT_MS) || 15000),
    push: !/^(off|0|false|no)$/i.test(env.HEARTH_PUSH ?? ""),
    pushSubject: env.HEARTH_PUSH_SUBJECT || undefined,
    pushHosts: [...DEFAULT_PUSH_HOSTS, ...list(env.HEARTH_PUSH_HOSTS).map((h) => h.toLowerCase())],
    identity: env.HEARTH_IDENTITY ?? "single:",
    cfTeamDomain: env.HEARTH_CF_TEAM_DOMAIN, cfAud: env.HEARTH_CF_AUD,
    allowedUsers: list(env.HEARTH_ALLOWED_USERS).map((u) => u.toLowerCase()),
    userAliases: parseUserAliases(env.HEARTH_USER_ALIASES),
    password: env.HEARTH_PASSWORD ?? "off",
    unlockTtlHours: Number(env.HEARTH_UNLOCK_TTL_HOURS ?? 12),
    allowedOrigins: list(env.HEARTH_ALLOWED_ORIGINS).length ? list(env.HEARTH_ALLOWED_ORIGINS) : [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
  };
}

const dataDirFor = (env: NodeJS.ProcessEnv) => dataDir(env);
function defaultWebDir(): string { try { return fileURLToPath(new URL("../web", import.meta.url)); } catch { return ""; } }
/** Web assets: from web/ on disk, or embedded in the single-file binary. */
function webAsset(webDir: string, rel: string): Buffer | null {
  if (isSea()) {
    try {
      // Only reached inside the single-file binary (a CJS bundle, where `require` exists).
      const sea = require("node:sea") as { getAsset(k: string): ArrayBuffer };
      return Buffer.from(sea.getAsset(`web/${rel}`));
    } catch { return null; }
  }
  if (!webDir) return null;
  const file = resolve(webDir, rel);
  if (!within(webDir, file) || !statSync(file, { throwIfNoEntry: false })?.isFile()) return null;
  return readFileSync(file);
}
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const SEC_HEADERS = {
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data: blob: https:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
};
/** Image types the session-file endpoint will serve (by extension, confirmed by magic bytes). */
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml" };
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
export function sniffImage(b: Buffer, type: string): boolean {
  const at = (off: number, s: string) => b.subarray(off, off + s.length).toString("latin1") === s;
  switch (type) {
    case "image/png": return at(0, "\x89PNG\r\n\x1a\n");
    case "image/jpeg": return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/gif": return at(0, "GIF87a") || at(0, "GIF89a");
    case "image/webp": return at(0, "RIFF") && at(8, "WEBP");
    case "image/avif": return at(4, "ftyp") && ["avif", "avis", "mif1", "msf1"].some((x) => at(8, x));
    case "image/svg+xml": { const head = b.subarray(0, 4096).toString("utf8"); return !head.includes("\0") && /<svg[\s>]/i.test(head); }
    default: return false;
  }
}

export class Hearth {
  store: Store; auth: Auth; agents: AgentDef[];
  live = new Map<string, LiveSession>();
  server = createServer((q, s) => { this.http(q, s).catch((e) => this.send(s, 500, { error: String(e?.message ?? e) })); });
  wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });
  private deepCache = new Map<string, unknown>();
  private rel: { at: number; release?: Release; error?: string } = { at: 0 };
  private updating = 0; private pendingSince = 0; private autoTimer?: NodeJS.Timeout;
  files: Files | null = null; push: Push | null = null;
  /** Sockets currently looking at a session (tab visible and focused): no push for that session while > 0. */
  private viewers = new Map<string, Set<WebSocket>>();

  constructor(readonly cfg: Config) {
    this.store = new Store(cfg.dataDir);
    this.auth = new Auth(cfg);
    this.agents = loadAgents(cfg.agentsFile);
    if (cfg.files) { try { this.files = new Files(cfg.filesRoot, { timeoutMs: cfg.filesTimeoutMs }); } catch { this.files = null; } }
    if (cfg.push) {
      // VAPID "sub" must be a mailto: or https: contact; default to this server's public origin.
      const subject = cfg.pushSubject || cfg.allowedOrigins.find((o) => o.startsWith("https://")) || "https://github.com/BobStrogg/hearth";
      try { this.push = new Push(cfg.dataDir, (o) => dirname(this.store.userDir(o)), subject, cfg.pushHosts); } catch { this.push = null; }
    }
    // Daemon restart: nothing is running any more.
    for (const m of this.store.all()) if (m.state === "running" || m.state === "idle") { m.state = "stopped"; this.store.save(m); }
    this.server.on("upgrade", (req, sock, head) => { this.upgrade(req, sock as never, head).catch(() => sock.destroy()); });
  }

  listen(): Promise<number> {
    return new Promise((res) => this.server.listen(this.cfg.port, this.cfg.bind, () => {
      if (process.env.HEARTH_SERVICE) { try { writeFileSync(pidFile(), String(process.pid)); } catch { /* best effort */ } }
      if (this.cfg.autoUpdate) this.scheduleAuto(10 * 60_000);
      res((this.server.address() as { port: number }).port);
    }));
  }
  /** Cached GitHub release lookup (at most hourly unless forced). */
  async release(force = false): Promise<Release | undefined> {
    if (!force && Date.now() - this.rel.at < 3600_000) return this.rel.release;
    try { this.rel = { at: Date.now(), release: await latestRelease(8000) }; } catch (e) { this.rel = { at: Date.now(), release: this.rel.release, error: String((e as Error).message) }; }
    return this.rel.release;
  }
  /** True while any agent is mid-turn: restarting then would cut it off. */
  busy() { return [...this.live.values()].some((l) => l.turnActive || l.meta.state === "running" || l.pending.size > 0); }
  private async versionInfo(check: boolean) {
    const rel = check ? await this.release() : this.rel.release;
    const info = installInfo(); const p = plan(info);
    return { version: VERSION, latest: rel?.version ?? null, releaseUrl: rel?.url ?? null, updateAvailable: !!rel && cmpVer(rel.version, VERSION) > 0,
      method: info.method, canApply: p.canApply && !!process.env.HEARTH_SERVICE, how: p.how, autoUpdate: this.cfg.autoUpdate, updating: Date.now() - this.updating < 5 * 60_000, checkError: this.rel.error ?? null };
  }
  /** Auto-update: daily check; restart only when no agent is mid-turn, but don't wait more than 24h. */
  private scheduleAuto(ms: number) {
    clearTimeout(this.autoTimer);
    this.autoTimer = setTimeout(async () => {
      try {
        const v = await this.versionInfo(true);
        if (v.updateAvailable && v.canApply) {
          this.pendingSince ||= Date.now();
          if (!this.busy() || Date.now() - this.pendingSince > 24 * 3600_000) { this.updating = Date.now(); spawnUpdater(); return this.scheduleAuto(24 * 3600_000); }
          return this.scheduleAuto(15 * 60_000); // busy: try again soon
        }
        this.pendingSince = 0;
      } catch { /* try again tomorrow */ }
      this.scheduleAuto(24 * 3600_000 + Math.floor(Math.random() * 3600_000));
    }, ms);
    this.autoTimer.unref();
  }
  async close() {
    clearTimeout(this.autoTimer);
    if (process.env.HEARTH_SERVICE) { try { if (readFileSync(pidFile(), "utf8").trim() === String(process.pid)) rmSync(pidFile(), { force: true }); } catch { /* none */ } }
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
      this.notifyOn(l);
    }
    return l;
  }

  private watching(id: string) { return (this.viewers.get(id)?.size ?? 0) > 0; }
  /** Push "finished" (the turn ended and nothing queued runs next) and "needs approval" to the owner's devices. */
  private notifyOn(l: LiveSession) {
    if (!this.push) return;
    let tail = "";
    const url = () => `./#/s/${l.meta.id}`, topic = () => l.meta.id.replace(/-/g, "");
    l.listeners.add((e) => {
      const push = this.push!;
      if (e.type === "entry") {
        const msg = e.entry.msg as { method?: string; params?: { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } } };
        if (e.entry.dir === "out" && msg?.method === "session/prompt") tail = "";
        else if (e.entry.dir === "in" && msg?.method === "session/update" && msg.params?.update?.sessionUpdate === "agent_message_chunk" && msg.params.update.content?.type === "text")
          tail = replyTail(tail, String(msg.params.update.content.text ?? ""));
      } else if (e.type === "prompt_done" || e.type === "error") {
        if (e.type === "prompt_done" && e.stopReason === "cancelled") return; // you stopped it yourself
        const problem = e.type === "error" ? `Failed: ${e.message}` : e.stopReason !== "end_turn" ? `Stopped: ${e.stopReason}` : "";
        setTimeout(() => {
          if (l.turnActive || this.watching(l.meta.id)) return; // the queue moved on, or you're looking at it
          const q = l.queue.items.length;
          void push.notify(l.meta.owner, "done", { title: `${l.meta.title}: ${problem ? "needs a look" : "done"}`,
            body: (problem || snippet(tail) || "The agent finished.") + (q && l.queue.paused ? ` (${q} queued, paused)` : ""), url: url(), tag: `s-${l.meta.id}` }, topic()).catch(() => {});
        }, 100);
      } else if (e.type === "permission") {
        if (this.watching(l.meta.id)) return;
        const t = e.params?.toolCall?.title || "an action";
        void push.notify(l.meta.owner, "perm", { title: `${l.meta.title}: needs your approval`, body: snippet(String(t), 160), url: url(), tag: `s-${l.meta.id}` }, topic()).catch(() => {});
      }
    });
  }

  private view(m: SessionMeta) {
    const l = this.live.get(m.id);
    return { id: m.id, title: m.title, agentId: m.agentId, cwd: m.cwd, createdAt: m.createdAt, lastActivity: m.lastActivity,
      state: l?.meta.state ?? m.state, importedFrom: m.importedFrom ?? null, pendingPermissions: l?.pending.size ?? 0, seq: l?.meta.seq ?? m.seq, queued: l?.queue.items.length ?? 0 };
  }

  private async http(q: IncomingMessage, s: ServerResponse) {
    if (!this.auth.hostOk(q)) return this.send(s, 421, { error: "host not allowed" });
    const url = new URL(q.url ?? "/", "http://x");
    if (url.pathname === "/healthz") return this.send(s, 200, { ok: true, version: VERSION });
    if (!url.pathname.startsWith("/api/")) return this.static(url.pathname, s);

    const who = await this.auth.identify(q);
    if (!who) return this.send(s, 401, { error: "unauthenticated" });
    const mutating = q.method !== "GET" && q.method !== "HEAD";
    if (mutating && !this.auth.csrfOk(q)) return this.send(s, 403, { error: "csrf/origin check failed" });

    if (url.pathname === "/api/me") return this.send(s, 200, { user: who, needsPassword: this.auth.needsPassword, unlocked: this.auth.unlocked(q, who), files: !!this.files, push: !!this.push });
    if (url.pathname === "/api/unlock" && q.method === "POST") {
      const b = await this.body(q);
      if (!(await this.auth.checkPassword(who, String(b.password ?? "")))) return this.send(s, 403, { error: "wrong password" });
      return this.send(s, 200, { ok: true }, { "set-cookie": this.auth.makeCookie(who) });
    }
    if (!this.auth.unlocked(q, who)) return this.send(s, 423, { error: "locked" });

    if (url.pathname.startsWith("/api/files")) return this.filesApi(q, s, url);
    if (url.pathname.startsWith("/api/push")) return this.pushApi(q, s, url, who);
    if (url.pathname === "/api/version" && q.method === "GET") return this.send(s, 200, await this.versionInfo(url.searchParams.get("check") === "1"));
    if (url.pathname === "/api/update" && q.method === "POST") {
      // Runs the fixed `hearth update --yes` command as a detached process; takes no input.
      const v = await this.versionInfo(true);
      if (!v.updateAvailable) return this.send(s, 409, { error: "already up to date" });
      if (!v.canApply) return this.send(s, 409, { error: process.env.HEARTH_SERVICE ? `update this install with: ${v.how}` : "Hearth isn't running as a service: run `hearth update` in a terminal" });
      if (v.updating) return this.send(s, 202, { ok: true, already: true });
      this.updating = Date.now(); spawnUpdater();
      return this.send(s, 202, { ok: true, to: v.latest });
    }
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
    const fm = /^\/api\/sessions\/([a-f0-9-]{36})\/file$/.exec(url.pathname);
    if (fm && q.method === "GET") {
      const m = this.live.get(fm[1])?.meta.owner === who ? this.live.get(fm[1])!.meta : this.store.get(who, fm[1]);
      if (!m || m.owner !== who) return this.send(s, 404, { error: "not found" });
      return this.sessionImage(s, m, url.searchParams.get("path") ?? "");
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

  private async filesApi(q: IncomingMessage, s: ServerResponse, url: URL) {
    const f = this.files;
    if (!f) return this.send(s, 404, { error: "the file browser is turned off (HEARTH_FILES=off)" });
    const path = url.searchParams.get("path") ?? "";
    try {
      if (url.pathname === "/api/files" && q.method === "GET") return this.send(s, 200, { ...(await f.list(path, url.searchParams.get("hidden") === "1")), root: f.root });
      if (url.pathname === "/api/files/download" && (q.method === "GET" || q.method === "HEAD")) return await f.download(path, q, s, SEC_HEADERS, url.searchParams.get("check") === "1");
      if (url.pathname === "/api/files/mkdir" && q.method === "POST") { const b = await this.body(q); return this.send(s, 201, await f.mkdir(String(b.path ?? ""), String(b.name ?? ""))); }
      if (url.pathname === "/api/files/upload" && q.method === "POST") {
        const n = (k: string) => Number(url.searchParams.get(k) ?? NaN);
        const r = await f.upload(q, { rel: path, name: url.searchParams.get("name") ?? "", id: url.searchParams.get("id") ?? "", offset: n("offset"), total: n("total"), overwrite: url.searchParams.get("overwrite") === "1" });
        return this.send(s, r.done ? 201 : 200, r);
      }
      return this.send(s, 404, { error: "not found" });
    } catch (e) {
      if (s.headersSent) { console.error(`files: ${url.pathname} ${JSON.stringify(path)} failed mid-response: ${(e as NodeJS.ErrnoException).code ?? (e as Error)?.message}`); s.destroy(); return; }
      const fe = readError(e);
      if (fe.status >= 500 || fe.log) console.error(`files: ${url.pathname} ${JSON.stringify(path)}: ${fe.message}`);
      return this.send(s, fe.status, { error: fe.message, ...((e as unknown as { have?: number }).have !== undefined ? { have: (e as unknown as { have: number }).have } : {}) });
    }
  }

  private async pushApi(q: IncomingMessage, s: ServerResponse, url: URL, who: string) {
    const p = this.push;
    if (url.pathname === "/api/push" && q.method === "GET") return this.send(s, 200, { enabled: !!p, publicKey: p?.vapid.publicKey ?? null, devices: p ? p.store.list(who).map((x) => ({ endpointHost: new URL(x.endpoint).host, label: x.label ?? null, created: x.created, prefs: x.prefs, endpoint: x.endpoint })) : [] });
    if (!p) return this.send(s, 404, { error: "notifications are turned off (HEARTH_PUSH=off)" });
    if (q.method !== "POST") return this.send(s, 404, { error: "not found" });
    const b = await this.body(q);
    const sub = b.subscription as { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | undefined;
    if (sub?.keys) { sub.keys.p256dh = String(sub.keys.p256dh ?? "").replace(/=+$/, ""); sub.keys.auth = String(sub.keys.auth ?? "").replace(/=+$/, ""); }
    if (url.pathname === "/api/push/subscribe") {
      if (!validSubscription(sub)) return this.send(s, 400, { error: "bad subscription" });
      if (!endpointOk(sub.endpoint, p.hosts)) return this.send(s, 400, { error: "unsupported push service" });
      const pr = (b.prefs ?? {}) as { done?: unknown; perm?: unknown };
      p.store.upsert(who, { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, prefs: { done: pr.done !== false, perm: pr.perm !== false },
        created: new Date().toISOString(), label: typeof b.label === "string" ? b.label.slice(0, 60) : undefined });
      return this.send(s, 200, { ok: true });
    }
    if (url.pathname === "/api/push/unsubscribe") return this.send(s, 200, { ok: true, removed: p.store.remove(who, String(b.endpoint ?? sub?.endpoint ?? "")) });
    if (url.pathname === "/api/push/test") {
      const ep = String(b.endpoint ?? "");
      const subs = p.store.list(who).filter((x) => !ep || x.endpoint === ep);
      if (!subs.length) return this.send(s, 404, { error: "this device isn't subscribed" });
      const r = await Promise.all(subs.map((x) => p.sendOne(who, x, { title: "Hearth", body: "Test notification: this device will be told when an agent finishes or needs approval.", url: "./", tag: "hearth-test" })));
      const ok = r.every((c) => c >= 200 && c < 300);
      return this.send(s, ok ? 200 : 502, { ok, statuses: r });
    }
    return this.send(s, 404, { error: "not found" });
  }

  /**
   * An image file referenced by the agent (file:// uri, absolute or session-relative path). Only image types, only
   * inside the session's folder (symlinks resolved), content checked by magic bytes, size-capped. Served sandboxed so
   * an SVG opened directly can't run script.
   */
  private sessionImage(s: ServerResponse, m: SessionMeta, raw: string) {
    let p = raw;
    if (/^file:\/\//i.test(p)) { try { p = fileURLToPath(p); } catch { return this.send(s, 400, { error: "bad file uri" }); } }
    if (!p || p.length > 4096 || p.includes("\0")) return this.send(s, 400, { error: "bad path" });
    const abs = resolve(m.cwd, p);
    const type = IMAGE_TYPES[extname(abs).toLowerCase()];
    if (!type) return this.send(s, 415, { error: "not an image" });
    if (!within(m.cwd, abs)) return this.send(s, 403, { error: "outside the session folder" }); // before any existence check
    let real: string;
    try { real = realpathSync(abs); } catch { return this.send(s, 404, { error: "not found" }); }
    if (!within(m.cwd, real)) return this.send(s, 403, { error: "outside the session folder" });
    if (IMAGE_TYPES[extname(real).toLowerCase()] !== type) return this.send(s, 415, { error: "not an image" });
    const st = statSync(real, { throwIfNoEntry: false });
    if (!st?.isFile()) return this.send(s, 404, { error: "not found" });
    if (st.size > MAX_IMAGE_BYTES) return this.send(s, 413, { error: "image too large" });
    const buf = readFileSync(real);
    if (!sniffImage(buf, type)) return this.send(s, 415, { error: "not an image" });
    s.writeHead(200, { ...SEC_HEADERS, "content-type": type, "content-length": String(buf.length), "cache-control": "private, max-age=300",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox", "cross-origin-resource-policy": "same-origin",
      "content-disposition": `inline; filename="${basename(real).replace(/[^\w.-]/g, "_")}"` });
    s.end(buf);
  }

  private static(path: string, s: ServerResponse) {
    const rel = path === "/" ? "index.html" : path.slice(1);
    const body = /^[\w.-]+$/.test(rel) ? webAsset(this.cfg.webDir, rel) : null;
    if (!body) { s.writeHead(404, SEC_HEADERS); return s.end("not found"); }
    s.writeHead(200, { "content-type": MIME[extname(rel)] ?? "application/octet-stream", "cache-control": "no-cache", ...SEC_HEADERS });
    s.end(body);
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
    // Fresh open: only the tail (the client pages older history in on scroll). Reconnect: everything it missed.
    const page = since > 0 ? { items: this.store.read(l.meta, since), hasMore: false } : this.store.readPage(l.meta, { turns: HISTORY_TURNS });
    const rawItems = page.items;
    const items = dedupeFanout(rawItems);
    const last = rawItems.at(-1)?.seq ?? since;
    send({ type: "replay", items, hasMore: page.hasMore, firstSeq: rawItems[0]?.seq ?? null, agent: l.meta.agentId, cwd: l.meta.cwd, loadSession: !!l.caps?.agentCapabilities?.loadSession });
    send({ type: "state", state: l.meta.state, title: l.meta.title });
    send({ type: "settings", options: l.options });
    send({ type: "queue", ...l.queue.view() });
    for (const [pid, p] of l.pending) send({ type: "permission", id: pid, params: p.params });
    replaying = false;
    for (const e of buffered) { const ent = (e as { entry?: { seq: number } }).entry; if (!ent || ent.seq > last) send(e); }

    const ping = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, 25000);
    const sid = l.meta.id;
    const setVisible = (v: boolean) => {
      let set = this.viewers.get(sid);
      if (v) { if (!set) this.viewers.set(sid, set = new Set()); set.add(ws); }
      else if (set) { set.delete(ws); if (!set.size) this.viewers.delete(sid); }
    };
    ws.on("close", () => { clearInterval(ping); l.listeners.delete(listener); setVisible(false); });
    ws.on("message", async (raw) => {
      let msg: { type?: string; content?: unknown; id?: string; optionId?: string | null; text?: string; modeId?: string; configId?: string; value?: unknown; before?: unknown; to?: unknown };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      try {
        if (msg.type === "prompt") {
          const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.text ?? "") }];
          if (!content.every((c) => c && typeof c === "object" && typeof (c as { type?: unknown }).type === "string")) throw new Error("bad prompt content");
          const r = l.submit(content as never);
          if (r.queued) send({ type: "queued" });
        } else if (msg.type === "cancel") await l.cancel();
        else if (msg.type === "queue_edit" && typeof msg.id === "string") l.queue.edit(msg.id, String(msg.text ?? ""));
        else if (msg.type === "queue_move" && typeof msg.id === "string" && Number.isFinite(Number(msg.to))) l.queue.move(msg.id, Number(msg.to));
        else if (msg.type === "queue_delete" && typeof msg.id === "string") l.queue.remove(msg.id);
        else if (msg.type === "queue_clear") l.queue.clear();
        else if (msg.type === "queue_resume") l.resumeQueue();
        else if (msg.type === "queue_send_now" && typeof msg.id === "string") await l.sendNow(msg.id);
        else if (msg.type === "permission" && msg.id) l.answerPermission(msg.id, msg.optionId ?? null);
        else if (msg.type === "setOption" && typeof msg.configId === "string") await l.setOption(msg.configId, msg.value);
        else if (msg.type === "setMode" && msg.modeId) {
          const o = l.options.find((x) => x.category === "mode");
          if (o) await l.setOption(o.id, msg.modeId); else if (l.conn) await l.conn.setSessionMode({ sessionId: l.meta.agentSessionId!, modeId: msg.modeId });
        }
        else if (msg.type === "resume") await l.ensureRunning();
        else if (msg.type === "visibility") setVisible((msg as { visible?: unknown }).visible === true);
        else if (msg.type === "history" && Number.isInteger(msg.before) && (msg.before as number) > 0) {
          const pg = this.store.readPage(l.meta, { before: msg.before as number, turns: HISTORY_TURNS });
          send({ type: "history", before: msg.before, items: dedupeFanout(pg.items), hasMore: pg.hasMore });
        }
      } catch (e) { send({ type: "error", message: String((e as Error)?.message ?? e) }); }
    });
  }
}
