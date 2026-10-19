import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { which } from "./agents.js";
import { installInfo, type InstallInfo, selfCommand } from "./install-info.js";
import { dataDir } from "./platform.js";
import { serviceManager } from "./service.js";
import { VERSION } from "./version.js";

export const REPO = process.env.HEARTH_UPDATE_REPO || "BobStrogg/hearth";

/** Compare dotted versions (x.y.z, optional -pre; a pre-release sorts before its release). */
export function cmpVer(a: string, b: string): number {
  const p = (v: string) => { const [core, pre] = v.replace(/^v/, "").split("-", 2); return { n: core.split(".").map((x) => Number(x) || 0), pre }; };
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) { const d = (x.n[i] ?? 0) - (y.n[i] ?? 0); if (d) return Math.sign(d); }
  if (x.pre === y.pre) return 0; if (!x.pre) return 1; if (!y.pre) return -1; return x.pre < y.pre ? -1 : 1;
}

export interface Release { version: string; tag: string; url: string; assets: { name: string; url: string }[] }
export async function latestRelease(timeoutMs = 10000): Promise<Release> {
  const api = process.env.HEARTH_UPDATE_API || "https://api.github.com"; // override for tests / mirrors
  const r = await fetch(`${api}/repos/${REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": `hearth/${VERSION}` }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`GitHub releases: HTTP ${r.status}`);
  const j = await r.json() as { tag_name: string; html_url: string; assets: { name: string; browser_download_url: string }[] };
  return { version: j.tag_name.replace(/^v/, ""), tag: j.tag_name, url: j.html_url, assets: (j.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url })) };
}

export const binaryAsset = (v: string, platform = process.platform, arch = process.arch) =>
  `hearth-${v}-${platform === "win32" ? "win" : platform}-${arch}${platform === "win32" ? ".exe" : ""}`;
export const tarballAsset = (v: string) => `hearth-acp-${v}.tgz`;

/** What `hearth update` would do for this install. */
export function plan(info: InstallInfo = installInfo()): { canApply: boolean; how: string } {
  switch (info.method) {
    case "npm": return { canApply: true, how: `npm install -g --prefix ${info.prefix} (release tarball, sha256-verified)` };
    case "binary": return { canApply: true, how: "download the release binary (sha256-verified) and swap it in" };
    case "brew": return { canApply: false, how: "brew upgrade hearth" };
    case "npx": return { canApply: false, how: "npx always runs the latest: npx hearth-acp@latest" };
    default: return { canApply: false, how: "this is a source checkout: git pull && npm install && npm run build" };
  }
}

async function download(url: string, to: string) {
  const r = await fetch(url, { headers: { "user-agent": `hearth/${VERSION}` }, redirect: "follow", signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error(`download ${basename(to)}: HTTP ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer()); writeFileSync(to, b); return b;
}
/** Download a release asset and check it against the release's SHA256SUMS. Never returns unverified bytes. */
export async function fetchVerified(rel: Release, name: string, dir: string): Promise<string> {
  const sums = rel.assets.find((a) => a.name === "SHA256SUMS"); const asset = rel.assets.find((a) => a.name === name);
  if (!sums) throw new Error("release has no SHA256SUMS; refusing to install");
  if (!asset) throw new Error(`release ${rel.tag} has no asset ${name}`);
  const list = (await download(sums.url, join(dir, "SHA256SUMS"))).toString("utf8");
  const want = list.split("\n").map((l) => l.trim().split(/\s+\*?/)).find((p) => p[1] === name)?.[0]?.toLowerCase();
  if (!want || !/^[0-9a-f]{64}$/.test(want)) throw new Error(`SHA256SUMS has no entry for ${name}`);
  const p = join(dir, name); const got = createHash("sha256").update(await download(asset.url, p)).digest("hex");
  if (got !== want) { rmSync(p, { force: true }); throw new Error(`checksum mismatch for ${name}`); }
  return p;
}

