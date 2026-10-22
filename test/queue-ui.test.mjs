// Queued prompts in a real browser (headless Chrome via puppeteer-core), as the Tesla browser (mouse-like pointer on
// a big touchscreen) and as a phone (touch): SVG icons that draw without special fonts, no pencil button, tap the text
// to edit in place (Enter saves, Esc cancels, blur saves), and drag the handle to reorder; the order is kept on the
// server. Skips without Chrome. HEARTH_SHOTS=<dir> saves screenshots.
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
let h, base, cwd, browser;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (t) => [{ type: "text", text: t }];
before(async () => {
  const root = mkdtempSync(join(tmpdir(), "hearth-quroot-")); cwd = join(root, "p"); mkdirSync(cwd);
  const data = mkdtempSync(join(tmpdir(), "hearth-qudata-"));
  writeFileSync(join(data, "agents.json"), JSON.stringify([{ id: "mock", name: "Mock", detect: [process.execPath], command: process.execPath, args: [MOCK] }]));
  const port = 20000 + Math.floor(Math.random() * 20000);
  h = new Hearth(configFromEnv({ HEARTH_PORT: String(port), HEARTH_DATA_DIR: data, HEARTH_ROOTS: root, HEARTH_AGENTS_FILE: join(data, "agents.json"), HEARTH_IDENTITY: "single:me", HEARTH_PASSWORD: "off" }));
  await h.listen(); base = `http://127.0.0.1:${port}`;
  if (CHROME) { const { default: puppeteer } = await import("puppeteer-core"); browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] }); }
});
after(async () => { await browser?.close(); await h?.close(); });

/** A session whose agent is busy (a long prompt) with four prompts waiting behind it. */
async function busySession(title) {
  const r = await fetch(base + "/api/sessions", { method: "POST", headers: { origin: base, "x-hearth-csrf": "1", "content-type": "application/json" }, body: JSON.stringify({ agentId: "mock", cwd, title }) });
  const sid = (await r.json()).id; const l = h.live.get(sid); await l.ensureRunning();
  l.submit(text("slowest: refactor the parser"));
  for (const t of ["Add tests for the tokenizer", "Update the README with the new flags", "Run the linter and fix warnings", "Summarise what changed"]) l.queue.add(text(t));
  return { sid, l, order: () => l.queue.items.map((i) => i.content.find((c) => c.type === "text")?.text) };
}
async function open(sid, ua, w, ht, mobile) {
  const page = await browser.newPage();
  await page.setUserAgent(ua); await page.setViewport({ width: w, height: ht, isMobile: !!mobile, hasTouch: !!mobile, deviceScaleFactor: mobile ? 2 : 1 });
  await page.evaluateOnNewDocument(() => localStorage.clear());
  const logs = []; page.on("pageerror", (e) => logs.push(String(e)));
  await page.goto(`${base}/#/s/${sid}`);
  await page.waitForFunction(() => document.querySelectorAll(".qlist .qitem").length === 4, { timeout: 15000 }).catch(async () => { throw new Error(`no queue: ${logs.join(" | ")}`); });
  await sleep(200);
  page.logs = logs;
  return page;
}
const until = async (f, what, ms = 5000) => { for (const t0 = Date.now(); !(await f()); ) { if (Date.now() - t0 > ms) throw new Error("timeout: " + what); await sleep(30); } };
/** Icons are SVG with a real size; no emoji or symbol glyphs anywhere in the header or the queue. */
async function checkIcons(page) {
  const r = await page.evaluate(() => {
    const q = document.querySelector(".queue");
    const svgs = [...q.querySelectorAll("svg.ico"), ...document.querySelectorAll("#top svg.ico")].filter((s) => s.getClientRects().length);
    return { n: svgs.length, tiny: svgs.filter((s) => { const b = s.getBoundingClientRect(); return b.width < 10 || b.height < 10; }).length,
      names: [...new Set([...q.querySelectorAll("svg")].map((s) => s.dataset.icon))].sort(),
      glyphs: (q.innerText + document.querySelector("#top").innerText).match(/[\u2190-\u2BFF\u{1F000}-\u{1FFFF}]/gu) || [],
      edit: !!q.querySelector("[aria-label='Edit']") };
  });
  assert.ok(r.n >= 12, `svg icons shown: ${r.n}`); assert.equal(r.tiny, 0); assert.deepEqual(r.names, ["grip", "play", "trash"]);
  assert.deepEqual(r.glyphs, []); assert.equal(r.edit, false, "no pencil button");
}
const box = async (page, sel) => page.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, h: b.height }; }, sel);

