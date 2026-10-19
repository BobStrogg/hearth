// Build a single-file executable (Node SEA) for the current platform: build/hearth-<version>-<os>-<arch>[.exe]
// Needs Node >= 20.12 (SEA assets). Usage: node scripts/build-sea.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "build"); rmSync(out, { recursive: true, force: true }); mkdirSync(out);
const os = process.platform === "win32" ? "win" : process.platform;
const exe = join(out, `hearth-${version}-${os}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`);

await build({
  entryPoints: [join(root, "src", "main.ts")], bundle: true, platform: "node", format: "cjs", target: "node20",
  outfile: join(out, "hearth.cjs"), external: ["bufferutil", "utf-8-validate"],
  logOverride: { "empty-import-meta": "silent" }, banner: { js: "/* hearth single-file build */\nvar __hearth_meta_url = require(\"url\").pathToFileURL(process.execPath).href;" },
  define: { HEARTH_SEA: "true", "import.meta.url": "__hearth_meta_url" },
});

const assets = Object.fromEntries(readdirSync(join(root, "web")).map((f) => [`web/${f}`, join(root, "web", f)]));
writeFileSync(join(out, "sea-config.json"), JSON.stringify({ main: join(out, "hearth.cjs"), output: join(out, "sea-prep.blob"), disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, assets }));
execFileSync(process.execPath, ["--experimental-sea-config", join(out, "sea-config.json")], { stdio: "inherit" });
copyFileSync(process.execPath, exe); if (process.platform !== "win32") chmodSync(exe, 0o755);
if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", exe]);
const postject = join(root, "node_modules", "postject", "dist", "cli.js");
execFileSync(process.execPath, [postject, exe, "NODE_SEA_BLOB", join(out, "sea-prep.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : [])], { stdio: "inherit" });
if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", exe]);
for (const f of ["hearth.cjs", "sea-prep.blob", "sea-config.json"]) rmSync(join(out, f), { force: true });
console.log(exe);
