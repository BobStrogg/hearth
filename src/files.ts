import { createReadStream, createWriteStream, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

/**
 * Browser file manager backend: list, download, upload (chunked, resumable) and new folder, confined to one root
 * folder (by default the home folder of the account Hearth runs as). Every path is relative to the root; the real
 * path (symlinks resolved) must stay inside the real root. Downloads are always attachments (never rendered here).
 */
export const MAX_CHUNK = 96 * 1024 * 1024; // keep each request under common proxy body limits (Cloudflare free: 100 MB)

export class FilesError extends Error { constructor(readonly status: number, msg: string) { super(msg); } }

export function validName(n: string): boolean {
  return typeof n === "string" && n.length > 0 && n.length <= 255 && n !== "." && n !== ".." && !/[/\\\0]/.test(n) && !n.includes(".hearth-upload-");
}

export class Files {
  readonly root: string;
  constructor(root: string) { this.root = realpathSync(root); }

  /** Resolve a root-relative path; throws 403 if it (or what it links to) leaves the root. `mustExist` false allows a new leaf. */
  resolve(rel: string, mustExist = true): string {
    const r = String(rel ?? "");
    if (r.length > 4096 || r.includes("\0")) throw new FilesError(400, "bad path");
    const abs = resolve(this.root, "." + sep + r.replace(/^[/\\]+/, ""));
    if (!this.inside(abs)) throw new FilesError(403, "outside the files folder");
    let real: string;
    try { real = realpathSync(abs); }
    catch {
      if (mustExist) throw new FilesError(404, "not found");
      let parent: string; try { parent = realpathSync(resolve(abs, "..")); } catch { throw new FilesError(404, "folder not found"); }
      if (!this.inside(parent)) throw new FilesError(403, "outside the files folder");
      return join(parent, basename(abs));
    }
    if (!this.inside(real)) throw new FilesError(403, "outside the files folder");
    return real;
  }
  private inside(p: string) { const rel = relative(this.root, p); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); }
  rel(abs: string) { return relative(this.root, abs).split(sep).join("/"); }

  list(rel: string, hidden = false) {
    const dir = this.resolve(rel);
    if (!statSync(dir).isDirectory()) throw new FilesError(400, "not a folder");
    const entries = [];
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (!hidden && d.name.startsWith(".")) continue;
      if (d.name.includes(".hearth-upload-")) continue;
      let st; try { st = statSync(join(dir, d.name)); } catch { continue; } // broken symlink
      if (d.isSymbolicLink()) { try { if (!this.inside(realpathSync(join(dir, d.name)))) continue; } catch { continue; } } // links out of the root aren't shown
      entries.push({ name: d.name, dir: st.isDirectory(), size: st.isFile() ? st.size : null, mtime: st.mtime.toISOString(), link: d.isSymbolicLink() || undefined });
    }
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.dir ? -1 : 1));
    const r = this.rel(dir);
    return { path: r, parent: r === "" ? null : this.rel(resolve(dir, "..")), entries };
  }

  async download(rel: string, s: ServerResponse, headers: Record<string, string>) {
    const f = this.resolve(rel);
    const st = statSync(f);
    if (!st.isFile()) throw new FilesError(400, "not a file");
    const name = basename(f);
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    s.writeHead(200, { ...headers, "content-type": "application/octet-stream", "content-length": String(st.size), "cache-control": "no-store",
      "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`, "content-security-policy": "default-src 'none'; sandbox" });
    await pipeline(createReadStream(f), s);
  }

  mkdir(rel: string, name: string) {
    if (!validName(name)) throw new FilesError(400, "bad folder name");
    const parent = this.resolve(rel);
    if (!statSync(parent).isDirectory()) throw new FilesError(400, "not a folder");
    const target = this.resolve(this.rel(join(parent, name)), false);
    try { mkdirSync(target); } catch (e) { throw new FilesError((e as NodeJS.ErrnoException).code === "EEXIST" ? 409 : 500, (e as NodeJS.ErrnoException).code === "EEXIST" ? "already exists" : String((e as Error).message)); }
    return { path: this.rel(target) };
  }

  /**
   * One chunk of an upload into folder `rel` as `name`. Chunks go to a hidden temp file next to the target and must
   * arrive in order (`offset` = bytes already received; a mismatch answers 409 with the size so the client resumes).
   * The last chunk renames the temp file into place (refusing to replace an existing file unless `overwrite`).
   */
  async upload(q: IncomingMessage, o: { rel: string; name: string; id: string; offset: number; total: number; overwrite: boolean }) {
    if (!validName(o.name)) throw new FilesError(400, "bad file name");
    if (!/^[a-z0-9]{8,40}$/.test(o.id)) throw new FilesError(400, "bad upload id");
    if (!Number.isSafeInteger(o.total) || o.total < 0 || !Number.isSafeInteger(o.offset) || o.offset < 0 || o.offset > o.total) throw new FilesError(400, "bad offset/total");
    const dir = this.resolve(o.rel);
    if (!statSync(dir).isDirectory()) throw new FilesError(400, "not a folder");
    const target = this.resolve(this.rel(join(dir, o.name)), false);
    const exists = statSync(target, { throwIfNoEntry: false });
    if (exists?.isDirectory()) throw new FilesError(409, "a folder with that name exists");
    if (exists && !o.overwrite) throw new FilesError(409, "exists");
    const tmp = join(dir, `.${o.name.slice(0, 180)}.hearth-upload-${o.id}`);
    const have = statSync(tmp, { throwIfNoEntry: false })?.size ?? 0;
    if (have !== o.offset) { q.resume(); throw Object.assign(new FilesError(409, "offset mismatch"), { have }); }
    const room = Math.min(MAX_CHUNK, o.total - o.offset); let n = 0;
    const limit = new Transform({ transform(c: Buffer, _e, cb) { n += c.length; if (n > room) cb(new FilesError(413, "chunk too large")); else cb(null, c); } });
    try { await pipeline(q, limit, createWriteStream(tmp, { flags: o.offset === 0 ? "w" : "a" })); }
    catch (e) { if (o.offset === 0) rmSync(tmp, { force: true }); throw e instanceof FilesError ? e : new FilesError(400, "upload interrupted"); }
    const size = o.offset + n;
    if (size < o.total) return { received: size, done: false };
    if (statSync(target, { throwIfNoEntry: false }) && !o.overwrite) { rmSync(tmp, { force: true }); throw new FilesError(409, "exists"); }
    renameSync(tmp, target);
    return { received: size, done: true, path: this.rel(target) };
  }
}
