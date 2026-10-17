/* SupplyNow Order Dash: order verification layer (one file for the sandbox and the live app).

   Tap an order on the run sheet (or the location list in Run sheet mode) and it opens line by line:
   bin, item #, UPC, description, quantity and unit, in the RD pick-list order. For each line the
   selector confirms the quantity (exact, less or more) and scans the UPC with the phone camera.
   A scan that doesn't match the expected UPC, or a short/over quantity, is an exception.

   Loaded before the app's main script, so it only defines functions here; everything that touches
   the app's globals (ORDERS, state, loadedDate, show, markDone...) runs later, at call time.

   Config comes from window.CART_VERIFY, set in index.html before this file loads:
     sandbox  { mode: "sandbox", api: "api/" }          tailnet copy; always on; Tailscale is the gate
     live     { mode: "prod", api: "<ngrok>/cart/", rollout: "off" | "on" }
              On only for a phone set up from the tailnet-only setup QR (the key arrives in the link's
              #k= fragment and is kept in localStorage), and only when rollout is "on" or that phone
              opted in with ?verify=on. Otherwise the app behaves exactly as before.
   The server (server.py in the private supplynow-cart-labels-dev repo) reads rd_orders read-only and
   writes checks and photos to its own database. */
const VERIFY = (() => {
  const CFG = Object.assign({ mode: "sandbox", api: "api/", rollout: "off" }, window.CART_VERIFY || {});
  const PROD = CFG.mode === "prod";
  const KEYLESS = !!CFG.keyless;   // Cloudflare copy: Access gates the page, and its /cart/ proxy adds the key
  const API = CFG.api;
  const SRC_KEY = "sn_dev_source", WHO_KEY = "sn_verify_who", QUEUE_KEY = "sn_verify_queue";
  const KEY_KEY = "sn_verify_key", DEVICE_KEY = "sn_verify_device";
  const SCANNER_LIB = "https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js";
  const S = { cur: null, summary: {}, summaryAt: {}, scan: null, scanner: null, fileScanner: null,
              lastCode: "", lastAt: 0, log: [], photos: {} };

  /* ---------- small helpers (the app's own helpers load after this file) ---------- */
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  };
  const el = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtQty = n => n == null || isNaN(n) ? "—" : (Math.round(n * 100) / 100).toString();
  function headers() {
    return PROD && !KEYLESS ? { "X-Cart-Key": ls.get(KEY_KEY, ""), "ngrok-skip-browser-warning": "1" } : {};
  }
  async function getJSON(path) { const r = await fetch(API + path, { cache: "no-store", headers: headers() }); return r.json(); }
  async function postJSON(path, body) {
    const r = await fetch(API + path, { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, headers()), body: JSON.stringify(body) });
    return r.json();
  }
  function source() { return PROD ? "live" : ls.get(SRC_KEY, "live"); }

  /* ---------- live app: device setup + on/off switch ---------- */
  (function readSetupLink() {
    if (!PROD) return;
    try {
      const m = location.hash.match(/(?:^#|&)k=([A-Za-z0-9_-]{20,})/);
      if (m) ls.set(KEY_KEY, m[1]);
      const q = new URLSearchParams(location.search), v = q.get("verify");
      if (v === "on" || v === "off") ls.set(DEVICE_KEY, v);
      if (m || v) {                       // keep the key out of the address bar and history
        q.delete("verify");
        history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : ""));
      }
    } catch (e) {}
  })();
  function enabled() {
    if (!PROD) return true;
    const device = ls.get(DEVICE_KEY, "");
    return (KEYLESS || !!ls.get(KEY_KEY, "")) && (device === "on" || (CFG.rollout === "on" && device !== "off"));
  }
  function who() {
    let w = ls.get(WHO_KEY, "") || S.user;
    if (!w) { w = (prompt("Your name, for the verification log:") || "").trim() || "unknown"; ls.set(WHO_KEY, w); }
    return w;
  }
  function batchDate() { return (typeof loadedDate !== "undefined" && loadedDate) || $("#date").value; }

  /* ---------- UPC matching ----------
     RD stores UPCs without leading zeros and without the check digit (Duke's mayo = 5250006010).
     A camera read gives the full code: UPC-A (12), EAN-13, UPC-E (8) or a case GTIN-14. */
  const digits = s => String(s || "").replace(/\D/g, "");
  const strip0 = s => s.replace(/^0+/, "");
  function upcEtoA(e) {
    if (e.length !== 8) return null;
    const ns = e[0], d = e.slice(1, 7), chk = e[7];
    let m;
    if ("012".includes(d[5])) m = d[0] + d[1] + d[5] + "0000" + d[2] + d[3] + d[4];
    else if (d[5] === "3") m = d[0] + d[1] + d[2] + "00000" + d[3] + d[4];
    else if (d[5] === "4") m = d[0] + d[1] + d[2] + d[3] + "00000" + d[4];
    else m = d[0] + d[1] + d[2] + d[3] + d[4] + "0000" + d[5];
    return ns + m + chk;
  }
  function upcKeys(raw) {
    const s = digits(raw), out = new Set();
    if (!s) return out;
    if (s.length === 8) { const a = upcEtoA(s); if (a) { out.add(strip0(a)); out.add(strip0(a.slice(0, -1))); } }
    out.add(strip0(s));
    if (s.length >= 8) out.add(strip0(s.slice(0, -1)));          // drop the check digit
    if (s.length === 14) out.add(strip0(s.slice(1, -1)));         // case GTIN-14: drop packing indicator + check
    out.delete("");
    return out;
  }
  function upcMatch(scanned, expected) {
    const ex = strip0(digits(expected));
    if (!ex) return false;
    const keys = upcKeys(scanned);
    if (keys.has(ex)) return true;
    if (ex.length >= 12 && keys.has(strip0(ex.slice(0, -1)))) return true;   // stored value kept its check digit
    return false;
  }

  /* ---------- data source: live feed (identical to production) or the warehouse by date ---------- */
  async function loadWarehouse(iso) {
    loadStatus = "loading"; renderLocations();
    try {
      const r = await getJSON("orders?date=" + encodeURIComponent(iso || todayISO()));
      if (!r.ok) throw new Error(r.error || "warehouse error");
      buildFromFeed(r); loadStatus = "ok";
    } catch (e) { ORDERS = {}; LOCATIONS = []; loadStatus = "error"; console.warn("warehouse load failed:", e); }
  }
  function setSource(src) {
    ls.set(SRC_KEY, src);
    document.querySelectorAll("#sbx [data-src]").forEach(b => b.classList.toggle("on", b.dataset.src === src));
    S.summary = {}; S.summaryAt = {};
    show("loc"); reload();
  }

  /* ---------- badges on the order list and run sheet ---------- */
  function badgeHtml(s) {
    if (!s) return "";
    if (s.exceptions) return `<span class="vbadge exc">${s.complete}/${s.total} · ${s.exceptions} exc</span>`;
    if (s.complete >= s.total && s.total) return `<span class="vbadge full">${s.total}/${s.total} ✓</span>`;
    return `<span class="vbadge part">${s.complete}/${s.total}</span>`;
  }
  function badge(ord) {
    return `<span data-vb="${esc(ord.id)}">${badgeHtml(S.summary[ord.id])}</span>`;
  }
  async function syncBadges(orders) {
    const ids = (orders || []).map(o => o.id).filter(id => id && Date.now() - (S.summaryAt[id] || 0) > 15000);
    if (!ids.length) return;
    ids.forEach(id => S.summaryAt[id] = Date.now());
    try {
      const r = await getJSON(`summary?date=${encodeURIComponent(batchDate())}&ids=${ids.map(encodeURIComponent).join(",")}`);
      if (!r.ok) return;
      ids.forEach(id => { S.summary[id] = r.summary[id]; });
      document.querySelectorAll("[data-vb]").forEach(n => { n.innerHTML = badgeHtml(S.summary[n.dataset.vb]); });
    } catch (e) { /* badges are a convenience; the list works without them */ }
  }

  /* ---------- open an order ---------- */
  async function openOrder(uid, from) {
    const ord = (ORDERS[String(uid).split(":")[0]] || []).find(x => x._uid === uid);   // any depot, not just the open one
    if (!ord) return;
    S.cur = { uid, from, ord, data: null, err: null, filter: "all", sort: "bin", adj: null, confirm: false };
    show("verify"); document.body.classList.add("verifying"); render();
    try {
      const r = await getJSON(`order?id=${encodeURIComponent(ord.id)}&date=${encodeURIComponent(batchDate())}`);
      if (S.cur && S.cur.uid === uid) { if (r.ok) S.cur.data = r; else S.cur.err = r.detail || r.error || "Couldn't load this order."; }
    } catch (e) {
      if (S.cur) S.cur.err = PROD ? "Couldn't reach order verification. Check the connection, or go back and tap the box to mark this order picked."
                                  : "Couldn't reach the sandbox server. Check that you're on Tailscale.";
    }
    if (S.admin == null) {             // whoami: admins (Mike, Melissa, Ed) get the add-on form
      S.admin = false;
      getJSON("whoami").then(r => { S.admin = !!(r && r.admin); S.user = (r && r.user) || ""; render(); }).catch(() => {});
    }
    flushQueue().then(render);
  }
  function back() {
    closeScanner();
    const from = S.cur && S.cur.from;
    if (S.cur && S.cur.ord) delete S.summaryAt[S.cur.ord.id];
    S.cur = null;
    document.body.classList.remove("verifying");
    if (from === "ops") { show("ops"); renderOps(); } else { show("list"); renderList(); }
  }

  function photoSrc(name) {            // the live app needs the key header, so photos come as blobs
    if (!name) return "";
    if (!PROD) return API + "photo/" + name;
    if (S.photos[name]) return S.photos[name] === "loading" ? "" : S.photos[name];
    S.photos[name] = "loading";
    fetch(API + "photo/" + name, { headers: headers() }).then(r => r.ok ? r.blob() : null)
      .then(b => { if (b) { S.photos[name] = URL.createObjectURL(b); render(); } else delete S.photos[name]; })
      .catch(() => { delete S.photos[name]; });
    return "";
  }

  /* ---------- per-line state ---------- */
  const isScanned = c => c.scan_status === "match" || c.scan_status === "manual";
  function check(line) { return (S.cur.data.checks[String(line)] = S.cur.data.checks[String(line)] || {}); }
  function lineOf(n) { return S.cur.data.lines.find(l => l.line === n); }
  function lineClass(c) {
    if (c.scan_status === "mismatch") return "st-bad";
    if (c.qty_status === "less") return "st-less";
    if (c.qty_status === "more") return "st-more";
    if (c.qty_status === "ok") return "st-ok";
    return "";
  }
  // done = quantity confirmed and item scanned; an out-of-stock line (less, 0) has nothing to scan
  const isComplete = c => !!c.qty_status && (isScanned(c) || (c.qty_status === "less" && Number(c.actual_qty) === 0));
  const isException = c => c.qty_status === "less" || c.qty_status === "more" || c.scan_status === "mismatch";
  function summary() {
    const L = S.cur.data.lines, out = { total: L.length, qty: 0, scanned: 0, complete: 0, clean: 0, exceptions: 0 };
    L.forEach(l => {
      const c = S.cur.data.checks[String(l.line)] || {};
      if (c.qty_status) out.qty++;
      if (isScanned(c)) out.scanned++;
      if (isComplete(c)) out.complete++;
      if (isException(c)) out.exceptions++;
      if (isComplete(c) && !isException(c)) out.clean++;
    });
    return out;
  }
  function unitOf(l) { return l.qty_unit || l.unit || ""; }

  /* ---------- saving (optimistic; queued on the phone if the server can't be reached) ---------- */
  async function save(line, fields) {
    const c = check(line);
    Object.assign(c, fields);
    if (fields.photo_b64) { c.photo_local = fields.photo_b64; delete c.photo_b64; }
    render();
    const body = Object.assign({ order: S.cur.data.order.order_number, line, who: who() }, fields);
    await flushQueue();
    try {
      const r = await postJSON("verify", body);
      if (!r.ok) throw new Error(r.error);
      Object.assign(c, r.check);
      if (r.check.photo) delete c.photo_local;
    } catch (e) { queuePush(body); }
    render();
  }
  function queuePush(body) {
    const q = ls.get(QUEUE_KEY, []);
    q.push(body);
    if (!ls.set(QUEUE_KEY, q.slice(-40))) { delete body.photo_b64; ls.set(QUEUE_KEY, q.slice(-40)); }
  }
  async function flushQueue() {
    const q = ls.get(QUEUE_KEY, []);
    if (!q.length) return;
    const left = [];
    for (const b of q) { try { const r = await postJSON("verify", b); if (!r.ok) left.push(b); } catch (e) { left.push(b); } }
    ls.set(QUEUE_KEY, left);
  }

  /* ---------- quantity: exact / less / more ---------- */
  function qtyOk(line) {
    const l = lineOf(line), c = check(line);
    if (c.qty_status === "ok") return save(line, { qty_status: null, actual_qty: null });
    S.cur.adj = null;
    return save(line, { qty_status: "ok", actual_qty: l.qty });
  }
  function qtyAdj(line, kind) {
    const l = lineOf(line), c = check(line);
    const start = c.qty_status === kind && c.actual_qty != null ? c.actual_qty
      : kind === "less" ? Math.max(0, (l.qty || 0) - 1) : (l.qty || 0) + 1;
    S.cur.adj = { line, kind, val: start, reason: c.qty_status === kind ? (c.note || "") : "" };
    render();
    const i = el("adjVal"); if (i) i.focus();
  }
  function adjStep(d) { const a = S.cur.adj; a.val = Math.max(0, Math.round(((Number(a.val) || 0) + d) * 100) / 100); render(); }
  function adjInput(v) { S.cur.adj.val = v; }
  function adjReason(r) { const a = S.cur.adj; a.reason = a.reason === r ? "" : r; render(); }
  function adjCancel() { S.cur.adj = null; render(); }
  function adjSave() {
    const a = S.cur.adj, l = lineOf(a.line), v = Number(a.val);
    if (isNaN(v) || v < 0) { alert("Enter the quantity you actually have."); return; }
    S.cur.adj = null;
    const status = v === l.qty ? "ok" : v < l.qty ? "less" : "more";
    return save(a.line, { qty_status: status, actual_qty: v, note: status === "ok" ? null : (a.reason || null) });
  }

  /* ---------- order picked ---------- */
  function exceptionsList() {
    return S.cur.data.lines.map(l => ({ l, c: S.cur.data.checks[String(l.line)] || {} }))
      .filter(x => isException(x.c))
      .map(({ l, c }) => ({ line: l.line, item: l.item, desc: l.desc, ordered: l.qty, actual: c.actual_qty,
        qty_status: c.qty_status, scan_status: c.scan_status, scanned_code: c.scanned_code, note: c.note }));
  }
  function isMarkedDone() {
    const uid = S.cur.uid;
    if (S.cur.from === "ops") { const rs = runGet(state.opsLoc); return !!(rs[uid] && rs[uid].done); }
    return !!state.done[uid];
  }
  async function markPicked(force) {
    const s = summary();
    if (!force && s.complete < s.total) { S.cur.confirm = true; render(); return; }
    const uid = S.cur.uid;
    if (S.cur.from === "ops") { const rs = runGet(state.opsLoc); rs[uid] = rs[uid] || {}; rs[uid].done = true; lsSet(runKey(state.opsLoc), rs); }
    else if (!state.done[uid]) markDone(uid);          // pings dispatch; the sandbox logs it instead
    try { await postJSON("order_done", { order: S.cur.data.order.order_number, who: who(), summary: Object.assign(s, { exception_lines: exceptionsList() }) }); } catch (e) {}
    back();
  }
  async function undoPicked() {
    const uid = S.cur.uid;
    if (S.cur.from === "ops") { const rs = runGet(state.opsLoc); if (rs[uid]) { rs[uid].done = false; lsSet(runKey(state.opsLoc), rs); } }
    else if (state.done[uid]) markDone(uid);           // un-tick: the app sends no ping
    try { await postJSON("order_done", { order: S.cur.data.order.order_number, undo: true }); } catch (e) {}
    S.cur.data.done = null; render();
  }

  /* ---------- render the order screen ---------- */
  const CAM = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7h3l2-3h8l2 3h3v13H3z"/><circle cx="12" cy="13" r="4"/></svg>`;
  function setFilter(f) { S.cur.filter = f; render(); }
  function setSort(s) { S.cur.sort = s; render(); }

  function lineHtml(l) {
    const c = S.cur.data.checks[String(l.line)] || {};
    const unit = unitOf(l), upc = String(l.upc || "");
    const chips = [];
    if (c.qty_status === "ok") chips.push(`<span class="chip ok">Qty ✓ ${fmtQty(c.actual_qty)}</span>`);
    if (c.qty_status === "less") chips.push(`<span class="chip less">Short · ${fmtQty(c.actual_qty)} of ${fmtQty(l.qty)}</span>`);
    if (c.qty_status === "more") chips.push(`<span class="chip more">Over · ${fmtQty(c.actual_qty)} of ${fmtQty(l.qty)}</span>`);
    if (c.scan_status === "match") chips.push(`<span class="chip ok">UPC ✓ scanned</span>`);
    if (c.scan_status === "manual") chips.push(`<span class="chip ok">UPC ✓ typed</span>`);
    if (c.scan_status === "mismatch") chips.push(`<span class="chip bad">UPC ✗ ${esc(c.scanned_code || "")}</span>`);
    if (c.scan_status === "photo") chips.push(`<span class="chip">Photo only, not read</span>`);
    if (c.note && c.qty_status !== "ok") chips.push(`<span class="chip">${esc(c.note)}</span>`);
    const src = c.photo_local || photoSrc(c.photo);
    if (src) chips.push(`<a href="${esc(src)}" target="_blank" rel="noopener"><img class="thumb" src="${esc(src)}" alt="Scan photo, line ${l.line}"></a>`);
    const a = S.cur.adj && S.cur.adj.line === l.line ? S.cur.adj : null;
    const reasons = a ? (a.kind === "less" ? ["Out of stock", "Short on shelf", "Damaged", "Substituted"] : ["Customer asked", "Pack size", "Substituted"]) : [];
    return `<div class="ln ${lineClass(c)}${isComplete(c) ? " complete" : ""}" id="ln-${l.line}">
      <div class="lnhead"><span class="bin">BIN ${esc(l.bin || "—")}</span><span>#${esc(l.item)}</span>
        <span class="upc">UPC ${esc(upc.slice(0, -5))}<b>${esc(upc.slice(-5))}</b></span></div>
      <div class="lnitem">${l.img ? `<button class="lnimg" onclick="VERIFY.showImg(${l.line})" aria-label="Show photo of ${esc(l.desc)}"><img src="${esc(l.img)}" alt="" loading="lazy"></button>` : ""}
        <div class="lndesc">${esc(l.desc)}</div></div>
      ${l.note ? `<div class="lnsub">${esc(l.note)}</div>` : ""}
      ${l.addon ? `<div class="lnsub addon">ADD-ON · added by ${esc(l.added_by || "—")}${l.requested_by ? ` · for ${esc(l.requested_by)}` : ""}${S.admin ? ` <button class="addon-x" onclick="VERIFY.removeAddon(${l.addon_id})">Remove</button>` : ""}</div>` : ""}
      <div class="lnrow">
        <div class="lnqty"><b>${fmtQty(l.qty)}</b><span>${esc(unit)}</span></div>
        <div class="lnacts">
          <button class="ok${c.qty_status === "ok" ? " on" : ""}" onclick="VERIFY.qtyOk(${l.line})" aria-label="Quantity matches, ${fmtQty(l.qty)}">✓ ${fmtQty(l.qty)}</button>
          <button class="less${c.qty_status === "less" ? " on" : ""}" onclick="VERIFY.qtyAdj(${l.line},'less')" aria-label="Less than ordered">&lt; Less</button>
          <button class="more${c.qty_status === "more" ? " on" : ""}" onclick="VERIFY.qtyAdj(${l.line},'more')" aria-label="More than ordered">&gt; More</button>
          <button class="cam${isScanned(c) ? " on" : c.scan_status === "mismatch" ? " bad" : ""}" onclick="VERIFY.scanLine(${l.line})" aria-label="Scan UPC barcode">${CAM}</button>
        </div>
      </div>
      ${a ? `<div class="adj">
        <div class="row"><span class="lbl">${a.kind === "less" ? "Actual (less than" : "Actual (more than"} ${fmtQty(l.qty)})</span></div>
        <div class="row">
          <button class="step" onclick="VERIFY.adjStep(-1)" aria-label="One less">−</button>
          <input id="adjVal" type="number" inputmode="decimal" min="0" step="any" value="${esc(a.val)}" oninput="VERIFY.adjInput(this.value)">
          <button class="step" onclick="VERIFY.adjStep(1)" aria-label="One more">+</button>
          <span class="lbl">${esc(unit)}</span>
          <button class="save" onclick="VERIFY.adjSave()">Save</button>
        </div>
        <div class="reasons">${reasons.map(r => `<button class="${a.reason === r ? "on" : ""}" onclick="VERIFY.adjReason('${r}')">${r}</button>`).join("")}
          <button onclick="VERIFY.adjCancel()">Cancel</button></div>
      </div>` : ""}
      ${chips.length ? `<div class="lnstat">${chips.join("")}</div>` : ""}
    </div>`;
  }

  function render() {
    const host = el("screenVerify");
    if (!host || !S.cur) return;
    const o = S.cur.ord;
    const d = S.cur.data;
    const head = `<div class="vhead"><button class="back" onclick="VERIFY.back()">‹ Back</button>
      <div><div class="eyebrow" style="margin:0 0 2px">Pick order</div><div class="ltitle">${esc(o.acct)}</div>
      <div class="lcount">${esc(o.win || "—")} · ${esc(o.type.toUpperCase())} · ${esc(o._tag || "")}${d ? ` · #${esc(d.order.order_number)}` : ""}</div></div></div>`;
    if (!d) {
      host.innerHTML = head + `<div class="vmsg">${S.cur.err ? esc(S.cur.err) : "Pulling the order lines…"}</div>`;
      return;
    }
    const s = summary();
    const pc = s.total ? Math.round(100 * s.clean / s.total) : 0;      // green: verified, no exception
    const px = s.total ? Math.round(100 * s.exceptions / s.total) : 0;
    let lines = d.lines.slice();
    if (S.cur.sort === "bin") lines.sort((a, b) => ((parseInt(a.bin, 10) || 1e9) - (parseInt(b.bin, 10) || 1e9)) || (a.line - b.line));
    if (S.cur.filter === "todo") lines = lines.filter(l => !isComplete(d.checks[String(l.line)] || {}));
    if (S.cur.filter === "exc") lines = lines.filter(l => isException(d.checks[String(l.line)] || {}));
    const done = isMarkedDone() || !!d.done;
    const pending = ls.get(QUEUE_KEY, []).length;
    host.innerHTML = head + `
      <div class="vprog">
        <div class="vbar" role="img" aria-label="${s.complete} of ${s.total} lines picked"><i class="c" style="width:${pc}%"></i><i class="x" style="width:${px}%"></i></div>
        <div class="vstats">
          <div><b>${s.complete}/${s.total}</b><span>picked</span></div>
          <div><b>${s.qty}</b><span>qty</span></div>
          <div><b>${s.scanned}</b><span>scanned</span></div>
          <div class="exc"><b>${s.exceptions}</b><span>exceptions</span></div>
        </div>
      </div>
      <div class="vactions"><button class="vscanall" onclick="VERIFY.scanAll()">${CAM} Start picking</button>
        ${S.admin ? `<button class="vaddon" onclick="VERIFY.addonOpen()">+ Add-on</button>` : ""}</div>
      ${S.cur.addon ? addonForm() : ""}
      <div class="vtools">
        <div class="seg">
          <button class="${S.cur.filter === "all" ? "on" : ""}" onclick="VERIFY.setFilter('all')">All ${s.total}</button>
          <button class="${S.cur.filter === "todo" ? "on" : ""}" onclick="VERIFY.setFilter('todo')">To do ${s.total - s.complete}</button>
          <button class="${S.cur.filter === "exc" ? "on" : ""}" onclick="VERIFY.setFilter('exc')">Exceptions ${s.exceptions}</button>
        </div>
        <div class="seg">
          <button class="${S.cur.sort === "bin" ? "on" : ""}" onclick="VERIFY.setSort('bin')">Bin</button>
          <button class="${S.cur.sort === "line" ? "on" : ""}" onclick="VERIFY.setSort('line')">Line</button>
        </div>
      </div>
      <p class="vnote">A line is picked once its quantity is confirmed and its UPC is scanned. ${d.matched_from ? "Matched from the live feed's rounded order number." : ""}</p>
      ${lines.length ? lines.map(lineHtml).join("") : `<div class="vmsg">${S.cur.filter === "exc" ? "No exceptions on this order." : "Every line is picked."}</div>`}
      <div class="vfoot">
        ${S.cur.confirm && !done ? `<div class="vconfirm"><b>${s.total - s.complete} of ${s.total} lines aren't picked yet.</b> Mark this order picked anyway?
          <div class="row"><button onclick="VERIFY.cancelConfirm()">Keep picking</button><button class="go" onclick="VERIFY.markPicked(true)">Mark picked</button></div></div>` : ""}
        ${done ? `<button class="isdone" onclick="VERIFY.undoPicked()">Picked ✓ · tap to undo</button>`
               : `<button class="${s.complete === s.total && s.total ? "ready" : ""}" onclick="VERIFY.markPicked(false)">Mark order picked${s.exceptions ? ` · ${s.exceptions} exception${s.exceptions > 1 ? "s" : ""}` : ""}</button>`}
        ${pending ? `<div class="vpend">${pending} check${pending > 1 ? "s" : ""} saved on this phone, will sync when the connection is back</div>` : ""}
      </div>`;
  }
  function cancelConfirm() { S.cur.confirm = false; render(); }

  /* ---------- add-ons: admins (Mike, Melissa, Ed) add lines after the RD order came in ---------- */
  function addonForm() {
    const a = S.cur.addon, f = (k, label, extra = "") =>
      `<label>${label}<input id="ao_${k}" value="${esc(a[k])}" oninput="VERIFY.addonField('${k}', this.value)" ${extra}></label>`;
    return `<div class="aoform">
      <div class="ao-h">Add-on to this order</div>
      <div class="row"><input id="ao_item" placeholder="Item # or name" value="${esc(a.item)}" oninput="VERIFY.addonField('item', this.value)"
        onkeydown="if(event.key==='Enter')VERIFY.addonLookup()"><button onclick="VERIFY.addonLookup()">Look up</button></div>
      ${a.results.length ? `<div class="ao-res">${a.results.map((it, i) => `<button onclick="VERIFY.addonPick(${i})">${it.img ? `<img src="${esc(it.img)}" alt="">` : ""}
        <span><b>#${esc(it.item)}</b> ${esc(it.desc)}<br><small>UPC ${esc(it.upc)} · BIN ${esc(it.bin || "?")}</small></span></button>`).join("")}</div>` : ""}
      ${a.img ? `<img class="ao-img" src="${esc(a.img)}" alt="">` : ""}
      ${f("desc", "Description")}
      <div class="row">${f("upc", "UPC", 'inputmode="numeric"')}${f("bin", "Bin", 'inputmode="numeric"')}</div>
      <div class="row">${f("qty", "Quantity", 'type="number" inputmode="decimal" min="0" step="any"')}
        <label>Unit<select id="ao_unit" onchange="VERIFY.addonField('unit', this.value)">${["Unit", "Case", "lb"].map(u => `<option${a.unit === u ? " selected" : ""}>${u}</option>`).join("")}</select></label></div>
      ${f("requested_by", "Requested by", 'placeholder="Customer, rep, who called"')}
      ${f("note", "Note (optional)")}
      ${a.err ? `<div class="ao-err">${esc(a.err)}</div>` : ""}
      <div class="row"><button onclick="VERIFY.addonClose()">Cancel</button><button class="go" onclick="VERIFY.addonSave()" ${a.saving ? "disabled" : ""}>${a.saving ? "Adding…" : "Add to order"}</button></div>
    </div>`;
  }
  function addonOpen() {
    S.cur.addon = { item: "", desc: "", upc: "", bin: "", img: "", qty: 1, unit: "Unit", requested_by: "", note: "", results: [], err: "" };
    render(); setTimeout(() => { const i = el("ao_item"); if (i) i.focus(); }, 0);
  }
  function addonClose() { S.cur.addon = null; render(); }
  function addonField(k, v) { if (S.cur && S.cur.addon) S.cur.addon[k] = v; }
  async function addonLookup() {
    const a = S.cur.addon, q = String(a.item || "").trim();
    if (!q) return;
    a.err = ""; a.results = []; render();
    try {
      const r = await getJSON(`addon_lookup?q=${encodeURIComponent(q)}&store=${encodeURIComponent(S.cur.data.order.store_key || "")}`);
      a.results = (r && r.items) || [];
      if (a.results.length === 1) return addonPick(0);
      if (!a.results.length) a.err = "No match in the catalog. Fill the fields in by hand.";
    } catch (e) { a.err = "Lookup failed. Fill the fields in by hand."; }
    render();
  }
  function addonPick(i) {
    const a = S.cur.addon, it = a.results[i];
    Object.assign(a, { item: it.item, desc: it.desc, upc: it.upc, bin: it.bin || a.bin, img: it.img || "", results: [], err: it.bin ? "" : "No bin on file for this depot. Enter it." });
    render();
  }
  async function addonSave() {
    const a = S.cur.addon;
    const miss = [["item", "Item #"], ["desc", "Description"], ["upc", "UPC"], ["bin", "Bin"], ["requested_by", "Requested by"]]
      .filter(([k]) => !String(a[k] || "").trim()).map(x => x[1]);
    if (!(Number(a.qty) > 0)) miss.push("Quantity");
    if (miss.length) { a.err = "Required: " + miss.join(", "); return render(); }
    a.err = ""; a.saving = true; render();
    let r = null;
    try {
      r = await postJSON("addon", { order: S.cur.data.order.order_number, item: a.item.trim(), desc: a.desc.trim(), upc: a.upc.trim(),
        bin: a.bin.trim(), img: a.img, qty: Number(a.qty), unit: a.unit, requested_by: a.requested_by.trim(), note: a.note.trim(), who: who() });
    } catch (e) {}
    if (!r || !r.ok) { a.saving = false; a.err = (r && r.error) || "Couldn't save the add-on. Check the connection."; return render(); }
    S.cur.data.lines.push(r.line); S.cur.addon = null; render();
    const n = el("ln-" + r.line.line); if (n) { n.classList.add("flash"); n.scrollIntoView({ block: "center" }); }
  }
  async function removeAddon(id) {
    if (!confirm("Remove this add-on from the order?")) return;
    let r = null;
    try { r = await postJSON("addon_remove", { order: S.cur.data.order.order_number, id, who: who() }); } catch (e) {}
    if (r && r.ok) { S.cur.data.lines = S.cur.data.lines.filter(l => l.addon_id !== id); render(); }
    else alert((r && r.error) || "Couldn't remove the add-on.");
  }

  /* ---------- guided pick: camera on top, one item card below, walking the order in bin order ---------- */
  let actx = null;
  function beep(ok) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = ok ? "sine" : "square"; o.frequency.value = ok ? 1046 : 220; g.gain.value = 0.08;
      o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + (ok ? 0.12 : 0.35));
    } catch (e) {}
    if (navigator.vibrate) navigator.vibrate(ok ? 40 : [80, 60, 80]);
  }
  function grabFrame() {
    const v = document.querySelector("#scanView video");
    if (!v || !v.videoWidth) return null;
    const W = Math.min(960, v.videoWidth), H = Math.round(v.videoHeight * W / v.videoWidth);
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    c.getContext("2d").drawImage(v, 0, 0, W, H);
    return c.toDataURL("image/jpeg", 0.62);
  }
  function fileToJpeg(file, max = 1280) {
    return new Promise(res => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas"); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); res(c.toDataURL("image/jpeg", 0.7));
      };
      img.onerror = () => { URL.revokeObjectURL(url); res(null); };
      img.src = url;
    });
  }
  function formats() {
    const F = window.Html5QrcodeSupportedFormats;
    return F ? [F.UPC_A, F.UPC_E, F.EAN_13, F.EAN_8, F.ITF, F.CODE_128, F.CODE_39] : undefined;
  }
  function loadScannerLib() {           // 375 KB, so it loads on first scan rather than with the app
    if (window.Html5Qrcode) return Promise.resolve(true);
    if (S.libLoading) return S.libLoading;
    S.libLoading = new Promise(res => {
      const t = document.createElement("script");
      t.src = SCANNER_LIB; t.onload = () => res(true); t.onerror = () => { S.libLoading = null; res(false); };
      document.head.appendChild(t);
    });
    return S.libLoading;
  }
  const binNum = l => parseInt(l.bin, 10) || 1e9;
  function walkOrder() { return S.cur.data.lines.slice().sort((a, b) => (binNum(a) - binNum(b)) || (a.line - b.line)); }
  function nextLine(after) {            // next line that isn't done, in walk order, wrapping around
    const L = walkOrder(), i = after == null ? -1 : L.findIndex(l => l.line === after);
    for (let k = 1; k <= L.length; k++) { const l = L[(i + k + L.length) % L.length]; if (!isComplete(check(l.line))) return l.line; }
    return null;
  }
  async function wakeLock(on) {         // keep the screen on while picking
    try {
      if (on && navigator.wakeLock && !S.wake) S.wake = await navigator.wakeLock.request("screen");
      if (!on && S.wake) { await S.wake.release(); S.wake = null; }
    } catch (e) {}
  }
  async function openScanner(ctx) {
    if (!S.cur || !S.cur.data) return;
    const start = ctx && ctx.line != null ? ctx.line : nextLine(null);
    S.scan = { line: start, status: "ready", msg: "", code: "", photo: null, adj: null };
    S.lastCode = ""; S.lastAt = 0;
    el("scanSheet").classList.remove("hidden");
    renderPick(); wakeLock(true);
    if (!(await loadScannerLib())) return setPick("bad", "The scanner didn't load. Check the connection, or use Type last 5.");
    try {
      S.scanner = new Html5Qrcode("scanView", { formatsToSupport: formats(), verbose: false,
        useBarCodeDetectorIfSupported: true, experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
      await S.scanner.start({ facingMode: "environment" },
        { fps: 15, aspectRatio: 1.6, disableFlip: true,
          qrbox: (w, h) => ({ width: Math.floor(w * 0.94), height: Math.max(70, Math.floor(h * 0.55)) }) },
        text => onDecoded(text, grabFrame(), "camera"), () => {});
      torchSetup();
    } catch (e) {
      S.scanner = null;
      setPick("bad", `Camera unavailable (${(e && e.message) || e}). Allow camera access for this site, or use Type last 5.`);
    }
  }
  function torchSetup() {
    const b = el("torchBtn"); if (!b) return;
    let ok = false;
    try { ok = S.scanner.getRunningTrackCameraCapabilities().torchFeature().isSupported(); } catch (e) {}
    b.hidden = !ok;
  }
  async function torch() {
    try {
      S.torch = !S.torch;
      await S.scanner.getRunningTrackCameraCapabilities().torchFeature().apply(S.torch);
      el("torchBtn").classList.toggle("on", S.torch);
    } catch (e) {}
  }
  async function closeScanner() {
    const sheet = el("scanSheet"); if (sheet) sheet.classList.add("hidden");
    const sc = S.scanner; S.scanner = null; S.scan = null; S.torch = false; wakeLock(false);
    if (sc) { try { await sc.stop(); } catch (e) {} try { sc.clear(); } catch (e) {} }
    if (S.cur) render();
  }
  function setPick(kind, msg) { if (!S.scan) return; S.scan.status = kind; S.scan.msg = msg; renderPick(); }

  function renderPick() {
    const host = el("pickCard"); if (!host || !S.scan || !S.cur || !S.cur.data) return;
    const s = summary();
    el("pickProg").innerHTML = `<b>${s.complete}/${s.total}</b> picked${s.exceptions ? ` · <span class="pex">${s.exceptions} exception${s.exceptions > 1 ? "s" : ""}</span>` : ""}`;
    if (S.scan.line == null) {
      host.className = "pickcard ok";
      host.innerHTML = `<div class="pc-big">✓ Every line is picked</div><p class="pc-msg">Tap Done, look over the order, then Mark order picked.</p>`;
      return;
    }
    const l = lineOf(S.scan.line), c = check(l.line), unit = unitOf(l), upc = String(l.upc || "");
    const scanned = isScanned(c), bad = S.scan.status === "bad", a = S.scan.adj;
    const banner = bad ? `<div class="pc-banner bad">${esc(S.scan.msg)}</div>`
      : scanned ? `<div class="pc-banner ok">✓ Right item${c.scan_status === "manual" ? " (typed)" : ""}${S.scan.msg ? " · " + esc(S.scan.msg) : ""}</div>`
      : `<div class="pc-banner">${esc(S.scan.msg || "Scan this item's barcode")}</div>`;
    const reasons = a ? (a.kind === "less" ? ["Out of stock", "Short on shelf", "Damaged", "Substituted"] : ["Customer asked", "Pack size"]) : [];
    host.className = "pickcard" + (bad ? " bad" : scanned ? " ok" : "");
    host.innerHTML = `
      <div class="pc-top"><span class="bin">BIN ${esc(l.bin || "—")}</span>${l.addon ? `<span class="chip addonchip">ADD-ON</span>` : ""}
        <span>#${esc(l.item)}</span><button class="pc-skip" onclick="VERIFY.pickSkip()">Skip ›</button></div>
      <div class="pc-item">${l.img ? `<img src="${esc(l.img)}" alt="">` : ""}<div><div class="pc-desc">${esc(l.desc)}</div>
        <div class="pc-upc">UPC ${esc(upc.slice(0, -5))}<b>${esc(upc.slice(-5))}</b></div>${l.note ? `<div class="lnsub">${esc(l.note)}</div>` : ""}</div></div>
      ${banner}
      ${a ? `<div class="pc-adj"><span class="lbl">${a.kind === "less" ? "How many do you have?" : "How many are going?"}</span>
          <div class="row"><button class="step" onclick="VERIFY.pickStep(-1)" aria-label="One less">−</button>
          <input id="pickQty" type="number" inputmode="decimal" min="0" step="any" value="${esc(a.val)}" oninput="VERIFY.pickInput(this.value)">
          <button class="step" onclick="VERIFY.pickStep(1)" aria-label="One more">+</button><span class="lbl">${esc(unit)}</span></div>
          <div class="reasons">${reasons.map(r => `<button class="${a.reason === r ? "on" : ""}" onclick="VERIFY.pickReason('${r}')">${r}</button>`).join("")}</div>
          <div class="row"><button class="pc-cancel" onclick="VERIFY.pickAdjCancel()">Cancel</button><button class="pc-ok" onclick="VERIFY.pickAdjSave()">Save &amp; next</button></div></div>`
        : `<div class="pc-qty"><button class="pc-ok${scanned ? " ready" : ""}" onclick="VERIFY.pickQty('ok')">✓ ${fmtQty(l.qty)} ${esc(unit)}</button>
          <button onclick="VERIFY.pickQty('less')">&lt; Less</button><button onclick="VERIFY.pickQty('more')">&gt; More</button></div>`}
      ${bad && S.scan.code ? `<div class="pc-wrong"><button onclick="VERIFY.pickMarkWrong()">This is the wrong item: flag it on this line</button></div>` : ""}`;
  }

  async function onDecoded(text, photo, how) {
    if (!S.scan || !S.cur) return;
    const code = digits(text) || String(text);
    if (code === S.lastCode && Date.now() - S.lastAt < 2500) return;
    S.lastCode = code; S.lastAt = Date.now();
    const status = how === "typed" ? "manual" : "match";
    const cur = S.scan.line != null ? lineOf(S.scan.line) : null;
    if (cur && upcMatch(code, cur.upc)) {
      beep(true); Object.assign(S.scan, { code: "", status: "ok", msg: "" });
      await save(cur.line, { scan_status: status, scanned_code: code, photo_b64: photo || undefined });
      if (check(cur.line).qty_status) return advance(cur.line, 700);
      return renderPick();
    }
    const hits = S.cur.data.lines.filter(l => upcMatch(code, l.upc));
    const other = hits.find(l => !isComplete(check(l.line))) || hits[0];
    if (other) {
      beep(true); Object.assign(S.scan, { line: other.line, adj: null, code: "", status: "ok", msg: `Jumped to BIN ${other.bin}` });
      await save(other.line, { scan_status: status, scanned_code: code, photo_b64: photo || undefined });
      return renderPick();
    }
    beep(false); S.scan.code = code; S.scan.photo = photo;
    setPick("bad", `✗ Not on this order (scanned ${code}).${cur ? ` Check it against BIN ${cur.bin}.` : ""}`);
  }
  async function pickMarkWrong() {      // keep the stray scan on the current line as a wrong item
    const s = S.scan; if (!s || s.line == null || !s.code) return;
    await save(s.line, { scan_status: "mismatch", scanned_code: s.code, photo_b64: s.photo || undefined });
    Object.assign(s, { code: "", photo: null, status: "ready", msg: "Flagged as wrong item" }); renderPick();
  }
  function advance(from, delay) {
    setTimeout(() => {
      if (!S.scan) return;
      Object.assign(S.scan, { line: nextLine(from), adj: null, status: "ready", msg: "", code: "" });
      S.lastCode = ""; renderPick();
    }, delay || 0);
  }
  async function pickQty(kind) {
    const s = S.scan; if (!s || s.line == null) return;
    const l = lineOf(s.line);
    if (kind === "ok") {
      await save(l.line, { qty_status: "ok", actual_qty: l.qty, note: null });
      if (isComplete(check(l.line))) return advance(l.line, 250);
      return setPick("ready", "Quantity saved. Scan the barcode to confirm the item.");
    }
    s.adj = { kind, val: kind === "less" ? Math.max(0, (l.qty || 0) - 1) : (l.qty || 0) + 1, reason: "" };
    renderPick(); const i = el("pickQty"); if (i) i.focus();
  }
  function pickStep(d) { const a = S.scan.adj; a.val = Math.max(0, Math.round(((Number(a.val) || 0) + d) * 100) / 100); renderPick(); }
  function pickInput(v) { S.scan.adj.val = v; }
  function pickReason(r) { const a = S.scan.adj; a.reason = a.reason === r ? "" : r; renderPick(); }
  function pickAdjCancel() { S.scan.adj = null; renderPick(); }
  async function pickAdjSave() {
    const s = S.scan, a = s.adj, l = lineOf(s.line), v = Number(a.val);
    if (isNaN(v) || v < 0) return;
    const st = v === l.qty ? "ok" : v < l.qty ? "less" : "more";
    s.adj = null;
    await save(l.line, { qty_status: st, actual_qty: v, note: st === "ok" ? null : (a.reason || null) });
    if (isComplete(check(l.line))) return advance(l.line, 250);
    setPick("ready", "Saved. Scan the barcode to confirm the item.");
  }
  function pickSkip() { const s = S.scan; if (s && s.line != null) advance(s.line, 0); }
  function typeLast5() {
    const v = digits(prompt("Type the last 5 digits of the UPC (the numbers under the barcode):") || "").slice(-5);
    if (!v || !S.scan) return;
    const hits = S.cur.data.lines.filter(l => strip0(digits(l.upc)).endsWith(v));
    const cur = S.scan.line != null ? lineOf(S.scan.line) : null;
    const target = cur && hits.includes(cur) ? cur : hits.length === 1 ? hits[0] : null;
    if (!target) { beep(false); return setPick("bad", hits.length ? `${hits.length} lines end in ${v}. Scan the barcode instead.` : `Nothing on this order ends in ${v}.`); }
    S.lastCode = ""; onDecoded(String(target.upc), null, "typed");
  }
  async function onPhoto(input) {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file || !S.scan) return;
    setPick("ready", "Reading the barcode in the photo…");
    const jpeg = await fileToJpeg(file);
    await loadScannerLib();
    try {
      S.fileScanner = S.fileScanner || new Html5Qrcode("scanFileHost", { formatsToSupport: formats(), verbose: false });
      const text = await S.fileScanner.scanFile(file, false);
      S.lastCode = ""; onDecoded(text, jpeg, "photo");
    } catch (e) { beep(false); setPick("bad", "Couldn't read a barcode in that photo. Retake it closer and flat-on, or use Type last 5."); }
  }
  function showImg(line) {
    const l = lineOf(line); if (!l || !l.img) return;
    let o = el("imgView");
    if (!o) { document.body.insertAdjacentHTML("beforeend", `<div class="imgview" id="imgView" role="dialog" aria-label="Product photo"></div>`); o = el("imgView"); }
    o.innerHTML = `<img src="${esc(l.img)}" alt="${esc(l.desc)}"><div class="cap">${esc(l.desc)}<br>UPC ${esc(l.upc)} · BIN ${esc(l.bin)} · #${esc(l.item)}</div><button type="button">Close</button>`;
    o.onclick = () => o.remove();
  }
  function scanLine(line) { openScanner({ line }); }
  function scanAll() { openScanner({}); }

  /* ---------- page furniture: sandbox banner + the pick sheet ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    const top = document.querySelector(".topbar");
    if (top && !PROD) top.insertAdjacentHTML("afterend", `<div class="sbx" id="sbx"><b>SANDBOX</b>
      <span>Dev copy · dispatch pings are logged, not sent</span><span class="sp"></span><span>Orders</span>
      <div class="seg"><button data-src="live">Live feed</button><button data-src="warehouse">Warehouse</button></div></div>`);
    document.querySelectorAll("#sbx [data-src]").forEach(b => {
      b.classList.toggle("on", b.dataset.src === source());
      b.addEventListener("click", () => setSource(b.dataset.src));
    });
    document.body.insertAdjacentHTML("beforeend", `<div class="scansheet hidden" id="scanSheet" role="dialog" aria-label="Pick with the camera">
      <div class="scantop"><div class="t" id="pickProg"></div>
        <button class="x" id="torchBtn" hidden onclick="VERIFY.torch()">Light</button>
        <button class="x" onclick="VERIFY.closeScanner()">Done</button></div>
      <div id="scanView"></div>
      <div class="pickcard" id="pickCard"></div>
      <div class="scanalt"><button onclick="VERIFY.typeLast5()">Type last 5</button>
        <label>Take photo<input type="file" accept="image/*" capture="environment" id="scanFile" onchange="VERIFY.onPhoto(this)"></label></div>
      <div id="scanFileHost" style="position:absolute;width:1px;height:1px;overflow:hidden;opacity:0"></div>
    </div>`);
  });

  return { showImg, enabled, source, loadWarehouse, badge, syncBadges, openOrder, back, render, setFilter, setSort,
           qtyOk, qtyAdj, adjStep, adjInput, adjReason, adjCancel, adjSave, markPicked, undoPicked, cancelConfirm,
           scanLine, scanAll, closeScanner, torch, typeLast5, onPhoto,
           pickQty, pickStep, pickInput, pickReason, pickAdjCancel, pickAdjSave, pickSkip, pickMarkWrong,
           addonOpen, addonClose, addonField, addonLookup, addonPick, addonSave, removeAddon,
           _upcMatch: upcMatch, _simScan: code => onDecoded(code, null, "camera") };   // _ = test hooks
})();
