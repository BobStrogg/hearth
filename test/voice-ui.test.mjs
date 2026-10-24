// Voice in a real browser (headless Chrome via puppeteer-core): dictation with the browser's speech recognition
// (words stream into the box, nothing is sent until you say so), read-aloud of the final reply without code, the
// per-reply speaker, hands-free, and the Tesla-style fallback (no working SpeechRecognition): record with the (fake)
// microphone and let this computer transcribe it. Skips without Chrome. HEARTH_SHOTS=<dir> saves screenshots.
import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hearth, configFromEnv } from "../dist/server.js";
import { Voice } from "../dist/voice.js";

const CHROME = process.platform !== "win32" && [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p));
const MOCK = new URL("./mock-agent.mjs", import.meta.url).pathname;
const TESLA_UA = "Mozilla/5.0 (X11; GNU/Linux) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/140.0 Chrome/140.0 Safari/537.36 Tesla/2026.20";
const SHOTS = process.env.HEARTH_SHOTS;
let h, base, cwd, browser, data, bin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
before(async () => {
  const root = mkdtempSync(join(tmpdir(), "hearth-vroot-")); cwd = join(root, "p"); mkdirSync(cwd);
  data = mkdtempSync(join(tmpdir(), "hearth-vdata-")); bin = mkdtempSync(join(tmpdir(), "hearth-vbin-"));
  writeFileSync(join(data, "agents.json"), JSON.stringify([{ id: "mock", name: "Mock", detect: [process.execPath], command: process.execPath, args: [MOCK] }]));
  writeFileSync(join(bin, "whisper-cli"), "#!/bin/sh\necho ' Hello world.'\n"); chmodSync(join(bin, "whisper-cli"), 0o755);
  mkdirSync(join(data, "models")); writeFileSync(join(data, "models", "ggml-base.en-q5_1.bin"), "model");
  const port = 20000 + Math.floor(Math.random() * 20000);
  h = new Hearth(configFromEnv({ HEARTH_PORT: String(port), HEARTH_DATA_DIR: data, HEARTH_ROOTS: root, HEARTH_AGENTS_FILE: join(data, "agents.json"), HEARTH_IDENTITY: "single:me", HEARTH_PASSWORD: "off" }));
  h.voice = new Voice(data, { HEARTH_WHISPER_BIN: join(bin, "whisper-cli"), HEARTH_TTS: "off" }, "linux");
  await h.listen(); base = `http://127.0.0.1:${port}`;
  if (CHROME) {
    const { default: puppeteer } = await import("puppeteer-core");
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  }
});
after(async () => { await browser?.close(); await h?.close(); });

