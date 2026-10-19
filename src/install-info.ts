import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { which } from "./agents.js";

export const isSea = (): boolean => typeof HEARTH_SEA !== "undefined" && !!HEARTH_SEA;

export type InstallMethod = "binary" | "brew" | "npm" | "npx" | "source";
export interface InstallInfo { method: InstallMethod; pkgRoot?: string; prefix?: string; exe?: string }

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
/** dist/.. of the running code (undefined in a single-file binary). */
export function pkgRoot(): string | undefined {
  if (isSea()) return undefined;
  // When bundled as a CJS SEA, import.meta.url is absent; fall back to __dirname / argv.
  try { if (typeof import.meta !== "undefined" && import.meta.url) return resolve(dirname(fileURLToPath(import.meta.url)), ".."); } catch { /* SEA */ }
  try { // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = (globalThis as any).__dirname ?? dirname(process.argv[1] || process.execPath); return resolve(d, ".."); } catch { return undefined; }
}

/** How this copy of Hearth was installed, which decides how `hearth update` updates it. */
export function installInfo(): InstallInfo {
  if (isSea()) return { method: "binary", exe: process.execPath };
  const root = pkgRoot()!; const r = real(root);
  if (/[\\/]Cellar[\\/]hearth[\\/]/.test(r) || /[\\/]homebrew[\\/].*[\\/]hearth[\\/]libexec/.test(r)) return { method: "brew", pkgRoot: root };
  if (/[\\/]_npx[\\/]/.test(r)) return { method: "npx", pkgRoot: root };
  if (basename(dirname(r)) === "node_modules" && basename(r) === "hearth-acp") {
    // unix: <prefix>/lib/node_modules/hearth-acp ; windows: <prefix>\node_modules\hearth-acp
    const nm = dirname(r); const up = dirname(nm);
    const prefix = basename(up) === "lib" ? dirname(up) : up;
    return { method: "npm", pkgRoot: root, prefix };
  }
  return { method: "source", pkgRoot: root };
}

/**
 * argv that starts this Hearth again (for service definitions and the updater). Prefers a `node` on PATH that is the
 * same binary (e.g. Homebrew's stable /opt/homebrew/bin/node symlink rather than a versioned Cellar path).
 */
export function selfCommand(): string[] {
  if (isSea()) return [process.execPath];
  let node = process.execPath;
  const onPath = which(process.platform === "win32" ? "node.exe" : "node");
  if (onPath && real(onPath) === real(node)) node = onPath;
  const main = join(pkgRoot()!, "dist", "main.js");
  return [node, existsSync(main) ? main : process.argv[1]];
}
export const SEP = sep;
