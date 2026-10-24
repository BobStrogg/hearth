// Sending into an existing session whose agent is stopped (killed, crashed, Hearth restarted): the agent is
// respawned (and its session reloaded) for a direct send, clients see "starting" while that happens, a start that
// hangs times out with a visible error instead of doing nothing, and the browser never drops a send silently.
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { Hearth, configFromEnv } from "../dist/server.js";
import { LiveSession } from "../dist/session.js";

const CHROME = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p));
const MOCK = new URL("./mock-agent.mjs", import.meta.url).pathname;
let h, base, root, data, port, hangInit, hangLoad, gate;
const TIMEOUT = LiveSession.START_TIMEOUT_MS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cfg = () => configFromEnv({ HEARTH_PORT: String(port), HEARTH_DATA_DIR: data, HEARTH_ROOTS: root, HEARTH_AGENTS_FILE: join(data, "agents.json"), HEARTH_IDENTITY: "single:me", HEARTH_PASSWORD: "off" });
before(async () => {
  root = mkdtempSync(join(tmpdir(), "hearth-sroot-")); mkdirSync(join(root, "p"));
  data = mkdtempSync(join(tmpdir(), "hearth-sdata-"));
  hangInit = join(data, "hang-init"); hangLoad = join(data, "hang-load"); gate = join(data, "init-gate");
  const a = (id, env) => ({ id, name: id, detect: [process.execPath], command: process.execPath, args: [MOCK], env });
  writeFileSync(join(data, "agents.json"), JSON.stringify([
    a("plain", {}), a("load", { MOCK_LOAD_SESSION: "1" }), a("slow", { MOCK_LOAD_SESSION: "1", MOCK_SLOW_START: "1200" }),
    a("hang", { MOCK_LOAD_SESSION: "1", MOCK_HANG_INIT: hangInit, MOCK_HANG_LOAD: hangLoad, MOCK_INIT_GATE: gate }),
  ]));
  port = 20000 + Math.floor(Math.random() * 20000);
  h = new Hearth(cfg()); await h.listen(); base = `http://127.0.0.1:${port}`;
});
after(async () => { LiveSession.START_TIMEOUT_MS = TIMEOUT; await h.close(); });

