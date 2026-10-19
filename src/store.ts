import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionMeta {
  id: string;
  owner: string;          // identity (e.g. email); sessions are visible only to this owner
  agentId: string;
  cwd: string;
  title: string;
  createdAt: string;
  lastActivity: string;
  agentSessionId?: string; // the agent's own session id (for session/load)
  state: "running" | "idle" | "stopped" | "exited";
  seq: number;             // last transcript seq written
  /** For imported sessions: false until the agent's own history has been replayed into the transcript once. */
  seeded?: boolean;
  importedFrom?: { agentSessionId: string; via: "load" | "resume" | "pending" };
  /** Last known agent settings (config options / modes / models), so the UI can show them before the agent restarts. */
  settings?: import("./settings.js").RawSettings;
}
/** Per-user, per-agent preferred settings used as defaults for new sessions: { [agentId]: { [optionId]: value } } */
export type Prefs = Record<string, Record<string, string | boolean>>;

export interface TranscriptEntry {
  seq: number;
  ts: string;
  /** "out" = daemon -> agent, "in" = agent -> daemon, "sys" = daemon events */
  dir: "in" | "out" | "sys";
  msg: unknown;
}

/** Per-user directories: <data>/users/<sha256(owner)[:16]>/sessions/<id>/{meta.json,transcript.jsonl} */
export class Store {
  constructor(readonly root: string) { mkdirSync(root, { recursive: true, mode: 0o700 }); }

  userDir(owner: string) {
    const h = createHash("sha256").update(owner).digest("hex").slice(0, 16);
    return join(this.root, "users", h, "sessions");
  }
  dir(owner: string, id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("bad session id");
    return join(this.userDir(owner), id);
  }

  create(owner: string, agentId: string, cwd: string, title: string): SessionMeta {
    const now = new Date().toISOString();
    const m: SessionMeta = { id: randomUUID(), owner, agentId, cwd, title, createdAt: now, lastActivity: now, state: "idle", seq: 0 };
    mkdirSync(this.dir(owner, m.id), { recursive: true, mode: 0o700 });
    this.save(m);
    return m;
  }

  save(m: SessionMeta) {
    const p = join(this.dir(m.owner, m.id), "meta.json");
    writeFileSync(p + ".tmp", JSON.stringify(m, null, 2), { mode: 0o600 });
    renameSync(p + ".tmp", p);
  }

  get(owner: string, id: string): SessionMeta | null {
    try {
      const m = JSON.parse(readFileSync(join(this.dir(owner, id), "meta.json"), "utf8")) as SessionMeta;
      return m.owner === owner ? m : null;
    } catch { return null; }
  }

  list(owner: string): SessionMeta[] {
    const d = this.userDir(owner);
    if (!existsSync(d)) return [];
    
    return readdirSync(d).map((id) => this.get(owner, id)).filter((m): m is SessionMeta => !!m)
      .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }

  /** All sessions of all users (daemon-internal use only, e.g. restart bookkeeping). */
  all(): SessionMeta[] {
    
    const base = join(this.root, "users");
    if (!existsSync(base)) return [];
    const out: SessionMeta[] = [];
    for (const u of readdirSync(base)) for (const id of existsSync(join(base, u, "sessions")) ? readdirSync(join(base, u, "sessions")) : []) {
      try { out.push(JSON.parse(readFileSync(join(base, u, "sessions", id, "meta.json"), "utf8"))); } catch { /* skip */ }
    }
    return out;
  }

  append(m: SessionMeta, dir: TranscriptEntry["dir"], msg: unknown): TranscriptEntry {
    const e: TranscriptEntry = { seq: ++m.seq, ts: new Date().toISOString(), dir, msg };
    appendFileSync(join(this.dir(m.owner, m.id), "transcript.jsonl"), JSON.stringify(e) + "\n", { mode: 0o600 });
    return e;
  }

  read(m: SessionMeta, since = 0): TranscriptEntry[] {
    const p = join(this.dir(m.owner, m.id), "transcript.jsonl");
    if (!existsSync(p)) return [];
    const out: TranscriptEntry[] = [];
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line) continue;
      try { const e = JSON.parse(line) as TranscriptEntry; if (e.seq > since) out.push(e); } catch { /* torn line */ }
    }
    return out;
  }

  getPrefs(owner: string): Prefs {
    try { return JSON.parse(readFileSync(join(this.userDir(owner), "..", "prefs.json"), "utf8")) as Prefs; } catch { return {}; }
  }
  setPref(owner: string, agentId: string, optionId: string, value: string | boolean) {
    const p = this.getPrefs(owner); (p[agentId] ??= {})[optionId] = value;
    const f = join(this.userDir(owner), "..", "prefs.json");
    mkdirSync(join(this.userDir(owner), ".."), { recursive: true, mode: 0o700 });
    writeFileSync(f + ".tmp", JSON.stringify(p, null, 2), { mode: 0o600 }); renameSync(f + ".tmp", f);
  }

  remove(m: SessionMeta) { rmSync(this.dir(m.owner, m.id), { recursive: true, force: true }); }
}

const CHUNK = new Set(["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"]);
/**
 * Display-time repair for transcripts written while an agent delivered every update 2-3x (an agent subscribed to the
 * session twice; fixed in 0.3.1). Within each prompt turn, if *every* chunk appears in runs of exactly k identical
 * consecutive copies (k = 2 or 3, at least 4 distinct chunks), keep one copy of each. Files on disk are untouched.
 */
export function dedupeFanout(items: TranscriptEntry[]): TranscriptEntry[] {
  const key = (e: TranscriptEntry) => { const m = e.msg as { method?: string; params?: { update?: { sessionUpdate?: string } } }; return m?.method === "session/update" && CHUNK.has(String(m.params?.update?.sessionUpdate)) ? JSON.stringify(m.params) : null; };
  const drop = new Set<number>();
  const turns: TranscriptEntry[][] = [[]];
  for (const e of items) { const m = e.msg as { method?: string }; if (e.dir === "out" && m?.method === "session/prompt") turns.push([]); if (key(e)) turns.at(-1)!.push(e); }
  for (const t of turns) {
    for (const k of [3, 2]) {
      if (t.length < 4 * k || t.length % k) continue;
      let ok = true;
      for (let i = 0; i < t.length && ok; i += k) { const a = key(t[i]); for (let j = 1; j < k; j++) if (key(t[i + j]) !== a) ok = false; if (i + k < t.length && key(t[i + k]) === a) ok = false; }
      if (ok) { for (let i = 0; i < t.length; i += k) for (let j = 1; j < k; j++) drop.add(t[i + j].seq); break; }
    }
  }
  return drop.size ? items.filter((e) => !drop.has(e.seq)) : items;
}
