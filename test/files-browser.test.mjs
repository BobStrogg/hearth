// Files browser in a real browser (headless Chrome via puppeteer-core): clicking a file preflights it, a file that
// can't be read shows the reason in the list, and a readable one lands in the downloads folder. Skips without Chrome.
import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hearth, configFromEnv } from "../dist/server.js";

const CHROME = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p));
const canLock = process.platform !== "win32" && process.getuid?.() !== 0;
let h, base, root, dl, browser;
const data = randomBytes(150_000);
before(async () => {
  root = mkdtempSync(join(tmpdir(), "hearth-froot-")); dl = mkdtempSync(join(tmpdir(), "hearth-dl-"));
  writeFileSync(join(root, "Model part.stl"), data);
  writeFileSync(join(root, "locked.stl"), "x"); if (canLock) chmodSync(join(root, "locked.stl"), 0o000);
  const dd = mkdtempSync(join(tmpdir(), "hearth-fdata-"));
  writeFileSync(join(dd, "agents.json"), "[]");
  const port = 20000 + Math.floor(Math.random() * 20000);
  h = new Hearth(configFromEnv({ HEARTH_PORT: String(port), HEARTH_DATA_DIR: dd, HEARTH_ROOTS: root, HEARTH_FILES_ROOT: root, HEARTH_AGENTS_FILE: join(dd, "agents.json"), HEARTH_IDENTITY: "single:me", HEARTH_PASSWORD: "off" }));
  await h.listen(); base = `http://127.0.0.1:${port}`;
  if (CHROME) { const { default: puppeteer } = await import("puppeteer-core"); browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] }); }
});
after(async () => { await browser?.close(); await h?.close(); if (canLock) chmodSync(join(root, "locked.stl"), 0o600); });

test("files UI: unreadable file shows why; readable file downloads intact", { skip: !CHROME && "no Chrome" }, async () => {
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dl, eventsEnabled: true });
  const done = new Promise((res) => cdp.on("Browser.downloadProgress", (e) => { if (e.state !== "inProgress") res(e.state); }));
  await page.goto(base + "/#/files"); await page.waitForSelector("a.fname");
  if (canLock) {
    await page.evaluate(() => [...document.querySelectorAll("a.fname")].find((a) => a.textContent.includes("locked.stl")).click());
    await page.waitForSelector(".files .err:not([hidden])", { timeout: 5000 });
    assert.match(await page.$eval(".files .err:not([hidden])", (e) => e.textContent), /Can't download: permission denied/);
  }
  await page.evaluate(() => [...document.querySelectorAll("a.fname")].find((a) => a.textContent.includes("Model part")).click());
  assert.equal(await Promise.race([done, new Promise((r) => setTimeout(() => r("timeout"), 8000))]), "completed");
  assert.deepEqual(readdirSync(dl), ["Model part.stl"]); assert.ok(readFileSync(join(dl, "Model part.stl")).equals(data));
  await page.close();
});