const create = async (agentId) => (await (await fetch(base + "/api/sessions", { method: "POST", headers: { origin: base, "x-hearth-csrf": "1", "content-type": "application/json" }, body: JSON.stringify({ agentId, cwd: join(root, "p"), title: agentId }) })).json()).id;
function ws(id) {
  const s = new WebSocket(`${base.replace("http", "ws")}/ws?session=${id}&since=0`, { headers: { origin: base } });
  s.msgs = []; s.on("message", (d) => s.msgs.push(JSON.parse(String(d))));
  s.until = async (pred, what, ms = 8000) => { for (const t0 = Date.now(); ; await sleep(20)) { const f = s.msgs.find(pred); if (f) return f; if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}; got ${s.msgs.map((m) => m.type + (m.message ? ":" + m.message : "")).join(",")}`); } };
  return new Promise((res, rej) => { s.on("open", () => res(s)); s.on("error", rej); });
}
const prompts = (id) => h.store.read(h.live.get(id).meta).filter((e) => e.dir === "out" && e.msg.method === "session/prompt").map((e) => e.msg.params.prompt[0].text);
const stopAgent = async (l) => { l.child.kill("SIGKILL"); for (let i = 0; i < 100 && l.meta.state !== "stopped"; i++) await sleep(20); assert.equal(l.meta.state, "stopped"); };

test("agent killed: a direct send respawns it, with agent_starting / agent_ready, and the prompt runs", async () => {
  const id = await create("plain"); const l = h.live.get(id); await l.ensureRunning();
  await stopAgent(l);
  const s = await ws(id);
  s.send(JSON.stringify({ type: "prompt", text: "hello after stop" }));
  await s.until((m) => m.type === "agent_starting", "starting");
  await s.until((m) => m.type === "agent_ready", "ready");
  await s.until((m) => m.type === "prompt_done", "done");
  assert.deepEqual(prompts(id), ["hello after stop"]);
  assert.equal(s.msgs.some((m) => m.type === "error"), false);
  s.close();
});

test("after a Hearth restart: a send into the old session reloads it (session/load) and runs", async () => {
  const id = await create("load"); const l = h.live.get(id); await l.ensureRunning();
  await l.prompt([{ type: "text", text: "first" }]);
  await h.close(); h = new Hearth(cfg()); await h.listen();
  const s = await ws(id);
  await s.until((m) => m.type === "state" && m.state === "stopped", "stopped after restart");
  s.send(JSON.stringify({ type: "prompt", text: "second" }));
  await s.until((m) => m.type === "prompt_done", "done");
  assert.deepEqual(prompts(id), ["first", "second"]);
  assert.ok(h.store.read(h.live.get(id).meta).some((e) => e.msg?.event === "session_loaded"));
  s.close();
});

test("a slow start: every client sees 'starting' (also one that connects meanwhile), nothing is queued", async () => {
  const id = await create("slow"); const l = h.live.get(id); await l.ensureRunning(); await stopAgent(l);
  const a = await ws(id);
  a.send(JSON.stringify({ type: "prompt", text: "while starting" }));
  await a.until((m) => m.type === "agent_starting", "starting");
  const b = await ws(id); // e.g. the phone opening the same session
  await b.until((m) => m.type === "agent_starting", "late client sees starting");
  await a.until((m) => m.type === "prompt_done", "done");
  assert.equal(a.msgs.some((m) => m.type === "queued"), false);
  assert.deepEqual(prompts(id), ["while starting"]);
  a.close(); b.close();
});

test("a start that hangs times out with a visible error, leaves no agent behind, and the next send works", async () => {
  // Short timeouts only for the steps that must hang; every step that must succeed runs under the default (minutes), so
  // a loaded CI runner (macOS Intel) can't trip it. Each step reads the timeout when it starts, so the mock holds its
  // initialize answer (MOCK_INIT_GATE) while the test sets 2 s for the session/load that follows, and says when that
  // load arrived (MOCK_HANG_LOAD.got) so the fresh process Hearth then starts gets the default again.
  const waitFor = async (f, what, gone = false) => {
    for (let i = 0; i < 1500 && existsSync(f) === gone; i++) await sleep(20);
    assert.equal(existsSync(f), !gone, what);
  };
  try {
    const id = await create("hang"); const l = h.live.get(id); await l.ensureRunning(); await stopAgent(l);
    LiveSession.START_TIMEOUT_MS = 2000; writeFileSync(hangInit, "");
    const s = await ws(id);
    s.send(JSON.stringify({ type: "prompt", text: "into the void" }));
    const e = await s.until((m) => m.type === "error", "error");
    assert.match(e.message, /couldn't start the agent: the agent didn't answer initialize within/);
    assert.equal(l.alive, false); assert.equal(l.meta.state, "stopped"); assert.equal(l.turnActive, false);
    rmSync(hangInit); LiveSession.START_TIMEOUT_MS = TIMEOUT;
    // session/load hangs: Hearth gives up on reloading and starts the agent fresh so the message still goes
    writeFileSync(hangLoad, ""); writeFileSync(gate, "");
    s.send(JSON.stringify({ type: "prompt", text: "try again" }));
    await waitFor(`${gate}.waiting`, "the agent got initialize (answered under the default timeout)");
    LiveSession.START_TIMEOUT_MS = 2000; rmSync(gate); writeFileSync(`${gate}.go`, "");
    await waitFor(`${gate}.go`, "initialize answered", true);
    await waitFor(`${hangLoad}.got`, "the agent got session/load (2 s to answer, and it won't)");
    LiveSession.START_TIMEOUT_MS = TIMEOUT;
    await s.until((m) => m.type === "prompt_done", "done after the fallback");
    assert.equal(prompts(id).at(-1), "try again");
    const ev = h.store.read(l.meta).map((x) => x.msg?.event).filter(Boolean);
    assert.ok(ev.includes("session_load_failed") && ev.includes("context_reset"), ev.join());
    rmSync(hangLoad);
    s.close();
  } finally { LiveSession.START_TIMEOUT_MS = TIMEOUT; for (const f of [gate, `${gate}.go`, `${gate}.waiting`, `${hangLoad}.got`]) rmSync(f, { force: true }); }
});

test("browser: 'Starting the agent…' while it starts; a send while disconnected waits and goes after reconnecting", { skip: !CHROME && "no Chrome" }, async () => {
  const id = await create("slow"); const l = h.live.get(id); await l.ensureRunning(); await stopAgent(l);
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${base}/#/s/${id}`); await page.waitForSelector(".composer textarea"); await sleep(500);
    await page.type(".composer textarea", "are you there?"); await page.click(".composer button.primary");
    await page.waitForSelector(".note.starting", { timeout: 10000 });
    assert.equal(await page.$eval("#status", (x) => x.textContent), "starting");
    await page.waitForFunction(() => /Hello world!/.test(document.querySelector(".log").innerText) && !document.querySelector(".note.starting"), { timeout: 10000 });
    // disconnected: the send isn't lost
    // (offline emulation keeps the page from reconnecting before the send, which a fast runner otherwise does)
    await page.setOfflineMode(true);
    for (const c of h.wss.clients) c.terminate();
    await sleep(200);
    await page.type(".composer textarea", "sent while offline"); await page.click(".composer button.primary");
    await page.waitForFunction(() => /Reconnecting/.test(document.querySelector(".log").innerText), { timeout: 10000 });
    await page.setOfflineMode(false);
    for (let i = 0; i < 200 && prompts(id).at(-1) !== "sent while offline"; i++) await sleep(50);
    assert.equal(prompts(id).at(-1), "sent while offline");
    assert.equal(prompts(id).filter((t) => t === "sent while offline").length, 1, "sent once");
    await page.waitForFunction(() => document.querySelector(".composer textarea").value === "", { timeout: 3000 });
    assert.deepEqual(errs, []);
  } finally { await browser.close(); }
});
