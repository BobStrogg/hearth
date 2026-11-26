// Tool-call expanders and markdown code must not widen the chat column (headless Chrome via puppeteer-core).
// Skips if no Chrome.
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hearth, configFromEnv } from "../dist/server.js";

const CHROME = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p));
const MOCK = new URL("./mock-agent.mjs", import.meta.url).pathname;
const LONG = "A".repeat(400);
const LONG_PATH = "/Users/someone/Developer/" + "very-long-directory-name/".repeat(16) + "file-with-a-long-name.ts";
const LONG_URL = "https://example.com/api/v1/" + "segment/".repeat(24) + "resource?token=" + "abc123DEF456".repeat(20);
const LONG_CMD = "pnpm exec eslint --fix " + LONG_PATH;
const LONG_TITLE = "Bash: " + LONG_CMD;
const SHOT = join(tmpdir(), "hearth-chat-overflow-390.png");

const upd = (update) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "x", update } });

let h, base, root, browser;
before(async () => {
  if (!CHROME) return;
  root = mkdtempSync(join(tmpdir(), "hearth-oroot-")); mkdirSync(join(root, "p"));
  const data = mkdtempSync(join(tmpdir(), "hearth-odata-"));
  writeFileSync(join(data, "agents.json"), JSON.stringify([{ id: "mock", name: "Mock", detect: [process.execPath], command: process.execPath, args: [MOCK] }]));
  const port = 20000 + Math.floor(Math.random() * 20000);
  h = new Hearth(configFromEnv({ HEARTH_PORT: String(port), HEARTH_DATA_DIR: data, HEARTH_ROOTS: root, HEARTH_AGENTS_FILE: join(data, "agents.json"), HEARTH_IDENTITY: "single:me" }));
  await h.listen(); base = `http://127.0.0.1:${port}`;
  const { default: puppeteer } = await import("puppeteer-core");
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
});
after(async () => { await browser?.close(); await h?.close(); });

async function session() {
  const r = await fetch(base + "/api/sessions", { method: "POST", headers: { origin: base, "x-hearth-csrf": "1", "content-type": "application/json" }, body: JSON.stringify({ agentId: "mock", cwd: join(root, "p") }) });
  const id = (await r.json()).id; const l = h.live.get(id); await l.ensureRunning();
  l.log("out", { jsonrpc: "2.0", id: 1000, method: "session/prompt", params: { sessionId: "x", prompt: [{ type: "text", text: "please run the long tools" }] } });
  l.log("in", upd({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Considering `" + LONG_CMD + "` and " + LONG_URL } }));
  l.log("in", upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Here is a path `" + LONG_PATH + "` and a URL " + LONG_URL + "\n\n```\n" + LONG_CMD + "\n" + LONG + "\n```\n" } }));
  l.log("in", upd({ sessionUpdate: "tool_call", toolCallId: "diff1", title: "Edit " + LONG_PATH, kind: "edit", status: "completed",
    content: [{ type: "diff", path: LONG_PATH, oldText: "const x = '" + "old".repeat(120) + "';\n", newText: "const x = '" + "new".repeat(120) + "';\n" }] }));
  l.log("in", upd({ sessionUpdate: "tool_call", toolCallId: "out1", title: LONG_TITLE, kind: "execute", status: "completed",
    content: [{ type: "content", content: { type: "text", text: "ERROR " + LONG_PATH + ": " + LONG + "\n" + LONG_URL + "\n" } }] }));
  l.log("in", upd({ sessionUpdate: "tool_call", toolCallId: "json1", title: "Call API", kind: "other", status: "completed",
    rawInput: { command: LONG_CMD, url: LONG_URL, token: LONG } }));
  l.log("in", upd({ sessionUpdate: "tool_call", toolCallId: "raw1", title: "Read output", kind: "read", status: "completed",
    rawOutput: "LOG " + LONG_PATH + " " + LONG + "\n" }));
  l.log("in", upd({ sessionUpdate: "tool_call", toolCallId: "title1", title: LONG_TITLE, kind: "execute", status: "in_progress" }));
  l.log("in", upd({ sessionUpdate: "plan", entries: [
    { status: "in_progress", content: "Run " + LONG_CMD },
    { status: "pending", content: "Fetch " + LONG_URL },
  ] }));
  return id;
}

const measures = (page) => page.evaluate(() => {
  const box = (el) => el ? { sw: el.scrollWidth, cw: el.clientWidth, bw: el.getBoundingClientRect().width } : null;
  const de = document.documentElement;
  const fits = (el) => !el || el.scrollWidth <= el.clientWidth + 1;
  const pres = [...document.querySelectorAll(".log pre")].map((p) => ({ className: p.className, sw: p.scrollWidth, cw: p.clientWidth, overflows: p.scrollWidth > p.clientWidth + 1 }));
  const tools = [...document.querySelectorAll(".tool")].map((t) => ({ open: t.open, title: t.querySelector("summary")?.textContent.trim() ?? "", sw: t.scrollWidth, cw: t.clientWidth, sumSw: t.querySelector("summary")?.scrollWidth, sumCw: t.querySelector("summary")?.clientWidth }));
  return {
    doc: { sw: de.scrollWidth, cw: de.clientWidth },
    body: box(document.body),
    main: box(document.querySelector("main")),
    chat: box(document.querySelector(".chat")),
    log: box(document.querySelector(".log")),
    fits: {
      doc: de.scrollWidth <= de.clientWidth + 1,
      body: fits(document.body),
      main: fits(document.querySelector("main")),
      chat: fits(document.querySelector(".chat")),
      log: fits(document.querySelector(".log")),
    },
    pres,
    tools,
    toolCount: tools.length,
  };
});

test("long tool-call and markdown content stays inside the chat column at 390px", { skip: !CHROME && "no Chrome" }, async () => {
  const id = await session();
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2, isLandscape: false });
  await page.goto(`${base}/#/s/${id}`);
  await page.waitForSelector("details.tool");
  await page.waitForFunction(() => document.querySelectorAll("details.tool").length >= 5);
  // Open every expander except the in-progress long-title tool, which stays collapsed.
  await page.$$eval("details.tool, details.thought", (els) => {
    for (const el of els) {
      if (el.classList.contains("tool") && el.querySelector("summary.in_progress")) continue;
      el.open = true;
    }
  });
  await page.waitForFunction(() => [...document.querySelectorAll("details.tool:not(:has(summary.in_progress)), details.thought")].every((d) => d.open));
  // Paint, then measure.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const m = await measures(page);
  await page.screenshot({ path: SHOT, fullPage: true });
  assert.ok(m.toolCount >= 5, `expected tool cards, got ${m.toolCount}`);
  assert.ok(m.pres.length >= 3, `expected pre blocks in tools and markdown, got ${m.pres.length}`);
  assert.ok(m.pres.some((p) => p.overflows || p.className.includes("payload")), `long pre should scroll or wrap; got ${JSON.stringify(m.pres)}`);
  for (const [name, ok] of Object.entries(m.fits)) {
    assert.ok(ok, `${name} horizontal overflow: ${JSON.stringify(m[name] || m.doc)}`);
  }
  const collapsed = m.tools.find((t) => /Bash: pnpm exec eslint/.test(t.title) && !t.open);
  assert.ok(collapsed, "collapsed long-title tool");
  assert.ok(collapsed.sw <= collapsed.cw + 1, `collapsed title widened the tool: ${JSON.stringify(collapsed)}`);
  console.log("overflow screenshot:", SHOT);
  await page.close();
});