test("Tesla 1920x1200: SVG icons, drag the handle to reorder, click the text to edit in place", { skip: !CHROME && "no Chrome" }, async () => {
  const { sid, l, order } = await busySession("Tesla queue");
  const page = await open(sid, TESLA_UA, 1920, 1200);
  await checkIcons(page);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "hearth-queue-tesla.png") });
  // drag the first prompt's handle down past the third
  const g = await box(page, ".qitem:nth-child(1) .qgrip"), t3 = await box(page, ".qitem:nth-child(3)");
  await page.mouse.move(g.x, g.y); await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(g.x, g.y + ((t3.y + t3.h * 0.3 - g.y) * i) / 10);
  assert.equal(await page.evaluate(() => document.querySelector(".qitem.drag") !== null), true, "dragging");
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "hearth-queue-tesla-drag.png") });
  await page.mouse.up();
  await until(() => order()[2] === "Add tests for the tokenizer", "server order after drop");
  assert.deepEqual(order(), ["Update the README with the new flags", "Run the linter and fix warnings", "Add tests for the tokenizer", "Summarise what changed"]);
  await until(() => page.evaluate(() => [...document.querySelectorAll(".qtext")].map((x) => x.textContent)[2] === "Add tests for the tokenizer"), "UI order");
  // a plain click on the handle (no movement) doesn't move anything or open the editor
  const g2 = await box(page, ".qitem:nth-child(2) .qgrip"); await page.mouse.click(g2.x, g2.y); await sleep(200);
  assert.equal(order()[1], "Run the linter and fix warnings"); assert.equal(await page.$(".qedit"), null);
  // click the text: edits in place (keyboard mode comes up in the Tesla browser), Enter saves
  await page.click(".qitem:nth-child(2) .qtext");
  await page.waitForSelector(".qitem:nth-child(2) textarea.qedit");
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("qedit")), true);
  await page.keyboard.type(" (only src/)");
  await sleep(400);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "hearth-queue-tesla-edit.png") });
  await page.keyboard.press("Enter");
  await until(() => order()[1] === "Run the linter and fix warnings (only src/)", "edit saved on the server");
  // Esc cancels
  await page.click(".qitem:nth-child(1) .qtext"); await page.waitForSelector("textarea.qedit");
  await page.keyboard.type(" XXX"); await page.keyboard.press("Escape");
  await until(() => page.evaluate(() => !document.querySelector("textarea.qedit")), "editor closed");
  assert.equal(order()[0], "Update the README with the new flags");
  // the trash can deletes
  await page.click(".qitem:nth-child(4) button[aria-label='Delete']");
  await until(() => order().length === 3, "deleted");
  assert.deepEqual(page.logs, []);
  l.queue.clear(); await l.cancel(); await page.close();
});

test("phone: touch-drag the handle to reorder (no page scroll), tap the text to edit, blur saves", { skip: !CHROME && "no Chrome" }, async () => {
  const { sid, l, order } = await busySession("Phone queue");
  const page = await open(sid, PHONE_UA, 390, 844, true);
  await checkIcons(page);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "hearth-queue-phone.png") });
  const g = await box(page, ".qitem:nth-child(4) .qgrip"), t1 = await box(page, ".qitem:nth-child(1)");
  const scroll0 = await page.evaluate(() => [scrollY, document.querySelector(".log").scrollTop, document.querySelector(".qlist").scrollTop].join());
  await page.touchscreen.touchStart(g.x, g.y);
  for (let i = 1; i <= 12; i++) await page.touchscreen.touchMove(g.x, g.y + ((t1.y - t1.h * 0.3 - g.y) * i) / 12);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "hearth-queue-phone-drag.png") });
  assert.equal(await page.evaluate(() => [scrollY, document.querySelector(".log").scrollTop, document.querySelector(".qlist").scrollTop].join()), scroll0, "dragging the handle doesn't scroll the page");
  await page.touchscreen.touchEnd();
  await until(() => order()[0] === "Summarise what changed", "moved to the top on the server");
  assert.deepEqual(order(), ["Summarise what changed", "Add tests for the tokenizer", "Update the README with the new flags", "Run the linter and fix warnings"]);
  // tap the text: edits in place; tapping elsewhere (blur) saves. (Chrome's gesture detector drops a synthetic tap
  // that comes within a few ms of the previous touch sequence, so give it a human pause.)
  await sleep(400);
  await page.tap(".qitem:nth-child(3) .qtext");
  await page.waitForSelector(".qitem:nth-child(3) textarea.qedit");
  await page.evaluate(() => { const t = document.querySelector("textarea.qedit"); t.value = "Update the README"; });
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "hearth-queue-phone-edit.png") });
  await page.tap("#title"); // tap somewhere else
  await until(() => order()[2] === "Update the README", "blur saved");
  // send now from the queue
  await sleep(300); await page.tap(".qitem:nth-child(2) button[aria-label='Send now']");
  await until(() => !order().includes("Add tests for the tokenizer"), "sent now");
  assert.deepEqual(page.logs, []);
  l.queue.clear(); await l.cancel(); await page.close();
});
