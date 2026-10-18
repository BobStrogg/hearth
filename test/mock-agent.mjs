#!/usr/bin/env node
// Minimal ACP agent used by the e2e tests. Behaviour is driven by the prompt text.
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const LOAD = process.env.MOCK_LOAD_SESSION === "1";
const sessions = new Map();
let n = 0;

new acp.AgentSideConnection((conn) => ({
  async initialize() {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: LOAD }, authMethods: [], agentInfo: { name: "mock-agent", version: "1" } };
  },
  async newSession({ cwd }) { const id = `mock-${++n}-${process.pid}`; sessions.set(id, { cwd, history: [] }); return { sessionId: id, modes: { currentModeId: "code", availableModes: [{ id: "code", name: "Code" }, { id: "ask", name: "Ask" }] } }; },
  async loadSession({ sessionId, cwd }) {
    sessions.set(sessionId, { cwd, history: [] });
    await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "(replayed history)" } } });
    return {};
  },
  async authenticate() { return {}; },
  async setSessionMode() { return {}; },
  async cancel({ sessionId }) { const s = sessions.get(sessionId); if (s) s.cancelled = true; },
  async prompt({ sessionId, prompt }) {
    const s = sessions.get(sessionId); s.cancelled = false;
    const text = prompt.map((c) => c.text ?? "").join(" ");
    const say = (t) => conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } } });
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
    if (text.includes("slow")) { for (let i = 0; i < 50 && !s.cancelled; i++) await new Promise((r) => setTimeout(r, 100)); if (s.cancelled) return { stopReason: "cancelled" }; }
    for (const w of ["Hello ", "**world**", "!"]) await say(w);
    return { stopReason: "end_turn" };
  },
}), acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
