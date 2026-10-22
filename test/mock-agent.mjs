#!/usr/bin/env node
import { existsSync as existsSyncM } from "node:fs";
// Minimal ACP agent used by the e2e tests. Behaviour is driven by the prompt text.
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

import { readFileSync } from "node:fs";
const LOAD = process.env.MOCK_LOAD_SESSION === "1";
const LIST = process.env.MOCK_LIST === "1";
const RESUME = process.env.MOCK_RESUME === "1";
// Pre-existing "CLI" sessions: { [id]: { cwd, title, updatedAt, history: [{ role: "user"|"agent", text }] } }
const STORE = process.env.MOCK_STORE ? JSON.parse(readFileSync(process.env.MOCK_STORE, "utf8")) : {};
const CONFIG = process.env.MOCK_CONFIG === "1";
const sessions = new Map();
// Devin-like quirks: every load/resume on this process attaches another subscriber (updates are emitted once per
// subscriber); MOCK_LOAD_FAIL=1 attaches then fails the load; MOCK_LATE_REPLAY=1 replays history after responding.
const LOAD_FAIL = process.env.MOCK_LOAD_FAIL === "1", LATE = process.env.MOCK_LATE_REPLAY === "1";
const subs = new Map();
const attach = (id) => subs.set(id, (subs.get(id) ?? 0) + 1);
const fanout = (conn, p) => { const n = Math.max(1, subs.get(p.sessionId) ?? 1); return (async () => { for (let i = 0; i < n; i++) await conn.sessionUpdate(p); })(); };
const MODELS = [{ group: "fast", name: "Fast", options: [{ value: "m-small", name: "Small" }] }, { group: "smart", name: "Smart", options: [{ value: "m-large", name: "Large", description: "Best" }] }];
// Option shape (MOCK_SHAPE): "spec" (default, `id` like Claude Code / Grok Build / Devin), "configId" (non-standard key),
// "split" (model/effort as config options, mode only as legacy `modes`), "late" (nothing in session/new; a
// config_option_update right after), "wrapped" (currentValue as { value }).
const SHAPE = process.env.MOCK_SHAPE || "spec";
function cfg(s) {
  const all = cfgAll(s).filter((o) => SHAPE !== "split" || o.id !== "mode");
  if (SHAPE === "configId") return all.map(({ id, ...o }) => ({ configId: id, ...o }));
  if (SHAPE === "wrapped") return all.map((o) => o.type === "select" ? { ...o, currentValue: { value: o.currentValue } } : o);
  return all;
}
function cfgAll(s) {
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: MODELS },
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: s.mode, options: [{ value: "code", name: "Code" }, { value: "ask", name: "Ask" }] },
    // reasoning effort depends on model, like real agents
    { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: s.effort, options: s.model === "m-large" ? [{ value: "low", name: "Low" }, { value: "high", name: "High" }] : [{ value: "low", name: "Low" }] },
    { id: "web", name: "Web search", type: "boolean", currentValue: s.web },
  ];
}
const fresh = (cwd) => ({ cwd, history: [], model: "m-small", mode: "code", effort: "low", web: false, legacyModel: "lm-a", legacyMode: "code" });
let n = 0;

