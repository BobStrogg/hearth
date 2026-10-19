// Browser-client regression tests: run web/app.js in jsdom against a real daemon + mock agent.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { JSDOM } from "jsdom";
import WebSocket from "ws";
import { Hearth, configFromEnv } from "../dist/server.js";

const MOCK = new URL("./mock-agent.mjs", import.meta.url).pathname;
const WEB = new URL("../web/", import.meta.url).pathname;
let h, base, root;
before(async () => {
  root = mkdtempSync(join(tmpdir(), "hearth-croot-")); mkdirSync(join(root, "p"));
  const data = mkdtempSync(join(tmpdir(), "hearth-cdata-"));
  writeFileSync(join(data, "agents.json"), JSON.stringify([{ id: "mock", name: "Mock", detect: [process.execPath], command: process.execPath, args: [MOCK], env: { MOCK_CONFIG: "1" } }]));
  const port = 20000 + Math.floor(Math.random() * 20000);
  h = new Hearth(configFromEnv({ HEARTH_PORT: String(port), HEARTH_DATA_DIR: data, HEARTH_ROOTS: root, HEARTH_AGENTS_FILE: join(data, "agents.json"), HEARTH_IDENTITY: "single:me" }));
  await h.listen(); base = `http://127.0.0.1:${port}`;
});
after(async () => { await h.close(); });

function browser(hash) {
  const html = readFileSync(join(WEB, "index.html"), "utf8").replace(/<script src="[^"]+"><\/script>/g, "");
  const dom = new JSDOM(html, { url: base + "/" + hash, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window; const sockets = [];
  w.fetch = (p, o = {}) => fetch(new URL(p, base), { ...o, headers: { ...(o.headers || {}), origin: base } });
  w.WebSocket = class extends WebSocket { constructor(u) { super(u, { headers: { origin: base } }); sockets.push(this); } };
  Object.defineProperty(w.document, "visibilityState", { get: () => "visible", configurable: true });
  w.matchMedia = () => ({ matches: false });
  for (const f of ["md.js", "app.js"]) w.eval(readFileSync(join(WEB, f), "utf8") + (f === "app.js" ? "\n;window.__chat = () => chat;" : ""));
  return { w, sockets, $: (s) => w.document.querySelector(s) };
}
const until = async (f, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 25)); } };

test("reconnect races (drop + tab refocus) never duplicate streamed text", async () => {
  const r = await fetch(base + "/api/sessions", { method: "POST", headers: { origin: base, "x-hearth-csrf": "1", "content-type": "application/json" }, body: JSON.stringify({ agentId: "mock", cwd: join(root, "p") }) });
  const sid = (await r.json()).id;
  const b = browser(`#/s/${sid}`);
  const open = () => b.sockets.filter((s) => s.readyState === 1).length;
  await until(() => open() === 1 && b.$(".ctl") && !b.$(".ctl").hidden);
  for (let i = 0; i < 3; i++) {
    for (const c of h.wss.clients) c.terminate();          // network drop -> client schedules a retry
    await new Promise((r) => setTimeout(r, 50));
    b.w.document.dispatchEvent(new b.w.Event("visibilitychange")); // phone tab comes back -> immediate reconnect
    b.w.document.dispatchEvent(new b.w.Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 2500));          // let any pending retry timer fire too
  }
  await until(() => open() >= 1);
  assert.equal(open(), 1, "exactly one live socket");
  assert.equal(h.wss.clients.size, 1, "server sees one subscriber");
  b.$("textarea").value = "stream"; b.$(".composer button.primary").click();
  await until(() => /Hello \*\*world\*\*!|Hello world!/.test(b.$(".log").textContent));
  await new Promise((r) => setTimeout(r, 300));
  const txt = b.$(".log").textContent;
  for (const w of ["one", "two", "three", "four", "Hello"]) assert.equal(txt.split(w).length - 1, 1, `${w} once in: ${txt}`);
  // the same entry delivered twice (e.g. replay overlapping live) is applied once
  const chat = b.w.__chat();
  const e = h.store.read(h.live.get(sid).meta).filter((x) => x.msg?.params?.update?.sessionUpdate === "agent_message_chunk").at(-1);
  chat.onMsg({ type: "entry", entry: e }); chat.onMsg({ type: "replay", items: [e] });
  assert.equal(b.$(".log").textContent, txt);
  chat.close(); b.w.close();
});
