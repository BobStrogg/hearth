// An agent that starts but never answers initialize (waiting on a sign-in, an update, a keychain prompt, the network):
// the "couldn't start" note carries what THIS process printed while Hearth waited (or that it printed nothing), never
// an earlier run's output; Hearth stops the agent's whole process group; agent-stderr.log marks each run and rotates
// instead of freezing; agents an earlier Hearth left running are stopped at startup.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { Hearth, configFromEnv } from "../dist/server.js";
import { LiveSession, STDERR_LOG_MAX, localStamp } from "../dist/session.js";
import { AgentPids } from "../dist/orphans.js";

const CHROME = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p));
const MOCK = new URL("./mock-agent.mjs", import.meta.url).pathname;
const POSIX = process.platform !== "win32";
let h, base, root, data, hang, grand;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const START = LiveSession.START_TIMEOUT_MS;
/** A start that must hang: only then is the timeout short (4 s, as the messages say). Normal starts keep the default
 *  (minutes), so a loaded CI runner (macOS Intel) that takes a few seconds to start node can't trip it. */
async function hungStart(l) {
  LiveSession.START_TIMEOUT_MS = 4000;
  try { return await l.ensureRunning(); } finally { LiveSession.START_TIMEOUT_MS = START; }
}
before(async () => {
  root = mkdtempSync(join(tmpdir(), "hearth-troot-")); mkdirSync(join(root, "p"));
  data = mkdtempSync(join(tmpdir(), "hearth-tdata-")); hang = join(data, "hang"); grand = join(data, "grandchild.pid");
  const env = { MOCK_HANG_AT_START: hang, MOCK_OLD_STDERR: "2026-10-22T14:09:54.080463Z  INFO OLD RUN LINE", MOCK_GRANDCHILD: grand, MOCK_LOAD_SESSION: "1" };
  writeFileSync(join(data, "agents.json"), JSON.stringify([
    { id: "quiet", name: "Quiet", detect: [process.execPath], command: process.execPath, args: [MOCK], env },
    { id: "talks", name: "Talks", detect: [process.execPath], command: process.execPath, args: [MOCK], env: { ...env, MOCK_HANG_SAY: "Checking for updates…" } },
  ]));
  const port = 20000 + Math.floor(Math.random() * 20000);
  h = new Hearth(configFromEnv({ HEARTH_PORT: String(port), HEARTH_DATA_DIR: data, HEARTH_ROOTS: root, HEARTH_AGENTS_FILE: join(data, "agents.json"), HEARTH_IDENTITY: "single:me", HEARTH_PASSWORD: "off", HEARTH_QUEUE_CHECK_MS: "100" }));
  await h.listen(); base = `http://127.0.0.1:${port}`;
});
after(async () => { LiveSession.START_TIMEOUT_MS = START; rmSync(hang, { force: true }); await h.close(); });
const create = async (agentId) => (await (await fetch(base + "/api/sessions", { method: "POST", headers: { origin: base, "x-hearth-csrf": "1", "content-type": "application/json" }, body: JSON.stringify({ agentId, cwd: join(root, "p"), title: agentId }) })).json()).id;
const sys = (id, ev) => h.store.read(h.live.get(id).meta).filter((e) => e.dir === "sys" && e.msg?.event === ev);
/** A session that worked once (its stderr has an earlier run's line in it), then its agent stops answering. */
async function wedged(agentId) {
  const id = await create(agentId); const l = h.live.get(id);
  await l.ensureRunning(); await l.prompt([{ type: "text", text: "hi" }]);
  writeFileSync(hang, ""); rmSync(grand, { force: true });
  await l.shutdown(); for (let i = 0; i < 100 && l.meta.state !== "stopped"; i++) await sleep(20);
  return { id, l };
}

