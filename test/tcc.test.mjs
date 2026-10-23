// A session folder macOS holds behind a privacy prompt (Documents after a Node.js or Hearth update): every access waits
// until someone answers on the Mac's screen, and an agent started there hangs silently until the start-up limit.
// Hearth now checks the folder first and says why within seconds, without starting the agent.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hearth, configFromEnv } from "../dist/server.js";
import { LiveSession, folderHelp } from "../dist/session.js";
import { clearBlocked } from "../dist/privacy.js";
import { ensureLauncher, LAUNCHER_C } from "../dist/launcher.js";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const MOCK = new URL("./mock-agent.mjs", import.meta.url).pathname;
let h, base, root, data;
const PROBE = LiveSession.folderProbe, CHECK = LiveSession.FOLDER_CHECK_MS;
before(async () => {
  root = mkdtempSync(join(tmpdir(), "hearth-froot-")); mkdirSync(join(root, "p"));
  data = mkdtempSync(join(tmpdir(), "hearth-fdata-"));
  writeFileSync(join(data, "agents.json"), JSON.stringify([{ id: "m", name: "M", detect: [process.execPath], command: process.execPath, args: [MOCK], env: { MOCK_LOAD_SESSION: "1" } }]));
  const port = 20000 + Math.floor(Math.random() * 20000);
  h = new Hearth(configFromEnv({ HEARTH_PORT: String(port), HEARTH_DATA_DIR: data, HEARTH_ROOTS: root, HEARTH_AGENTS_FILE: join(data, "agents.json"), HEARTH_IDENTITY: "single:me", HEARTH_PASSWORD: "off", HEARTH_QUEUE_CHECK_MS: "100" }));
  await h.listen(); base = `http://127.0.0.1:${port}`;
});
after(async () => { LiveSession.folderProbe = PROBE; LiveSession.FOLDER_CHECK_MS = CHECK; await h.close(); rmSync(root, { recursive: true, force: true }); });
let n = 0;
// (each test gets its own folder: a check stuck on a folder is shared until it finishes, as on the Mac)
const create = async () => { const cwd = join(root, `p${++n}`); mkdirSync(cwd); return (await (await fetch(base + "/api/sessions", { method: "POST", headers: { origin: base, "x-hearth-csrf": "1", "content-type": "application/json" }, body: JSON.stringify({ agentId: "m", cwd, title: "f" }) })).json()).id; };
const sys = (id, ev) => h.store.read(h.live.get(id).meta).filter((e) => e.dir === "sys" && e.msg?.event === ev).map((e) => e.msg);
async function stopped() { const id = await create(); const l = h.live.get(id); await l.ensureRunning(); await l.shutdown(); for (let i = 0; i < 100 && l.meta.state !== "stopped"; i++) await new Promise((r) => setTimeout(r, 20)); return { id, l }; }