async function session(title) {
  const r = await fetch(base + "/api/sessions", { method: "POST", headers: { origin: base, "x-hearth-csrf": "1", "content-type": "application/json" }, body: JSON.stringify({ agentId: "mock", cwd, title }) });
  const sid = (await r.json()).id; await h.live.get(sid).ensureRunning(); return sid;
}
/** Fakes installed before the app loads. sr: "ok" (scripted results), "network" (API present, service fails), "none". */
async function open(sid, { ua, w = 1280, ht = 800, sr = "ok", synth = true, prefs = {} } = {}) {
  const page = await browser.newPage();
  if (ua) await page.setUserAgent(ua);
  await page.setViewport({ width: w, height: ht });
  await page.evaluateOnNewDocument((sr, synth, prefs) => {
    localStorage.clear(); for (const [k, v] of Object.entries(prefs)) localStorage.setItem(`hearth.voice.${k}`, v);
    window.__said = []; window.__srs = [];
    delete window.SpeechRecognition; delete window.webkitSpeechRecognition;
    if (sr !== "none") {
      window.webkitSpeechRecognition = class {
        constructor() { window.__srs.push(this); this.running = false; }
        start() { this.running = true; if (sr === "network") setTimeout(() => { this.onerror?.({ error: "network" }); this.running = false; this.onend?.(); }, 20); }
        stop() { if (!this.running) return; this.running = false; setTimeout(() => this.onend?.(), 10); }
        abort() { this.stop(); }
        emit(list) { this.onresult?.({ results: list.map(([t, f]) => Object.assign([{ transcript: t }], { isFinal: f })) }); }
        finish() { this.running = false; this.onend?.(); }
      };
    }
    if (synth) {
      window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
      Object.defineProperty(window, "speechSynthesis", { configurable: true, value: { speak(u) { if (u.text.trim()) window.__said.push(u.text); setTimeout(() => u.onend?.(), 20); }, cancel() {},
        getVoices: () => [{ name: "Ava (Premium)", lang: "en-US", localService: true, voiceURI: "ava" }], addEventListener() {} } });
    } else { delete window.SpeechSynthesisUtterance; }
  }, sr, synth, prefs);
  const logs = []; page.on("pageerror", (e) => logs.push(String(e))); page.on("console", (m) => { if (m.type() === "error") logs.push(m.text()); });
  page.logs = logs;
  await page.goto(`${base}/#/s/${sid}`);
  await page.waitForFunction(() => document.querySelector(".composer .mic") && !document.querySelector(".composer .mic").hidden, { timeout: 10000 }).catch(() => { throw new Error(`no mic button: ${logs.join(" | ")}`); });
  return page;
}
const userMsgs = (page) => page.evaluate(() => [...document.querySelectorAll(".msg.user")].map((e) => e.textContent));

test("dictation streams into the box and waits for Send; read-aloud speaks the final reply without code", { skip: !CHROME && "no Chrome" }, async () => {
  const sid = await session("Voice desktop"); const page = await open(sid);
  await page.click(".composer .mic");
  await page.waitForFunction(() => window.__srs.length === 1 && window.__srs[0].running);
  assert.equal(await page.$eval(".composer .mic", (b) => b.classList.contains("rec")), true);
  await page.evaluate(() => window.__srs[0].emit([["fix the", false]]));
  assert.equal(await page.$eval(".composer textarea", (t) => t.value), "fix the", "interim words show straight away");
  await page.evaluate(() => window.__srs[0].emit([["fix the parser", true], [" and", false]]));
  assert.equal(await page.$eval(".composer textarea", (t) => t.value), "fix the parser and");
  await page.click(".composer .mic"); await sleep(100); // stop
  assert.equal(await page.$eval(".composer .mic", (b) => b.classList.contains("rec")), false);
  assert.deepEqual(await userMsgs(page), [], "nothing sent: you can edit first");
  // read aloud on (pill by the composer), then send a prompt whose reply has a code block
  await page.waitForSelector(".ctl .readtg"); await page.click(".ctl .readtg");
  assert.equal(await page.evaluate(() => localStorage.getItem("hearth.voice.read")), "1", "remembered on this device");
  await page.$eval(".composer textarea", (t) => { t.value = "codeblock"; }); await page.click(".composer button.primary");
  await page.waitForFunction(() => window.__said.length > 0, { timeout: 10000 }).catch(async (e) => { throw new Error(`${e.message}: ${await page.evaluate(() => JSON.stringify({ said: window.__said, read: localStorage.getItem("hearth.voice.read"), log: document.querySelector(".log").textContent.slice(-300), vis: document.visibilityState }))} ${page.logs.join(" | ")}`); });
  await sleep(200);
  assert.equal((await page.evaluate(() => window.__said)).join(" "), "Here is the fix: (code omitted) All done. Hello world!");
  // the speaker on that reply reads it again
  await page.evaluate(() => { window.__said = []; });
  await page.click(".msg.agent:last-of-type .say");
  await page.waitForFunction(() => window.__said.length > 0);
  assert.match((await page.evaluate(() => window.__said)).join(" "), /All done/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "voice-desktop.png") });
  assert.deepEqual(page.logs, []);
  await page.close();
});

