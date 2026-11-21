import type { TranscriptEntry } from "./store.js";

/**
 * Turns added to an agent's own session outside Hearth (for example the user resumed it in the agent's CLI).
 *
 * When Hearth restarts an agent for a session it already has, it loads the session again (session/load), and the
 * agent replays its whole history. Hearth used to drop that replay because the history is "already in our
 * transcript", so anything added outside Hearth never showed up. Instead, the replay is split into turns (a turn
 * starts at a user message) and compared with the turns Hearth already has; only the newer ones are appended.
 */
type Upd = { method?: string; params?: { update?: { sessionUpdate?: string; content?: unknown }; prompt?: unknown } };

export interface ReplayTurn { user: string; msgs: unknown[] }

export function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(contentText).join("");
  if (c && typeof c === "object") { const o = c as { type?: string; text?: unknown }; if (typeof o.text === "string") return o.text; }
  return "";
}
const kind = (m: unknown) => { const u = m as Upd; return u?.method === "session/update" ? String(u.params?.update?.sessionUpdate ?? "") : ""; };
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Split replayed session/update notifications into turns. Updates before the first user message are dropped. */
export function splitTurns(msgs: unknown[]): ReplayTurn[] {
  const out: ReplayTurn[] = []; let prev = "";
  for (const m of msgs) {
    const k = kind(m);
    if (k === "user_message_chunk") {
      if (prev !== "user_message_chunk") out.push({ user: "", msgs: [] });
      out.at(-1)!.user += contentText((m as Upd).params?.update?.content);
    }
    if (out.length) out.at(-1)!.msgs.push(m);
    prev = k;
  }
  return out;
}

/**
 * How many turns a Hearth transcript already holds, and the text of the newest user message: each prompt Hearth sent,
 * plus each run of user messages the agent replayed (an import, an earlier sync). A user message the agent echoes right
 * after a Hearth prompt is that prompt, not another turn.
 */
export function knownTurns(entries: TranscriptEntry[]): { count: number; lastUser: string } {
  let count = 0, lastUser = "", prev = "", afterPrompt = false, counting = false;
  for (const e of entries) {
    const m = e.msg as Upd;
    if (e.dir === "out" && m?.method === "session/prompt") { count++; lastUser = contentText(m.params?.prompt); afterPrompt = true; prev = ""; continue; }
    if (e.dir !== "in") continue;
    const k = kind(m);
    if (!k) continue;
    if (k === "user_message_chunk") {
      const t = contentText(m.params?.update?.content);
      if (prev !== k) { counting = !afterPrompt; if (counting) { count++; lastUser = ""; } }
      if (counting) lastUser += t;
    } else afterPrompt = false;
    prev = k;
  }
  return { count, lastUser };
}

/** The replayed turns that come after what the transcript already has (none when they can't be told apart safely). */
export function newTurns(replay: unknown[], entries: TranscriptEntry[]): ReplayTurn[] {
  const turns = splitTurns(replay);
  const { count: k, lastUser } = knownTurns(entries);
  if (!turns.length) return [];
  if (k === 0) return turns;
  const want = norm(lastUser);
  const same = (t: ReplayTurn) => { const u = norm(t.user); return !!u && !!want && (u === want || u.startsWith(want) || want.startsWith(u)); };
  if (k <= turns.length && same(turns[k - 1])) return turns.slice(k);
  // Counts disagree (a prompt the agent never recorded, a turn it merged): anchor on the newest known user message.
  let best = -1;
  turns.forEach((t, i) => { if (same(t) && (best < 0 || Math.abs(i - (k - 1)) <= Math.abs(best - (k - 1)))) best = i; });
  if (best >= 0) return turns.slice(best + 1);
  return turns.length > k ? turns.slice(k) : [];
}
