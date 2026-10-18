"use strict";
const $ = (s, r = document) => r.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "html") e.innerHTML = v; else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { "content-type": "application/json", "x-hearth-csrf": "1" }, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  const j = await r.json().catch(() => ({}));
  if (r.status === 423) { showLock(); throw new Error("locked"); }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const ago = (iso) => { const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(iso).toLocaleDateString(); };
const short = (p) => p.replace(/^\/(Users|home)\/[^/]+/, "~");
let agents = [];
let chat = null;

function setHeader(title, { back = false, menu = false, status = "" } = {}) {
  $("#title").textContent = title; $("#back").hidden = !back; $("#menu").hidden = !menu;
  const st = $("#status"); st.textContent = status; st.className = `pill ${status}`; st.hidden = !status;
}
$("#back").onclick = () => { location.hash = "#/"; };

// ---------- lock ----------
function showLock() {
  if (chat) { chat.close(); chat = null; }
  setHeader("Unlock");
  const input = h("input", { type: "password", autocomplete: "current-password", placeholder: "Password", "aria-label": "Password" });
  const err = h("p", { class: "err" });
  const form = h("form", { class: "card lock", onsubmit: async (e) => { e.preventDefault(); err.textContent = "";
    try { await api("POST", "/api/unlock", { password: input.value }); route(); } catch (x) { err.textContent = x.message === "locked" ? "" : x.message; } } },
    h("p", {}, "This computer requires its password before agents can be used."), input, h("button", { class: "primary", type: "submit" }, "Unlock"), err);
  $("#view").replaceChildren(form); input.focus();
}

// ---------- session list ----------
async function showList() {
  if (chat) { chat.close(); chat = null; }
  setHeader("Hearth");
  const me = await api("GET", "/api/me");
  if (me.needsPassword && !me.unlocked) return showLock();
  const [list, ag] = await Promise.all([api("GET", "/api/sessions"), api("GET", "/api/agents")]);
  agents = ag;
  const name = (id) => agents.find((a) => a.id === id)?.name ?? id;
  const items = list.map((s) => h("li", { class: "card session", onclick: () => { location.hash = `#/s/${s.id}`; } },
    h("div", { class: "row" }, h("strong", {}, s.title), h("span", { class: `pill ${s.state}` }, s.pendingPermissions ? "needs you" : s.state)),
    h("div", { class: "meta" }, `${name(s.agentId)} · ${short(s.cwd)} · ${ago(s.lastActivity)}`)));
  $("#view").replaceChildren(
    h("div", { class: "toolbar" }, h("span", { class: "muted" }, me.user), h("div", { class: "row" }, h("button", { onclick: importSessions }, "Import existing"), h("button", { class: "primary", onclick: newSession }, "+ New session"))),
    items.length ? h("ul", { class: "list" }, items) : h("p", { class: "muted center" }, "No sessions yet."));
}

// ---------- new session sheet ----------
async function newSession() {
  const installed = agents.filter((a) => a.installed);
  const sheet = $("#sheet"); sheet.hidden = false;
  const sel = h("select", { "aria-label": "Agent" }, installed.map((a) => h("option", { value: a.id }, a.name)));
  const title = h("input", { placeholder: "Title (optional)" });
  const pathEl = h("div", { class: "path" }); const dirs = h("ul", { class: "dirs" });
  let cwd = null;
  async function browse(p) {
    const r = await api("GET", "/api/fs" + (p ? `?path=${encodeURIComponent(p)}` : ""));
    cwd = r.path; pathEl.textContent = short(r.path);
    dirs.replaceChildren(
      ...(r.parent ? [h("li", { onclick: () => browse(r.parent) }, "‹ ..")] : []),
      ...r.dirs.map((d) => h("li", { onclick: () => browse(r.path.replace(/\/$/, "") + "/" + d) }, "📁 " + d)));
  }
  const err = h("p", { class: "err" });
  sheet.replaceChildren(h("div", { class: "sheet-body" },
    h("h2", {}, "New session"),
    installed.length ? sel : h("p", { class: "err" }, "No ACP agents found on this computer."),
    h("label", {}, "Folder"), pathEl, dirs, title, err,
    h("div", { class: "row" }, h("button", { onclick: () => { sheet.hidden = true; } }, "Cancel"),
      h("button", { class: "primary", disabled: !installed.length, onclick: async () => {
        try { const s = await api("POST", "/api/sessions", { agentId: sel.value, cwd, title: title.value || undefined }); sheet.hidden = true; location.hash = `#/s/${s.id}`; }
        catch (e) { err.textContent = e.message; } } }, "Start"))));
  await browse();
}

