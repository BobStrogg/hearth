// Keyboard mode in a real browser (headless Chrome via puppeteer-core): the app follows the visual viewport, ⌨︎ squeezes
// it into the top part of the screen with the composer pinned and the conversation at its end, −/+ resize it, and the
// Tesla browser turns it on while a text field has focus. Skips without Chrome. HEARTH_SHOTS=<dir> saves screenshots.
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hearth, configFromEnv } from "../dist/server.js";

const CHROME = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p));
const MOCK = new URL("./mock-agent.mjs", import.meta.url).pathname;
const TESLA_UA = "Mozilla/5.0 (X11; GNU/Linux) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/140.0 Chrome/140.0 Safari/537.36 Tesla/2026.20";
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const SHOTS = process.env.HEARTH_SHOTS;
let h, base, root, browser, sid;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
before(async () => {
  root = mkdtempSync(join(tmpdir(), "hearth-kroot-")); const cwd = join(root, "p"); mkdirSync(cwd);
  const data = mkdtempSync(join(tmpdir(), "hearth-kdata-"));
  writeFileSync(join(data, "agents.json"), JSON.stringify([{ id: "mock", name: "Mock", detect: [process.execPath], command: process.execPath, args: [MOCK] }]));
  const port = 20000 + Math.floor(Math.random() * 20000);
  h = new Hearth(configFromEnv({ HEARTH_PORT: String(port), HEARTH_DATA_DIR: data, HEARTH_ROOTS: root, HEARTH_FILES_ROOT: root, HEARTH_AGENTS_FILE: join(data, "agents.json"), HEARTH_IDENTITY: "single:me", HEARTH_PASSWORD: "off" }));
  await h.listen(); base = `http://127.0.0.1:${port}`;
  const r = await fetch(base + "/api/sessions", { method: "POST", headers: { origin: base, "x-hearth-csrf": "1", "content-type": "application/json" }, body: JSON.stringify({ agentId: "mock", cwd, title: "Keyboard test" }) });
  sid = (await r.json()).id; const l = h.live.get(sid); await l.ensureRunning();
  for (let t = 0; t < 25; t++) {
    l.log("out", { jsonrpc: "2.0", id: 500 + t, method: "session/prompt", params: { sessionId: "x", prompt: [{ type: "text", text: `question ${t}` }] } });
    l.log("in", { jsonrpc: "2.0", method: "session/update", params: { sessionId: "x", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Answer number ${t}. `.repeat(6) } } } });
  }
  if (CHROME) { const { default: puppeteer } = await import("puppeteer-core"); browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] }); }
});
after(async () => { await browser?.close(); await h?.close(); });

async function open(ua, w, ht, mobile) {
  const page = await browser.newPage();
  await page.setUserAgent(ua); await page.setViewport({ width: w, height: ht, isMobile: !!mobile, hasTouch: !!mobile, deviceScaleFactor: mobile ? 2 : 1 });
  await page.evaluateOnNewDocument(() => localStorage.clear());
  const logs = []; page.on("console", (m) => logs.push(m.text())); page.on("pageerror", (e) => logs.push(String(e)));
  await page.goto(`${base}/#/s/${sid}`);
  try { await page.waitForSelector(".composer textarea", { timeout: 15000 }); }
  catch (e) { throw new Error(`no composer (${ua.slice(0, 30)}): ${logs.join(" | ")} :: ${await page.evaluate(() => document.querySelector("#view")?.innerText?.slice(0, 200))}`); }
  await page.waitForFunction(() => document.querySelectorAll(".log > *").length > 5, { timeout: 10000 }).catch(() => {}); // history replay; layout checks don't depend on it
  await sleep(300);
  return page;
}
const geo = (page) => page.evaluate(() => {
  const ta = document.querySelector(".composer textarea").getBoundingClientRect(), log = document.querySelector(".log");
  return { body: document.body.getBoundingClientRect().height, taBottom: ta.bottom, taTop: ta.top, atEnd: log.scrollHeight - log.scrollTop - log.clientHeight < 4,
    kbm: document.body.classList.contains("kbm"), toggleShown: getComputedStyle(document.querySelector("#kbctl")).display !== "none",
    stepShown: getComputedStyle(document.querySelector("#kbdp")).display !== "none" };
});

test("Tesla 1920x1200: keyboard mode follows focus on the composer and other fields, debounced; ⌨︎ and −/+", { skip: !CHROME && "no Chrome" }, async () => {
  const page = await open(TESLA_UA, 1920, 1200);
  let g = await geo(page); assert.equal(g.kbm, false); assert.ok(Math.abs(g.body - 1200) < 2, `full height ${g.body}`); assert.ok(g.toggleShown, "⌨︎ shown in the Tesla browser");
  await page.focus(".composer textarea");
  await page.waitForFunction(() => document.body.classList.contains("kbm"), { timeout: 3000 }).catch(() => {}); await sleep(150); // slow CI runners
  g = await geo(page); assert.equal(g.kbm, true); assert.ok(Math.abs(g.body - 624) < 2, `52% of 1200 = 624, got ${g.body}`);
  assert.ok(g.taBottom <= 624 && g.taTop > 400, `composer pinned at the bottom of the squeezed app (${g.taTop}-${g.taBottom})`); assert.ok(g.atEnd, "conversation at the latest message"); assert.ok(g.stepShown);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "hearth-tesla-keyboard.png") });
  // Blur and refocus quickly: no flap.
  await page.evaluate(() => document.activeElement.blur()); await sleep(200); await page.focus(".composer textarea"); await sleep(700);
  assert.equal((await geo(page)).kbm, true, "a quick blur/refocus doesn't turn it off");
  await page.click("#kbdp"); await sleep(150); g = await geo(page); assert.ok(Math.abs(g.body - 684) < 2, `+ -> 57% = 684, got ${g.body}`);
  assert.equal(await page.evaluate(() => localStorage.getItem("hearth.kbFrac")), "0.57");
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA", "−/+ keep the field focused (keyboard stays up)");
  await page.click("#kbm"); await sleep(150); assert.equal((await geo(page)).kbm, false, "⌨︎ turns it off even while the field has focus");
  await page.click("#kbm"); await sleep(150); assert.equal((await geo(page)).kbm, true);
  await page.click("#kbm"); await sleep(150);
  await page.evaluate(() => document.activeElement.blur()); await sleep(800);
  g = await geo(page); assert.equal(g.kbm, false); assert.ok(Math.abs(g.body - 1200) < 2, "off on blur");
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "hearth-tesla-normal.png") });
  // Other text fields (the file browser) trigger it too.
  await page.goto(`${base}/#/files`); await page.waitForSelector(".files");
  await page.evaluate(() => { const i = document.createElement("input"); i.type = "text"; i.id = "probe"; document.querySelector("#view").prepend(i); });
  await page.focus("#probe"); await sleep(400); await page.waitForFunction(() => document.body.classList.contains("kbm"), { timeout: 3000 }).catch(() => {}); assert.equal(await page.evaluate(() => document.body.classList.contains("kbm")), true, "any text input");
  await page.close();
});

test("phone: no automatic mode; ⌨︎ toggles it by hand and sizes to the viewport", { skip: !CHROME && "no Chrome" }, async () => {
  const page = await open(PHONE_UA, 390, 844, true);
  let g = await geo(page); assert.ok(g.toggleShown, "⌨︎ shown on touch screens"); assert.ok(Math.abs(g.body - 844) < 2, `${g.body}`);
  await page.focus(".composer textarea"); await sleep(400); assert.equal((await geo(page)).kbm, false, "not automatic outside the Tesla browser");
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "hearth-phone-normal.png") });
  await page.tap("#kbm"); await sleep(200); g = await geo(page);
  assert.equal(g.kbm, true); assert.ok(Math.abs(g.body - Math.round(844 * 0.52)) < 2, `${g.body}`); assert.ok(g.taBottom <= g.body + 1); assert.ok(g.atEnd);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "hearth-phone-keyboard.png") });
  await page.close();
});

test("desktop: ⌨︎ hidden (fine pointer, not Tesla)", { skip: !CHROME && "no Chrome" }, async () => {
  const page = await open("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", 1280, 800);
  assert.equal((await geo(page)).toggleShown, false); await page.close();
});