test("silent hang: the note says it printed nothing (with its pid and start time), never an earlier run's output, and no extra exit card", async () => {
  const { id, l } = await wedged("quiet");
  try {
    const exitsBefore = sys(id, "agent_exit").length;
    await assert.rejects(hungStart(l), /didn't answer initialize within 4 s and printed nothing since it started/);
    const f = sys(id, "agent_start_failed").at(-1).msg;
    assert.equal(f.timeout, true); assert.equal(f.noOutput, true); assert.equal(f.stderrTail, undefined);
    assert.ok(Number.isInteger(f.pid) && f.pid > 0); assert.ok(!isNaN(Date.parse(f.startedAt)));
    assert.doesNotMatch(JSON.stringify(f), /OLD RUN LINE/);
    assert.equal(sys(id, "agent_exit").length, exitsBefore, "Hearth's own cleanup kill is reported by the note, not a separate 'Agent stopped (SIGTERM)' card");
    assert.equal(l.child, undefined); assert.equal(l.meta.state, "stopped");
    // the log file marks where each run starts, in local time with its offset
    const log = readFileSync(join(h.store.dir(l.meta.owner, id), "agent-stderr.log"), "utf8");
    const marks = [...log.matchAll(/^--- hearth \S+: started node(?:\.exe)? \(pid (\d+)\) at (\S+) ---$/gm)];
    assert.ok(marks.length >= 2, log);
    assert.equal(Number(marks.at(-1)[1]), f.pid);
    assert.match(marks.at(-1)[2], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    assert.equal(log.slice(log.lastIndexOf("--- hearth")).split("\n").filter(Boolean).length, 1, "nothing after the newest run's mark: it printed nothing");
  } finally { rmSync(hang, { force: true }); }
});

test("hang with output: the note carries this run's stderr and its last line", async () => {
  const { id, l } = await wedged("talks");
  try {
    await assert.rejects(hungStart(l), /didn't answer initialize within 4 s; its last output: Checking for updates…/);
    const f = sys(id, "agent_start_failed").at(-1).msg;
    assert.equal(f.stderrTail, "Checking for updates…"); assert.equal(f.noOutput, undefined);
  } finally { rmSync(hang, { force: true }); }
});

test("the timeout stops the agent's whole process group (a child it started too), even if it ignores SIGTERM", { skip: !POSIX && "process groups" }, async () => {
  const { l } = await wedged("quiet");
  try {
    await assert.rejects(hungStart(l), /didn't answer initialize/);
    const g = Number(readFileSync(grand, "utf8"));
    for (let i = 0; i < 50 && alive(g); i++) await sleep(50);
    assert.equal(alive(g), false, "the grandchild is gone");
    assert.equal(h.agentPids.entries.length, 0, "no agent left on the books");
  } finally { rmSync(hang, { force: true }); }
});

test("a full agent-stderr.log is rotated to .1 and the new run is still logged", async () => {
  const id = await create("quiet"); const l = h.live.get(id);
  await l.ensureRunning(); await l.shutdown(); // (a new session starts its agent by itself)
  const p = join(h.store.dir(l.meta.owner, id), "agent-stderr.log");
  writeFileSync(p, "x".repeat(STDERR_LOG_MAX + 10));
  await l.ensureRunning();
  assert.ok(existsSync(`${p}.1`)); assert.ok(statSync(p).size < 10_000);
  assert.match(readFileSync(p, "utf8"), /^--- hearth \S+: started/);
  await l.shutdown();
});

test("localStamp has the computer's own UTC offset", () => {
  const s = localStamp(new Date(Date.UTC(2026, 9, 22, 14, 9, 54)));
  assert.match(s, /^2026-10-2\dT\d\d:09:54[+-]\d\d:\d\d$/);
  const [, hh, sign, oh, om] = /T(\d\d):09:54([+-])(\d\d):(\d\d)$/.exec(s);
  const off = (sign === "+" ? 1 : -1) * (Number(oh) * 60 + Number(om));
  assert.equal(((Number(hh) * 60 - off) % 1440 + 1440) % 1440, 14 * 60);
});

test("startup stops agent process groups an earlier Hearth left running, and only those", { skip: !POSIX && "process groups" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-pids-")); const file = join(dir, "agent-pids.json");
  const orphan = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  const other = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  const notLeader = spawn("sh", ["-c", "sleep 30"], { stdio: "ignore" }); // same group as this test: never touched
  try {
    await sleep(200);
    const old = new AgentPids(file);
    old.add(orphan.pid, process.execPath); old.add(other.pid, "/usr/local/bin/some-other-agent"); old.add(notLeader.pid, "sh");
    const reaped = await new AgentPids(file).reap(500);
    assert.deepEqual(reaped, [orphan.pid], "only the recorded group leader still running the recorded command");
    for (let i = 0; i < 40 && alive(orphan.pid); i++) await sleep(50);
    assert.equal(alive(orphan.pid), false, "SIGKILL after the grace period");
    assert.equal(alive(other.pid), true); assert.equal(alive(notLeader.pid), true);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), []);
  } finally { for (const c of [orphan, other, notLeader]) { try { c.kill("SIGKILL"); } catch { /* gone */ } } rmSync(dir, { recursive: true, force: true }); }
});

test("browser: the timeout note shows 'no output since it started at <local time>' and when it happened", { skip: !CHROME && "no Chrome" }, async () => {
  const { id, l } = await wedged("quiet");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"], env: { ...process.env, TZ: "America/Chicago" } });
  try {
    await assert.rejects(hungStart(l), /didn't answer initialize/);
    const page = await browser.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${base}/#/s/${id}`); await page.waitForSelector(".note.agentdown"); await sleep(400);
    const r = await page.evaluate(() => ({ cards: [...document.querySelectorAll(".note.agentdown")].map((n) => n.innerText) }));
    if (process.env.HEARTH_SHOTS) await page.screenshot({ path: join(process.env.HEARTH_SHOTS, "hearth-init-timeout.png") });
    const last = r.cards.at(-1);
    assert.match(last, /Couldn't start the agent: the agent didn't answer initialize within 4 s and printed nothing since it started/);
    assert.match(last, /· \d{1,2}:\d\d\s?[AP]M C[DS]T/, "when it happened, in local time with the zone");
    assert.match(last, /No output from the agent since it started at \d{1,2}:\d\d\s?[AP]M C[DS]T \(pid \d+\)/);
    assert.match(last, /sign-in, an update, a macOS permission or keychain prompt, or the network/);
    assert.doesNotMatch(last, /OLD RUN LINE/, "an earlier run's output is not shown with the timeout");
    assert.match(r.cards.at(-2), /^Agent stopped \(signal SIGTERM\)\. · \d{1,2}:\d\d\s?[AP]M C[DS]T/, "the earlier run's own card says when it was");
    assert.ok(!r.cards.some((c) => /while starting \(signal SIGTERM\)/.test(c)), "no separate card for Hearth's own cleanup kill");
    assert.deepEqual(errs, []);
  } finally { await browser.close(); rmSync(hang, { force: true }); }
});

test("browser: UTC timestamps in an exit card's agent output are shown in local time", { skip: !CHROME && "no Chrome" }, async () => {
  const id = await create("quiet"); const l = h.live.get(id);
  l.log("sys", { event: "agent_exit", code: 0, signal: null, stderrTail: "2026-10-22T14:09:54.080463Z  INFO run_acp_server: Dispatched SessionEnd", phase: "idle" });
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"], env: { ...process.env, TZ: "America/Chicago" } });
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/#/s/${id}`); await page.waitForSelector(".note.agentdown .adtail");
    const t = await page.evaluate(() => document.querySelector(".note.agentdown .adtail").innerText);
    assert.match(t, /(?:Oct 22, )?9:09:54\s?AM\s+INFO run_acp_server: Dispatched SessionEnd/);
  } finally { await browser.close(); }
});
