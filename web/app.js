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
    h("div", { class: "toolbar" }, h("span", { class: "muted" }, me.user), h("div", { class: "row" },
      me.files ? h("button", { onclick: () => { location.hash = "#/files"; }, title: "Browse, download and upload files on this computer" }, "📁 Files") : null,
      me.push ? h("button", { onclick: notifySheet, title: "Notifications on this device", "aria-label": "Notifications" }, "🔔") : null,
      h("button", { onclick: importSessions }, "Import existing"), h("button", { class: "primary", onclick: newSession }, "+ New session"))),
    items.length ? h("ul", { class: "list" }, items) : h("p", { class: "muted center" }, "No sessions yet."), versionBar());
}

// ---------- version / update ----------
function versionBar() {
  const bar = h("div", { class: "verbar muted small" });
  const show = (v) => {
    const kids = [`Hearth ${v.version}`];
    if (v.updating) kids.push(" · updating…");
    else if (v.updateAvailable) {
      kids.push(" · ", h("strong", {}, `${v.latest} available`));
      if (v.canApply) kids.push(" ", h("button", { class: "pillbtn", onclick: async (e) => {
        e.target.disabled = true; e.target.textContent = "Updating…";
        try { await api("POST", "/api/update"); waitForVersion(v.version, bar); } catch (x) { e.target.textContent = x.message; }
      } }, "Update now"));
      else kids.push(h("div", {}, `Update with: ${v.how}`));
    }
    bar.replaceChildren(...kids);
  };
  api("GET", "/api/version?check=1").then(show).catch(() => {});
  return bar;
}
/** After "Update now", the daemon restarts: poll until a different version answers, then reload. */
function waitForVersion(old, bar) {
  let n = 0;
  const tick = async () => {
    n++;
    try { const r = await fetch("/healthz", { cache: "no-store" }); const j = await r.json(); if (j.version && j.version !== old) { location.reload(); return; } } catch { /* restarting */ }
    if (n < 90) setTimeout(tick, 2000); else bar.textContent = "The update didn't finish; see `hearth service logs` on the computer.";
  };
  setTimeout(tick, 3000);
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
    this.log = h("div", { class: "log", role: "log", "aria-live": "polite", onscroll: () => this.onScroll(),
      onclick: (e) => { if (e.target.matches?.("img.inl")) lightbox(e.target); } });
    this.log.addEventListener("error", (e) => { if (e.target.matches?.("img.inl")) brokenImage(e.target); }, true);
    this.atEnd = true; this.mdOpts = { img: (u) => imageSrc(this.id, u) };
    // Images load (and get their real height) after they're laid out: keep the view still while that happens.
    this.ro = typeof ResizeObserver === "function" ? new ResizeObserver((ents) => this.imgResized(ents)) : null;
    this.top = h("div", { class: "histtop", hidden: true }); this.firstSeq = null; this.hasMore = false; this.loadingOlder = false;
    this.permBox = h("div", { class: "perms" });
    this.input = h("textarea", { rows: 1, placeholder: "Message the agent…", "aria-label": "Message", oninput: () => this.grow(),
      onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) { e.preventDefault(); this.send(); } } });
    this.sendBtn = h("button", { class: "primary", onclick: () => this.send() }, "Send");
    this.stopBtn = h("button", { class: "danger", hidden: true, onclick: () => this.ws?.send(JSON.stringify({ type: "cancel" })) }, "Stop");
    this.ctl = h("div", { class: "ctl", hidden: true }); this.options = [];
    this.qBox = h("div", { class: "queue", hidden: true }); this.queue = { items: [], paused: false, reason: null, max: 10 }; this.qEdit = null; this.busy = false;
    $("#view").replaceChildren(h("div", { class: "chat" }, this.log, this.permBox, h("div", { class: "composer-wrap" }, this.qBox, this.ctl, h("div", { class: "composer" }, this.input, this.stopBtn, this.sendBtn))));
    this.onVis = () => { if (document.visibilityState === "visible" && (!this.ws || this.ws.readyState > 1)) this.connect(); this.sendVis(); };
    document.addEventListener("visibilitychange", this.onVis);
    addEventListener("focus", this.onVis); addEventListener("blur", this.onVis);
    this.connect();
  }
  /** "Following the end" only changes when you scroll: content growing (images loading) doesn't turn it off. */
  onScroll() {
    const t = this.log.scrollTop, gap = this.endGap();
    if (gap < 40) this.atEnd = true; else if (t < (this.lastTop ?? 0) - 2) this.atEnd = false;
    this.lastTop = t; this.maybeOlder();
  }
  endGap() { return this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight; }
  toEnd() { this.log.scrollTop = this.log.scrollHeight; this.atEnd = true; this.lastTop = this.log.scrollTop; }
  /** Start tracking the height of not-yet-tracked inline images under `root` (only once they're in the live log). */
  watch(root) {
    if (!this.ro || !root?.isConnected || !this.log.isConnected) return;
    for (const img of root.querySelectorAll("img.inl:not([data-w])")) { img.dataset.w = "1"; img._h = img.offsetHeight; this.ro.observe(img); }
  }
  imgResized(ents) {
    const lt = this.log.getBoundingClientRect().top;
    for (const en of ents) {
      const img = en.target;
      if (!img.isConnected) { this.ro.unobserve(img); continue; }
      const nh = img.offsetHeight, d = nh - (img._h ?? nh); img._h = nh;
      if (!d) continue;
      if (this.atEnd) this.toEnd();                                   // following the conversation: stay at the end
      else if (img.getBoundingClientRect().top < lt) this.log.scrollTop += d; // grew above what you're reading: compensate
    }
  }
  grow() { this.input.style.height = "auto"; this.input.style.height = Math.min(this.input.scrollHeight, 160) + "px"; }
  /** Exactly one socket per chat: a dropped-connection retry and a tab-refocus reconnect used to race and leave
   *  2-3 sockets open, each rendering the same stream (interleaved duplicate text). */
  connect() {
    if (this.closed) return;
    clearTimeout(this.retryTimer); this.retryTimer = null;
    if (this.ws && this.ws.readyState <= 1) return; // already connecting/open
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?session=${this.id}&since=${this.lastSeq}`);
    this.ws = ws;
    ws.onopen = () => { if (this.ws === ws) { this.retry = 0; this.sendVis(true); } };
    ws.onmessage = (ev) => { if (this.ws === ws && !this.closed) this.onMsg(JSON.parse(ev.data)); };
    ws.onclose = (ev) => {
      if (this.closed || this.ws !== ws) return; // a stale socket closing must not schedule another one
      this.status("offline");
      if (ev.code === 1006 && this.retry > 3) fetch("/api/me").then((r) => r.status === 423 && showLock());
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.connect(), Math.min(1000 * 2 ** this.retry++, 15000));
    };
  }
  close() { this.closed = true; clearTimeout(this.retryTimer); document.removeEventListener("visibilitychange", this.onVis); removeEventListener("focus", this.onVis); removeEventListener("blur", this.onVis); this.ws?.close(); }
  /** Tell the server whether you're looking at this session (it skips notifications for it while you are). */
  sendVis(force) {
    const v = document.visibilityState === "visible" && (typeof document.hasFocus !== "function" || document.hasFocus());
    if ((force || v !== this.visSent) && this.ws?.readyState === 1) { this.ws.send(JSON.stringify({ type: "visibility", visible: v })); this.visSent = v; }
  }
  status(s) {
    setHeader($("#title").textContent, { back: true, menu: true, status: s }); this.stopBtn.hidden = s !== "running";
    this.busy = s === "running"; this.sendBtn.textContent = this.busy ? "Queue" : "Send";
    this.sendBtn.title = this.busy ? "The agent is busy: this prompt waits in the queue and runs next" : "";
    this.renderQueue();
  }
  send() {
    const text = this.input.value.trim(); if (!text || this.ws?.readyState !== 1) return;
    if (this.busy && this.queue.items.length >= this.queue.max) return this.note(`The queue is full (${this.queue.max} prompts). Wait for the agent, or remove a queued prompt.`, "err");
    this.ws.send(JSON.stringify({ type: "prompt", content: [{ type: "text", text }] }));
    this.input.value = ""; this.grow();
  }
  qsend(o) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(o)); }
  /** Queued prompts: a compact list above the composer (edit, reorder, delete, send now, resume). */
  renderQueue() {
    const q = this.queue, n = q.items.length;
    this.qBox.hidden = !n; if (!n) { this.qBox.replaceChildren(); this.qEdit = null; return; }
    if (this.qEdit && !q.items.some((i) => i.id === this.qEdit)) this.qEdit = null;
    const head = h("div", { class: "qhead" }, h("span", {}, `Queued ${n}/${q.max}`),
      h("span", { class: "qwhy" }, q.paused ? `· Paused${q.reason ? `: ${q.reason}` : ""}` : "· runs after the current prompt"),
      q.paused ? h("button", { class: "qbtn qresume", title: "Run the next queued prompt and continue", onclick: () => this.qsend({ type: "queue_resume" }) }, "Resume") : null);
    const list = h("ol", { class: "qlist" });
    q.items.forEach((it, i) => {
      const li = h("li", { class: "qitem", draggable: this.qEdit ? false : "true",
        ondragstart: (e) => { e.dataTransfer.setData("text/x-hearth-q", it.id); e.dataTransfer.effectAllowed = "move"; li.classList.add("drag"); },
        ondragend: () => li.classList.remove("drag"),
        ondragover: (e) => { if ([...e.dataTransfer.types].includes("text/x-hearth-q")) { e.preventDefault(); li.classList.add("over"); } },
        ondragleave: () => li.classList.remove("over"),
        ondrop: (e) => { e.preventDefault(); li.classList.remove("over"); const id = e.dataTransfer.getData("text/x-hearth-q"); if (id && id !== it.id) this.qsend({ type: "queue_move", id, to: i }); } });
      if (this.qEdit === it.id) {
        const ta = h("textarea", { class: "qedit", rows: 2, "aria-label": "Edit queued prompt" }); ta.value = it.text;
        const save = () => { this.qEdit = null; this.qsend({ type: "queue_edit", id: it.id, text: ta.value }); this.renderQueue(); };
        ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) { e.preventDefault(); save(); } else if (e.key === "Escape") { this.qEdit = null; this.renderQueue(); } });
        li.append(ta, h("div", { class: "qacts" }, h("button", { class: "qbtn", onclick: save }, "Save"), h("button", { class: "qbtn", onclick: () => { this.qEdit = null; this.renderQueue(); } }, "Cancel")));
        setTimeout(() => ta.focus(), 0);
      } else {
        li.append(h("span", { class: "qtext", title: it.text, onclick: () => { this.qEdit = it.id; this.renderQueue(); } }, it.text || "(attachment)", it.attachments ? h("span", { class: "muted" }, ` +${it.attachments} 📎`) : null),
          h("div", { class: "qacts" },
            h("button", { class: "qbtn", title: "Move up", "aria-label": "Move up", disabled: i === 0, onclick: () => this.qsend({ type: "queue_move", id: it.id, to: i - 1 }) }, "↑"),
            h("button", { class: "qbtn", title: "Move down", "aria-label": "Move down", disabled: i === n - 1, onclick: () => this.qsend({ type: "queue_move", id: it.id, to: i + 1 }) }, "↓"),
            h("button", { class: "qbtn", title: "Edit", "aria-label": "Edit", onclick: () => { this.qEdit = it.id; this.renderQueue(); } }, "✎"),
            h("button", { class: "qbtn", title: this.busy ? "Stop the current prompt and send this now" : "Send this now", "aria-label": "Send now", onclick: () => this.qsend({ type: "queue_send_now", id: it.id }) }, "▶"),
            h("button", { class: "qbtn qdel", title: "Delete", "aria-label": "Delete", onclick: () => this.qsend({ type: "queue_delete", id: it.id }) }, "✕")));
      }
      list.append(li);
    });
    this.qBox.replaceChildren(head, list);
  }
  onMsg(m) {
    const atBottom = this.atEnd || this.endGap() < 80;
    this.stick = atBottom;
    const initial = m.type === "replay" && this.lastSeq === 0;
    if (m.type === "replay") {
      this.replaying = true;
      if (this.lastSeq === 0) { this.log.replaceChildren(this.top); this.tools.clear(); this.cur = null; this.firstSeq = m.firstSeq ?? m.items[0]?.seq ?? null; this.hasMore = !!m.hasMore; this.loadingOlder = false; this.showTop(); }
      m.items.forEach((e) => this.entry(e)); this.replaying = false;
    }
    else if (m.type === "history") return this.prependOlder(m);
    else if (m.type === "entry") this.entry(m.entry);
    else if (m.type === "state") { setHeader(m.title, { back: true, menu: true, status: m.state }); this.status(m.state); this.title = m.title; }
    else if (m.type === "settings") { this.options = m.options || []; this.renderCtl(); if (!$("#sheet").hidden && this.settingsOpen) this.openSettings(); }
    else if (m.type === "permission") this.addPerm(m);
    else if (m.type === "queue") { this.queue = { items: m.items || [], paused: !!m.paused, reason: m.reason ?? null, max: m.max || 10 }; this.renderQueue(); }
    else if (m.type === "queued") { /* shown by the queue update */ }
    else if (m.type === "permission_resolved") { this.perms.get(m.id)?.remove(); this.perms.delete(m.id); }
    else if (m.type === "prompt_done") { this.cur = null; if (m.stopReason !== "end_turn") this.note(`Stopped: ${m.stopReason}`); }
    else if (m.type === "error" && /setting|config|mode|model/i.test(m.message) && this.options.length) { this.renderCtl(); this.note(m.message, "err"); }
    else if (m.type === "error") this.note(/auth/i.test(m.message) ? `${m.message}. Sign in to this agent once on the computer itself (for example run "claude" then /login, or "grok login").` : m.message, "err");
    if (atBottom || initial) this.toEnd();
    if (initial) { this.watch(this.log); this.fillScreen(); }
  }
  // ---- lazy history: older pages load when you scroll near the top, keeping your place ----
  showTop() {
    this.top.hidden = this.firstSeq == null;
    this.top.textContent = this.loadingOlder ? "Loading earlier…" : this.hasMore ? "" : "Beginning of conversation";
    this.top.className = `histtop${this.loadingOlder ? " loading" : ""}`;
  }
  maybeOlder() {
    if (!this.hasMore || this.loadingOlder || this.firstSeq == null || this.ws?.readyState !== 1) return;
    if (this.log.scrollTop > Math.max(600, this.log.clientHeight)) return; // start early so momentum scrolling rarely hits the top
    this.loadingOlder = true; this.showTop();
    this.ws.send(JSON.stringify({ type: "history", before: this.firstSeq }));
  }
  fillScreen() { if (this.hasMore && this.log.scrollHeight <= this.log.clientHeight + 200) this.maybeOlder(); }
  prependOlder(m) {
    this.loadingOlder = false;
    if (m.before !== this.firstSeq) { this.showTop(); return; } // stale answer (e.g. after a full reload)
    const items = (m.items || []).filter((e) => e.seq < this.firstSeq);
    // Render the older page into a detached container with its own streaming state, then prepend it.
    const saved = { log: this.log, cur: this.cur, tools: this.tools, planEl: this.planEl, stick: this.stick };
    const frag = h("div");
    this.log = frag; this.cur = null; this.tools = new Map(); this.planEl = null; this.replaying = true; this.stick = false;
    try { for (const e of items) this.render(e); }
    finally { Object.assign(this, saved); this.replaying = false; }
    const log = this.log, beforeH = log.scrollHeight, beforeTop = log.scrollTop;
    this.top.after(...frag.childNodes);
    log.scrollTop = beforeTop + (log.scrollHeight - beforeH); // anchor: what you were looking at stays put
    this.watch(log); // images in the new page: later height changes are compensated in imgResized
    if (items.length) this.firstSeq = items[0].seq;
    this.hasMore = !!m.hasMore && items.length > 0; this.showTop();
    requestAnimationFrame(() => this.fillScreen());
  }
  note(t, cls = "") { this.log.append(h("div", { class: `note ${cls}` }, t)); }
  entry(e) {
    if (e.seq <= this.lastSeq) return; // idempotent: an entry delivered twice (replay overlap, stray socket) is applied once
    this.lastSeq = e.seq;
    if (this.firstSeq == null) { this.firstSeq = e.seq; this.showTop(); }
    this.render(e);
  }
  render(e) {
    const msg = e.msg || {};
    if (e.dir === "out" && msg.method === "session/prompt") {
      this.cur = null;
      const blocks = msg.params.prompt || [];
      const el = h("div", { class: "msg user" }, blocks.map((c) => c.text ?? "").join(""));
      for (const c of blocks) { const im = imageOf(c); if (im) el.append(this.figure(im) ?? h("div", {}, `[image: ${im.alt}]`)); }
      this.log.append(el); this.watch(el);
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
        if (!this.cur || this.cur.role !== role) { this.cur = { role, seg: null, el: h("div", { class: `msg ${role} md` }) }; this.log.append(this.cur.el); }
        const c = u.content || {}; const im = imageOf(c);
        if (im) {
          const f = this.figure(im);
          if (f) { this.cur.seg = null; this.cur.el.append(f); this.watch(f); if (this.stick) this.toEnd(); }
          else this.addText(`\n[image: ${im.alt}]\n`);
        } else if (c.type === "text") this.addText(c.text ?? "");
        else if (c.type === "resource_link") this.addText(` [${c.name || c.uri}]`);
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
  /** Text goes into the message's current text segment (an image block ends the segment, so text after it follows it). */
  addText(t) {
    const cur = this.cur;
    if (!cur.seg) { cur.seg = { text: "", el: h("div", { class: "seg" }) }; cur.el.append(cur.seg.el); }
    cur.seg.text += t; this.paint(cur.seg.el, cur.seg);
  }
  /** Inline image with a caption link (Open / Save); null if the block isn't a displayable image. */
  figure(im) {
    const src = blockSrc(this.id, im); if (!src) return null;
    return h("figure", { class: "img" }, h("img", { class: "inl", loading: "lazy", decoding: "async", alt: im.alt || "image",
      ...(im.width && im.height ? { width: im.width, height: im.height } : {}), src }), h("figcaption", {}, imageAction(src, im.alt)));
  }
  // Progressive rendering: every chunk is appended immediately; markdown is re-rendered at most once per frame.
  paint(el, cur) {
    el._cur = cur;
    if (el._raf) return;
    const draw = () => { el._raf = 0; el.innerHTML = renderMarkdown(el._cur.text, this.mdOpts); this.watch(el); if (this.stick) this.toEnd(); };
    if (document.visibilityState !== "visible" || this.replaying) return draw();
    el._raf = requestAnimationFrame(draw);
  }
  renderTool(t) {
    const d = t.data; const open = t.el.open;
    const icon = { pending: "○", in_progress: "◐", completed: "✓", failed: "✗" }[d.status] || "•";
    const body = h("div", { class: "tool-body" });
    // Image figures are reused across updates (same source -> same node), so re-rendering doesn't reload/re-measure them.
    const figs = new Map(); const seen = new Set();
    const fig = (im) => {
      const k = imgKey(im); if (seen.has(k)) return null; seen.add(k);
      const f = t.figs?.get(k) ?? this.figure(im); if (f) figs.set(k, f); return f;
    };
    for (const c of d.content || []) {
      const im = c.type === "content" ? imageOf(c.content) : null;
      if (c.type === "diff") body.append(h("div", { class: "path" }, short(c.path)), diffView(c.oldText ?? "", c.newText ?? ""));
      else if (im) body.append(fig(im) ?? h("div", { class: "muted" }, `[image: ${im.alt}]`));
      else if (c.type === "content" && c.content?.type === "text") body.append(h("pre", {}, c.content.text));
      else if (c.type === "terminal") body.append(h("div", { class: "muted" }, `terminal ${c.terminalId}`));
    }
    if (d.rawInput && !(d.content || []).length) body.append(h("pre", {}, JSON.stringify(d.rawInput, squash, 2).slice(0, 4000)));
    if (d.rawOutput) {
      for (const im of findImages(d.rawOutput)) { const f = fig(im); if (f) body.append(f); }
      body.append(h("pre", {}, (typeof d.rawOutput === "string" ? d.rawOutput : JSON.stringify(d.rawOutput, squash, 2)).slice(0, 4000)));
    }
    t.figs = figs;
    t.el.replaceChildren(h("summary", { class: d.status || "" }, `${icon} ${d.title || d.kind || "Tool"}`), body);
    t.el.open = open || (d.content || []).some((c) => c.type === "diff") || figs.size > 0;
    this.watch(t.el);
  }
  setOpt(o, value) { this.ws?.readyState === 1 && this.ws.send(JSON.stringify({ type: "setOption", configId: o.id, value })); }
  /** Model and mode as compact pills by the composer; everything else behind the gear. */
  renderCtl() {
    const opts = this.options;
    const pill = (o) => {
      const sel = h("select", { class: "pillsel", "aria-label": o.name, title: o.description || o.name, onchange: () => this.setOpt(o, sel.value) },
        selectChoices(o));
      sel.value = o.value; return sel;
    };
    const main = ["model", "mode"].map((c) => opts.find((o) => o.category === c && o.type === "select")).filter(Boolean);
    const rest = opts.filter((o) => !main.includes(o));
    this.ctl.replaceChildren(...main.map(pill),
      ...(rest.length ? [h("button", { class: "pillbtn", "aria-label": "More settings", title: "More settings", onclick: () => this.openSettings() }, `⚙︎ ${rest.length}`)] : []));
    this.ctl.hidden = !opts.length;
  }
  openSettings() {
    this.settingsOpen = true;
    const sheet = $("#sheet"); sheet.hidden = false;
    const groups = new Map();
    const label = { model: "Model", mode: "Mode", thought_level: "Reasoning", model_config: "Model settings" };
    for (const o of this.options) { const k = o.category ? (label[o.category] ?? o.category.replace(/^_/, "").replace(/_/g, " ")) : "Other"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(o); }
    const row = (o) => {
      let ctl;
      if (o.type === "boolean") { ctl = h("input", { type: "checkbox", class: "toggle", checked: !!o.value, "aria-label": o.name, onchange: () => this.setOpt(o, ctl.checked) }); }
      else { ctl = h("select", { "aria-label": o.name, onchange: () => this.setOpt(o, ctl.value) }, selectChoices(o)); ctl.value = o.value; }
      const cur = o.type === "select" ? o.choices?.find((c) => c.value === o.value) : null;
      return h("div", { class: "opt" }, h("div", { class: "opt-l" }, h("div", {}, o.name), (o.description || cur?.description) ? h("div", { class: "meta" }, cur?.description || o.description) : null), ctl);
    };
    sheet.replaceChildren(h("div", { class: "sheet-body" }, h("h2", {}, "Agent settings"),
      ...[...groups].map(([k, os]) => h("section", { class: "optgroup" }, h("h3", {}, k), os.map(row))),
      h("p", { class: "muted small" }, "Changes apply to this session and become the default for new sessions with this agent."),
      h("button", { onclick: () => { sheet.hidden = true; this.settingsOpen = false; } }, "Done")));
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

// ---------- images ----------
// Only raster formats plus SVG, and SVG only ever as an <img> (never inline markup, where it could run script).
const IMG_MIME = { "image/png": 1, "image/jpeg": 1, "image/jpg": 1, "image/gif": 1, "image/webp": 1, "image/avif": 1, "image/svg+xml": 1 };
const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
const DATA_IMG = /^data:image\/(png|jpeg|gif|webp|avif|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/i;
const baseName = (u) => String(u || "").split(/[?#]/)[0].split("/").pop() || "image";
/** An ACP content block as an image: `image` (base64 data and/or uri), `resource_link` / embedded `resource` with an image mimeType. */
function imageOf(c) {
  if (!c || typeof c !== "object") return null;
  if (c.type === "image" && (c.data || c.uri)) return { mime: c.mimeType, data: c.data, uri: c.uri, alt: c.uri ? baseName(c.uri) : "image", width: c.width, height: c.height };
  if (c.type === "resource_link" && c.uri && (/^image\//i.test(c.mimeType || "") || (!c.mimeType && IMG_EXT.test(String(c.uri).split(/[?#]/)[0]))))
    return { mime: c.mimeType, uri: c.uri, alt: c.title || c.name || baseName(c.uri) };
  const r = c.type === "resource" ? c.resource : null;
  if (r && /^image\//i.test(r.mimeType || "") && (r.blob || r.uri)) return { mime: r.mimeType, data: r.blob, uri: r.blob ? undefined : r.uri, alt: baseName(r.uri) };
  return null;
}
const imgKey = (im) => im.data ? `d:${im.data.length}:${im.data.slice(0, 64)}:${im.data.slice(-64)}` : `u:${im.uri}`;
/** Image-looking objects inside a tool's rawOutput (e.g. MCP results: { content: [{ type: "image", data, mimeType }] }). */
function findImages(v, depth = 0, out = []) {
  if (!v || typeof v !== "object" || depth > 5 || out.length >= 12) return out;
  const im = imageOf(v); if (im && im.data) { out.push(im); return out; }
  for (const x of Array.isArray(v) ? v : Object.values(v)) findImages(x, depth + 1, out);
  return out;
}
/** JSON.stringify replacer: don't dump base64 blobs into tool cards. */
function squash(k, v) { return typeof v === "string" && v.length > 300 && /^[A-Za-z0-9+/=\r\n]+$/.test(v.slice(0, 300)) ? `<${v.length} chars of base64>` : v; }
function blockSrc(id, im) {
  if (im.data) {
    const mime = String(im.mime || "").toLowerCase().replace("image/jpg", "image/jpeg");
    if (!IMG_MIME[mime] || typeof im.data !== "string") return null;
    const src = `data:${mime};base64,${im.data}`;
    return DATA_IMG.test(src) ? src : null;
  }
  return imageSrc(id, im.uri);
}
/** Safe src for an image reference: base64 image data: URLs, http(s), or a file on this computer (file://, absolute or
 *  relative to the session folder) via Hearth's authenticated endpoint, which only serves images inside that folder. */
function imageSrc(id, u) {
  u = String(u || "").trim(); if (!u) return null;
  if (/^data:/i.test(u)) return DATA_IMG.test(u) ? u : null;
  if (/^https?:\/\//i.test(u)) return u;
  let path = null;
  if (/^file:\/\//i.test(u)) { try { const x = new URL(u); if (!x.host || x.host === "localhost") path = decodeURIComponent(x.pathname); } catch { /* bad uri */ } }
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) path = u;
  if (!path || path.startsWith("~")) return null; // ~ isn't expanded: keep it a plain link
  return `/api/sessions/${id}/file?path=${encodeURIComponent(path)}`;
}
function dataToBlob(src) {
  const [head, b64] = src.split(","); const bin = atob(b64.replace(/\s/g, ""));
  const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return new Blob([a], { type: head.slice(5).split(";")[0] });
}
/** "Open" (served/remote images, new tab) or "Save" (inline data: images, downloaded, never navigated to). */
function imageAction(src, alt) {
  if (!src.startsWith("data:")) return h("a", { href: src, target: "_blank", rel: "noopener noreferrer", class: "imgact" }, "Open");
  return h("button", { class: "imgact", type: "button", onclick: (e) => {
    e.stopPropagation();
    const blob = dataToBlob(src); const url = URL.createObjectURL(blob);
    const ext = blob.type.split("/")[1].replace("svg+xml", "svg").replace("jpeg", "jpg");
    const name = /\.[a-z0-9]+$/i.test(alt || "") ? alt : `image.${ext}`;
    const a = h("a", { href: url, download: name }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } }, "Save");
}
function lightbox(img) {
  const close = () => { box.remove(); removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const src = img.currentSrc || img.src;
  const box = h("div", { class: "lightbox", role: "dialog", "aria-modal": "true", "aria-label": img.alt || "Image",
    onclick: (e) => { if (!e.target.closest(".lb-actions a, .lb-actions .imgact")) close(); } },
    h("img", { src, alt: img.alt }), h("div", { class: "lb-actions" }, imageAction(src, img.alt), h("button", { type: "button", class: "imgact" }, "Close")));
  document.body.append(box); addEventListener("keydown", onKey);
}
function brokenImage(img) {
  if (img.dataset.broken) return; img.dataset.broken = "1";
  img.replaceWith(h("span", { class: "muted imgbroken" }, `🖼 ${img.alt || "image"} (couldn't be shown${img.src.includes("/file?") ? ": not an image inside the session folder" : ""})`));
}

function selectChoices(o) {
  const grouped = new Map();
  for (const c of o.choices || []) { const g = c.group || ""; if (!grouped.has(g)) grouped.set(g, []); grouped.get(g).push(c); }
  const opt = (c) => h("option", { value: c.value, title: c.description || "" }, c.name);
  return [...grouped].flatMap(([g, cs]) => g ? [h("optgroup", { label: g }, cs.map(opt))] : cs.map(opt));
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
  if (!chat) return; chat.settingsOpen = false;
  const sheet = $("#sheet"); sheet.hidden = false; const id = chat.id;
  const name = h("input", { value: chat.title || "" });
  sheet.replaceChildren(h("div", { class: "sheet-body" }, h("h2", {}, "Session"),
    h("label", {}, "Name"), name,
    h("button", { onclick: async () => { await api("PATCH", `/api/sessions/${id}`, { title: name.value }); sheet.hidden = true; } }, "Rename"),
    h("button", { class: "danger", onclick: async () => { if (confirm("Stop this agent? History is kept.")) { await api("DELETE", `/api/sessions/${id}`); sheet.hidden = true; } } }, "Terminate"),
    h("button", { class: "danger", onclick: async () => { if (confirm("Stop the agent and delete all history for this session?")) { await api("DELETE", `/api/sessions/${id}?purge=1`); sheet.hidden = true; location.hash = "#/"; } } }, "Terminate & delete history"),
    h("button", { onclick: () => { sheet.hidden = true; } }, "Close")));
};
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") { e.target.hidden = true; if (chat) chat.settingsOpen = false; } });

// ---------- files ----------
const fmtSize = (n) => n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB` : `${(n / 1073741824).toFixed(1)} GB`;
const filesHash = (p) => p ? `#/files?p=${encodeURIComponent(p)}` : "#/files";
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
const UPLOAD_CHUNK = 8 * 1024 * 1024;
/**
 * One file row. Clicking checks with the server first (same request path and cookies as the listing), so a file this
 * computer can't read shows the reason here instead of a broken entry in the browser's download list; then it hands
 * the real download to the browser (streamed to disk, resumable).
 */
function fileItem(path, e) {
  const href = `/api/files/download?path=${encodeURIComponent(path)}`;
  const meta = h("span", { class: "meta" }, `${fmtSize(e.size)} · ${ago(e.mtime)}`);
  const err = h("span", { class: "err", hidden: true });
  const a = h("a", { class: "fname", href, download: e.name, title: "Download", onclick: async (ev) => {
    if (a.dataset.ok === "1") { delete a.dataset.ok; return; } // the checked, real click below
    ev.preventDefault(); if (a.dataset.busy) return;
    a.dataset.busy = "1"; err.hidden = true; meta.textContent = "Checking…";
    try {
      const r = await fetch(href + "&check=1", { credentials: "same-origin", cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (r.status === 423) return showLock();
      if (!r.ok || !j.ok) throw new Error(j.error || (r.status >= 500 ? `this computer didn't answer (HTTP ${r.status}); try again` : `HTTP ${r.status}`));
      a.dataset.ok = "1"; a.click();
    } catch (x) { err.textContent = `Can't download: ${x.message === "Failed to fetch" ? "no connection to this computer" : x.message}`; err.hidden = false; }
    finally { delete a.dataset.busy; meta.textContent = `${fmtSize(e.size)} · ${ago(e.mtime)}`; }
  } }, `📄 ${e.name}`);
  return h("li", { class: "card file" }, a, meta, err);
}
async function showFiles(rel) {
  if (chat) { chat.close(); chat = null; }
  setHeader("Files", { back: true });
  const me = await api("GET", "/api/me"); if (me.needsPassword && !me.unlocked) return showLock();
  const hidden = localStorage.getItem("hearth.hidden") === "1";
  const r = await api("GET", `/api/files?path=${encodeURIComponent(rel)}${hidden ? "&hidden=1" : ""}`);
  const segs = r.path ? r.path.split("/") : [];
  const crumbs = h("div", { class: "crumbs" }, h("a", { href: filesHash("") }, "🏠 Home"),
    ...segs.flatMap((sg, i) => [" / ", h("a", { href: filesHash(segs.slice(0, i + 1).join("/")) }, sg)]));
  const join = (n) => (r.path ? r.path + "/" : "") + n;
  const list = h("ul", { class: "list files" },
    ...(r.parent != null ? [h("li", { class: "card file", onclick: () => { location.hash = filesHash(r.parent); } }, h("span", { class: "fname" }, "‹ .."))] : []),
    ...r.entries.map((e) => e.dir
      ? h("li", { class: "card file", onclick: () => { location.hash = filesHash(join(e.name)); } }, h("span", { class: "fname" }, `📁 ${e.name}`), h("span", { class: "meta" }, ago(e.mtime)))
      : fileItem(join(e.name), e)));
  if (!r.entries.length) list.append(h("li", { class: "muted center" }, "Empty folder."));
  const prog = h("div", { class: "uploads" });
  const input = h("input", { type: "file", multiple: true, hidden: true, onchange: async () => {
    const files = [...input.files]; input.value = "";
    const names = new Set(r.entries.map((e) => e.name));
    for (const f of files) {
      let overwrite = false;
      if (names.has(f.name)) { if (!confirm(`Replace "${f.name}"?`)) continue; overwrite = true; }
      const bar = h("progress", { max: 1, value: 0 }), line = h("div", { class: "upl" }, h("span", {}, f.name), bar, h("span", { class: "meta" }, fmtSize(f.size)));
      prog.append(line);
      try { await uploadFile(rel, f, overwrite, (x) => { bar.value = x; }); line.classList.add("ok"); }
      catch (x) { line.classList.add("bad"); line.append(h("span", { class: "err" }, x.message)); }
    }
    if (!prog.querySelector(".bad")) showFiles(rel); else { const keep = prog; showFiles(rel).then(() => $(".uploads")?.replaceWith(keep)); }
  } });
  const bar = h("div", { class: "toolbar" }, crumbs, h("div", { class: "row" },
    h("label", { class: "small muted hid" }, h("input", { type: "checkbox", checked: hidden, onchange: (e) => { localStorage.setItem("hearth.hidden", e.target.checked ? "1" : "0"); showFiles(rel); } }), " hidden"),
    h("button", { onclick: async () => { const n = prompt("New folder name"); if (!n) return; try { await api("POST", "/api/files/mkdir", { path: rel, name: n }); showFiles(rel); } catch (x) { alert(x.message); } } }, "New folder"),
    h("button", { class: "primary", onclick: () => input.click() }, "Upload")));
  $("#view").replaceChildren(bar, input, prog, list, h("p", { class: "muted small center" }, `Files in ${short(r.root)}${r.path ? "/" + r.path : ""} on this computer. Downloads stream; uploads go in ${fmtSize(UPLOAD_CHUNK)} pieces and resume after a dropped connection.`));
}
/** Chunked, resumable upload: the server says how much it has (409 + have) and we continue from there. */
async function uploadFile(dir, file, overwrite, onProgress) {
  const id = rid(); let off = 0, tries = 0;
  for (;;) {
    const end = Math.min(off + UPLOAD_CHUNK, file.size);
    const qs = new URLSearchParams({ path: dir, name: file.name, id, offset: String(off), total: String(file.size), overwrite: overwrite ? "1" : "0" });
    let r, j;
    try {
      r = await fetch("/api/files/upload?" + qs, { method: "POST", credentials: "same-origin", headers: { "x-hearth-csrf": "1", "content-type": "application/octet-stream" }, body: file.slice(off, end) });
      j = await r.json().catch(() => ({}));
    } catch (x) { if (++tries > 5) throw new Error("connection lost"); await new Promise((res) => setTimeout(res, 1000 * tries)); continue; }
    if (r.status === 409 && typeof j.have === "number") { off = j.have; continue; }
    if (r.status === 423) { showLock(); throw new Error("locked"); }
    if (!r.ok) throw new Error(j.error === "exists" ? "a file with that name already exists" : j.error || r.statusText);
    tries = 0; off = j.received; onProgress(file.size ? off / file.size : 1);
    if (j.done) return j;
  }
}

// ---------- notifications ----------
const b64uBytes = (s) => { const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
function deviceLabel() {
  const u = navigator.userAgent;
  const dev = /iPhone/.test(u) ? "iPhone" : /iPad/.test(u) || (/Macintosh/.test(u) && navigator.maxTouchPoints > 1) ? "iPad" : /Android/.test(u) ? "Android" : /Mac OS X|Macintosh/.test(u) ? "Mac" : /Windows/.test(u) ? "Windows" : /Linux|X11/.test(u) ? "Linux" : "Device";
  const br = /Edg\//.test(u) ? "Edge" : /Firefox\//.test(u) ? "Firefox" : /Chrome\//.test(u) ? "Chrome" : /Safari\//.test(u) ? "Safari" : "";
  return br ? `${dev} · ${br}` : dev;
}
async function notifySheet() {
  const sheet = $("#sheet"); sheet.hidden = false;
  const err = h("p", { class: "err" }), info = h("p", { class: "muted" });
  const done = h("input", { type: "checkbox", class: "toggle", checked: true, "aria-label": "When an agent finishes" });
  const perm = h("input", { type: "checkbox", class: "toggle", checked: true, "aria-label": "When an agent needs approval" });
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const srv = await api("GET", "/api/push");
  let sub = null;
  if (supported) { try { const reg = await navigator.serviceWorker.getRegistration(); sub = reg ? await reg.pushManager.getSubscription() : null; } catch { /* no SW yet */ } }
  const mine = sub && srv.devices.find((d) => d.endpoint === sub.endpoint);
  if (mine) { done.checked = mine.prefs.done !== false; perm.checked = mine.prefs.perm !== false; }
  const close = h("button", { onclick: () => { sheet.hidden = true; } }, "Close");
  const body = [h("h2", {}, "Notifications")];
  if (!supported) {
    body.push(h("p", {}, ios && !standalone ? "On iPhone and iPad, notifications work once Hearth is on your Home Screen: tap Share, then “Add to Home Screen”, open Hearth from there and come back here." : "This browser can't receive web notifications."));
  } else {
    info.textContent = mine ? `This device (${mine.label || deviceLabel()}) gets notifications.` : Notification.permission === "denied" ? "Notifications are blocked for this site: allow them in the browser's site settings, then try again." : "Get a notification on this device when an agent finishes or needs your approval, even when Hearth isn't open.";
    const on = h("button", { class: "primary", onclick: async () => {
      err.textContent = ""; on.disabled = true;
      try {
        const p = await Notification.requestPermission(); // first, while the tap still counts as a user gesture
        if (p !== "granted") throw new Error(p === "denied" ? "Notifications are blocked for this site in the browser settings." : "Permission wasn't granted.");
        const reg = await navigator.serviceWorker.register("sw.js"); await navigator.serviceWorker.ready;
        const key = b64uBytes(srv.publicKey);
        let s = await reg.pushManager.getSubscription();
        const cur = s?.options?.applicationServerKey ? new Uint8Array(s.options.applicationServerKey) : null;
        if (s && (!cur || cur.length !== key.length || cur.some((x, i) => x !== key[i]))) { await s.unsubscribe(); s = null; }
        s = s || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        await api("POST", "/api/push/subscribe", { subscription: s.toJSON(), prefs: { done: done.checked, perm: perm.checked }, label: deviceLabel() });
        notifySheet();
      } catch (x) { err.textContent = x.message; on.disabled = false; }
    } }, mine ? "Save" : "Turn on for this device");
    const off = mine ? h("button", { class: "danger", onclick: async () => {
      try { await api("POST", "/api/push/unsubscribe", { endpoint: sub.endpoint }); await sub.unsubscribe(); notifySheet(); } catch (x) { err.textContent = x.message; } } }, "Turn off for this device") : null;
    const test = mine ? h("button", { onclick: async () => { err.textContent = ""; try { await api("POST", "/api/push/test", { endpoint: sub.endpoint }); info.textContent = "Test sent. It can take a few seconds to arrive."; } catch (x) { err.textContent = `Test failed: ${x.message}`; } } }, "Send a test") : null;
    body.push(info,
      h("div", { class: "opt" }, h("div", { class: "opt-l" }, h("div", {}, "When an agent finishes"), h("div", { class: "meta" }, "The reply's last lines; skipped while you're looking at that session.")), done),
      h("div", { class: "opt" }, h("div", { class: "opt-l" }, h("div", {}, "When an agent needs approval"), h("div", { class: "meta" }, "A permission request is waiting for you.")), perm),
      err, h("div", { class: "row wrap" }, on, test, off));
    const others = srv.devices.filter((d) => !sub || d.endpoint !== sub.endpoint);
    if (others.length) body.push(h("p", { class: "muted small" }, `Also on: ${others.map((d) => d.label || d.endpointHost).join(", ")}`));
    if (ios && !standalone) body.push(h("p", { class: "muted small" }, "iPhone/iPad: add Hearth to the Home Screen first (Share → Add to Home Screen) and turn this on from there."));
  }
  body.push(close);
  sheet.replaceChildren(h("div", { class: "sheet-body" }, ...body));
}

// ---------- routing ----------
async function route() {
  $("#sheet").hidden = true;
  const m = /^#\/s\/([a-f0-9-]{36})$/.exec(location.hash);
  const fm = /^#\/files(?:\?p=(.*))?$/.exec(location.hash);
  try {
    if (fm) { let p = ""; try { p = decodeURIComponent(fm[1] || ""); } catch { /* bad escape */ } await showFiles(p); }
    else if (m) {
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
