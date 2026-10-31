/* SupplyNow Order Dash: batch picking (Shop orders → Pick: Batch picking).

   Pick several orders in one walk, then sort the items back into each order and give each a quick check.
     1. Choose   Optimum (open orders under 23 pieces and under $1,100), Delivery, Pickup, or one Time slot (a wave).
     2. Pick     one master pick list: every line of every chosen order, like items combined, in bin order.
                 ✓ got them all · Less · Out · Sub. A short is shared out in pick order (order A first).
     3. Sort & check   each order in pick order, large type, no barcode scan: ✓ / Less / Out / Sub on each line,
                 an optional proof photo, then Mark order picked (same dispatch ping and depot@ email as one order).

   Step 2 is kept on this phone (localStorage), so a reload or a dropped connection picks up where it left off.
   Step 3 saves each line to the server like a single-order pick, with scan_status "visual" (checked by sight).
   Loads after verify.js and goes through its connection (device key, offline queue): VERIFY.net, VERIFY.util.
   Everything that touches the app's globals (ORDERS, state, markDone, show, renderList...) runs at call time. */
const BATCH = (() => {
  const OPT_PIECES = 23, OPT_AMOUNT = 1100;          // Optimum: under 23 pieces AND under $1,100
  const MODES = [["optimum", "Optimum"], ["delivery", "Delivery"], ["pickup", "Pickup"], ["slot", "Time slot"]];
  const COLORS = ["#35D0C0", "#F5B544", "#7AA2FF", "#F472B6", "#A3E635", "#FB923C", "#A78BFA", "#38BDF8"];
  const LESS_REASONS = ["Short on shelf", "Damaged"];
  const S = { on: false, mode: "optimum", slot: "", skip: {}, b: null, bKey: "", data: {}, view: "pick", cur: null,
              filter: "todo", adj: null, confirm: false, busy: false, proof: {}, mkeys: [], clines: [] };

  const ready = () => typeof VERIFY !== "undefined" && !!VERIFY.net;
  const net = () => VERIFY.net, U = () => VERIFY.util;
  const el = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = n => n == null || isNaN(n) ? "—" : (Math.round(n * 100) / 100).toString();
  const digits = s => String(s || "").replace(/\D/g, "");
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };

  /* ---------- the batch on this phone: one per depot and board date ---------- */
  function day() { return String((typeof loadedDate !== "undefined" && loadedDate) || $("#date").value || ""); }
  function keyFor(loc) { return "sn_batch_" + day().replace(/\//g, "-") + "_" + (loc || ""); }
  function persist() { ls.set(S.bKey, S.b); }
  function restore() {                 // the stored batch for the open depot (none for another depot or date)
    const k = keyFor(state.loc);
    if (S.bKey === k) return;
    S.bKey = k; S.b = ls.get(k, null); S.data = {}; S.proof = {}; S.adj = null; S.cur = null;
  }
  function ordById(id) { return (ORDERS[(S.b && S.b.loc) || state.loc] || []).find(o => o.id === id); }
  function tagOf(id) {
    const i = S.b.ids.indexOf(id);
    return i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + i % 26);
  }
  function colorOf(id) { return COLORS[Math.max(0, S.b.ids.indexOf(id)) % COLORS.length]; }
  function tagHtml(id, big) { return `<span class="bt-tag${big ? " big" : ""}" style="--c:${colorOf(id)}">${tagOf(id)}</span>`; }
  function modeLabel(b) { return b.mode === "slot" ? `Time slot ${b.slot}` : (MODES.find(m => m[0] === b.mode) || [, "Batch"])[1]; }

  /* ---------- step 1: which orders (the four batch options) ---------- */
  function pickSort(a, b) {           // the app's pick order: time slot, then pickRank, then largest first
    return (a.startMin - b.startMin) || (typeof pickRank === "function" ? pickRank(a) - pickRank(b) : 0) || (b.amount - a.amount);
  }
  function openOrders() { return (ORDERS[state.loc] || []).filter(o => !state.done[o._uid]).sort(pickSort); }
  const isOptimum = o => (Number(o.cases) || 0) < OPT_PIECES && (Number(o.amount) || 0) < OPT_AMOUNT;
  const slotOf = o => o.win || "No time";
  function slots() {
    const m = new Map();
    openOrders().forEach(o => m.set(slotOf(o), (m.get(slotOf(o)) || 0) + 1));
    return [...m.entries()];
  }
  function matches(o) {
    if (S.mode === "optimum") return isOptimum(o);
    if (S.mode === "delivery") return o.type === "Delivery";
    if (S.mode === "pickup") return o.type === "Pickup";
    return slotOf(o) === S.slot;
  }
  const candidates = () => openOrders().filter(matches);
  const chosen = () => candidates().filter(o => !S.skip[o.id]);
  function ruleText() {
    if (S.mode === "optimum") return `Optimum: orders under ${OPT_PIECES} pieces and under $${OPT_AMOUNT.toLocaleString("en-US")}.`;
    if (S.mode === "delivery") return "Every open delivery order.";
    if (S.mode === "pickup") return "Every open pickup order.";
    return "One time slot, picked as a wave.";
  }

  function toolbar() {
    return `<div class="controls bt-toggle"><span class="seglbl">Pick</span><div class="seg">
      <button class="${S.on ? "" : "on"}" onclick="BATCH.setOn(false)">One order</button>
      <button class="${S.on ? "on" : ""}" onclick="BATCH.setOn(true)">Batch picking</button></div></div>`;
  }
  // called by renderList in Shop orders mode: true = the batch view replaced the order cards
  function listView(wrap) {
    if (!ready()) return false;
    restore();
    if (!S.on) {
      wrap.insertAdjacentHTML("afterbegin", toolbar() + (S.b ? resumeHtml() : ""));
      return false;
    }
    const sl = slots();
    if (S.mode === "slot" && !sl.some(([k]) => k === S.slot)) S.slot = (sl[0] || [""])[0];
    const all = openOrders(), C = candidates(), n = C.filter(o => !S.skip[o.id]).length;
    let h = toolbar() + (S.b ? resumeHtml() : "");
    h += `<div class="seg bt-modes">${MODES.map(([k, t]) => `<button class="${S.mode === k ? "on" : ""}" onclick="BATCH.setMode('${k}')">${t}</button>`).join("")}</div>`;
    if (S.mode === "slot") h += `<div class="bt-slots">${sl.map(([k, c], i) =>
      `<button class="${S.slot === k ? "on" : ""}" onclick="BATCH.setSlot(${i})">${esc(k)} <small>${c}</small></button>`).join("")}</div>`;
    h += `<p class="bt-rule">${ruleText()} <b>${C.length}</b> of ${all.length} open order${all.length === 1 ? "" : "s"} match. Tap an order to leave it out.</p>`;
    h += C.length ? C.map(selCard).join("") : `<div class="vmsg">No open orders match. Try another option.</div>`;
    h += `<div class="vfoot bt-foot"><button class="${n ? "ready" : ""}" ${n ? "" : "disabled"} onclick="BATCH.start()">Start batch pick · ${n} order${n === 1 ? "" : "s"}</button></div>`;
    wrap.innerHTML = h;
    return true;
  }
  function selCard(o) {
    const on = !S.skip[o.id], d = o.type === "Delivery";
    return `<div class="card${on ? " sel" : ""}"><div class="stripe" style="background:${d ? "var(--delivery)" : "var(--pickup)"}"></div>
      <button class="pick" onclick="BATCH.toggle('${esc(o.id)}')"><div class="chk">${on ? "✓" : ""}</div>
        <div class="meta"><div class="acct">${esc(o.acct)}</div><div class="line2"><span class="win">${esc(o.win || "—")}</span>
          <span class="typetag ${d ? "d" : "p"}">${esc(o.type.toUpperCase())}</span></div></div>
        <div class="bt-size"><b>${o.cases || "—"}</b><span>pcs</span><em>${money(Number(o.amount) || 0)}</em></div></button></div>`;
  }
  function resumeHtml() {
    const b = S.b, st = b.stats || {}, done = Object.keys(b.done || {}).length;
    return `<div class="bt-resume"><div class="t"><b>Batch in progress</b><span>${esc(modeLabel(b))} · ${b.ids.length} order${b.ids.length === 1 ? "" : "s"}
      · ${st.items ? `${st.picked || 0}/${st.items} items picked · ` : ""}${done}/${b.ids.length} checked</span></div>
      <button class="go" onclick="BATCH.resume()">Resume</button><button onclick="BATCH.end()">End</button></div>`;
  }
  function setOn(v) { S.on = !!v; renderList(); }
  function setMode(k) { S.mode = k; S.skip = {}; renderList(); }
  function setSlot(i) { const s = slots()[i]; if (s) { S.slot = s[0]; S.skip = {}; } renderList(); }
  function toggle(id) { S.skip[id] = !S.skip[id]; renderList(); }

  function start() {
    const list = chosen();
    if (!list.length) return;
    if (S.b && !confirm("End the batch in progress and start this one? Orders already marked picked stay picked.")) return;
    net().who();                      // the name on the pick log, asked once per phone
    S.b = { id: Date.now().toString(36), loc: state.loc, day: day(), mode: S.mode, slot: S.mode === "slot" ? S.slot : "",
            ids: list.map(o => o.id), picks: {}, done: {}, stats: {}, started: Date.now() };
    S.data = {}; S.proof = {}; S.filter = "todo"; S.adj = null;
    persist();
    open("pick");
  }
  function resume() { open(S.b && Object.keys(S.b.done || {}).length ? "sort" : "pick"); }
  function end() {
    if (!S.b) return;
    const left = S.b.ids.filter(id => !S.b.done[id]).length;
    if (left && !confirm(`End this batch? ${left} order${left === 1 ? " isn't" : "s aren't"} marked picked yet. They go back on the list; anything already checked stays saved.`)) return;
    S.b = null; persist(); S.data = {}; S.cur = null;
    close();
  }

  /* ---------- screens ---------- */
  function open(view) {
    S.view = view; S.adj = null; S.confirm = false;
    show("batch"); document.body.classList.add("batching");
    U().wakeLock(true);
    render(); loadAll();
  }
  function close() {
    U().wakeLock(false);
    document.body.classList.remove("batching");
    show("list"); renderList();
  }
  function back() {
    if (S.view === "check") { S.cur = null; S.view = "sort"; S.adj = null; S.confirm = false; render(); window.scrollTo(0, 0); return; }
    close();
  }
  function tab(v) { if (v === S.view) return; S.view = v; S.cur = null; S.adj = null; S.confirm = false; render(); window.scrollTo(0, 0); }

  async function loadOne(id) {
    try {
      const r = await net().get(`order?id=${encodeURIComponent(id)}&date=${encodeURIComponent(S.b.day)}`);
      S.data[id] = r.ok ? r : { err: r.detail || r.error || "Couldn't load this order.", missing: r.error === "not_in_warehouse" };
    } catch (e) { S.data[id] = { err: "Couldn't reach order verification. Check the connection, then Retry." }; }
  }
  let loading = null;
  function loadAll(force) {
    if (!S.b) return Promise.resolve();
    if (loading && !force) return loading;
    const b = S.b, todo = b.ids.filter(id => force || !S.data[id] || S.data[id].err);
    let i = 0;
    const worker = async () => { while (i < todo.length && S.b === b) { const id = todo[i++]; await loadOne(id); render(); } };
    loading = Promise.all([worker(), worker(), worker(), worker()]).then(() => { loading = null; render(); });
    return loading;
  }
  function retry() { loadAll(); render(); }
  async function refresh(id) {        // fresh lines and checks for one order; keeps what's loaded if the call fails
    try { const r = await net().get(`order?id=${encodeURIComponent(id)}&date=${encodeURIComponent(S.b.day)}`); if (r.ok) S.data[id] = r; } catch (e) {}
    render();
  }

  /* ---------- step 2: the master pick list ---------- */
  const unitOf = l => l.qty_unit || l.unit || "";
  const binNum = x => parseInt(x.bin, 10) || 1e9;
  function keyOf(l) {                 // like items: same item # (or UPC, or description) in the same unit
    const id = l.item ? "i" + l.item : l.upc ? "u" + digits(l.upc) : "d" + String(l.desc || "").toLowerCase();
    return id + "|" + unitOf(l).toLowerCase();
  }
  function master() {
    const m = new Map();
    S.b.ids.forEach((id, oi) => {
      const d = S.data[id];
      if (!d || !d.lines) return;
      d.lines.forEach(l => {
        const k = keyOf(l);
        let e = m.get(k);
        if (!e) m.set(k, e = { key: k, item: l.item, upc: l.upc, desc: l.desc, bin: l.bin, img: l.img, unit: unitOf(l), total: 0, parts: [], notes: [] });
        const q = Number(l.qty) || 0;
        e.total = Math.round((e.total + q) * 100) / 100;
        e.parts.push({ id, oi, line: l.line, qty: q });
        if (!e.bin && l.bin) e.bin = l.bin;
        if (!e.img && l.img) e.img = l.img;
        if (!e.upc && l.upc) e.upc = l.upc;
        if (l.note) e.notes.push({ id, note: l.note });
        if (l.addon) e.notes.push({ id, note: "ADD-ON" + (l.requested_by ? ` for ${l.requested_by}` : "") });
      });
    });
    return [...m.values()].sort((a, b) => (binNum(a) - binNum(b)) || String(a.desc).localeCompare(String(b.desc)));
  }
  const pickOf = e => S.b.picks[e.key];
  function pickStats(M) {
    const out = { items: M.length, picked: 0, exc: 0, units: 0 };
    M.forEach(e => { out.units += e.total; const p = pickOf(e); if (p) { out.picked++; if (p.st !== "ok") out.exc++; } });
    out.units = Math.round(out.units * 100) / 100;
    return out;
  }
  function setPick(i, p) {
    const k = S.mkeys[i]; if (!k) return;
    if (p) S.b.picks[k] = p; else delete S.b.picks[k];
    S.adj = null; persist(); render();
  }
  function mOk(i) {
    const e = master().find(x => x.key === S.mkeys[i]); if (!e) return;
    const p = S.b.picks[e.key];
    setPick(i, p && p.st === "ok" ? null : { st: "ok", qty: e.total });
  }
  function mOut(i) {
    const p = S.b.picks[S.mkeys[i]];
    setPick(i, p && p.st === "out" ? null : { st: "out", qty: 0, reason: "Out of stock" });
  }
  function mAdj(i, kind) {
    const e = master().find(x => x.key === S.mkeys[i]); if (!e) return;
    const p = S.b.picks[e.key] || {};
    const val = p.st === kind || (kind === "less" && p.st === "out") ? p.qty : kind === "less" ? Math.max(0, e.total - 1) : e.total;
    S.adj = { scope: "m", i, key: e.key, kind, val, max: e.total, unit: e.unit, reason: p.st === kind ? p.reason || "" : "", sub: p.sub || "" };
    render(); focusAdj();
  }

  /* a short or a substitution in the master pick, shared out to the orders in pick order (A first) */
  function allocation() {
    const out = {};
    master().forEach(e => {
      const p = pickOf(e); if (!p) return;
      let left = p.st === "ok" ? Infinity : Number(p.qty) || 0;
      e.parts.slice().sort((a, b) => (a.oi - b.oi) || (a.line - b.line)).forEach(pt => {
        const give = Math.min(pt.qty, Math.max(0, left));
        left -= give;
        let st;
        if (give <= 0 && pt.qty > 0) st = "out";
        else if (p.st === "sub") st = "sub";
        else st = give >= pt.qty ? "ok" : "less";
        out[pt.id + "|" + pt.line] = { st, qty: give, sub: p.sub || "",
          reason: st === "out" ? (p.st === "less" && p.reason ? p.reason : "Out of stock") : st === "less" ? (p.reason || "Short on shelf") : "" };
      });
    });
    return out;
  }

  /* ---------- step 3: sort into orders + quick check (no barcode) ---------- */
  const isOutC = c => c.qty_status === "less" && Number(c.actual_qty) === 0;
  const lineDone = c => !!c.qty_status && (U().isScanned(c) || U().isVisual(c) || isOutC(c));
  const lineExc = c => U().isException(c);
  function ordStats(id) {
    const d = S.data[id];
    if (!d || !d.lines) return null;
    const out = { total: d.lines.length, done: 0, exc: 0 };
    d.lines.forEach(l => { const c = d.checks[String(l.line)] || {}; if (lineDone(c)) out.done++; if (lineExc(c)) out.exc++; });
    return out;
  }
  function openCheck(id) {
    S.cur = id; S.view = "check"; S.adj = null; S.confirm = false;
    render(); window.scrollTo(0, 0);
    net().flush().then(() => refresh(id));         // fresh checks (another phone, or the one-order screen)
  }
  function ckLine(i) { const l = S.clines[i]; return l && { l, d: S.data[S.cur] }; }
  function scanFields(c) {            // keep a real barcode scan; otherwise the line is checked by sight
    return U().isScanned(c) ? {} : { scan_status: "visual", scanned_code: null };
  }
  async function saveLine(l, fields) {
    const id = S.cur, d = S.data[id];
    const c = (d.checks[String(l.line)] = d.checks[String(l.line)] || {});
    Object.assign(c, fields);
    S.adj = null; render();
    const saved = await net().save(Object.assign({ order: d.order.order_number, line: l.line, who: net().who() }, fields));
    if (saved && S.data[id] === d) Object.assign(c, saved);
    render();
  }
  function qtyStatus(v, ordered) { return v === ordered ? "ok" : v < ordered ? "less" : "more"; }
  function cOk(i) {
    const x = ckLine(i); if (!x) return;
    const c = x.d.checks[String(x.l.line)] || {};
    if (lineDone(c) && c.qty_status === "ok" && !U().isSub(c)) {          // tap again: undo
      return saveLine(x.l, Object.assign({ qty_status: null, actual_qty: null, note: null, sub_item: null },
        U().isVisual(c) ? { scan_status: null, scanned_code: null } : {}));
    }
    saveLine(x.l, Object.assign({ qty_status: "ok", actual_qty: x.l.qty, note: null, sub_item: null }, scanFields(c)));
  }
  function cOut(i) {
    const x = ckLine(i); if (!x) return;
    const c = x.d.checks[String(x.l.line)] || {};
    saveLine(x.l, Object.assign({ qty_status: "less", actual_qty: 0, note: "Out of stock", sub_item: null }, scanFields(c)));
  }
  function cSug(i) {                  // take the master pick's suggestion for this line in one tap
    const x = ckLine(i); if (!x) return;
    const s = allocation()[S.cur + "|" + x.l.line]; if (!s) return;
    const c = x.d.checks[String(x.l.line)] || {}, ordered = Number(x.l.qty) || 0;
    if (s.st === "out") return cOut(i);
    if (s.st === "sub") return saveLine(x.l, Object.assign({ qty_status: qtyStatus(s.qty, ordered), actual_qty: s.qty,
      note: "Substituted" + (s.sub ? ": " + s.sub : ""), sub_item: s.sub || "Substituted" }, scanFields(c)));
    if (s.st === "less") return saveLine(x.l, Object.assign({ qty_status: "less", actual_qty: s.qty, note: s.reason || null, sub_item: null }, scanFields(c)));
    return cOk(i);
  }
  function cAdj(i, kind) {
    const x = ckLine(i); if (!x) return;
    const c = x.d.checks[String(x.l.line)] || {}, ordered = Number(x.l.qty) || 0;
    const s = allocation()[S.cur + "|" + x.l.line];
    const cur = c.qty_status && c.actual_qty != null ? Number(c.actual_qty) : null;
    const val = kind === "less" ? (cur != null && cur < ordered ? cur : s && s.st === "less" ? s.qty : Math.max(0, ordered - 1))
                                : (cur != null && U().isSub(c) ? cur : s && s.st === "sub" ? s.qty : ordered);
    S.adj = { scope: "c", i, kind, val, max: ordered, unit: unitOf(x.l), reason: kind === "less" && c.qty_status === "less" ? (c.note || "") : "",
              sub: kind === "sub" ? (c.sub_item && c.sub_item !== "Substituted" ? c.sub_item : (s && s.sub) || "") : "" };
    render(); focusAdj();
  }

  /* ---------- the Less / Sub panel (master pick and quick check) ---------- */
  function focusAdj() { setTimeout(() => { const n = el("btAdjVal"); if (n) { n.focus(); n.select && n.select(); } }, 0); }
  function adjStep(d) { const a = S.adj; if (!a) return; a.val = Math.max(0, Math.round(((Number(a.val) || 0) + d) * 100) / 100); render(); }
  function adjInput(v) { if (S.adj) S.adj.val = v; }
  function adjSub(v) { if (S.adj) S.adj.sub = v; }
  function adjReason(r) { const a = S.adj; if (!a) return; a.reason = a.reason === r ? "" : r; render(); }
  function adjCancel() { S.adj = null; render(); }
  function adjSave() {
    const a = S.adj; if (!a) return;
    const v = Number(a.val);
    if (isNaN(v) || v < 0) { alert("Enter the quantity you actually have."); return; }
    const sub = String(a.sub || "").trim();
    if (a.scope === "m") {
      if (a.kind === "sub") return setPick(a.i, { st: "sub", qty: v, sub });
      if (v >= a.max) return setPick(a.i, { st: "ok", qty: a.max });
      return setPick(a.i, v === 0 ? { st: "out", qty: 0, reason: a.reason || "Out of stock" } : { st: "less", qty: v, reason: a.reason || "" });
    }
    const x = ckLine(a.i); if (!x) return;
    const c = x.d.checks[String(x.l.line)] || {}, ordered = Number(x.l.qty) || 0;
    if (a.kind === "sub") return saveLine(x.l, Object.assign({ qty_status: qtyStatus(v, ordered), actual_qty: v,
      note: "Substituted" + (sub ? ": " + sub : ""), sub_item: sub || "Substituted" }, scanFields(c)));
    const st = qtyStatus(v, ordered);
    saveLine(x.l, Object.assign({ qty_status: st, actual_qty: v, note: st === "ok" ? null : (v === 0 && !a.reason ? "Out of stock" : a.reason || null), sub_item: null }, scanFields(c)));
  }
  function adjHtml() {
    const a = S.adj;
    const qty = `<div class="row"><button class="step" onclick="BATCH.adjStep(-1)" aria-label="One less">−</button>
      <input id="btAdjVal" type="number" inputmode="decimal" min="0" step="any" value="${esc(a.val)}" oninput="BATCH.adjInput(this.value)">
      <button class="step" onclick="BATCH.adjStep(1)" aria-label="One more">+</button><span class="lbl">${esc(a.unit)}</span>
      <button class="save" onclick="BATCH.adjSave()">Save</button></div>`;
    if (a.kind === "sub") return `<div class="adj"><div class="row"><span class="lbl">Substitute: how many are going?</span></div>${qty}
      <input class="bt-subin" placeholder="Substituted with (brand, size), optional" value="${esc(a.sub)}" oninput="BATCH.adjSub(this.value)">
      <div class="reasons"><button onclick="BATCH.adjCancel()">Cancel</button></div></div>`;
    return `<div class="adj"><div class="row"><span class="lbl">How many did you get? (of ${fmt(a.max)})</span></div>${qty}
      <div class="reasons">${LESS_REASONS.map(r => `<button class="${a.reason === r ? "on" : ""}" onclick="BATCH.adjReason('${r}')">${r}</button>`).join("")}
      <button onclick="BATCH.adjCancel()">Cancel</button></div></div>`;
  }

  /* ---------- order picked ---------- */
  async function proofPick(input) {
    const f = input.files && input.files[0];
    input.value = "";
    const id = S.cur, d = S.data[id];
    if (!f || !d || !d.order) return;
    const jpeg = await U().fileToJpeg(f);
    if (!jpeg) { alert("Couldn't read that photo. Take it again."); return; }
    const pr = S.proof[id] = { src: jpeg, state: "saving" };
    render();
    // line 0 holds the order's proof photo (RD lines start at 1, add-ons at 9001)
    pr.p = net().save({ order: d.order.order_number, line: 0, who: net().who(), photo_b64: jpeg, note: "Proof of pick" })
      .then(saved => { pr.state = saved ? "saved" : "queued"; render(); });
  }
  function excLines(id) {
    const d = S.data[id];
    return d.lines.map(l => ({ l, c: d.checks[String(l.line)] || {} })).filter(x => lineExc(x.c))
      .map(({ l, c }) => ({ line: l.line, item: l.item, desc: l.desc, ordered: l.qty, actual: c.actual_qty, qty_status: c.qty_status,
        scan_status: c.scan_status, scanned_code: c.scanned_code, note: c.note, sub_item: c.sub_item || null }));
  }
  async function markPicked(force) {
    const id = S.cur, d = S.data[id], s = ordStats(id);
    if (!s) return;
    if (!force && s.done < s.total) { S.confirm = true; return render(); }
    S.confirm = false; S.busy = true; render();
    const pr = S.proof[id];
    if (pr && pr.p) await pr.p;                    // the proof photo goes up first, so depot@'s email can carry it
    const o = ordById(id);
    if (o && !state.done[o._uid]) markDone(o._uid);   // strikes it on the list and pings dispatch, same as one order
    const b = S.b;
    try {
      await net().post("order_done", { order: d.order.order_number, who: net().who(), summary: {
        total: s.total, complete: s.done, exceptions: s.exc, method: "batch", exception_lines: excLines(id),
        batch: { id: b.id, mode: b.mode, slot: b.slot, orders: b.ids.length, tag: tagOf(id) } } });
    } catch (e) {}
    b.done[id] = Date.now(); persist();
    S.busy = false; S.cur = null; S.view = "sort"; render(); window.scrollTo(0, 0);
  }
  async function undoPicked() {
    const id = S.cur, d = S.data[id], o = ordById(id);
    if (o && state.done[o._uid]) markDone(o._uid);   // un-tick: the app sends no ping
    try { await net().post("order_done", { order: d.order.order_number, undo: true }); } catch (e) {}
    delete S.b.done[id]; d.done = null; persist(); render();
  }
  function finish() {
    const left = S.b.ids.filter(id => !S.b.done[id]).length;
    if (left) return end();
    S.b = null; persist(); S.data = {}; close();
  }

  /* ---------- render ---------- */
  function head(title, sub) {
    const b = S.b;
    return `<div class="vhead"><button class="back" onclick="BATCH.back()">‹ ${S.view === "check" ? "Orders" : "Back"}</button>
      <div><div class="eyebrow" style="margin:0 0 2px">Batch pick · ${esc(modeLabel(b))}</div><div class="ltitle">${title}</div>
      <div class="lcount">${sub}</div></div></div>`;
  }
  function tabs(st) {
    const done = Object.keys(S.b.done).length;
    return `<div class="seg bt-tabs"><button class="${S.view === "pick" ? "on" : ""}" onclick="BATCH.tab('pick')">1 · Pick list <b>${st.picked}/${st.items}</b></button>
      <button class="${S.view !== "pick" ? "on" : ""}" onclick="BATCH.tab('sort')">2 · Sort &amp; check <b>${done}/${S.b.ids.length}</b></button></div>`;
  }
  function loadNote() {
    const b = S.b, got = b.ids.filter(id => S.data[id]).length, bad = b.ids.filter(id => S.data[id] && S.data[id].err);
    let h = "";
    if (got < b.ids.length) h += `<div class="vmsg">Pulling order lines… ${got} of ${b.ids.length} orders</div>`;
    if (bad.length) h += `<div class="bt-err"><b>${bad.length} order${bad.length === 1 ? "" : "s"} not in the pick list:</b>
      ${bad.map(id => `<div>${tagHtml(id)} ${esc((ordById(id) || {}).acct || id)}: ${esc(S.data[id].err)}</div>`).join("")}
      <button onclick="BATCH.retry()">Retry</button></div>`;
    return h;
  }
  function splitHtml(e) {
    return e.parts.map(pt => `<span class="bt-part">${tagHtml(pt.id)}<b>${fmt(pt.qty)}</b></span>`).join("");
  }
  function mCard(e, i) {
    const p = pickOf(e), a = S.adj && S.adj.scope === "m" && S.adj.key === e.key;
    const upc = String(e.upc || ""), st = p ? p.st : "";
    const chip = !p ? "" : st === "ok" ? `<span class="chip ok">Picked ✓ ${fmt(p.qty)}</span>`
      : st === "out" ? `<span class="chip bad">Out of stock</span>`
      : st === "less" ? `<span class="chip less">Short · ${fmt(p.qty)} of ${fmt(e.total)}${p.reason ? " · " + esc(p.reason) : ""}</span>`
      : `<span class="chip less">Sub · ${fmt(p.qty)}${p.sub ? " · " + esc(p.sub) : ""}</span>`;
    return `<div class="ln bt-m${st ? " st-" + (st === "ok" ? "ok" : st === "sub" ? "more" : "less") : ""}${p ? " complete" : ""}" id="bm-${i}">
      <div class="lnhead"><span class="bin">BIN ${esc(e.bin || "—")}</span><span>#${esc(e.item)}</span>
        <span class="upc">UPC ${esc(upc.slice(0, -5))}<b>${esc(upc.slice(-5))}</b></span></div>
      <div class="lnitem">${e.img ? `<span class="lnimg"><img src="${esc(e.img)}" alt="" loading="lazy"></span>` : ""}<div class="lndesc">${esc(e.desc)}</div></div>
      ${e.notes.map(n => `<div class="lnsub">${tagHtml(n.id)} ${esc(n.note)}</div>`).join("")}
      <div class="bt-split"><span class="lbl">For</span>${splitHtml(e)}</div>
      <div class="lnrow"><div class="lnqty"><b>${fmt(e.total)}</b><span>${esc(e.unit)}</span></div>
        <div class="lnacts bt-acts">
          <button class="ok${st === "ok" ? " on" : ""}" onclick="BATCH.mOk(${i})">✓ ${fmt(e.total)}</button>
          <button class="less${st === "less" ? " on" : ""}" onclick="BATCH.mAdj(${i},'less')">Less</button>
          <button class="out${st === "out" ? " on" : ""}" onclick="BATCH.mOut(${i})">Out</button>
          <button class="sub${st === "sub" ? " on" : ""}" onclick="BATCH.mAdj(${i},'sub')">Sub</button></div></div>
      ${a ? adjHtml() : ""}
      ${chip ? `<div class="lnstat">${chip}</div>` : ""}
    </div>`;
  }
  function renderPick(host) {
    const b = S.b, M = master(), st = pickStats(M);
    b.stats = { items: st.items, picked: st.picked }; persist();
    let list = M;
    if (S.filter === "todo") list = M.filter(e => !pickOf(e));
    if (S.filter === "exc") list = M.filter(e => pickOf(e) && pickOf(e).st !== "ok");
    S.mkeys = M.map(e => e.key);
    const idx = new Map(M.map((e, i) => [e.key, i]));
    const pc = st.items ? Math.round(100 * (st.picked - st.exc) / st.items) : 0, px = st.items ? Math.round(100 * st.exc / st.items) : 0;
    const loc = (typeof locName === "function" && locName()) || "";
    const all = st.items && st.picked === st.items;
    host.innerHTML = head(`${b.ids.length} order${b.ids.length === 1 ? "" : "s"} · ${st.items} items`, `${esc(loc)} · ${fmt(st.units)} units · bin order`) + tabs(st) + `
      <div class="vprog">
        <div class="vbar" role="img" aria-label="${st.picked} of ${st.items} items picked"><i class="c" style="width:${pc}%"></i><i class="x" style="width:${px}%"></i></div>
        <div class="vstats"><div><b>${st.picked}/${st.items}</b><span>picked</span></div><div><b>${fmt(st.units)}</b><span>units</span></div>
          <div><b>${b.ids.length}</b><span>orders</span></div><div class="exc"><b>${st.exc}</b><span>exceptions</span></div></div>
      </div>
      <div class="bt-legend">${b.ids.map(id => `<span>${tagHtml(id)} ${esc(((ordById(id) || {}).acct || id))}</span>`).join("")}</div>
      ${loadNote()}
      <div class="vtools"><div class="seg">
        <button class="${S.filter === "todo" ? "on" : ""}" onclick="BATCH.setFilter('todo')">To pick ${st.items - st.picked}</button>
        <button class="${S.filter === "all" ? "on" : ""}" onclick="BATCH.setFilter('all')">All ${st.items}</button>
        <button class="${S.filter === "exc" ? "on" : ""}" onclick="BATCH.setFilter('exc')">Exceptions ${st.exc}</button></div></div>
      <p class="vnote">Like items are combined. Pick the total, then sort it out by the letters. A short goes to order A first.</p>
      ${list.length ? list.map(e => mCard(e, idx.get(e.key))).join("") : `<div class="vmsg">${S.filter === "exc" ? "No exceptions." : st.items ? "Every item is picked." : ""}</div>`}
      <div class="vfoot"><button class="${all ? "ready" : ""}" onclick="BATCH.tab('sort')">Sort &amp; check orders ›${all ? "" : ` · ${st.items - st.picked} left to pick`}</button></div>`;
  }
  function renderSort(host) {
    const b = S.b, M = master(), st = pickStats(M), doneN = Object.keys(b.done).length;
    const loc = (typeof locName === "function" && locName()) || "";
    host.innerHTML = head("Sort &amp; check", `${esc(loc)} · ${doneN}/${b.ids.length} orders picked`) + tabs(st) + `
      <p class="vnote">Put each order's items in its cart, then open it and check it. Orders are in pick order.</p>
      ${loadNote()}
      ${b.ids.map(id => {
        const o = ordById(id) || { acct: id, win: "", type: "" }, s = ordStats(id), done = !!b.done[id];
        const status = done ? `<span class="vbadge full">Picked ✓</span>` : !S.data[id] ? `<span class="vbadge">Loading</span>`
          : S.data[id].err ? `<span class="vbadge exc">No lines</span>`
          : `<span class="vbadge ${s.exc ? "exc" : s.done ? "part" : ""}">${s.done}/${s.total}${s.exc ? ` · ${s.exc} exc` : ""}</span>`;
        return `<button class="bt-ord${done ? " done" : ""}" onclick="BATCH.openCheck('${esc(id)}')" ${S.data[id] && S.data[id].lines ? "" : "disabled"}>
          ${tagHtml(id, true)}<div class="meta"><div class="acct">${esc(o.acct)}</div>
          <div class="line2"><span class="win">${esc(o.win || "—")}</span>${o.type ? `<span class="typetag ${o.type === "Delivery" ? "d" : "p"}">${esc(o.type.toUpperCase())}</span>` : ""}
          ${s ? `<span>${s.total} lines</span>` : ""}</div></div>${status}</button>`;
      }).join("")}
      <div class="vfoot"><button class="${doneN === b.ids.length ? "ready" : ""}" onclick="BATCH.finish()">${doneN === b.ids.length ? "Batch done ✓ · back to orders" : `End batch · ${doneN}/${b.ids.length} picked`}</button></div>`;
  }
  function cCard(l, i, sug) {
    const d = S.data[S.cur], c = d.checks[String(l.line)] || {}, done = lineDone(c), upc = String(l.upc || "");
    const ordered = Number(l.qty) || 0, a = S.adj && S.adj.scope === "c" && S.adj.i === i;
    const st = !c.qty_status ? "" : U().isSub(c) ? "sub" : isOutC(c) ? "out" : c.qty_status;
    const chip = !c.qty_status ? ""
      : st === "out" ? `<span class="chip bad">Out of stock</span>`
      : st === "sub" ? `<span class="chip less">Sub · ${fmt(c.actual_qty)}${c.sub_item && c.sub_item !== "Substituted" ? " · " + esc(c.sub_item) : ""}</span>`
      : st === "less" ? `<span class="chip less">Short · ${fmt(c.actual_qty)} of ${fmt(ordered)}${c.note ? " · " + esc(c.note) : ""}</span>`
      : st === "more" ? `<span class="chip more">Over · ${fmt(c.actual_qty)} of ${fmt(ordered)}</span>`
      : `<span class="chip ok">✓ ${fmt(c.actual_qty)} ${esc(unitOf(l))}${U().isScanned(c) ? " · scanned" : ""}</span>`;
    const sugTxt = !sug || sug.st === "ok" || c.qty_status ? ""
      : sug.st === "out" ? "Out of stock in the batch"
      : sug.st === "sub" ? `Sub in the batch: ${fmt(sug.qty)}${sug.sub ? " · " + esc(sug.sub) : ""}`
      : `Short in the batch: ${fmt(sug.qty)} of ${fmt(ordered)} for this order`;
    return `<div class="bt-ck${st ? " st-" + st : ""}${done ? " complete" : ""}" id="ck-${l.line}">
      <div class="bt-ck-top"><span class="bin">BIN ${esc(l.bin || "—")}</span>${l.addon ? `<span class="chip addonchip">ADD-ON</span>` : ""}</div>
      <div class="bt-ck-item">${l.img ? `<span class="lnimg"><img src="${esc(l.img)}" alt="" loading="lazy"></span>` : ""}
        <div class="bt-ck-desc">${esc(l.desc)}</div></div>
      <div class="bt-ck-ids"><span>Item <b>#${esc(l.item || "—")}</b></span><span>UPC ${esc(upc.slice(0, -5))}<b>${esc(upc.slice(-5))}</b></span></div>
      ${l.note ? `<div class="lnsub">${esc(l.note)}</div>` : ""}
      <div class="bt-ck-qty"><span class="lbl">Qty</span><b>${fmt(l.qty)}</b><span class="u">${esc(unitOf(l))}</span></div>
      ${sugTxt ? `<div class="bt-sug"><span>${sugTxt}</span><button onclick="BATCH.cSug(${i})">Confirm</button></div>` : ""}
      <div class="bt-ck-acts">
        <button class="ok${st === "ok" ? " on" : ""}" onclick="BATCH.cOk(${i})">✓ ${fmt(l.qty)}</button>
        <button class="less${st === "less" ? " on" : ""}" onclick="BATCH.cAdj(${i},'less')">Less</button>
        <button class="out${st === "out" ? " on" : ""}" onclick="BATCH.cOut(${i})">Out</button>
        <button class="sub${st === "sub" ? " on" : ""}" onclick="BATCH.cAdj(${i},'sub')">Sub</button></div>
      ${a ? adjHtml() : ""}
      ${chip ? `<div class="lnstat">${chip}</div>` : ""}
    </div>`;
  }
  function renderCheck(host) {
    const id = S.cur, d = S.data[id], o = ordById(id) || { acct: id, win: "", type: "" };
    if (!d || !d.lines) { host.innerHTML = head(esc(o.acct), "") + `<div class="vmsg">${d && d.err ? esc(d.err) : "Pulling the order lines…"}</div>`; return; }
    const s = ordStats(id), sug = allocation(), done = !!S.b.done[id] || !!d.done;
    S.clines = d.lines.slice().sort((a, b) => (binNum(a) - binNum(b)) || (a.line - b.line));
    const pc = s.total ? Math.round(100 * (s.done - s.exc) / s.total) : 0, px = s.total ? Math.round(100 * s.exc / s.total) : 0;
    const pr = S.proof[id], had = d.checks["0"] && d.checks["0"].photo;
    host.innerHTML = `<div class="vhead"><button class="back" onclick="BATCH.back()">‹ Orders</button>${tagHtml(id, true)}
        <div><div class="eyebrow" style="margin:0 0 2px">Quick check</div><div class="ltitle">${esc(o.acct)}</div>
        <div class="lcount">${esc(o.win || "—")} · ${esc((o.type || "").toUpperCase())} · #${esc(d.order.order_number)}</div></div></div>
      <div class="vprog">
        <div class="vbar" role="img" aria-label="${s.done} of ${s.total} lines checked"><i class="c" style="width:${pc}%"></i><i class="x" style="width:${px}%"></i></div>
        <div class="vstats bt-3"><div><b>${s.done}/${s.total}</b><span>checked</span></div><div><b>${s.total - s.done}</b><span>to check</span></div>
          <div class="exc"><b>${s.exc}</b><span>exceptions</span></div></div>
      </div>
      <p class="vnote">Put each item in ${tagOf(id)}'s cart and tap ✓. No scan needed. Less, Out and Sub flag the line for dispatch.</p>
      ${S.clines.map((l, i) => cCard(l, i, sug[id + "|" + l.line])).join("")}
      <div class="bt-proof">
        ${pr ? `<img src="${esc(pr.src)}" alt="Proof of pick">` : ""}
        <div class="t"><b>Proof photo</b><span>${pr ? (pr.state === "saving" ? "Saving…" : pr.state === "queued" ? "Saved on this phone, sends when the connection is back" : "Saved ✓")
          : had ? "Saved ✓ (take another to replace it)" : "Optional: a photo of the finished cart"}</span></div>
        <label class="bt-cam">${pr || had ? "Retake" : "Take photo"}<input type="file" accept="image/*" capture="environment" onchange="BATCH.proofPick(this)"></label>
      </div>
      <div class="vfoot">
        ${S.confirm && !done ? `<div class="vconfirm"><b>${s.total - s.done} of ${s.total} lines aren't checked yet.</b> Mark this order picked anyway?
          <div class="row"><button onclick="BATCH.cancelConfirm()">Keep checking</button><button class="go" onclick="BATCH.markPicked(true)">Mark picked</button></div></div>` : ""}
        ${done ? `<button class="isdone" onclick="BATCH.undoPicked()">Picked ✓ · tap to undo</button>`
               : `<button class="${s.done === s.total ? "ready" : ""}" ${S.busy ? "disabled" : ""} onclick="BATCH.markPicked(false)">${S.busy ? "Saving…" : `Mark order picked${s.exc ? ` · ${s.exc} exception${s.exc > 1 ? "s" : ""}` : ""}`}</button>`}
      </div>`;
  }
  function render() {
    const host = el("screenBatch");
    if (!host || !S.b || host.classList.contains("hidden")) return;
    const y = window.scrollY;
    if (S.view === "check" && S.cur) renderCheck(host);
    else if (S.view === "sort" || S.view === "check") { S.view = "sort"; renderSort(host); }
    else renderPick(host);
    window.scrollTo(0, y);
  }
  function setFilter(f) { S.filter = f; render(); }
  function cancelConfirm() { S.confirm = false; render(); }

  return { listView, setOn, setMode, setSlot, toggle, start, resume, end, back, tab, retry, setFilter,
           mOk, mOut, mAdj, openCheck, cOk, cOut, cAdj, cSug, adjStep, adjInput, adjSub, adjReason, adjCancel, adjSave,
           proofPick, markPicked, undoPicked, cancelConfirm, finish, render,
           _S: S, _master: () => master(), _allocation: () => allocation() };   // _ = test hooks
})();
