import { createWriteStream, realpathSync, type Dirent, type Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
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

export class FilesError extends Error { log = false; constructor(readonly status: number, msg: string) { super(msg); } }

/** RFC 5987 value for `filename*`: encodeURIComponent plus the few characters it leaves alone but the grammar forbids. */
export function encodeRFC5987(n: string): string {
  return encodeURIComponent(n).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Turn an error from opening/reading a file into a status and a message a person can act on. */
export function readError(e: unknown): FilesError {
  if (e instanceof FilesError) return e;
  const fe = readError0(e); fe.log = true; fe.message += ` [${(e as NodeJS.ErrnoException)?.code ?? "error"}]`; return fe;
}
function readError0(e: unknown): FilesError {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "EPERM" && process.platform === "darwin")
    return new FilesError(403, "macOS is blocking Hearth from reading this file. In System Settings > Privacy & Security, give the app Hearth runs under (node or hearth) Full Disk Access, or access to this folder, then restart Hearth.");
  if (code === "EACCES" || code === "EPERM") return new FilesError(403, "permission denied: the account Hearth runs as can't read this file");
  if (code === "ENOENT") return new FilesError(404, "not found");
  if (code === "EDEADLK" || code === "ETIMEDOUT" || code === "EAGAIN")
    return new FilesError(503, "this file isn't stored on this computer right now (for example an iCloud placeholder that hasn't downloaded); open it once on the Mac, then try again");
  if (code === "EISDIR") return new FilesError(400, "not a file");
  return new FilesError(500, `couldn't read the file (${code ?? (e as Error)?.message ?? "error"})`);
}

export function validName(n: string): boolean {
  return typeof n === "string" && n.length > 0 && n.length <= 255 && n !== "." && n !== ".." && !/[/\\\0]/.test(n) && !n.includes(".hearth-upload-");
}

/** File-system calls the file browser makes, all asynchronous (overridable in tests). */
export interface FilesFs {
  realpath(p: string): Promise<string>;
  stat(p: string): Promise<Stats>;
  readdir(p: string): Promise<Dirent[]>;
  mkdir(p: string): Promise<unknown>;
  rename(a: string, b: string): Promise<void>;
  rm(p: string): Promise<void>;
  open(p: string): Promise<FileHandle>;
}
const realFs: FilesFs = {
  realpath: (p) => fsp.realpath(p), stat: (p) => fsp.stat(p), readdir: (p) => fsp.readdir(p, { withFileTypes: true }),
  mkdir: (p) => fsp.mkdir(p), rename: (a, b) => fsp.rename(a, b), rm: (p) => fsp.rm(p, { force: true }), open: (p) => fsp.open(p, "r"),
};

export const SLOW_MSG = "this folder or file is taking too long to open. On a Mac this usually means macOS is showing a privacy prompt on the Mac's screen " +
  "(\"node would like to access files in…\"): click Allow there, or give node Full Disk Access in System Settings > Privacy & Security. Cloud folders " +
  "(iCloud Drive, Google Drive, Dropbox, network drives) can also be slow while they download.";

/**
 * The file browser. Every file-system call is asynchronous (runs on libuv's thread pool, never on the main thread) and
 * has a deadline: on macOS a read in a protected folder (Desktop, Documents, Downloads, cloud and network folders) can
 * block until someone answers a privacy prompt on the Mac's screen, and a synchronous call there froze the whole server
 * (every page, the agents, health checks). A call past its deadline answers 504 with an explanation; calls still stuck
 * are counted, and while several are stuck new file requests are refused at once, so the thread pool (also used for
 * DNS, crypto and session storage) is never used up.
 */
export class Files {
  stuck = 0;
  readonly root: string; readonly timeoutMs: number; readonly maxStuck: number;
  private fs: FilesFs;
  /** The root itself is resolved once at startup (the home folder isn't privacy-protected). */
  constructor(root: string, o: { fs?: FilesFs; timeoutMs?: number; maxStuck?: number } = {}) {
    this.root = realpathSync(root); this.fs = o.fs ?? realFs; this.timeoutMs = o.timeoutMs ?? 15000; this.maxStuck = o.maxStuck ?? 3;
  }

  /** Run one file-system call with the deadline and stuck accounting. */
  private op<T>(p: () => Promise<T>): Promise<T> {
    if (this.stuck >= this.maxStuck) return Promise.reject(new FilesError(503, `waiting on ${this.stuck} earlier file requests that are still stuck; ${SLOW_MSG}`));
    const run = p();
    return new Promise<T>((res, rej) => {
      let late = false;
      const t = setTimeout(() => { late = true; this.stuck++; const fe = new FilesError(504, SLOW_MSG); fe.log = true; rej(fe); }, this.timeoutMs);
      run.then((v) => { clearTimeout(t); if (late) { this.stuck--; if (v && typeof (v as { close?: unknown }).close === "function") void (v as unknown as FileHandle).close().catch(() => {}); } else res(v); },
        (e) => { clearTimeout(t); if (late) this.stuck--; else rej(e); });
    });
  }
  private stat(p: string) { return this.op(() => this.fs.stat(p)); }
  private statOrNull(p: string) { return this.stat(p).catch((e) => { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }); }

  /** Resolve a root-relative path; throws 403 if it (or what it links to) leaves the root. `mustExist` false allows a new leaf. */
  async resolve(rel: string, mustExist = true): Promise<string> {
    const r = String(rel ?? "");
    if (r.length > 4096 || r.includes("\0")) throw new FilesError(400, "bad path");
    const abs = resolve(this.root, "." + sep + r.replace(/^[/\\]+/, ""));
    if (!this.inside(abs)) throw new FilesError(403, "outside the files folder");
    let real: string;
    try { real = await this.op(() => this.fs.realpath(abs)); }
    catch (e) {
      if (e instanceof FilesError) throw e;
      if (mustExist) throw readError(e).status === 403 ? readError(e) : new FilesError(404, "not found");
      let parent: string;
      try { parent = await this.op(() => this.fs.realpath(resolve(abs, ".."))); } catch (e2) { if (e2 instanceof FilesError) throw e2; throw new FilesError(404, "folder not found"); }
      if (!this.inside(parent)) throw new FilesError(403, "outside the files folder");
      return join(parent, basename(abs));
    }
    if (!this.inside(real)) throw new FilesError(403, "outside the files folder");
    return real;
  }
  private inside(p: string) { const rel = relative(this.root, p); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); }
  rel(abs: string) { return relative(this.root, abs).split(sep).join("/"); }

  async list(rel: string, hidden = false) {
    const dir = await this.resolve(rel);
    let ents: Dirent[];
    try {
      if (!(await this.stat(dir)).isDirectory()) throw new FilesError(400, "not a folder");
      ents = await this.op(() => this.fs.readdir(dir));
    } catch (e) { throw readError(e); }
    ents = ents.filter((d) => (hidden || !d.name.startsWith(".")) && !d.name.includes(".hearth-upload-"));
    type Entry = { name: string; dir: boolean; size: number | null; mtime: string; link?: boolean };
    const out: (Entry | null)[] = new Array(ents.length).fill(null);
    // Stat entries a few at a time (each still has the deadline); one entry that can't be read is just left out.
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < ents.length; i = next++) {
        const d = ents[i], p = join(dir, d.name);
        let st: Stats;
        try { st = await this.stat(p); } catch (e) { if (e instanceof FilesError && e.status >= 503) throw e; continue; } // broken symlink etc.
        if (d.isSymbolicLink()) { try { if (!this.inside(await this.op(() => this.fs.realpath(p)))) continue; } catch (e) { if (e instanceof FilesError && e.status >= 503) throw e; continue; } } // links out of the root aren't shown
        out[i] = { name: d.name, dir: st.isDirectory(), size: st.isFile() ? st.size : null, mtime: st.mtime.toISOString(), link: d.isSymbolicLink() || undefined };
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, ents.length) }, worker));
    const entries = out.filter((x): x is Entry => !!x);
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.dir ? -1 : 1));
    const r = this.rel(dir);
    return { path: r, parent: r === "" ? null : this.rel(resolve(dir, "..")), entries };
  }

  /**
   * Stream one file as an attachment. The file is opened and its first block read BEFORE any header goes out, so a
   * file that can be listed but not read (macOS privacy controls, an iCloud placeholder, another user's file) answers
   * with a real error status and message instead of a dropped connection (which a proxy such as Cloudflare Tunnel
   * turns into a 502, shown by browsers as "Site wasn't available"). Supports a single `Range` (with `If-Range`) so
   * browsers can resume an interrupted download, and `?check=1`-style preflights via `checkOnly`.
   */
  async download(rel: string, q: IncomingMessage, s: ServerResponse, headers: Record<string, string>, checkOnly = false) {
    const f = await this.resolve(rel);
    let fh: FileHandle;
    try {
      if (!(await this.stat(f)).isFile()) throw new FilesError(400, "not a file");
      fh = await this.op(() => this.fs.open(f));
    } catch (e) { throw readError(e); }
    let handedOff = false;
    try {
      const st = await this.op(() => fh.stat()), size = st.size;
      const etag = `"${size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`, lastMod = st.mtime.toUTCString();
      let start = 0, end = size - 1, partial = false;
      const range = q.headers.range, ifRange = q.headers["if-range"];
      if (typeof range === "string" && !checkOnly && (ifRange === undefined || ifRange === etag || ifRange === lastMod)) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (m && (m[1] || m[2])) {
          if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
          else { start = Math.max(0, size - Number(m[2])); }
          if (start >= size || start > end) {
            s.writeHead(416, { ...headers, "content-range": `bytes */${size}`, "cache-control": "no-store" }); s.end(); return;
          }
          partial = true;
        }
      }
      const len = size === 0 ? 0 : end - start + 1;
      const first = Buffer.alloc(Math.min(len, 64 * 1024));
      let got = 0;
      try { while (got < first.length) { const { bytesRead } = await this.op(() => fh.read(first, got, first.length - got, start + got)); if (!bytesRead) break; got += bytesRead; } }
      catch (e) { throw readError(e); }
      if (got < first.length) throw new FilesError(409, "the file changed while it was being read; try again");
      if (checkOnly) { s.writeHead(200, { ...headers, "content-type": "application/json", "cache-control": "no-store" }); s.end(JSON.stringify({ ok: true, size, name: basename(f) })); return; }
      const name = basename(f);
      const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
      s.writeHead(partial ? 206 : 200, { ...headers, "content-type": "application/octet-stream", "content-length": String(len), "cache-control": "no-store",
        "accept-ranges": "bytes", etag, "last-modified": lastMod, ...(partial ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
        "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRFC5987(name)}`, "content-security-policy": "default-src 'none'; sandbox" });
      if (q.method === "HEAD") { s.end(); return; }
      s.write(first);
      if (got >= len) { s.end(); return; }
      handedOff = true;
      // If the browser goes away mid-download, pipeline destroys the read stream, which closes the file.
      await pipeline(fh.createReadStream({ start: start + got, end, autoClose: true }), s);
    } finally { if (!handedOff) await fh.close().catch(() => {}); }
  }

  async mkdir(rel: string, name: string) {
    if (!validName(name)) throw new FilesError(400, "bad folder name");
    const parent = await this.resolve(rel);
    if (!(await this.stat(parent)).isDirectory()) throw new FilesError(400, "not a folder");
    const target = await this.resolve(this.rel(join(parent, name)), false);
    try { await this.op(() => this.fs.mkdir(target)); }
    catch (e) { if (e instanceof FilesError) throw e; const c = (e as NodeJS.ErrnoException).code; throw c === "EEXIST" ? new FilesError(409, "already exists") : readError(e); }
    return { path: this.rel(target) };
  }

  /**
   * One chunk of an upload into folder `rel` as `name`. Chunks go to a hidden temp file next to the target and must
   * arrive in order (`offset` = bytes already received; a mismatch answers 409 with the size so the client resumes).
   * The last chunk renames the temp file into place (refusing to replace an existing file unless `overwrite`).
   */
  async upload(q: IncomingMessage, o: { rel: string; name: string; id: string; offset: number; total: number; overwrite: boolean }) {
    const drain = (e: unknown) => { q.resume(); throw e; };
    if (!validName(o.name)) drain(new FilesError(400, "bad file name"));
    if (!/^[a-z0-9]{8,40}$/.test(o.id)) drain(new FilesError(400, "bad upload id"));
    if (!Number.isSafeInteger(o.total) || o.total < 0 || !Number.isSafeInteger(o.offset) || o.offset < 0 || o.offset > o.total) drain(new FilesError(400, "bad offset/total"));
    let dir: string, target: string, tmp: string;
    try {
      dir = await this.resolve(o.rel);
      if (!(await this.stat(dir)).isDirectory()) throw new FilesError(400, "not a folder");
      target = await this.resolve(this.rel(join(dir, o.name)), false);
      const exists = await this.statOrNull(target);
      if (exists?.isDirectory()) throw new FilesError(409, "a folder with that name exists");
      if (exists && !o.overwrite) throw new FilesError(409, "exists");
      tmp = join(dir, `.${o.name.slice(0, 180)}.hearth-upload-${o.id}`);
      const have = (await this.statOrNull(tmp))?.size ?? 0;
      if (have !== o.offset) throw Object.assign(new FilesError(409, "offset mismatch"), { have });
    } catch (e) { return drain(e instanceof FilesError ? e : readError(e)); }
    const room = Math.min(MAX_CHUNK, o.total - o.offset); let n = 0;
    const limit = new Transform({ transform(c: Buffer, _e, cb) { n += c.length; if (n > room) cb(new FilesError(413, "chunk too large")); else cb(null, c); } });
    try { await pipeline(q, limit, createWriteStream(tmp, { flags: o.offset === 0 ? "w" : "a" })); }
    catch (e) { if (o.offset === 0) await this.op(() => this.fs.rm(tmp)).catch(() => {}); throw e instanceof FilesError ? e : new FilesError(400, "upload interrupted"); }
    const size = o.offset + n;
    if (size < o.total) return { received: size, done: false };
    if ((await this.statOrNull(target)) && !o.overwrite) { await this.op(() => this.fs.rm(tmp)).catch(() => {}); throw new FilesError(409, "exists"); }
    await this.op(() => this.fs.rename(tmp, target));
    return { received: size, done: true, path: this.rel(target) };
  }
}
