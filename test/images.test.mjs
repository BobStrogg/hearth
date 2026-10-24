// Inline images: ACP image/resource blocks, markdown images, tool results, history paging, the session-file endpoint.
// Real browser (headless Chrome via puppeteer-core); browser tests skip if no Chrome.
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { deflateSync } from "node:zlib";
import { Hearth, configFromEnv, sniffImage } from "../dist/server.js";

const CHROME = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p));
const MOCK = new URL("./mock-agent.mjs", import.meta.url).pathname;

function crc32(b) { let c, crc = ~0; for (const x of b) { c = (crc ^ x) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; }
/** Solid-colour RGB PNG of w x h. */
function png(w, h, rgb = [200, 80, 40]) {
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}
const B64 = png(320, 240).toString("base64");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><script>window.__pwned=1</script><rect width="40" height="40" fill="red"/></svg>').toString("base64");

let h, base, root, cwd, browser;
before(async () => {
  root = mkdtempSync(join(tmpdir(), "hearth-iroot-")); cwd = join(root, "p"); mkdirSync(cwd);
  writeFileSync(join(cwd, "chart.png"), png(300, 200, [40, 120, 220]));
  writeFileSync(join(cwd, "fake.png"), "not really a png");
  writeFileSync(join(cwd, "notes.txt"), "secret notes");
  writeFileSync(join(root, "outside.png"), png(10, 10));
  symlinkSync(join(root, "outside.png"), join(cwd, "link.png"));
  writeFileSync(join(cwd, "pic.svg"), Buffer.from(SVG, "base64"));
  const data = mkdtempSync(join(tmpdir(), "hearth-idata-"));
  writeFileSync(join(data, "agents.json"), JSON.stringify([{ id: "mock", name: "Mock", detect: [process.execPath], command: process.execPath, args: [MOCK] }]));
  const port = 20000 + Math.floor(Math.random() * 20000);
  h = new Hearth(configFromEnv({ HEARTH_PORT: String(port), HEARTH_DATA_DIR: data, HEARTH_ROOTS: root, HEARTH_AGENTS_FILE: join(data, "agents.json"), HEARTH_IDENTITY: "single:me" }));
  await h.listen(); base = `http://127.0.0.1:${port}`;
  if (CHROME) { const { default: puppeteer } = await import("puppeteer-core"); browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] }); }
});
after(async () => { await browser?.close(); await h?.close(); });