new acp.AgentSideConnection((conn) => ({
  async initialize() {
    if (process.env.MOCK_SLOW_START) await new Promise((r) => setTimeout(r, Number(process.env.MOCK_SLOW_START)));
    if (process.env.MOCK_HANG_INIT && existsSyncM(process.env.MOCK_HANG_INIT)) await new Promise(() => {}); // never answers
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: LOAD, sessionCapabilities: { ...(LIST ? { list: {} } : {}), ...(RESUME ? { resume: {} } : {}) } }, authMethods: [], agentInfo: { name: "mock-agent", version: "1" } };
  },
  async newSession({ cwd }) { const id = `mock-${++n}-${process.pid}`; const st = fresh(cwd); sessions.set(id, st);
    const legacy = { modes: { currentModeId: "code", availableModes: [{ id: "code", name: "Code" }, { id: "ask", name: "Ask" }] }, models: { currentModelId: "lm-a", availableModels: [{ modelId: "lm-a", name: "Alpha" }, { modelId: "lm-b", name: "Beta" }] } };
    if (CONFIG && SHAPE === "late") setTimeout(() => conn.sessionUpdate({ sessionId: id, update: { sessionUpdate: "config_option_update", configOptions: cfg(st) } }), 20);
    return { sessionId: id, ...legacy, ...(CONFIG && SHAPE !== "late" ? { configOptions: cfg(st) } : {}) }; },
  async setSessionConfigOption({ sessionId, configId, value }) {
    const s = sessions.get(sessionId);
    if (!["model", "mode", "effort", "web"].includes(configId)) throw acp.RequestError.invalidParams({ configId });
    s[configId] = value;
    if (configId === "model" && value !== "m-large") s.effort = "low";
    return { configOptions: cfg(s) };
  },
  async extMethod(method, params) {
    if (method === "session/set_model") { sessions.get(params.sessionId).legacyModel = params.modelId; return {}; }
    throw acp.RequestError.methodNotFound(method);
  },
  async listSessions({ cwd }) {
    return { sessions: Object.entries(STORE).filter(([, v]) => !cwd || v.cwd === cwd).map(([id, v]) => ({ sessionId: id, cwd: v.cwd, title: v.title, updatedAt: v.updatedAt })) };
  },
  async resumeSession({ sessionId, cwd }) {
    if (!STORE[sessionId] && !sessions.has(sessionId)) throw acp.RequestError.resourceNotFound(sessionId);
    sessions.set(sessionId, fresh(cwd)); attach(sessionId); return {};
  },
  async loadSession({ sessionId, cwd }) {
    if (process.env.MOCK_HANG_LOAD && existsSyncM(process.env.MOCK_HANG_LOAD)) await new Promise(() => {}); // a wedged session/load
    sessions.set(sessionId, fresh(cwd)); attach(sessionId);
    if (LOAD_FAIL) throw acp.RequestError.internalError({}, "load exploded after attaching");
    if (LATE && STORE[sessionId]) {
      setTimeout(async () => { for (const h of STORE[sessionId].history) await conn.sessionUpdate({ sessionId, update: { sessionUpdate: h.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: h.text } } }); }, 30);
      return {};
    }
    if (STORE[sessionId]) {
      for (const h of STORE[sessionId].history) await conn.sessionUpdate({ sessionId, update: { sessionUpdate: h.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: h.text } } });
      return {};
    }
    await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "(replayed history)" } } });
    return {};
  },
  async authenticate() { return {}; },
  async setSessionMode({ sessionId, modeId }) { const st = sessions.get(sessionId); st.legacyMode = modeId; if (SHAPE === "split") st.mode = modeId; return {}; },
  async cancel({ sessionId }) { const s = sessions.get(sessionId); if (s) s.cancelled = true; },
  async prompt({ sessionId, prompt }) {
    const s = sessions.get(sessionId); s.cancelled = false;
    const text = prompt.map((c) => c.text ?? "").join(" ");
    const say = (t) => fanout(conn, { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } } });
    if (text.includes("whoami")) await say(`model=${CONFIG ? s.model : s.legacyModel} mode=${CONFIG ? s.mode : s.legacyMode} effort=${s.effort} web=${s.web} `);
    if (text.includes("pushcfg")) { s.mode = "ask"; await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "config_option_update", configOptions: cfg(s) } }); }
    if (text.includes("pushmode")) { s.legacyMode = "ask"; await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: "ask" } }); }
    if (text.includes("plan")) {
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "plan", entries: [{ content: "Step one", priority: "high", status: "completed" }, { content: "Step two", priority: "medium", status: "in_progress" }] } });
    }
    if (text.includes("write")) {
      await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tc1", title: "Write hello.txt", kind: "edit", status: "pending",
        content: [{ type: "diff", path: `${s.cwd}/hello.txt`, oldText: null, newText: "hello\n" }] } });
      const r = await conn.requestPermission({ sessionId, toolCall: { toolCallId: "tc1", title: "Write hello.txt", kind: "edit" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
      if (r.outcome.outcome === "selected" && r.outcome.optionId === "allow") {
        await conn.writeTextFile({ sessionId, path: `${s.cwd}/hello.txt`, content: "hello\n" });
        await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed" } });
      } else {
        await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "failed" } });
        await say("permission denied");
        return { stopReason: r.outcome.outcome === "cancelled" ? "cancelled" : "end_turn" };
      }
    }
    if (text.includes("escape")) {
      try { await conn.readTextFile({ sessionId, path: "/etc/passwd" }); await say("ESCAPED"); } catch (e) { await say("blocked: " + e.message); }
    }
    if (text.includes("terminal")) {
      const t = await conn.createTerminal({ sessionId, command: "echo", args: ["term-ok"] });
      const exit = await t.waitForExit(); const out = await t.currentOutput(); await t.release();
      await say(`terminal said ${out.output.trim()} (exit ${exit.exitCode})`);
    }
    if (text.includes("stream")) {
      for (const w of ["one ", "two ", "three ", "four "]) { await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "t" } } }); await say(w); await new Promise((r) => setTimeout(r, 150)); }
    }
    if (text.includes("shellcmd")) {
      // Devin-style: a whole shell line as `command`, no args, relative cwd; plus an args-style call and a missing binary.
      const a = await conn.createTerminal({ sessionId, command: "echo $((6*7)) | tr 4 X && pwd", cwd: ".", outputByteLimit: 4096 });
      const ea = await a.waitForExit(); const oa = await a.currentOutput(); await a.release();
      const b = await conn.createTerminal({ sessionId, command: "printf", args: ["%s-%s", "a b", "c"] });
      await b.waitForExit(); const ob = await b.currentOutput(); await b.release();
      const c = await conn.createTerminal({ sessionId, command: "definitely-not-a-binary-xyz" });
      const ec = await c.waitForExit(); await c.release();
      const d = await conn.createTerminal({ sessionId, command: "yes | head -c 5000", outputByteLimit: 100 });
      await d.waitForExit(); const od = await d.currentOutput(); await d.release();
      await say(`A=${JSON.stringify(oa.output.trim())} exit=${ea.exitCode} status=${JSON.stringify(oa.exitStatus)} B=${ob.output} C=${ec.exitCode} D=${od.output.length},${od.truncated}`);
    }
    if (text.includes("crashlater")) { await new Promise((r) => setTimeout(r, 300)); process.exit(3); } // the agent dies mid-turn
    if (text.includes("explode")) throw acp.RequestError.internalError({}, "mock agent exploded");
    if (text.includes("slow")) { for (let i = 0, n = text.includes("slowest") ? 300 : 50; i < n && !s.cancelled; i++) await new Promise((r) => setTimeout(r, 100)); if (s.cancelled) return { stopReason: "cancelled" }; }
    for (const w of ["Hello ", "**world**", "!"]) await say(w);
    return { stopReason: "end_turn" };
  },
}), acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