// ---------- import existing agent sessions ----------
async function importSessions() {
  const installed = agents.filter((a) => a.installed);
  const sheet = $("#sheet"); sheet.hidden = false;
  const sel = h("select", { "aria-label": "Agent" }, installed.map((a) => h("option", { value: a.id }, a.name)));
  const info = h("p", { class: "muted" }); const list = h("ul", { class: "dirs" }); const err = h("p", { class: "err" });
  let token = 0;
  async function load() {
    const my = ++token;
    info.textContent = "Asking the agent for its sessions…"; list.replaceChildren(); err.textContent = "";
    try {
      const r = await api("GET", `/api/agents/${encodeURIComponent(sel.value)}/sessions`);
      if (my !== token) return; // a newer request (agent changed) wins
      if (!r.importable) info.textContent = "This agent can't load or resume its sessions over ACP, so they can't be imported.";
      else if (r.source === "files") info.textContent = "Listed from the agent's own files (it doesn't support session/list).";
      else info.textContent = r.canLoad ? "History will be loaded from the agent." : "The agent resumes sessions without replaying history, so earlier messages won't show.";
      if (r.error && r.source !== "acp") err.textContent = r.error;
      if (!r.sessions.length) list.append(h("li", { class: "muted" }, "No sessions found."));
      for (const x of r.sessions) {
        const btn = x.hearthId ? h("button", { onclick: () => { sheet.hidden = true; location.hash = `#/s/${x.hearthId}`; } }, "Open")
          : h("button", { class: "primary", disabled: !r.importable || !x.allowed, onclick: async () => {
              btn.disabled = true; btn.textContent = "Importing…";
              try { const s = await api("POST", "/api/sessions/import", { agentId: sel.value, agentSessionId: x.sessionId, cwd: x.cwd, title: x.title || undefined }); sheet.hidden = true; location.hash = `#/s/${s.id}`; }
              catch (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = "Import"; } } }, "Import");
        list.append(h("li", { class: "ext" }, h("div", { class: "row" }, h("strong", {}, x.title || x.sessionId.slice(0, 12)), btn),
          h("div", { class: "meta" }, `${short(x.cwd || "?")}${x.updatedAt ? " · " + ago(x.updatedAt) : ""}${x.allowed ? "" : " · outside allowed folders"}`)));
      }
    } catch (e) { info.textContent = ""; err.textContent = e.message; }
  }
  sel.onchange = load;
  sheet.replaceChildren(h("div", { class: "sheet-body" }, h("h2", {}, "Import an existing session"),
    installed.length ? sel : h("p", { class: "err" }, "No ACP agents found on this computer."), info, err, list,
    h("button", { onclick: () => { sheet.hidden = true; } }, "Close")));
  if (installed.length) await load();
}

