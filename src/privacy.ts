import { basename } from "node:path";

/**
 * Folders Hearth couldn't open because the computer is holding them (on a Mac: a privacy prompt waiting on the
 * screen, or a denial). Shown in the chat, and as a summary in /healthz so a dashboard can say "needs permission".
 * A folder is cleared as soon as an access to it succeeds (for example the stuck one, once someone clicks Allow).
 */
export interface Blocked { folder: string; code: string; since: string; via: "agent" | "files" | "startup" }
const blocked = new Map<string, Blocked>();

export function noteBlocked(folder: string, code: string, via: Blocked["via"]) {
  if (!blocked.has(folder)) blocked.set(folder, { folder, code, since: new Date().toISOString(), via });
}
export function noteOpen(folder: string) { blocked.delete(folder); }
export function blockedFolders(): Blocked[] { return [...blocked.values()]; }
export function clearBlocked() { blocked.clear(); }

/**
 * The program macOS asks about (and that a permission must be given to): the stable launcher when Hearth runs
 * through it, otherwise the Node.js (or hearth) binary itself.
 */
export function responsibleProgram(): string { return process.env.HEARTH_LAUNCHER || process.execPath; }

/** For /healthz (no login): whether permission is needed, and only folder names, no full paths. */
export function permissionSummary(): { needed: boolean; folders?: string[]; since?: string; launcher?: boolean } {
  const b = blockedFolders();
  const launcher = !!process.env.HEARTH_LAUNCHER || undefined;
  if (!b.length) return { needed: false, launcher };
  return { needed: true, folders: b.map((x) => basename(x.folder)).slice(0, 5), since: b.map((x) => x.since).sort()[0], launcher };
}
