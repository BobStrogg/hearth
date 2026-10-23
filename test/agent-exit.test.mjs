// The agent exits by itself while starting (wrong Node version, missing module, not logged in…): the chat shows its last
// stderr lines and the exit code in one card that collapses repeated failures, and after a few immediate failures in a
// row Hearth stops restarting it by itself and says why. Sends still try, and the first good answer resets it.
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { Hearth, configFromEnv } from "../dist/server.js";

const CHROME = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p));
const MOCK = new URL("./mock-agent.mjs", import.meta.url).pathname;
let h, base, root, data, die;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
after(() => rmSync(join(data, "die"), { force: true }));
before(async () => {
  root = mkdtempSync(join(tmpdir(), "hearth-xroot-")); mkdirSync(join(root, "p"));
  data = mkdtempSync(join(tmpdir(), "hearth-xdata-")); die = join(data, "die");
  writeFileSync(join(data, "agents.json"), JSON.stringify([{ id: "dies", name: "Dies", detect: [process.execPath], command: process.execPath, args: [MOCK], env: { MOCK_DIE_AT_START: die, MOCK_LOAD_SESSION: "1" } }]));
  const port = 20000 + Math.floor(Math.random() * 20000);
  h = new Hearth(configFromEnv({ HEARTH_PORT: String(port), HEARTH_DATA_DIR: data, HEARTH_ROOTS: root, HEARTH_AGENTS_FILE: join(data, "agents.json"), HEARTH_IDENTITY: "single:me", HEARTH_PASSWORD: "off", HEARTH_QUEUE_CHECK_MS: "100" }));
  await h.listen(); base = `http://127.0.0.1:${port}`;
});
after(async () => { await h.close(); });
const create = async () => (await (await fetch(base + "/api/sessions", { method: "POST", headers: { origin: base, "x-hearth-csrf": "1", "content-type": "application/json" }, body: JSON.stringify({ agentId: "dies", cwd: join(root, "p"), title: "dies" }) })).json()).id;
function ws(id) {
  const s = new WebSocket(`${base.replace("http", "ws")}/ws?session=${id}&since=0`, { headers: { origin: base } });
  s.msgs = []; s.on("message", (d) => s.msgs.push(JSON.parse(String(d))));
  s.count = (pred) => s.msgs.filter(pred).length;
  s.until = async (pred, what, ms = 8000) => { for (const t0 = Date.now(); ; await sleep(20)) { if (s.msgs.some(pred)) return; if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); } };
  return new Promise((res, rej) => { s.on("open", () => res(s)); s.on("error", rej); });
}
const exits = (id) => h.store.read(h.live.get(id).meta).filter((e) => e.msg?.event === "agent_exit").map((e) => e.msg);
const errOf = (m) => m.type === "error" && /couldn't start the agent/.test(m.message);

test("exits while starting: exit code and last stderr lines are kept; after 3 in a row automatic restarts stop", async () => {
  const id = await create(); const l = h.live.get(id); await l.ensureRunning(); // a working session first
  await l.prompt([{ type: "text", text: "hi" }]);
  writeFileSync(die, ""); l.child.kill("SIGKILL"); for (let i = 0; i < 100 && l.meta.state !== "stopped"; i++) await sleep(20);
  l.quickFails = 0; // (that kill came right after the start, so it counted as one)
  const s = await ws(id);
  for (let n = 1; n <= 3; n++) {
    s.send(JSON.stringify({ type: "prompt", text: `try ${n}` }));
    await s.until((m) => s.count(errOf) >= n, `error ${n}`);
  }
  const e = s.msgs.filter(errOf).at(-1).message;
  assert.match(e, /agent exited \(1\): Error: The module 'better_sqlite3\.node' was compiled against a different Node\.js version/);
  const x = exits(id).slice(-3);
  assert.deepEqual(x.map((m) => [m.code, m.phase, m.fails]), [[1, "starting", 1], [1, "starting", 2], [1, "starting", 3]]);
  assert.equal(x[2].gaveUp, true); assert.equal(x[1].gaveUp, undefined);
  const tail = x[2].stderrTail.split("\n");
  assert.equal(tail.length, 20, "the last 20 lines"); assert.match(tail.at(-1), /NODE_MODULE_VERSION/); assert.match(tail[0], /trace line 7/);
  assert.equal(l.crashLooping, true);
  // queued prompts aren't retried by themselves any more (no respawn loop), and the queue says why
  l.queue.add([{ type: "text", text: "queued" }]);
  const before = exits(id).length;
  await sleep(600); h.kickQueues();
  assert.equal(exits(id).length, before, "no automatic respawn");
  // fixed on the computer: the next send works and resets the counter
  rmSync(die);
  l.queue.clear();
  s.send(JSON.stringify({ type: "prompt", text: "fixed" }));
  await s.until((m) => m.type === "prompt_done", "works again");
  assert.equal(l.quickFails, 0); assert.equal(l.crashLooping, false);
  s.close();
});