export async function healthy(port: number, want?: string, timeoutMs = 30000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) { const j = await r.json() as { version?: string }; if (!want || j.version === want) return true; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export interface UpdateResult { from: string; to?: string; updated: boolean; message: string; rolledBack?: boolean }
type Log = (s: string) => void;

/**
 * Update in place: install the new version beside the old one, swap, restart the service, health-check, and roll back
 * if the new version doesn't come up. `force` re-installs the same version.
 */
export async function update(opts: { force?: boolean; check?: boolean; log?: Log; port?: number; restart?: boolean } = {}): Promise<UpdateResult> {
  const log = opts.log ?? ((s) => console.log(s)); const info = installInfo();
  const rel = await latestRelease();
  const newer = cmpVer(rel.version, VERSION) > 0;
  if (!newer && !opts.force) return { from: VERSION, to: rel.version, updated: false, message: `Hearth ${VERSION} is up to date (latest release ${rel.tag}).` };
  const p = plan(info);
  if (opts.check) return { from: VERSION, to: rel.version, updated: false, message: newer ? `Update available: ${VERSION} → ${rel.version}. ${p.canApply ? "Run `hearth update`." : `Update with: ${p.how}`}` : "Up to date." };
  if (!p.canApply) {
    if (info.method === "brew" && process.env.HEARTH_BREW_UPGRADE === "1" && which("brew")) {
      log("Running brew upgrade hearth…"); const r = spawnSync("brew", ["upgrade", "hearth"], { stdio: "inherit" });
      return { from: VERSION, to: rel.version, updated: r.status === 0, message: r.status === 0 ? "brew upgrade done (brew services restarts it)." : "brew upgrade failed" };
    }
    return { from: VERSION, to: rel.version, updated: false, message: `Update available: ${VERSION} → ${rel.version}. Update with: ${p.how}` };
  }
  const tmp = mkdtempSync(join(tmpdir(), "hearth-update-"));
  let undo: (() => void) | null = null;
  try {
    if (info.method === "npm") {
      const tgz = await fetchVerified(rel, tarballAsset(rel.version), tmp); log(`Verified ${basename(tgz)}`);
      const root = info.pkgRoot!; const prev = `${root}.prev`;
      rmSync(prev, { recursive: true, force: true }); cpSync(root, prev, { recursive: true });
      undo = () => { rmSync(root, { recursive: true, force: true }); renameSync(prev, root); };
      const npm = which(process.platform === "win32" ? "npm.cmd" : "npm", [dirname(process.execPath), process.env.PATH ?? ""].join(process.platform === "win32" ? ";" : ":"));
      if (!npm) throw new Error("npm not found next to node or on PATH");
      const r = spawnSync(npm, ["install", "-g", "--prefix", info.prefix!, "--no-audit", "--no-fund", tgz], { encoding: "utf8", shell: process.platform === "win32" });
      if (r.status !== 0) throw new Error(`npm install failed: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ")}`);
    } else {
      const bin = await fetchVerified(rel, binaryAsset(rel.version), tmp); log(`Verified ${basename(bin)}`);
      const exe = info.exe!; const prev = `${exe}.prev`;
      const staged = `${exe}.new`; cpSync(bin, staged); if (process.platform !== "win32") chmodSync(staged, 0o755);
      rmSync(prev, { force: true }); renameSync(exe, prev); renameSync(staged, exe);
      undo = () => { rmSync(exe, { force: true }); renameSync(prev, exe); };
    }
    log(`Installed ${rel.version}.`);
    const svc = serviceManager(); const st = svc?.status();
    if (opts.restart === false || !svc || !st?.installed) return { from: VERSION, to: rel.version, updated: true, message: `Updated to ${rel.version}. Restart Hearth to use it.` };
    log(`Restarting the ${st.manager} service…`); svc.restart();
    if (await healthy(opts.port ?? Number(process.env.HEARTH_PORT ?? 7682), rel.version)) return { from: VERSION, to: rel.version, updated: true, message: `Updated ${VERSION} → ${rel.version}; the service is healthy.` };
    log("The new version didn't pass its health check: rolling back."); undo(); svc.restart();
    const back = await healthy(opts.port ?? Number(process.env.HEARTH_PORT ?? 7682), VERSION);
    return { from: VERSION, to: rel.version, updated: false, rolledBack: true, message: `Rolled back to ${VERSION}${back ? "" : " (but it didn't come back healthy either: see `hearth service logs`)"}.` };
  } catch (e) {
    if (undo) { try { undo(); } catch { /* best effort */ } }
    throw e;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** Run `hearth update --yes` as a detached process (survives the service restart), logging to update.log. */
export function spawnUpdater(): number | undefined {
  const log = join(dataDir(), "update.log"); const fd = openSync(log, "a");
  const [cmd, ...args] = selfCommand();
  const c = spawn(cmd, [...args, "update", "--yes"], { detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, HEARTH_UPDATER: "1" } });
  c.unref(); return c.pid;
}