test("hands-free: after the reply is read it listens again and sends when you stop talking", { skip: !CHROME && "no Chrome" }, async () => {
  const sid = await session("Voice hands-free"); const page = await open(sid, { prefs: { read: "1", handsfree: "1", autosend: "1" } });
  await page.$eval(".composer textarea", (t) => { t.value = "first"; }); await page.click(".composer button.primary");
  await page.waitForFunction(() => window.__srs.some((r) => r.running), { timeout: 10000 }); // listening again by itself
  const r = await page.evaluateHandle(() => window.__srs.find((x) => x.running));
  assert.equal(await r.evaluate((x) => x.continuous), false, "stops at a pause");
  await r.evaluate((x) => { x.emit([["second question", true]]); x.finish(); });
  await page.waitForFunction(() => document.querySelectorAll(".msg.user").length === 2, { timeout: 5000 });
  assert.deepEqual(await userMsgs(page), ["first", "second question"]);
  await page.close();
});

test("Tesla-style browser: SpeechRecognition fails (network), so it records and this computer transcribes", { skip: !CHROME && "no Chrome" }, async () => {
  const sid = await session("Voice Tesla"); const page = await open(sid, { ua: TESLA_UA, w: 1920, ht: 1200, sr: "network", synth: false });
  await page.click(".composer .mic");
  await page.waitForFunction(() => document.querySelector(".composer .mic").classList.contains("rec") && localStorage.getItem("hearth.voice.srBroken") === "1", { timeout: 5000 });
  await page.waitForFunction(() => [...document.querySelectorAll(".note")].some((n) => /using this computer/.test(n.textContent)));
  await sleep(1200); // record a little of the fake microphone
  await page.click(".composer .mic");
  await page.waitForFunction(() => document.querySelector(".composer textarea").value === "Hello world.", { timeout: 10000 });
  assert.deepEqual(await userMsgs(page), [], "not sent");
  // next time it goes straight to the recorder
  await page.click(".composer .mic"); await sleep(600); await page.click(".composer .mic");
  await page.waitForFunction(() => document.querySelector(".composer textarea").value === "Hello world. Hello world.", { timeout: 10000 });
  // keyboard mode (Tesla): the composer with the mic stays inside the squeezed app
  await page.focus(".composer textarea"); await page.waitForFunction(() => document.body.classList.contains("kbm"), { timeout: 3000 });
  const g = await page.evaluate(() => { const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { left: b.left, right: b.right, bottom: b.bottom }; };
    return { app: document.body.getBoundingClientRect().height, mic: r(".composer .mic"), send: r(".composer button.primary") }; });
  assert.ok(g.mic.bottom <= g.app && g.send.bottom <= g.app && g.mic.right <= g.send.left + 1, JSON.stringify(g));
  assert.equal(await page.$eval(".composer .mic svg", (s) => s.getAttribute("data-icon")), "mic", "an SVG icon, no glyph fonts needed");
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "voice-tesla.png") });
  assert.deepEqual(page.logs.filter((l) => !/favicon/.test(l)), []);
  await page.close();
});

test("no speech recognition anywhere yet: the mic opens Voice settings with the private set-up", { skip: !CHROME && "no Chrome" }, async () => {
  const saved = h.voice; h.voice = new Voice(mkdtempSync(join(tmpdir(), "hvnone-")), { HEARTH_WHISPER_BIN: join(bin, "missing"), HEARTH_TTS: "off" }, "linux");
  try {
    const sid = await session("Voice setup"); const page = await open(sid, { sr: "none", synth: false });
    assert.equal(await page.$(".ctl .readtg"), null, "no read-aloud toggle without any speech output");
    await page.click(".composer .mic");
    await page.waitForSelector("#sheet .sheet-body.voice", { visible: true });
    const t = await page.$eval("#sheet", (s) => s.textContent);
    assert.match(t, /no speech recognition of its own/); assert.match(t, /Set up private speech recognition/);
    await page.close();
  } finally { h.voice = saved; }
});
