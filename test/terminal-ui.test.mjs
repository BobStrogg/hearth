// Real-browser test of the terminals UI (headless Chrome via puppeteer-core): the home-screen list, opening a terminal,
// typing, leaving and coming back (the shell kept running and its output is replayed), the touch key row, and close
// with confirm. Skips without Chrome or without a C compiler for the pty helper.
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hearth, configFromEnv } from "../dist/server.js";

const CHROME = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p));
const SHOTS = process.env.HEARTH_SHOTS; // a folder to save screenshots in, for reviewing the layout
let h, base, browser, skip = !CHROME && "no Chrome";
before(async () => {
  if (skip) return;
  const root = mkdtempSync(join(tmpdir(), "hearth-turoot-")); mkdirSync(join(root, "p"));
  const data = mkdtempSync(join(tmpdir(), "hearth-tudata-"));
  writeFileSync(join(data, "agents.json"), "[]");
  const port = 20000 + Math.floor(Math.random() * 20000);
  h = new Hearth(configFromEnv({ HEARTH_PORT: String(port), HEARTH_DATA_DIR: data, HEARTH_ROOTS: root, HEARTH_AGENTS_FILE: join(data, "agents.json"), HEARTH_IDENTITY: "single:me" }));
  if (h.terminals.status().available === false) { skip = "no pty helper"; return; }
  h.terminals.o.shell = () => (existsSync("/bin/bash") ? { command: "/bin/bash", args: ["--norc", "--noprofile", "-i"] } : { command: "/bin/sh", args: ["-i"] });
  h.terminals.o.graceMs = 300;
  await h.listen(); base = `http://127.0.0.1:${port}`;
  const { default: puppeteer } = await import("puppeteer-core");
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
});
after(async () => { await browser?.close(); await h?.close(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const screen = (page) => page.$eval(".xterm-rows", (el) => el.innerText).catch(() => "");
async function until(fn, ms = 8000) { const end = Date.now() + ms; let last; while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(50); } throw new Error("timeout"); }

for (const [name, vp] of [["desktop", { width: 1100, height: 760 }], ["phone", { width: 390, height: 760, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
  test(`terminal list, attach, leave and reattach, close (${name})`, async (t) => {
    if (skip) return t.skip(skip);
    const page = await browser.newPage(); await page.setViewport(vp);
    const errors = []; page.on("pageerror", (e) => errors.push(String(e))); page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("dialog", (d) => d.accept());
    await page.goto(base + "/#/"); await page.waitForSelector("section.terms");
    assert.match(await page.$eval("section.terms", (e) => e.textContent), /No terminals open/);
    await page.$$eval("section.terms button", (bs) => bs.find((b) => /New terminal/.test(b.textContent)).click());
    await page.waitForSelector(".xterm-rows");
    await until(async () => /\$|#/.test(await screen(page)));
    await page.click(".term-host"); await page.keyboard.type("echo from-the-browser-$((6*7))\n");
    await until(async () => (await screen(page)).includes("from-the-browser-42"));
    // xterm's run-time <style> (cell size, colours) must apply under Hearth's CSP: rows have a real line height.
    const rowH = await page.$eval(".xterm-rows > div", (el) => el.getBoundingClientRect().height);
    assert.ok(rowH > 8 && rowH < 40, `row height ${rowH}`);
    const cols = await page.evaluate(() => termv.term.cols);
    assert.ok(cols > (name === "phone" ? 30 : 80), `fits the width: ${cols} columns`);
    const keys = await page.$eval(".term-keys", (el) => getComputedStyle(el).display);
    assert.equal(keys, name === "phone" ? "flex" : "none", "the key row shows on touch screens only");
    if (name === "phone") { // Ctrl from the key row, then "c": interrupts sleep
      await page.keyboard.type("sleep 30\n"); await sleep(200);
      await page.$$eval(".term-keys button", (bs) => bs.find((b) => b.textContent === "Ctrl").click());
      await page.keyboard.type("c");
      await page.keyboard.type("echo after-ctrl-c\n");
      await until(async () => (await screen(page)).includes("after-ctrl-c\n") || (await screen(page)).split("after-ctrl-c").length > 2);
    }
    await page.keyboard.type("sleep 0.5; echo done-while-away\n");
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `terminal-${name}.png`) });
    await page.goto(base + "/#/"); await page.waitForSelector(".term-row");
    const row = await page.$eval(".term-row", (e) => e.textContent);
    assert.match(row, /Terminal 1/);
    await sleep(800);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `terminal-list-${name}.png`) });
    await page.click(".term-row");
    await until(async () => (await screen(page)).includes("done-while-away"));
    assert.ok((await screen(page)).includes("from-the-browser-42"), "output from before leaving is replayed");
    // Close from the list (confirm accepted).
    await page.goto(base + "/#/"); await page.waitForSelector(".term-row .iconbtn");
    await page.click(".term-row .iconbtn");
    await until(async () => /No terminals open/.test(await page.$eval("section.terms", (e) => e.textContent)));
    assert.equal(h.terminals.list("me").filter((x) => x.state === "running").length, 0);
    assert.deepEqual(errors.filter((e) => !/favicon|manifest/.test(e)), []);
    await page.close();
  });
}

test("#/terminals opens the home screen at the Terminals section; the toolbar has a Terminals button", async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage(); await page.setViewport({ width: 390, height: 500, isMobile: true, hasTouch: true });
  await page.goto(base + "/#/terminals"); await page.waitForSelector("section.terms");
  assert.ok(await page.$$eval(".toolbar button", (bs) => bs.some((b) => /Terminals/.test(b.textContent))), "Terminals button");
  await until(() => page.$eval("section.terms", (e) => { const r = e.getBoundingClientRect(); return r.top >= -1 && r.top < innerHeight; }));
  await page.close();
});
