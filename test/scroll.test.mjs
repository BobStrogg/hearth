// Real-browser test of lazy history + scroll anchoring (headless Chrome via puppeteer-core). Skips if no Chrome.
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hearth, configFromEnv } from "../dist/server.js";

const CHROME = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p));
const MOCK = new URL("./mock-agent.mjs", import.meta.url).pathname;
let h, base, root, browser;
before(async () => {
  if (!CHROME) return;
  root = mkdtempSync(join(tmpdir(), "hearth-sroot-")); mkdirSync(join(root, "p"));
  const data = mkdtempSync(join(tmpdir(), "hearth-sdata-"));
  writeFileSync(join(data, "agents.json"), JSON.stringify([{ id: "mock", name: "Mock", detect: [process.execPath], command: process.execPath, args: [MOCK] }]));
  const port = 20000 + Math.floor(Math.random() * 20000);
  h = new Hearth(configFromEnv({ HEARTH_PORT: String(port), HEARTH_DATA_DIR: data, HEARTH_ROOTS: root, HEARTH_AGENTS_FILE: join(data, "agents.json"), HEARTH_IDENTITY: "single:me" }));
  await h.listen(); base = `http://127.0.0.1:${port}`;
  const { default: puppeteer } = await import("puppeteer-core");
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
});
after(async () => { await browser?.close(); await h?.close(); });

async function session(turns, long) {
  const r = await fetch(base + "/api/sessions", { method: "POST", headers: { origin: base, "x-hearth-csrf": "1", "content-type": "application/json" }, body: JSON.stringify({ agentId: "mock", cwd: join(root, "p") }) });
  const id = (await r.json()).id; const l = h.live.get(id); await l.ensureRunning();
  for (let t = 0; t < turns; t++) {
    l.log("out", { jsonrpc: "2.0", id: 1000 + t, method: "session/prompt", params: { sessionId: "x", prompt: [{ type: "text", text: `question ${t}` }] } });
    const body = long ? `Answer ${t}.\n\n` + Array.from({ length: 6 }, (_, i) => `Paragraph ${i} of answer ${t}, with enough words to wrap a few lines on a phone.`).join("\n\n") + "\n\n```\ncode " + t + "\n```" : `ok ${t}`;
    l.log("in", { jsonrpc: "2.0", method: "session/update", params: { sessionId: "x", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: body } } } });
  }
  return id;
}
const users = (page) => page.$$eval(".msg.user", (els) => els.map((e) => e.textContent));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("opens on the tail, pages older history on scroll keeping position, ends at the beginning", { skip: !CHROME && "no Chrome" }, async () => {
  const id = await session(40, true);
  const page = await browser.newPage(); await page.setViewport({ width: 390, height: 700, isMobile: true });
  await page.goto(`${base}/#/s/${id}`); await page.waitForSelector(".msg.user");
  await sleep(300);
  let u = await users(page);
  assert.ok(u.length >= 8 && u.length < 40, `tail only, got ${u.length}`);
  assert.equal(u.at(-1), "question 39");
  const atBottom = await page.$eval(".log", (l) => l.scrollHeight - l.scrollTop - l.clientHeight < 5);
  assert.ok(atBottom, "starts at the bottom");
  // scroll to the top: an older page is prepended and the message we were looking at stays where it was
  const anchorBefore = await page.$eval(".log", (l) => { l.scrollTop = 0; const m = l.querySelector(".msg.user"); m.id = "anchor"; return m.getBoundingClientRect().top; });
  await page.waitForFunction((n) => document.querySelectorAll(".msg.user").length > n, {}, u.length);
  await sleep(100);
  const anchorAfter = await page.$eval("#anchor", (m) => m.getBoundingClientRect().top);
  assert.ok(Math.abs(anchorAfter - anchorBefore) <= 2, `anchor moved ${anchorBefore} -> ${anchorAfter}`);
  // keep going until the beginning
  for (let i = 0; i < 20; i++) {
    if (await page.$eval(".histtop", (e) => e.textContent === "Beginning of conversation")) break;
    await page.$eval(".log", (l) => { l.scrollTop = 0; l.dispatchEvent(new Event("scroll")); }); await sleep(250);
  }
  assert.equal(await page.$eval(".histtop", (e) => e.textContent), "Beginning of conversation");
  u = await users(page);
  assert.deepEqual(u, Array.from({ length: 40 }, (_, t) => `question ${t}`), "every turn once, in order");
  // scrolled up: live streaming doesn't yank you down
  await page.$eval(".log", (l) => { l.scrollTop = 0; });
  await page.type("textarea", "stream"); await page.click(".composer button.primary");
  await page.waitForFunction(() => /Hello world!/.test(document.querySelector(".log").textContent));
  assert.ok(await page.$eval(".log", (l) => l.scrollTop < 50), "stayed scrolled up");
  // at the bottom: live streaming sticks to the bottom
  await page.$eval(".log", (l) => { l.scrollTop = l.scrollHeight; });
  await page.$eval("textarea", (t) => { t.value = "stream again"; }); await page.click(".composer button.primary");
  await page.waitForFunction(() => (document.querySelector(".log").textContent.match(/Hello world!/g) || []).length === 2);
  await sleep(150);
  assert.ok(await page.$eval(".log", (l) => l.scrollHeight - l.scrollTop - l.clientHeight < 10), "stuck to bottom");
  await page.close();
});

test("a short tail that doesn't fill the screen auto-loads more", { skip: !CHROME && "no Chrome" }, async () => {
  const id = await session(30, false);
  const page = await browser.newPage(); await page.setViewport({ width: 390, height: 900 });
  await page.goto(`${base}/#/s/${id}`);
  await page.waitForFunction(() => document.querySelector(".histtop")?.textContent === "Beginning of conversation" || document.querySelector(".log").scrollHeight > document.querySelector(".log").clientHeight + 200, { timeout: 20000 });
  const u = await users(page);
  assert.ok(u.length > 8, `loaded more than the first page (${u.length})`);
  await page.close();
});
