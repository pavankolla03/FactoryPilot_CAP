/*
 * Insights chat.
 *
 * Three endpoints: insights/ask, insights/confirmAction, and OData for the
 * session list and usage. No framework — the page is served by CAP itself and
 * a build step would be one more thing to break between here and Cloud Foundry.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const threadEl = $("thread");
  const qEl = $("q"), whEl = $("wh"), askEl = $("ask");
  let conversationID = null;
  let sessions = [];
  let busy = false;

  const SUGGESTIONS = [
    ["How much stock do we have?", "1010"],
    ["Show goods movements", "1010"],
    ["What purchase orders are open?", "1010"],
    ["Which physical inventory counts are still open?", "1710"],
  ];

  // --- CSRF ---------------------------------------------------------------
  // The approuter rejects a POST without a token, before it ever reaches the
  // service. Locally there is no approuter and no token is issued, so the
  // header is simply omitted.
  let csrf = null;

  async function fetchCsrf() {
    try {
      const res = await fetch("../../insights/whoami()", {
        headers: { "x-csrf-token": "fetch" },
        credentials: "same-origin",
      });
      csrf = res.headers.get("x-csrf-token") || null;
    } catch { csrf = null; }
    return csrf;
  }

  async function call(path, body) {
    if (!csrf) await fetchCsrf();
    const send = () => fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(csrf && { "x-csrf-token": csrf }) },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    let res = await send();
    if (res.status === 403 && /required/i.test(res.headers.get("x-csrf-token") || "")) {
      await fetchCsrf();
      res = await send();
    }
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  }

  // --- markdown ------------------------------------------------------------
  // The model writes tables and lists. Rendering them as flat text throws away
  // exactly the structure that makes a set of figures readable.
  function md(src) {
    const out = [];
    let table = null, list = null;

    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

    const isNum = (v) => /^[-+]?[\d,.]+\s*[%A-Za-z]{0,4}$/.test(String(v).trim());
    const flushTable = () => {
      if (!table) return;
      const [head, ...rows] = table;
      const num = head.map((_, i) => rows.length && rows.every((r) => !r[i] || isNum(r[i])));
      out.push('<div class="tablewrap"><table><thead><tr>' +
        head.map((h, i) => `<th class="${num[i] ? "num" : ""}">${inline(h)}</th>`).join("") +
        "</tr></thead><tbody>" +
        rows.map((r) => "<tr>" + head.map((_, i) =>
          `<td class="${num[i] ? "num" : ""}">${inline(r[i] ?? "")}</td>`).join("") + "</tr>").join("") +
        "</tbody></table></div>");
      table = null;
    };
    const flushList = () => {
      if (!list) return;
      out.push(`<${list.tag}>` + list.items.map((i) => `<li>${inline(i)}</li>`).join("") + `</${list.tag}>`);
      list = null;
    };

    for (const raw of String(src ?? "").split("\n")) {
      const line = raw.trimEnd();
      if (/^\s*\|.*\|\s*$/.test(line)) {
        if (/^[\s|:-]+$/.test(line)) continue;           // the |---|---| rule
        flushList();
        (table ||= []).push(line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
        continue;
      }
      flushTable();

      const b = line.match(/^\s*[-*]\s+(.*)$/), n = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (b || n) {
        const tag = b ? "ul" : "ol";
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push((b || n)[1]);
        continue;
      }
      flushList();
      if (!line.trim()) continue;
      const h = line.match(/^#{1,4}\s+(.*)$/);
      out.push(h ? `<h3>${inline(h[1])}</h3>` : `<p>${inline(line)}</p>`);
    }
    flushTable(); flushList();
    return out.join("") || `<p>${inline(String(src ?? ""))}</p>`;
  }

  // --- rendering -----------------------------------------------------------
  function inner() {
    let el = threadEl.querySelector(".thread__inner");
    if (!el) { el = document.createElement("div"); el.className = "thread__inner"; threadEl.appendChild(el); }
    return el;
  }

  /** Appended, never prepended: the answer belongs under the question. */
  function add(html, kind) {
    const el = document.createElement("div");
    el.className = "turn " + (kind === "me" ? "turn--me" : "turn--bot");
    el.innerHTML = html;
    inner().appendChild(el);
    threadEl.scrollTop = threadEl.scrollHeight;
    return el;
  }

  function badges(meta = {}) {
    const b = [];
    if (meta.objectCode) b.push(`<span class="fd-status fd-status--information">${esc(meta.objectCode)}</span>`);
    b.push(`<span class="fd-status ${meta.grounded ? "fd-status--positive" : "fd-status--critical"}">${
      meta.grounded ? "Grounded in SAP data" : "Not grounded"}</span>`);
    if (meta.cacheResult && meta.cacheResult !== "NOT_APPLICABLE") {
      b.push(`<span class="fd-status ${meta.cacheResult === "HIT" ? "fd-status--positive" : ""}">Cache ${esc(meta.cacheResult)}</span>`);
    }
    if (meta.tokensUsed != null) b.push(`<span class="fd-status">${esc(meta.tokensUsed)} tokens</span>`);
    if (meta.totalResponseTimeMs != null) b.push(`<span class="fd-status">${esc(meta.totalResponseTimeMs)} ms</span>`);
    return `<div class="badges">${b.join("")}</div>`;
  }

  function welcome() {
    threadEl.innerHTML = "";
    inner().innerHTML =
      '<div class="welcome"><h2>Ask about your operational data</h2>' +
      "<p>Stock, goods movements, physical inventory, deliveries and purchase orders — " +
      "answered from live S/4HANA. Ask for a write and it stops for your confirmation.</p>" +
      '<div class="suggest">' +
      SUGGESTIONS.map(([q, w]) => `<button data-q="${esc(q)}" data-w="${esc(w)}">${esc(q)}</button>`).join("") +
      "</div></div>";
    inner().querySelectorAll(".suggest button").forEach((btn) =>
      btn.addEventListener("click", () => { whEl.value = btn.dataset.w; ask(btn.dataset.q); }));
  }

  // --- asking --------------------------------------------------------------
  async function ask(question, shownAs) {
    if (busy || !question.trim()) return;
    busy = true; askEl.disabled = true;
    if (threadEl.querySelector(".welcome")) threadEl.innerHTML = "";

    add(`<div class="turn__role">You</div><div class="turn__body">${esc(shownAs || question)}</div>`, "me");
    const pending = add('<div class="turn__role">FactoryPilot</div><div class="turn__body">Working through SAP…</div>');

    try {
      const { ok, status, data } = await call("../../insights/ask", {
        question, warehouseID: whEl.value, channel: "Web",
        ...(conversationID && { conversationID }),
      });

      if (!ok) {
        let help = "The service returned HTTP " + status + ".";
        if (status === 401) help = "Your session has expired. Reload the page to sign in again.";
        else if (status === 403) {
          help = "This sign-in has no permission to ask. Assign the <code>FactoryPilot_Administrator</code> " +
                 "role collection in the BTP cockpit, then log out and sign in again.";
          try {
            const probe = await fetch("../../insights/whoami()");
            if (probe.ok) {
              const who = JSON.parse((await probe.json()).value ?? "{}");
              if (who.canAsk) {
                help = "Your permissions are correct, so this was refused before it reached the service. " +
                       "Reload the page; if it persists, check <code>cf logs factorypilot-srv</code>.";
              }
            }
          } catch { /* the probe is a courtesy */ }
        }
        pending.innerHTML = `<div class="turn__role">FactoryPilot</div>
          <div class="turn__body"><div class="fd-message-strip fd-message-strip--error">
          <span><span class="fd-message-strip__title">Could not ask.</span> ${help}</span></div></div>`;
        return;
      }

      const meta = { ...(data.metadata || {}), ...safe(data.metrics) };
      if (meta.conversationID) conversationID = meta.conversationID;

      if (data.status === "AWAITING_APPROVAL" && data.pendingAction) {
        renderApproval(pending, data.pendingAction, meta);
      } else if (data.status === "RATE_LIMITED") {
        pending.innerHTML = strip("warning", "Quota reached.", data.message, meta);
      } else if (data.status === "FAILED") {
        pending.innerHTML = strip("error", "No data retrieved.", data.answer, meta);
      } else if (data.status === "ERROR") {
        pending.innerHTML = strip("error", "Could not answer.", data.message, meta);
      } else {
        pending.innerHTML = `<div class="turn__role">FactoryPilot</div>
          <div class="turn__body"><div class="md">${md(data.answer)}</div>${badges(meta)}</div>`;
      }
      refreshUsage();
      // Not loadSessions(): refetching re-sorts by modifiedAt, so the chat you
      // are in jumps to the top of the rail under your cursor every time it
      // answers. A conversation is added once, when it first appears.
      noteSession(meta.conversationID, question);
    } catch (err) {
      pending.innerHTML = strip("error", "Service unreachable.", err.message, {});
    } finally {
      busy = false; askEl.disabled = false;
      threadEl.scrollTop = threadEl.scrollHeight;
    }
  }

  const safe = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
  const strip = (kind, title, text, meta) =>
    `<div class="turn__role">FactoryPilot</div><div class="turn__body">
       <div class="fd-message-strip fd-message-strip--${kind}">
         <span><span class="fd-message-strip__title">${esc(title)}</span> ${esc(text || "")}</span>
       </div>${badges(meta)}</div>`;

  function renderApproval(host, p, meta) {
    const args = safe(p.arguments);
    host.innerHTML =
      `<div class="turn__role">FactoryPilot</div>
       <div class="turn__body approve">
         <strong>Confirmation required</strong>
         <p>${esc(p.summary || "This write needs your approval.")}</p>
         <dl>${Object.entries(args).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
         <button class="fd-button fd-button--emphasized" data-ok="1">Approve and run</button>
         <button class="fd-button" data-ok="0">Reject</button>
       </div>${badges(meta)}`;

    host.querySelectorAll("[data-ok]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        host.querySelectorAll("[data-ok]").forEach((b) => (b.disabled = true));
        const approve = btn.dataset.ok === "1";
        const { data } = await call("../../insights/confirmAction", { actionID: p.actionID, approve });
        if (data.status === "SUCCESS") {
          add(`<div class="turn__role">FactoryPilot</div><div class="turn__body">
                 <div class="md">${md(data.answer)}</div></div>`);
        } else {
          add(strip("error", data.errorCode || "Refused.", data.message, {}));
        }
        refreshUsage();
      }));
  }

  // --- sessions ------------------------------------------------------------
  /**
   * Record a conversation the moment it is created, and leave it alone after.
   *
   * The rail is navigation: it should be stable while you are reading and
   * typing. Re-sorting it on every answer moves the row you are looking at.
   */
  function noteSession(id, title) {
    if (!id) return;
    if (sessions.some((c) => c.ID === id)) {
      markActive();
      return;
    }
    sessions.unshift({ ID: id, title: String(title || "").slice(0, 120), modifiedAt: new Date().toISOString() });
    paintSessions();
  }

  /** Move the highlight without repainting — no reflow, no scroll jump. */
  function markActive() {
    $("sessionlist").querySelectorAll(".session").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.id === conversationID));
  }

  async function loadSessions() {
    try {
      const res = await fetch("../../insights/Conversations?$orderby=modifiedAt desc&$top=60");
      sessions = res.ok ? (await res.json()).value || [] : [];
    } catch { sessions = []; }
    paintSessions();
  }

  function paintSessions() {
    const list = $("sessionlist");
    const keepScroll = list.scrollTop;      // a repaint must not scroll the rail
    const term = ($("search").value || "").toLowerCase();
    const rows = sessions.filter((c) => !term || (c.title || "").toLowerCase().includes(term));
    if (!rows.length) {
      list.innerHTML = `<p class="sessions__empty">${term ? "No chat matches that." : "No conversations yet."}</p>`;
      return;
    }
    list.innerHTML = rows.map((c) => `
      <button class="session ${c.ID === conversationID ? "is-active" : ""}" data-id="${esc(c.ID)}">
        <div class="session__title">${esc(c.title || "Untitled")}</div>
        <div class="session__when">${esc(c.modifiedAt ? new Date(c.modifiedAt).toLocaleString("en-GB", {
          day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "")}</div>
      </button>`).join("");
    list.querySelectorAll(".session").forEach((b) =>
      b.addEventListener("click", () => openSession(b.dataset.id)));
    list.scrollTop = keepScroll;
  }

  /** Replay a past conversation in the order it happened. */
  async function openSession(id) {
    conversationID = id;
    threadEl.innerHTML = "";
    inner().innerHTML = '<div class="turn turn--bot"><div class="turn__body">Loading…</div></div>';
    try {
      const res = await fetch(`../../insights/Messages?$filter=conversation_ID eq ${id}&$orderby=seq asc&$top=300`);
      const rows = res.ok ? (await res.json()).value || [] : [];
      threadEl.innerHTML = "";
      const shown = rows.filter((m) => (m.role === "user" || m.role === "assistant") && m.content);
      if (!shown.length) { welcome(); return; }
      for (const m of shown) {
        if (m.role === "user") {
          add(`<div class="turn__role">You</div><div class="turn__body">${esc(m.content)}</div>`, "me");
        } else {
          add(`<div class="turn__role">FactoryPilot</div><div class="turn__body"><div class="md">${md(m.content)}</div></div>`);
        }
      }
      threadEl.scrollTop = threadEl.scrollHeight;
      markActive();
    } catch {
      threadEl.innerHTML = "";
      add(strip("warning", "Could not load that conversation.", "", {}));
    }
  }

  // --- chrome --------------------------------------------------------------
  async function refreshUsage() {
    try {
      const res = await fetch("../../odata/token/myUsage()");
      if (!res.ok) return;
      const u = await res.json();
      $("usage").textContent = u.limitDay == null
        ? String(u.userID || "")
        : `${u.userID} · ${u.usedDay}/${u.limitDay} today`;
      $("initials").textContent = ((u.userID || "?")[0] || "?").toUpperCase();
    } catch { /* the chip is decoration */ }
  }

  // --- wiring --------------------------------------------------------------
  qEl.addEventListener("input", () => {
    qEl.style.height = "auto";
    qEl.style.height = Math.min(144, qEl.scrollHeight) + "px";
  });
  qEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  function submit() {
    const v = qEl.value.trim();
    if (!v) return;
    qEl.value = ""; qEl.style.height = "auto";
    // The file travels with the question, not as a side channel, so the model
    // sees the same text the operator thinks it has.
    const withFile = attached
      ? `${v}\n\nAttached file "${attached.name}":\n${attached.text}`
      : v;
    const shown = attached ? `${v}  📎 ${attached.name}` : v;
    attached = null; showAttachment();
    ask(withFile, shown);
  }
  askEl.addEventListener("click", submit);
  $("newchat").addEventListener("click", () => { conversationID = null; welcome(); paintSessions(); });
  $("search").addEventListener("input", paintSessions);

  // --- input tools ---------------------------------------------------------
  // Each of these does something real or is disabled with a reason. A button
  // that opens a picker and then silently discards the file is worse than no
  // button: the operator believes the assistant has seen it.

  let attached = null;                       // { name, text } pending on the next question

  function showAttachment() {
    const strip = $("attachment");
    if (!attached) { strip.hidden = true; strip.innerHTML = ""; return; }
    strip.hidden = false;
    strip.innerHTML = `<span>📎 ${esc(attached.name)} — ${attached.text.length.toLocaleString()} characters will be sent with your question</span>
                       <button type="button" id="dropfile" aria-label="Remove attachment">✕</button>`;
    $("dropfile").addEventListener("click", () => { attached = null; showAttachment(); });
  }

  // Dictation. Browser speech recognition, so no audio leaves the machine and
  // no transcription service is needed; the words land in the box for you to
  // check before sending, which matters when a question can move stock.
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = $("mic");
  if (!Recognition) {
    mic.disabled = true;
    mic.title = "Dictation needs a browser with speech recognition (Chrome or Edge).";
  } else {
    let listening = false, rec = null;
    mic.addEventListener("click", () => {
      if (listening) { rec && rec.stop(); return; }
      rec = new Recognition();
      rec.lang = "en-GB";
      rec.interimResults = true;
      rec.continuous = false;
      const before = qEl.value;
      rec.onstart = () => { listening = true; mic.classList.add("is-live"); mic.title = "Listening — click to stop"; };
      rec.onresult = (e) => {
        const said = Array.from(e.results).map((r) => r[0].transcript).join("");
        qEl.value = (before ? before + " " : "") + said;
        qEl.dispatchEvent(new Event("input", { bubbles: true }));
      };
      rec.onerror = (e) => {
        mic.title = e.error === "not-allowed"
          ? "Microphone permission was refused."
          : "Dictation failed: " + e.error;
      };
      rec.onend = () => { listening = false; mic.classList.remove("is-live"); };
      try { rec.start(); } catch { listening = false; }
    });
  }

  // Attach a text-shaped file. Its contents are prepended to the question, so
  // the model genuinely reads it — a pasted picking list or CSV extract can be
  // asked about directly.
  const MAX_ATTACH = 20000;                  // beyond this the prompt budget suffers
  $("clip").addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { attached = null; showAttachment(); alert("That file is over 2 MB — please attach a smaller extract."); return; }
    const text = await f.text();
    attached = { name: f.name, text: text.slice(0, MAX_ATTACH) };
    showAttachment();
    qEl.focus();
  });

  // A photograph needs a model that can see. Nothing here reads images yet, so
  // the button says so rather than opening a camera and dropping the result.
  $("cam").addEventListener("click", () => {
    add(`<div class="turn__role">FactoryPilot</div><div class="turn__body">
           <div class="fd-message-strip fd-message-strip--information">
             <span><span class="fd-message-strip__title">Photos are not read yet.</span>
             The question pipeline is text-only, so an image would be collected and ignored.
             Attach a CSV or text extract with 📎, or dictate with 🎤 — both are sent to the model.</span>
           </div></div>`);
  });

  welcome();
  refreshUsage();
  loadSessions();
})();