test("a folder that never opens: fails in seconds, says why, starts no agent, and shares one stuck check", async () => {
  const { id, l } = await stopped();
  let calls = 0; LiveSession.folderProbe = () => { calls++; return new Promise(() => {}); }; LiveSession.FOLDER_CHECK_MS = 300;
  try {
    const exits = sys(id, "agent_exit").length;
    const t0 = Date.now();
    await assert.rejects(l.ensureRunning(), /couldn't start the agent: the session folder .* didn't open within 0 s, so the agent wasn't started/);
    const hz = await (await fetch(base + "/healthz")).json();
    assert.equal(hz.permission.needed, true, "/healthz says permission is needed (for the dashboard)");
    assert.deepEqual(hz.permission.folders, [l.meta.cwd.split("/").pop()], "folder names only, no full paths");
    assert.ok(Date.now() - t0 < 3000);
    await assert.rejects(l.ensureRunning(), /didn't open/);
    assert.equal(calls, 1, "the stuck check is shared, not repeated");
    assert.equal(l.child, undefined); assert.equal(sys(id, "agent_exit").length, exits, "no agent was started");
    assert.equal(sys(id, "agent_start_failed").at(-1).folderBlocked, "TIMEOUT");
  } finally { LiveSession.folderProbe = PROBE; LiveSession.FOLDER_CHECK_MS = CHECK; }
});

test("a folder macOS denies (EPERM): says so without starting the agent", async () => {
  const { id, l } = await stopped();
  LiveSession.folderProbe = async () => { throw Object.assign(new Error("operation not permitted"), { code: "EPERM" }); };
  try {
    await assert.rejects(l.ensureRunning(), /the session folder .* can't be opened \(EPERM\), so the agent wasn't started/);
    assert.equal(sys(id, "agent_start_failed").at(-1).folderBlocked, "EPERM");
  } finally { LiveSession.folderProbe = PROBE; }
});

test("a folder that opens normally starts the agent as before", async () => {
  const { l } = await stopped();
  await l.ensureRunning(); assert.ok(l.alive); await l.shutdown();
});

test("the Mac wording names the prompt, the settings and the exact program", () => {
  const m = folderHelp("/Users/me/Documents/x", "TIMEOUT", "darwin", "/opt/homebrew/Cellar/node/26.12.1/bin/node");
  assert.match(m, /macOS is probably waiting for permission/);
  assert.match(m, /"would like to access files in…" prompt and click Allow/);
  assert.match(m, /Files and Folders \(or Full Disk Access\) allow \/opt\/homebrew\/Cellar\/node\/26\.12\.1\/bin\/node/);
  assert.match(m, /asks again after Node\.js or Hearth is updated/);
  assert.doesNotMatch(folderHelp("/srv/x", "TIMEOUT", "linux"), /macOS/);
});

test("once the stuck folder opens (Allow clicked), /healthz clears and the next send starts the agent", async () => {
  clearBlocked();
  const { l } = await stopped();
  let allow; LiveSession.folderProbe = () => new Promise((r) => { allow = r; }); LiveSession.FOLDER_CHECK_MS = 200;
  try {
    await assert.rejects(l.ensureRunning(), /didn't open/);
    assert.equal((await (await fetch(base + "/healthz")).json()).permission.needed, true);
    allow(); await new Promise((r) => setTimeout(r, 50));
    assert.equal((await (await fetch(base + "/healthz")).json()).permission.needed, false);
  } finally { LiveSession.folderProbe = PROBE; LiveSession.FOLDER_CHECK_MS = CHECK; }
  await l.ensureRunning(); assert.ok(l.alive); await l.shutdown();
});

test("startup check: recent session folders are opened right after a (re)start, so a prompt shows up then", async () => {
  clearBlocked();
  const { l } = await stopped();
  const seen = []; LiveSession.folderProbe = (d) => { seen.push(d); return d === l.meta.cwd ? new Promise(() => {}) : Promise.resolve(); }; LiveSession.FOLDER_CHECK_MS = 200;
  try {
    const dirs = await h.checkRecentFolders();
    assert.ok(dirs.includes(l.meta.cwd) && dirs.length <= 5);
    const hz = (await (await fetch(base + "/healthz")).json()).permission;
    assert.equal(hz.needed, true); assert.ok(hz.folders.includes(l.meta.cwd.split("/").pop()));
  } finally { LiveSession.folderProbe = PROBE; LiveSession.FOLDER_CHECK_MS = CHECK; clearBlocked(); }
});

// The launcher: a stable parent, so macOS privacy permissions survive Node.js and Hearth updates.
const CC = ["/usr/bin/cc", "/usr/bin/clang", "/usr/bin/gcc"].find((p) => existsSync(p));
test("launcher: built once, kept untouched while its source is unchanged, passes exit codes, signals and HEARTH_LAUNCHER", { skip: (!CC || process.platform === "win32") && "no C compiler" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "hearth-launch-"));
  try {
    const a = ensureLauncher({ home, platform: process.platform === "darwin" ? "darwin" : "linux", cc: CC });
    assert.ok(a.path && a.built, JSON.stringify(a));
    const ino = statSync(a.path).ino, mt = statSync(a.path).mtimeMs;
    const b = ensureLauncher({ home, platform: "linux", cc: CC });
    assert.equal(b.built, false); assert.equal(statSync(b.path).ino, ino); assert.equal(statSync(b.path).mtimeMs, mt, "not rebuilt: same signature, same permission");
    const runL = (args, onSpawn) => new Promise((res) => { const c = spawn(a.path, args, { stdio: ["ignore", "pipe", "pipe"] }); let out = ""; c.stdout.on("data", (d) => { out += d; onSpawn?.(c, out); }); c.on("exit", (code, signal) => res({ code, signal, out })); });
    assert.equal((await runL([process.execPath, "-e", "process.exit(7)"])).code, 7);
    const env = await runL([process.execPath, "-e", "console.log(process.env.HEARTH_LAUNCHER)"]);
    assert.equal(env.out.trim(), a.path);
    // launchd stops the service with SIGTERM: the launcher forwards it; Hearth exits cleanly, and so does the launcher
    let sent = false;
    const t = await runL([process.execPath, "-e", "process.on('SIGTERM',()=>{console.log('got TERM');process.exit(0)}); console.log('up'); setInterval(()=>{},1000)"],
      (c, out) => { if (!sent && /up/.test(out)) { sent = true; c.kill("SIGTERM"); } });
    assert.equal(t.code, 0); assert.match(t.out, /got TERM/);
    const k = await runL([process.execPath, "-e", "process.kill(process.pid,'SIGKILL')"]);
    assert.equal(k.signal, "SIGKILL", "a child killed by a signal: the launcher ends the same way");
    assert.equal((await runL(["/nonexistent/prog"])).code, 127);
    // a changed source (a future Hearth with a new launcher) rebuilds it once
    writeFileSync(`${a.path}.sha256`, "old\n");
    assert.equal(ensureLauncher({ home, platform: "linux", cc: CC }).built, true);
    assert.equal(readFileSync(`${a.path}.c`, "utf8"), LAUNCHER_C);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("launcher on a Mac without the Command Line Tools: Hearth runs directly, with a note (no installer pop-up)", () => {
  const calls = [];
  const r = ensureLauncher({ home: mkdtempSync(join(tmpdir(), "hearth-launch-")), platform: "darwin", run: (cmd, args) => { calls.push(cmd); return { status: cmd.endsWith("xcode-select") ? 2 : 0, out: "" }; } });
  assert.equal(r.path, null); assert.match(r.note, /Command Line Tools aren't installed/);
  assert.deepEqual(calls, ["/usr/bin/xcode-select"], "never runs cc, which would pop up an installer");
  assert.deepEqual(ensureLauncher({ platform: "linux" }), { path: null, built: false }, "only on macOS");
});

test("launcher: a developer directory that's set but missing its clang (tools removed) never reaches the xcrun/cc shims", () => {
  for (const have of [[], ["/Library/Developer/CommandLineTools"]]) {
    const calls = [];
    const r = ensureLauncher({ home: mkdtempSync(join(tmpdir(), "hearth-launch-")), platform: "darwin", exists: (p) => have.includes(p),
      run: (cmd) => { calls.push(cmd); return { status: 0, out: cmd.endsWith("xcode-select") ? "/Library/Developer/CommandLineTools\n" : "" }; } });
    assert.equal(r.path, null); assert.match(r.note, /Command Line Tools/);
    assert.deepEqual(calls, ["/usr/bin/xcode-select"], `no xcrun, no cc (exists: ${JSON.stringify(have)})`);
  }
  // tools present: xcrun finds clang; an xcrun answer that doesn't exist isn't used either (no /usr/bin/cc fallback)
  const calls = [];
  const r = ensureLauncher({ home: mkdtempSync(join(tmpdir(), "hearth-launch-")), platform: "darwin",
    exists: (p) => ["/Library/Developer/CommandLineTools", "/Library/Developer/CommandLineTools/usr/bin/clang"].includes(p),
    run: (cmd) => { calls.push(cmd); return cmd.endsWith("xcode-select") ? { status: 0, out: "/Library/Developer/CommandLineTools\n" } : { status: 1, out: "" }; } });
  assert.equal(r.path, null); assert.deepEqual(calls, ["/usr/bin/xcode-select", "/usr/bin/xcrun"]);
});