const upd = (update) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "x", update } });
async function newSession() {
  const r = await fetch(base + "/api/sessions", { method: "POST", headers: { origin: base, "x-hearth-csrf": "1", "content-type": "application/json" }, body: JSON.stringify({ agentId: "mock", cwd }) });
  const id = (await r.json()).id; const l = h.live.get(id); await l.ensureRunning(); return { id, l };
}
/** A turn whose answer has text, an ACP image block, then more text; a tool call with an image result. */
function imageTurn(l, t) {
  l.log("out", { jsonrpc: "2.0", id: 1000 + t, method: "session/prompt", params: { sessionId: "x", prompt: [{ type: "text", text: `question ${t}` }] } });
  l.log("in", upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Here is picture ${t}:` } }));
  l.log("in", upd({ sessionUpdate: "agent_message_chunk", content: { type: "image", mimeType: "image/png", data: B64 } }));
  l.log("in", upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `after picture ${t}` } }));
  l.log("in", upd({ sessionUpdate: "tool_call", toolCallId: `tc${t}`, title: `screenshot ${t}`, status: "in_progress" }));
  l.log("in", upd({ sessionUpdate: "tool_call_update", toolCallId: `tc${t}`, status: "completed", content: [{ type: "content", content: { type: "image", mimeType: "image/png", data: B64 } }] }));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const imgsLoaded = (page) => page.waitForFunction(() => [...document.querySelectorAll(".log img.inl")].every((i) => i.complete), { timeout: 8000 });
/** Images on (or near) screen have loaded; lazy ones far away are allowed to wait. */
const visibleLoaded = (page) => page.waitForFunction(() => { const lr = document.querySelector(".log").getBoundingClientRect();
  return [...document.querySelectorAll(".log img.inl")].filter((i) => { const r = i.getBoundingClientRect(); return r.bottom > lr.top - 300 && r.top < lr.bottom + 300; }).every((i) => i.complete && i.naturalWidth > 0); }, { timeout: 8000 });

test("sniffImage checks magic bytes", () => {
  assert.ok(sniffImage(png(2, 2), "image/png"));
  assert.ok(!sniffImage(Buffer.from("hello"), "image/png"));
  assert.ok(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"));
  assert.ok(sniffImage(Buffer.from("GIF89a...."), "image/gif"));
  assert.ok(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 "), "image/webp"));
  assert.ok(sniffImage(Buffer.from("<?xml version='1.0'?><svg xmlns='x'/>"), "image/svg+xml"));
  assert.ok(!sniffImage(Buffer.from("<html><script>"), "image/svg+xml"));
});

test("session-file endpoint: only images, only inside the session folder", async () => {
  const { id } = await newSession();
  const get = (p) => fetch(`${base}/api/sessions/${id}/file?path=${encodeURIComponent(p)}`);
  let r = await get("chart.png"); assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "image/png");
  assert.match(r.headers.get("content-security-policy"), /sandbox/); assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await r.arrayBuffer()).byteLength, png(300, 200, [40, 120, 220]).length);
  assert.equal((await get(join(cwd, "chart.png"))).status, 200, "absolute path");
  assert.equal((await get("file://" + join(cwd, "chart.png"))).status, 200, "file:// uri");
  assert.equal((await get("../outside.png")).status, 403, "traversal");
  assert.equal((await get(join(root, "outside.png"))).status, 403, "absolute outside");
  assert.equal((await get("link.png")).status, 403, "symlink escaping the folder");
  assert.equal((await get("notes.txt")).status, 415, "not an image type");
  assert.equal((await get("fake.png")).status, 415, "content isn't an image");
  assert.equal((await get("/etc/passwd")).status, 415);
  assert.equal((await get("/nonexistent/x.png")).status, 403, "no existence oracle outside the folder");
  assert.equal((await get("missing.png")).status, 404);
  r = await get("pic.svg"); assert.equal(r.status, 200); assert.match(r.headers.get("content-security-policy"), /default-src 'none'.*sandbox/);
  assert.equal((await fetch(`${base}/api/sessions/00000000-0000-0000-0000-000000000000/file?path=chart.png`)).status, 404, "unknown session");
});

test("renders image blocks, markdown images, tool images; lightbox; SVG only via <img>", { skip: !CHROME && "no Chrome" }, async () => {
  const { id, l } = await newSession();
  imageTurn(l, 0);
  l.log("out", { jsonrpc: "2.0", id: 2000, method: "session/prompt", params: { sessionId: "x", prompt: [{ type: "text", text: "markdown please" }] } });
  l.log("in", upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Chart: ![the chart](chart.png)\n\n[view image](file://" + join(cwd, "chart.png") + ")\n\n![bad](javascript:alert(1)) ![out](../outside.png)" } }));
  l.log("in", upd({ sessionUpdate: "agent_message_chunk", content: { type: "resource", resource: { uri: "mem://pic.svg", mimeType: "image/svg+xml", blob: SVG } } }));
  l.log("in", upd({ sessionUpdate: "agent_message_chunk", content: { type: "resource_link", uri: "file://" + join(cwd, "chart.png"), name: "chart.png", mimeType: "image/png" } }));
  l.log("in", upd({ sessionUpdate: "tool_call", toolCallId: "mcp1", title: "mcp screenshot", status: "completed", rawOutput: { content: [{ type: "image", data: B64, mimeType: "image/png" }, { type: "text", text: "done" }] } }));
  const page = await browser.newPage(); await page.setViewport({ width: 390, height: 800, isMobile: true });
  const errors = []; page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${base}/#/s/${id}`); await page.waitForSelector(".msg.agent img.inl");
  await page.$$eval(".log img.inl", (is) => is.forEach((i) => i.scrollIntoView())); await imgsLoaded(page); await sleep(200);
  const info = await page.$$eval(".log img.inl", (is) => is.map((i) => ({ src: i.getAttribute("src").slice(0, 40), w: i.naturalWidth, shown: i.getBoundingClientRect().width, max: i.parentElement.closest(".msg, .tool").getBoundingClientRect().width, inTool: !!i.closest(".tool"), lazy: i.loading })));
  // image block in message, tool image, markdown chart, view-image link, svg resource, resource_link, mcp rawOutput image
  assert.equal(info.length, 7, JSON.stringify(info));
  assert.ok(info.every((i) => i.w > 0), "all decoded: " + JSON.stringify(info));
  assert.ok(info.every((i) => i.shown <= i.max), "constrained to the bubble width");
  assert.ok(info.every((i) => i.lazy === "lazy"));
  assert.equal(info.filter((i) => i.inTool).length, 2, "tool content image + rawOutput image (deduped)");
  assert.ok(info.some((i) => i.src.startsWith("/api/sessions/")), "file images go through the endpoint");
  // text after an image block stays after it
  const order = await page.$eval(".msg.agent", (m) => [...m.children].filter((c) => !c.classList.contains("say")).map((c) => c.tagName + ":" + c.textContent.trim()));
  assert.deepEqual(order.map((x) => x.split(":")[0]), ["DIV", "FIGURE", "DIV"], JSON.stringify(order));
  // unsafe/outside references aren't images
  const txt = await page.$eval(".log", (l) => l.textContent);
  assert.match(txt, /!\[bad\]\(javascript:alert\(1\)\)/);
  await page.waitForFunction(() => /out \(couldn't be shown/.test(document.querySelector(".log").textContent), { timeout: 5000 });
  assert.equal(await page.$$eval(".log svg:not(svg.ico[data-icon]), .log script, .log a[href^='javascript']", (x) => x.length), 0, "no inline svg/script (other than our own icons)");
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  // tool card with images is open; base64 isn't dumped into the raw output
  assert.ok(await page.$eval(".tool:last-of-type", (d) => d.open));
  assert.match(await page.$eval(".log", (l) => [...l.querySelectorAll(".tool pre")].map((p) => p.textContent).join("")), /chars of base64/);
  // lightbox: tap opens, tap closes; Esc closes
  await page.$eval(".msg.agent img.inl", (i) => i.scrollIntoView()); await page.click(".msg.agent img.inl");
  await page.waitForSelector(".lightbox img");
  assert.ok(await page.$(".lightbox .lb-actions .imgact"), "save/open action in the lightbox");
  await page.click(".lightbox img"); await page.waitForFunction(() => !document.querySelector(".lightbox"));
  await page.click(".msg.agent img.inl"); await page.waitForSelector(".lightbox");
  await page.keyboard.press("Escape"); await page.waitForFunction(() => !document.querySelector(".lightbox"));
  // touch: tap to open, tap the backdrop to close
  await page.setViewport({ width: 390, height: 800, isMobile: true, hasTouch: true });
  await page.$eval(".msg.agent img.inl", (i) => i.scrollIntoView()); await page.tap(".msg.agent img.inl"); await page.waitForSelector(".lightbox");
  await page.touchscreen.tap(195, 20); await page.waitForFunction(() => !document.querySelector(".lightbox"));
  // captions: Save for inline data, Open for served files
  const acts = await page.$$eval(".log figcaption .imgact", (a) => a.map((x) => x.textContent));
  assert.ok(acts.includes("Save") && acts.includes("Open"), acts.join());
  assert.deepEqual(errors.filter((e) => /Content Security Policy/i.test(e)), []);
  await page.close();
});

test("history paging with images keeps the scroll anchor; opens at the end", { skip: !CHROME && "no Chrome" }, async () => {
  const { id, l } = await newSession();
  for (let t = 0; t < 30; t++) imageTurn(l, t);
  const page = await browser.newPage(); await page.setViewport({ width: 390, height: 700, isMobile: true });
  await page.goto(`${base}/#/s/${id}`); await page.waitForSelector(".msg.user");
  await visibleLoaded(page); await sleep(300);
  const gap = await page.$eval(".log", (l) => [l.scrollHeight - l.scrollTop - l.clientHeight, l.scrollHeight, window.__chat?.().atEnd, [...l.querySelectorAll("img.inl")].map((i) => i._h + "/" + i.offsetHeight).join(" ")]);
  assert.ok(gap[0] < 10, "at the end after images loaded " + JSON.stringify(gap));
  const n0 = await page.$$eval(".msg.user", (e) => e.length); assert.ok(n0 < 30);
  const before = await page.$eval(".log", (l) => { l.scrollTop = 0; const m = l.querySelector(".msg.user"); m.id = "anchor"; return m.getBoundingClientRect().top; });
  await page.waitForFunction((n) => document.querySelectorAll(".msg.user").length > n, {}, n0);
  await sleep(150); await visibleLoaded(page); await sleep(300);
  const loadedAbove = await page.$$eval(".log img.inl", (is) => is.filter((i) => i.complete && i.getBoundingClientRect().bottom < document.querySelector("#anchor").getBoundingClientRect().top).length);
  assert.ok(loadedAbove > 0, "some images in the older page loaded above the anchor (the case being tested)");
  const after = await page.$eval("#anchor", (m) => m.getBoundingClientRect().top);
  assert.ok(Math.abs(after - before) <= 2, `anchor moved ${before} -> ${after}`);
  // each image once
  const imgs = await page.$$eval(".msg.agent img.inl", (e) => e.length), users = await page.$$eval(".msg.user", (e) => e.length);
  assert.equal(imgs, users, "one message image per turn");
  await page.close();
});