// ---------- chat ----------
class Chat {
  constructor(id) {
    this.id = id; this.lastSeq = 0; this.tools = new Map(); this.cur = null; this.perms = new Map(); this.retry = 0; this.closed = false;
    this.log = h("div", { class: "log", role: "log", "aria-live": "polite" });
    this.permBox = h("div", { class: "perms" });
    this.input = h("textarea", { rows: 1, placeholder: "Message the agent…", "aria-label": "Message", oninput: () => this.grow(),
      onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) { e.preventDefault(); this.send(); } } });
    this.sendBtn = h("button", { class: "primary", onclick: () => this.send() }, "Send");
    this.stopBtn = h("button", { class: "danger", hidden: true, onclick: () => this.ws?.send(JSON.stringify({ type: "cancel" })) }, "Stop");
    $("#view").replaceChildren(h("div", { class: "chat" }, this.log, this.permBox, h("div", { class: "composer" }, this.input, this.stopBtn, this.sendBtn)));
    this.onVis = () => { if (document.visibilityState === "visible" && (!this.ws || this.ws.readyState > 1)) this.connect(); };
    document.addEventListener("visibilitychange", this.onVis);
    this.connect();
  }
  grow() { this.input.style.height = "auto"; this.input.style.height = Math.min(this.input.scrollHeight, 160) + "px"; }
  connect() {
    if (this.closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?session=${this.id}&since=${this.lastSeq}`);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; };
    ws.onmessage = (ev) => this.onMsg(JSON.parse(ev.data));
    ws.onclose = (ev) => {
      if (this.closed) return;
      this.status("offline");
      if (ev.code === 1006 && this.retry > 3) fetch("/api/me").then((r) => r.status === 423 && showLock());
      setTimeout(() => this.connect(), Math.min(1000 * 2 ** this.retry++, 15000));
    };
  }
  close() { this.closed = true; document.removeEventListener("visibilitychange", this.onVis); this.ws?.close(); }
  status(s) { setHeader($("#title").textContent, { back: true, menu: true, status: s }); this.stopBtn.hidden = s !== "running"; }
  send() {
    const text = this.input.value.trim(); if (!text || this.ws?.readyState !== 1) return;
    this.ws.send(JSON.stringify({ type: "prompt", content: [{ type: "text", text }] }));
    this.input.value = ""; this.grow();
  }
  onMsg(m) {
    const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 80;
    this.stick = atBottom;
    if (m.type === "replay") { this.replaying = true; if (this.lastSeq === 0) { this.log.replaceChildren(); this.tools.clear(); this.cur = null; } m.items.forEach((e) => this.entry(e)); this.replaying = false; }
    else if (m.type === "entry") this.entry(m.entry);
    else if (m.type === "state") { setHeader(m.title, { back: true, menu: true, status: m.state }); this.status(m.state); this.title = m.title; }
    else if (m.type === "permission") this.addPerm(m);
    else if (m.type === "permission_resolved") { this.perms.get(m.id)?.remove(); this.perms.delete(m.id); }
    else if (m.type === "prompt_done") { this.cur = null; if (m.stopReason !== "end_turn") this.note(`Stopped: ${m.stopReason}`); }
    else if (m.type === "error") this.note(/auth/i.test(m.message) ? `${m.message}. Sign in to this agent once on the computer itself (for example run "claude" then /login, or "grok login").` : m.message, "err");
    if (atBottom || m.type === "replay") this.log.scrollTop = this.log.scrollHeight;
  }
  note(t, cls = "") { this.log.append(h("div", { class: `note ${cls}` }, t)); }
  entry(e) {
    this.lastSeq = Math.max(this.lastSeq, e.seq);
    const msg = e.msg || {};
    if (e.dir === "out" && msg.method === "session/prompt") {
      this.cur = null;
      const t = (msg.params.prompt || []).map((c) => c.text ?? (c.type === "image" ? "[image]" : "")).join("");
      this.log.append(h("div", { class: "msg user" }, t));
    } else if (e.dir === "in" && msg.method === "session/update") this.update(msg.params.update);
    else if (e.dir === "sys") {
      const ev = msg.event;
      if (ev === "agent_exit") this.note("Agent stopped. Send a message to restart it.");
      else if (ev === "context_reset") this.note("Agent restarted without its memory of the earlier conversation (it doesn't support session/load).");
      else if (ev === "session_loaded") this.note("Agent restarted and reloaded the conversation.");
      else if (ev === "session_resumed") this.note("Agent restarted and resumed the conversation.");
      else if (ev === "import_replay_start") this.note("Imported from the agent's own history:");
      else if (ev === "session_imported") this.note(msg.note ? `Imported. ${msg.note}.` : "Imported. New messages continue the same agent session.");
      else if (ev === "session_load_failed") this.note("Couldn't reload the conversation; started fresh.", "err");
      else if (ev === "permission_answer") this.note(msg.optionId ? `Permission answered: ${msg.optionId}` : "Permission cancelled");
    } else if (e.dir === "in" && msg.error) this.note(`Agent error: ${msg.error.message}`, "err");
  }
  update(u) {
    switch (u.sessionUpdate) {
      case "agent_message_chunk": case "user_message_chunk": {
        const role = u.sessionUpdate === "user_message_chunk" ? "user" : "agent";
        if (!this.cur || this.cur.role !== role) { this.cur = { role, text: "", el: h("div", { class: `msg ${role} md` }) }; this.log.append(this.cur.el); }
        const c = u.content || {};
        if (c.type === "text") this.cur.text += c.text; else if (c.type === "image") this.cur.text += "\n[image]\n"; else if (c.type === "resource_link") this.cur.text += ` [${c.name || c.uri}]`;
        this.paint(this.cur.el, this.cur);
        break;
      }
      case "agent_thought_chunk": {
        if (!this.cur || this.cur.role !== "thought") { const d = h("details", { class: "thought" }, h("summary", {}, "Thinking…"), h("div", { class: "md" })); this.cur = { role: "thought", text: "", el: d }; this.log.append(d); }
        this.cur.text += u.content?.text ?? ""; this.paint(this.cur.el.lastChild, this.cur);
        break;
      }
      case "tool_call": case "tool_call_update": {
        this.cur = null;
        let t = this.tools.get(u.toolCallId);
        if (!t) { t = { data: {}, el: h("details", { class: "tool" }) }; this.tools.set(u.toolCallId, t); this.log.append(t.el); }
        for (const [k, v] of Object.entries(u)) if (v != null) t.data[k] = v;
        this.renderTool(t);
        break;
      }
      case "plan": {
        this.cur = null;
        const el = h("div", { class: "card plan" }, h("strong", {}, "Plan"), h("ul", {}, (u.entries || []).map((p) => h("li", { class: p.status }, `${p.status === "completed" ? "✓" : p.status === "in_progress" ? "▸" : "○"} ${p.content}`))));
        if (this.planEl && this.planEl === this.log.lastChild) this.planEl.replaceWith(el); else this.log.append(el);
        this.planEl = el; break;
      }
      case "current_mode_update": this.note(`Mode: ${u.currentModeId}`); break;
      default: break;
    }
  }
  // Progressive rendering: every chunk is appended immediately; markdown is re-rendered at most once per frame.
  paint(el, cur) {
    el._cur = cur;
    if (el._raf) return;
    const draw = () => { el._raf = 0; el.innerHTML = renderMarkdown(el._cur.text); if (this.stick) this.log.scrollTop = this.log.scrollHeight; };
    if (document.visibilityState !== "visible" || this.replaying) return draw();
    el._raf = requestAnimationFrame(draw);
  }
  renderTool(t) {
    const d = t.data; const open = t.el.open;
    const icon = { pending: "○", in_progress: "◐", completed: "✓", failed: "✗" }[d.status] || "•";
    const body = h("div", { class: "tool-body" });
    for (const c of d.content || []) {
      if (c.type === "diff") body.append(h("div", { class: "path" }, short(c.path)), diffView(c.oldText ?? "", c.newText ?? ""));
      else if (c.type === "content" && c.content?.type === "text") body.append(h("pre", {}, c.content.text));
      else if (c.type === "terminal") body.append(h("div", { class: "muted" }, `terminal ${c.terminalId}`));
    }
    if (d.rawInput && !(d.content || []).length) body.append(h("pre", {}, JSON.stringify(d.rawInput, null, 2).slice(0, 4000)));
    if (d.rawOutput) body.append(h("pre", {}, (typeof d.rawOutput === "string" ? d.rawOutput : JSON.stringify(d.rawOutput, null, 2)).slice(0, 4000)));
    t.el.replaceChildren(h("summary", { class: d.status || "" }, `${icon} ${d.title || d.kind || "Tool"}`), body);
    t.el.open = open || (d.content || []).some((c) => c.type === "diff");
  }
  addPerm(m) {
    if (this.perms.has(m.id)) return;
    const p = m.params;
    const el = h("div", { class: "card perm" }, h("div", {}, h("strong", {}, "Permission: "), p.toolCall?.title || p.toolCall?.toolCallId || "action"),
      h("div", { class: "row wrap" }, (p.options || []).map((o) => h("button", { class: o.kind?.startsWith("allow") ? "primary" : "danger",
        onclick: () => this.ws.send(JSON.stringify({ type: "permission", id: m.id, optionId: o.optionId })) }, o.name))));
    this.perms.set(m.id, el); this.permBox.append(el);
  }
}

function diffView(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  const rows = [];
  if (A.length * B.length > 250000) { A.forEach((l) => rows.push(["-", l])); B.forEach((l) => rows.push(["+", l])); }
  else {
    const n = A.length, m = B.length, L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) { rows.push([" ", A[i]]); i++; j++; }
      else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) rows.push(["+", B[j++]]);
      else rows.push(["-", A[i++]]);
    }
  }
  // collapse long unchanged runs
  const out = []; let run = [];
  const flush = () => { if (run.length > 6) { out.push(...run.slice(0, 2), ["…", `${run.length - 4} unchanged lines`], ...run.slice(-2)); } else out.push(...run); run = []; };
  for (const r of rows) { if (r[0] === " ") run.push(r); else { flush(); out.push(r); } }
  flush();
  return h("pre", { class: "diff" }, out.map(([k, l]) => h("span", { class: k === "+" ? "add" : k === "-" ? "del" : k === "…" ? "skip" : "" }, `${k} ${l}\n`)));
}

// ---------- session menu ----------
$("#menu").onclick = () => {
  if (!chat) return;
  const sheet = $("#sheet"); sheet.hidden = false; const id = chat.id;
  const name = h("input", { value: chat.title || "" });
  sheet.replaceChildren(h("div", { class: "sheet-body" }, h("h2", {}, "Session"),
    h("label", {}, "Name"), name,
    h("button", { onclick: async () => { await api("PATCH", `/api/sessions/${id}`, { title: name.value }); sheet.hidden = true; } }, "Rename"),
    h("button", { class: "danger", onclick: async () => { if (confirm("Stop this agent? History is kept.")) { await api("DELETE", `/api/sessions/${id}`); sheet.hidden = true; } } }, "Terminate"),
    h("button", { class: "danger", onclick: async () => { if (confirm("Stop the agent and delete all history for this session?")) { await api("DELETE", `/api/sessions/${id}?purge=1`); sheet.hidden = true; location.hash = "#/"; } } }, "Terminate & delete history"),
    h("button", { onclick: () => { sheet.hidden = true; } }, "Close")));
};
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") e.target.hidden = true; });

// ---------- routing ----------
async function route() {
  $("#sheet").hidden = true;
  const m = /^#\/s\/([a-f0-9-]{36})$/.exec(location.hash);
  try {
    if (m) {
      const me = await api("GET", "/api/me"); if (me.needsPassword && !me.unlocked) return showLock();
      if (!agents.length) agents = await api("GET", "/api/agents");
      const s = await api("GET", `/api/sessions/${m[1]}`);
      if (chat) chat.close();
      setHeader(s.title, { back: true, menu: true, status: s.state });
      chat = new Chat(s.id); chat.title = s.title;
    } else await showList();
  } catch (e) { if (e.message !== "locked") $("#view").replaceChildren(h("p", { class: "err center" }, e.message)); }
}
addEventListener("hashchange", route);
route();
