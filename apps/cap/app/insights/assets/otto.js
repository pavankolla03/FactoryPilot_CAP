/*
 * Otto — chat behaviour.
 *
 * Talks to three endpoints: insights/ask, insights/confirmAction, and the
 * OData services for conversation history and usage. No framework: the page
 * is served by CAP itself and a build step would be one more thing to break
 * between here and Cloud Foundry.
 */

(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const thread = $("thread");
  let conversationID = null;
  let busy = false;

  const SUGGESTIONS = [
    ["How much stock do we have?", "1010"],
    ["How much stock of CH_C_C04 do we have?", "1010"],
    ["Show goods movements", "1010"],
    ["Which physical inventory counts are still open?", "1710"],
    ["How many deliveries are there?", "1710"],
    ["What purchase orders are open?", "1010"],
  ];

  // ---------- a small markdown renderer -------------------------------------
  // Answers come from a real model, which writes tables and lists. Rendering
  // them as plain text throws away exactly the structure that makes a figure
  // readable, so the little that is needed is done here rather than pulling in
  // a library the CSP would block anyway.
  function md(src) {
    const text = String(src ?? "");
    const blocks = [];
    let table = null;

    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");

    const isNum = (v) => /^[-+]?[\d,.]+\s*[%A-Za-z]{0,3}$/.test(String(v).trim());
    const flushTable = () => {
      if (!table) return;
      const [head, ...body] = table;
      const numCol = head.map((_, i) => body.length && body.every((r) => !r[i] || isNum(r[i])));
      blocks.push(
        '<div class="tablewrap"><table><thead><tr>' +
        head.map((h, i) => `<th class="${numCol[i] ? "num" : ""}">${inline(h)}</th>`).join("") +
        "</tr></thead><tbody>" +
        body.map((r) => "<tr>" + head.map((_, i) =>
          `<td class="${numCol[i] ? "num" : ""}">${inline(r[i] ?? "")}</td>`).join("") + "</tr>").join("") +
        "</tbody></table></div>"
      );
      table = null;
    };

    let list = null;
    const flushList = () => {
      if (!list) return;
      blocks.push(`<${list.tag}>` + list.items.map((i) => `<li>${inline(i)}</li>`).join("") + `</${list.tag}>`);
      list = null;
    };

    for (const raw of text.split("\n")) {
      const line = raw.trimEnd();

      if (/^\s*\|.*\|\s*$/.test(line)) {
        const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (/^[\s|:-]+$/.test(line)) continue;      // the |---|---| separator
        flushList();
        (table ||= []).push(cells);
        continue;
      }
      flushTable();

      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || numbered) {
        const tag = bullet ? "ul" : "ol";
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push((bullet || numbered)[1]);
        continue;
      }
      flushList();

      if (!line.trim()) continue;
      const h = line.match(/^#{1,4}\s+(.*)$/);
      blocks.push(h ? `<h3>${inline(h[1])}</h3>` : `<p>${inline(line)}</p>`);
    }
    flushTable(); flushList();
    return blocks.join("") || `<p>${inline(text)}</p>`;
  }

  // ---------- rendering ------------------------------------------------------
  function add(html) {
    const el = document.createElement("div");
    el.className = "turn";
    el.innerHTML = html;
    thread.appendChild(el);
    thread.scrollTop = thread.scrollHeight;
    return el;
  }

  function badges(meta = {}) {
    const b = [];
    if (meta.objectCode) b.push(`<span class="badge badge--info">${esc(meta.objectCode)}</span>`);
    if (meta.toolsCalled) b.push(`<span class="badge">${esc(meta.toolsCalled)}</span>`);
    b.push(meta.grounded
      ? '<span class="badge badge--go">Grounded in SAP data</span>'
      : '<span class="badge badge--warn">Not grounded</span>');
    if (meta.cacheResult && meta.cacheResult !== "NOT_APPLICABLE") {
      b.push(`<span class="badge ${meta.cacheResult === "HIT" ? "badge--go" : ""}">Cache ${esc(meta.cacheResult)}</span>`);
    }
    if (meta.tokensUsed != null) b.push(`<span class="badge">${esc(meta.tokensUsed)} tokens</span>`);
    if (meta.totalResponseTimeMs != null) b.push(`<span class="badge">${esc(meta.totalResponseTimeMs)} ms</span>`);
    return `<div class="badges">${b.join("")}</div>`;
  }

  function welcome() {
    thread.innerHTML =
      '<div class="welcome">' +
        '<div class="welcome__mark" aria-hidden="true">FP</div>' +
        "<h2>Ask Otto about your warehouses</h2>" +
        "<p>Stock levels, materials, movements, purchase orders — or ask the agent to move stock or set alerts.</p>" +
        '<div class="chips">' +
          SUGGESTIONS.map(([q, w]) =>
            `<button class="chip" data-q="${esc(q)}" data-w="${esc(w)}">${esc(q)}</button>`).join("") +
        "</div>" +
      "</div>";
    thread.querySelectorAll(".chip").forEach((c) =>
      c.addEventListener("click", () => {
        $("warehouse").value = c.dataset.w;
        ask(c.dataset.q);
      }));
  }

  // ---------- the request ----------------------------------------------------
  async function ask(question) {
    if (busy || !question.trim()) return;
    busy = true; $("send").disabled = true;
    if (thread.querySelector(".welcome")) thread.innerHTML = "";

    add(`<div class="turn__who">You</div><div class="bubble-you">${esc(question)}</div>`);
    const pending = add('<div class="turn__who">Otto</div><div class="card"><div class="thinking"><i></i><i></i><i></i> Working through SAP…</div></div>');

    try {
      const res = await fetch("../../insights/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          warehouseID: $("warehouse").value,
          channel: "WEB",
          conversationID: conversationID || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        pending.innerHTML = `<div class="turn__who">Otto</div><div class="strip strip--stop"><b>Request failed.</b> ${esc(data.error?.message || res.status)}</div>`;
        return;
      }

      conversationID = data.metadata?.conversationID || conversationID;
      const meta = {
        ...(data.metadata || {}),
        ...(() => { try { return JSON.parse(data.metrics || "{}"); } catch { return {}; } })(),
      };

      if (data.status === "AWAITING_APPROVAL" && data.pendingAction) {
        renderApproval(pending, data, meta);
      } else if (data.status === "RATE_LIMITED") {
        pending.innerHTML = `<div class="turn__who">Otto</div><div class="strip strip--warn"><b>Daily limit reached.</b> ${esc(data.message || "")}</div>${badges(meta)}`;
      } else if (data.status === "FAILED") {
        pending.innerHTML = `<div class="turn__who">Otto</div><div class="strip strip--stop"><b>No data retrieved.</b> ${esc(data.answer || "")}</div>${badges(meta)}`;
      } else if (data.status === "ERROR") {
        pending.innerHTML = `<div class="turn__who">Otto</div><div class="strip strip--stop"><b>Could not answer.</b> ${esc(data.message || "")}</div>${badges(meta)}`;
      } else {
        pending.innerHTML = `<div class="turn__who">Otto</div><div class="card"><div class="md">${md(data.answer)}</div>${badges(meta)}</div>`;
      }
      refreshUsage(); loadConversations();
    } catch (err) {
      pending.innerHTML = `<div class="turn__who">Otto</div><div class="strip strip--stop"><b>Could not reach FactoryPilot.</b> ${esc(err.message)}</div>`;
    } finally {
      busy = false; $("send").disabled = false;
      thread.scrollTop = thread.scrollHeight;
    }
  }

  function renderApproval(host, data, meta) {
    const p = data.pendingAction;
    let args = {};
    try { args = JSON.parse(p.arguments || "{}"); } catch { /* show what we can */ }
    host.innerHTML =
      '<div class="turn__who">Otto</div><div class="approve">' +
        "<h4>Confirmation required</h4>" +
        `<div class="approve__sub">${esc(p.summary || "This write needs your approval.")}</div>` +
        '<dl class="kv">' +
          Object.entries(args).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("") +
        "</dl>" +
        '<div class="acts">' +
          '<button class="btn btn--go" data-ok="1">Approve and run</button>' +
          '<button class="btn btn--ghost" data-ok="0">Reject</button>' +
        "</div>" +
      `</div>${badges(meta)}`;

    host.querySelectorAll("[data-ok]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        host.querySelectorAll("[data-ok]").forEach((b) => (b.disabled = true));
        const approve = btn.dataset.ok === "1";
        try {
          const res = await fetch("../../insights/confirmAction", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ actionID: p.actionID, approve }),
          });
          const out = await res.json().catch(() => ({}));
          if (out.status === "SUCCESS") {
            add(`<div class="turn__who">Otto</div><div class="strip strip--info"><b>${approve ? "Done." : "Rejected."}</b> ${esc(out.answer || "")}</div>`);
          } else {
            add(`<div class="turn__who">Otto</div><div class="strip strip--stop"><b>${esc(out.errorCode || "Refused")}.</b> ${esc(out.message || "")}</div>`);
          }
        } catch (err) {
          add(`<div class="turn__who">Otto</div><div class="strip strip--stop"><b>Could not confirm.</b> ${esc(err.message)}</div>`);
        }
        refreshUsage();
      }));
  }

  // ---------- side panels ----------------------------------------------------
  async function loadConversations() {
    try {
      const res = await fetch("../../insights/Conversations?$orderby=modifiedAt desc&$top=40");
      if (!res.ok) return;
      const rows = (await res.json()).value || [];
      const list = $("convlist");
      if (!rows.length) { list.innerHTML = '<div class="convs__empty">No conversations yet.</div>'; return; }
      list.innerHTML = rows.map((c) => {
        const when = c.modifiedAt ? new Date(c.modifiedAt).toLocaleDateString("en-GB") : "";
        return `<button class="conv ${c.ID === conversationID ? "is-active" : ""}" data-id="${esc(c.ID)}">
                  <div class="conv__title">${esc(c.title || "Untitled")}</div>
                  <div class="conv__meta">${esc(when)}</div>
                </button>`;
      }).join("");
      list.querySelectorAll(".conv").forEach((b) =>
        b.addEventListener("click", () => openConversation(b.dataset.id)));
    } catch { /* the list is navigation, never block the chat on it */ }
  }

  async function openConversation(id) {
    conversationID = id;
    thread.innerHTML = '<div class="turn"><div class="thinking"><i></i><i></i><i></i> Loading…</div></div>';
    try {
      const res = await fetch(`../../insights/Messages?$filter=conversation_ID eq ${id}&$orderby=seq asc&$top=200`);
      const rows = res.ok ? (await res.json()).value || [] : [];
      thread.innerHTML = "";
      const shown = rows.filter((m) => m.role === "user" || (m.role === "assistant" && m.content));
      if (!shown.length) { welcome(); return; }
      for (const m of shown) {
        if (m.role === "user") add(`<div class="turn__who">You</div><div class="bubble-you">${esc(m.content)}</div>`);
        else add(`<div class="turn__who">Otto</div><div class="card"><div class="md">${md(m.content)}</div></div>`);
      }
      loadConversations();
    } catch {
      thread.innerHTML = "";
      add('<div class="strip strip--warn">Could not load that conversation.</div>');
    }
  }

  async function refreshUsage() {
    try {
      const res = await fetch("../../odata/token/myUsage()");
      if (!res.ok) return;
      const u = await res.json();
      const used = u.usedDay ?? 0, limit = u.limitDay;
      $("usednum").textContent = used.toLocaleString();
      $("limitnum").textContent = limit == null ? "∞" : limit.toLocaleString();
      $("usedbar").style.width = limit ? Math.min(100, (used / limit) * 100) + "%" : "0%";
      $("bellcount").textContent = limit == null ? 0 : Math.max(0, limit - used);
      if (u.userID) $("orgname").textContent = u.userID;
    } catch { /* decoration */ }
  }

  async function checkConnection() {
    try {
      const res = await fetch("../../insights/health()");
      if (!res.ok) throw new Error(String(res.status));
      const h = JSON.parse((await res.json()).value ?? "{}");
      // Say which it is. A page that claims "Connected" while replaying
      // fixtures is the one sentence in this UI that could mislead a room.
      if (h.demoMode) {
        $("conndot").className = "dot dot--warn";
        $("conntext").textContent = "Demo data";
        $("conn").title = "Answers are replayed from synthetic fixtures, not a live SAP system.";
      } else {
        $("conndot").className = "dot";
        $("conntext").textContent = "Connected";
        $("conn").title = "Live SAP · model: " + (h.provider || "unknown");
      }
    } catch {
      $("conndot").className = "dot dot--off";
      $("conntext").textContent = "Offline";
    }
  }

  // ---------- wiring ---------------------------------------------------------
  const box = $("q");
  box.addEventListener("input", () => {
    box.style.height = "auto";
    box.style.height = Math.min(150, box.scrollHeight) + "px";
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  function submit() {
    const v = box.value.trim();
    if (!v) return;
    box.value = ""; box.style.height = "auto";
    ask(v);
  }
  $("send").addEventListener("click", submit);
  $("newchat").addEventListener("click", () => { conversationID = null; welcome(); loadConversations(); });
  $("srcbtn").addEventListener("click", () => { location.href = "../integrationendpoints/index.html"; });
  document.querySelectorAll(".lang button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".lang button").forEach((x) => {
        x.classList.toggle("is-active", x === b);
        x.setAttribute("aria-pressed", String(x === b));
      });
    }));

  welcome();
  checkConnection();
  refreshUsage();
  loadConversations();
})();