test("a queued prompt that hits a crash loop pauses the queue with the reason (instead of retrying forever)", async () => {
  const id = await create(); const l = h.live.get(id); await l.ensureRunning();
  writeFileSync(die, "");
  try {
    l.child.kill("SIGKILL"); for (let i = 0; i < 100 && l.meta.state !== "stopped"; i++) await sleep(20);
    l.quickFails = 2; // two immediate failures already (setting it also replaces the count from that kill) // two immediate failures already
    l.queue.add([{ type: "text", text: "A" }]); l.queue.add([{ type: "text", text: "B" }]);
    for (let i = 0; i < 200 && !l.queue.paused; i++) await sleep(25);
    assert.equal(l.queue.paused, true);
    assert.match(l.queue.reason, /keeps exiting right after it starts \(3 times in a row\).*NODE_MODULE_VERSION.*press Resume/);
    assert.equal(l.queue.items.length, 1);
  } finally { rmSync(die, { force: true }); }
  l.resumeQueue(); // fixed: Resume resets and drains
  for (let i = 0; i < 200 && l.queue.items.length; i++) await sleep(25);
  assert.equal(l.queue.items.length, 0);
});

test("browser: one card with the exit code and the agent's output, ×N for repeats, and why it stopped retrying", { skip: !CHROME && "no Chrome" }, async () => {
  const id = await create(); const l = h.live.get(id); await l.ensureRunning();
  writeFileSync(die, "");
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  try {
    l.child.kill("SIGKILL"); for (let i = 0; i < 100 && l.meta.state !== "stopped"; i++) await sleep(20);
    l.quickFails = 0;
    const page = await browser.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${base}/#/s/${id}`); await page.waitForSelector(".composer textarea"); await sleep(400);
    for (let n = 1; n <= 3; n++) {
      await page.evaluate(() => { document.querySelector(".composer textarea").value = ""; });
      await page.type(".composer textarea", `attempt ${n}`); await page.click(".composer button.primary");
      for (let i = 0; i < 200 && exits(id).length < n + 1; i++) await sleep(25);
      await sleep(600);
    }
    await page.waitForFunction(() => document.querySelector(".composer textarea").value === "attempt 3", { timeout: 3000 }); // given back, not lost
    const r = await page.evaluate(() => ({ cards: document.querySelectorAll(".note.agentdown").length, plain: [...document.querySelectorAll(".note")].filter((n) => /^Agent stopped\. Send a message/.test(n.textContent)).length,
      text: [...document.querySelectorAll(".note.agentdown")].at(-1)?.innerText }));
    if (process.env.HEARTH_SHOTS) await page.screenshot({ path: join(process.env.HEARTH_SHOTS, "hearth-agent-exit.png") });
    assert.equal(r.cards, 2, `the kill + one collapsed card for the three failed starts: ${r.text}`);
    assert.match(r.text, /Agent stopped while starting \(exit code 1\)\. ×3/);
    assert.match(r.text, /NODE_MODULE_VERSION 141/);
    assert.match(r.text, /stopped restarting it by itself/);
    // reload: the same, from the transcript
    await page.reload(); await page.waitForSelector(".note.agentdown"); await sleep(400);
    assert.match(await page.evaluate(() => [...document.querySelectorAll(".note.agentdown")].at(-1).innerText), /×3[\s\S]*NODE_MODULE_VERSION/);
    assert.deepEqual(errs, []);
  } finally { await browser.close(); rmSync(die, { force: true }); }
});
