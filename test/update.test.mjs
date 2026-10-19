// Packaging: config paths/env file, version compare, verified downloads, and a real npm-prefix self-update.
import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { dataDir, envFilePath, parseEnv, writeEnvFile } from "../dist/platform.js";
import { cmpVer, fetchVerified, binaryAsset } from "../dist/update.js";

const ROOT = new URL("..", import.meta.url).pathname;
const sha = (b) => createHash("sha256").update(b).digest("hex");

test("data/config locations per OS, legacy ~/.hearth kept", () => {
  const home = mkdtempSync(join(tmpdir(), "hh-"));
  assert.equal(dataDir({}, "linux", home), join(home, ".local/share/hearth"));
  assert.equal(envFilePath({}, "linux", home), join(home, ".config/hearth/env"));
  assert.equal(dataDir({ XDG_DATA_HOME: "/x" }, "linux", home), "/x/hearth");
  assert.equal(dataDir({}, "darwin", home), join(home, ".hearth"));
  assert.equal(envFilePath({}, "darwin", home), join(home, ".hearth/env"));
  assert.equal(dataDir({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32", home), join("C:\\Users\\a\\AppData\\Roaming", "hearth"));
  mkdirSync(join(home, ".hearth"));
  assert.equal(dataDir({}, "linux", home), join(home, ".hearth"), "existing ~/.hearth wins");
  assert.equal(envFilePath({}, "linux", home), join(home, ".hearth/env"));
  assert.equal(dataDir({ HEARTH_DATA_DIR: "/d" }, "linux", home), "/d");
});

test("env file: parse, create with defaults (600), merge explicit values only", () => {
  assert.deepEqual(parseEnv("# c\nA=1\nexport B=\"two words\"\nC='x'\nbad line\n"), { A: "1", B: "two words", C: "x" });
  const d = mkdtempSync(join(tmpdir(), "he-")); const f = join(d, "sub", "env");
  let r = writeEnvFile(f, {}, { publicOrigin: "https://agents.example.com", identity: "cloudflare" }, "linux", "/home/u");
  assert.ok(r.created);
  let e = parseEnv(readFileSync(f, "utf8"));
  assert.equal(e.HEARTH_ALLOWED_ORIGINS, "https://agents.example.com,http://127.0.0.1:7682,http://localhost:7682");
  assert.equal(e.HEARTH_IDENTITY, "cloudflare"); assert.equal(e.HEARTH_PASSWORD, "off"); assert.equal(e.HEARTH_ROOTS, "/home/u"); assert.equal(e.HEARTH_AUTO_UPDATE, "off");
  if (process.platform !== "win32") assert.equal(execFileSync("stat", ["-c", "%a", f]).toString().trim(), "600");
  r = writeEnvFile(f, {}, { identity: "single:" }); assert.equal(r.changed.length, 0, "defaults don't overwrite an existing file");
  r = writeEnvFile(f, { publicOrigin: "https://b.example.com", autoUpdate: "on" });
  e = parseEnv(readFileSync(f, "utf8"));
  assert.match(e.HEARTH_ALLOWED_ORIGINS, /^https:\/\/b\.example\.com,https:\/\/agents/); assert.equal(e.HEARTH_AUTO_UPDATE, "on"); assert.equal(e.HEARTH_IDENTITY, "cloudflare");
});

test("cmpVer", () => {
  assert.equal(cmpVer("0.4.0", "0.3.3"), 1); assert.equal(cmpVer("v0.4.0", "0.4.0"), 0); assert.equal(cmpVer("0.4.0-rc.1", "0.4.0"), -1);
  assert.equal(cmpVer("0.10.0", "0.9.9"), 1); assert.equal(cmpVer("1.0.0", "1.0.1"), -1);
  assert.equal(binaryAsset("1.2.3", "win32", "x64"), "hearth-1.2.3-win-x64.exe"); assert.equal(binaryAsset("1.2.3", "darwin", "arm64"), "hearth-1.2.3-darwin-arm64");
});

// A fake GitHub: /repos/<repo>/releases/latest plus asset downloads.
let srv, base; const files = new Map(); let latest = null;
before(async () => {
  srv = createServer((q, s) => {
    if (q.url.endsWith("/releases/latest")) { s.writeHead(latest ? 200 : 404, { "content-type": "application/json" }); return s.end(JSON.stringify(latest ?? {})); }
    const f = files.get(q.url); if (!f) { s.writeHead(404); return s.end(); }
    s.writeHead(200); s.end(f);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv?.close());
function release(version, assets) {
  const list = []; const out = [];
  for (const [name, buf] of Object.entries(assets)) { files.set(`/dl/${name}`, buf); list.push(`${sha(buf)}  ${name}`); out.push({ name, browser_download_url: `${base}/dl/${name}` }); }
  files.set("/dl/SHA256SUMS", Buffer.from(list.join("\n") + "\n")); out.push({ name: "SHA256SUMS", browser_download_url: `${base}/dl/SHA256SUMS` });
  return { tag_name: `v${version}`, html_url: `${base}/rel`, assets: out };
}
const asRel = (j) => ({ version: j.tag_name.slice(1), tag: j.tag_name, url: j.html_url, assets: j.assets.map((a) => ({ name: a.name, url: a.browser_download_url })) });

test("fetchVerified: checks SHA256SUMS, refuses mismatches and missing sums", async () => {
  const d = mkdtempSync(join(tmpdir(), "hv-"));
  const j = release("9.9.9", { "a.bin": Buffer.from("hello") });
  assert.equal(readFileSync(await fetchVerified(asRel(j), "a.bin", d), "utf8"), "hello");
  files.set("/dl/a.bin", Buffer.from("tampered"));
  await assert.rejects(fetchVerified(asRel(j), "a.bin", d), /checksum mismatch/);
  assert.ok(!existsSync(join(d, "a.bin")), "bad download removed");
  const k = asRel(j); k.assets = k.assets.filter((a) => a.name !== "SHA256SUMS");
  await assert.rejects(fetchVerified(k, "a.bin", d), /no SHA256SUMS/);
});

test("hearth update (npm install): installs the verified release tarball into the same prefix; refuses a bad checksum", { timeout: 240000 }, async () => {
  const w = mkdtempSync(join(tmpdir(), "hu-"));
  // current package -> tarball; then a copy with a bumped version as the "release"
  const cur = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const packed = execFileSync("npm", ["pack", "--pack-destination", w, "--ignore-scripts"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").pop();
  const prefix = join(w, "prefix");
  execFileSync("npm", ["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", join(w, packed)], { stdio: "ignore" });
  const next = "99.0.0";
  const stage = join(w, "stage"); mkdirSync(stage); execFileSync("tar", ["xzf", join(w, packed), "-C", stage]);
  const pj = join(stage, "package", "package.json"); const p = JSON.parse(readFileSync(pj, "utf8")); p.version = next; writeFileSync(pj, JSON.stringify(p));
  const vts = join(stage, "package", "dist", "version.js"); writeFileSync(vts, readFileSync(vts, "utf8").replace(cur, next));
  execFileSync("tar", ["czf", join(w, `hearth-acp-${next}.tgz`), "-C", stage, "package"]);
  const bin = join(prefix, "lib", "node_modules", "hearth-acp", "dist", "main.js");
  const env = { ...process.env, HEARTH_UPDATE_API: base, HEARTH_NO_ENV_FILE: "1", HEARTH_DATA_DIR: join(w, "data"), HEARTH_SERVICE: "" };
  // async: the fake GitHub server lives in this process
  const run = (...a) => new Promise((res) => { const c = spawn(process.execPath, [bin, ...a], { env }); let stdout = "", stderr = "";
    c.stdout.on("data", (d) => stdout += d); c.stderr.on("data", (d) => stderr += d); c.on("close", (status) => res({ status, stdout, stderr })); });
  assert.equal((await run("--version")).stdout.trim(), cur);
  // tampered tarball: refused, old version untouched
  latest = release(next, { [`hearth-acp-${next}.tgz`]: readFileSync(join(w, `hearth-acp-${next}.tgz`)) });
  files.set(`/dl/hearth-acp-${next}.tgz`, Buffer.from("evil"));
  let r = await run("update", "--yes"); assert.notEqual(r.status, 0); assert.match(r.stderr, /checksum mismatch/);
  assert.equal((await run("--version")).stdout.trim(), cur);
  // good tarball
  latest = release(next, { [`hearth-acp-${next}.tgz`]: readFileSync(join(w, `hearth-acp-${next}.tgz`)) });
  r = await run("update", "--check"); assert.match(r.stdout, new RegExp(`${cur.replace(/\./g, "\\.")} → 99\\.0\\.0`));
  r = await run("update", "--yes"); assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /Updated to 99\.0\.0/);
  assert.equal((await run("--version")).stdout.trim(), next);
  assert.ok(existsSync(join(prefix, "lib", "node_modules", "hearth-acp.prev")), "previous version kept for rollback");
  r = await run("update"); assert.match(r.stdout, /up to date/);
  rmSync(w, { recursive: true, force: true });
});
