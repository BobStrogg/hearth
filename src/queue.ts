import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** A prompt waiting for the agent: the same ACP content blocks a direct prompt would send (text, images, …). */
export interface QueueItem { id: string; content: unknown[]; at: string }
/** What clients see: text for display/editing, a count of the other blocks (images, resources). */
export interface QueueView { items: { id: string; text: string; attachments: number; at: string }[]; paused: boolean; reason: string | null; max: number }

export const QUEUE_MAX = 10;
export const QUEUE_MAX_BYTES = 16 * 1024 * 1024; // all queued content together (images can be large)

export class QueueError extends Error {}

const textOf = (content: unknown[]) => content.filter((c) => (c as { type?: string })?.type === "text").map((c) => String((c as { text?: unknown }).text ?? "")).join("\n");

/**
 * Per-session prompt queue, persisted to <session>/queue.json so it survives reloads, other devices and restarts.
 * Writes only when the persisted state actually changes; an empty, unpaused queue has no file at all.
 */
export class PromptQueue {
  items: QueueItem[] = [];
  paused = false;
  reason: string | null = null; // why it's paused (shown to the user); not persisted
  private written = "";

  constructor(private file: string, private onChange: (v: QueueView) => void = () => {}) {
    try {
      if (existsSync(file)) {
        const raw = readFileSync(file, "utf8");
        const j = JSON.parse(raw) as { items?: QueueItem[]; paused?: boolean };
        this.items = (Array.isArray(j.items) ? j.items : []).filter((i) => i && typeof i.id === "string" && Array.isArray(i.content)).slice(0, QUEUE_MAX);
        this.paused = !!j.paused && this.items.length > 0;
        this.written = this.serialize();
        // A fresh process never has a turn in flight, so leftover items wait for Resume (in memory only: no write).
        if (this.items.length) { this.paused = true; this.reason = j.paused ? "paused" : "Hearth restarted"; }
      }
    } catch { this.items = []; this.paused = false; }
  }

  view(): QueueView {
    return { items: this.items.map((i) => ({ id: i.id, text: textOf(i.content), attachments: i.content.filter((c) => (c as { type?: string })?.type !== "text").length, at: i.at })),
      paused: this.paused, reason: this.paused ? this.reason : null, max: QUEUE_MAX };
  }

  private serialize() { return this.items.length ? JSON.stringify({ items: this.items, paused: this.paused }) : ""; }
  private commit() {
    if (!this.items.length) { this.paused = false; this.reason = null; }
    const s = this.serialize();
    if (s !== this.written) {
      if (s) { writeFileSync(this.file + ".tmp", s, { mode: 0o600 }); renameSync(this.file + ".tmp", this.file); }
      else rmSync(this.file, { force: true });
      this.written = s;
    }
    this.onChange(this.view());
  }
  private idx(id: string) { const i = this.items.findIndex((x) => x.id === id); if (i < 0) throw new QueueError("that queued prompt is gone"); return i; }

  add(content: unknown[]): QueueItem {
    if (this.items.length >= QUEUE_MAX) throw new QueueError(`The queue is full (${QUEUE_MAX} prompts). Wait for the agent, or remove a queued prompt.`);
    const bytes = this.items.reduce((n, i) => n + JSON.stringify(i.content).length, 0) + JSON.stringify(content).length;
    if (bytes > QUEUE_MAX_BYTES) throw new QueueError("The queue is full (too much attached data). Wait for the agent, or remove a queued prompt.");
    const item: QueueItem = { id: randomUUID(), content, at: new Date().toISOString() };
    this.items.push(item); this.commit();
    return item;
  }
  /** Replace the text; images and other blocks are kept. */
  edit(id: string, text: string) {
    const it = this.items[this.idx(id)];
    const t = String(text ?? "").trim();
    const others = it.content.filter((c) => (c as { type?: string })?.type !== "text");
    if (!t && !others.length) throw new QueueError("A queued prompt can't be empty: delete it instead.");
    if (t === textOf(it.content).trim()) return;
    const at = it.content.findIndex((c) => (c as { type?: string })?.type === "text");
    const next = it.content.filter((c) => (c as { type?: string })?.type !== "text");
    if (t) next.splice(at < 0 ? 0 : Math.min(at, next.length), 0, { type: "text", text: t });
    it.content = next; this.commit();
  }
  /** Move to position `to` (clamped). */
  move(id: string, to: number) {
    const from = this.idx(id);
    const dest = Math.max(0, Math.min(this.items.length - 1, Math.trunc(Number(to) || 0)));
    if (dest === from) return;
    const [it] = this.items.splice(from, 1); this.items.splice(dest, 0, it); this.commit();
  }
  remove(id: string) { this.items.splice(this.idx(id), 1); this.commit(); }
  clear() { if (this.items.length) { this.items = []; this.commit(); } }
  shift(): QueueItem | undefined { const it = this.items.shift(); if (it) this.commit(); return it; }
  setPaused(paused: boolean, reason: string | null = null) {
    const p = paused && this.items.length > 0;
    if (p === this.paused && (!p || reason === this.reason)) return;
    this.paused = p; this.reason = p ? reason : null; this.commit();
  }
}
