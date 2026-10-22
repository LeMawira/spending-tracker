// Spending Tracker
// Privacy rules enforced here:
//  1. Every Gmail request is a search restricted to the configured bank senders.
//  2. Message requests ask only for body content (no headers, subject or sender details).
//  3. Only {amount, currency, time, merchant} is stored, keyed by message id. Email text is discarded.

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const KEYS = { tx: "st.tx", lastSync: "st.lastSync", senders: "st.senders", currency: "st.currency", theme: "st.theme" };
const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// ---------- Parsing (pure functions) ----------

const NUM = "([0-9]{1,3}(?:,[0-9]{3})+(?:\\.[0-9]{1,2})?|[0-9]+(?:\\.[0-9]{1,2})?)";
const AMOUNT_PATTERNS = [
  { re: new RegExp("\\b(AED|USD|Dhs?)\\.?\\s*" + NUM, "i"), cur: 1, num: 2 },
  { re: new RegExp("(US\\$|\\$)\\s*" + NUM, "i"), cur: 1, num: 2 },
  { re: new RegExp(NUM + "\\s*(AED|USD|Dhs?)\\b", "i"), cur: 2, num: 1 },
];

function normCurrency(raw) {
  const s = raw.toUpperCase();
  return s === "AED" || s.startsWith("DH") ? "AED" : "USD";
}

// Returns {amount, currency} from the earliest currency amount in the text, or null.
function parseAmount(text) {
  let best = null;
  for (const p of AMOUNT_PATTERNS) {
    const m = p.re.exec(text);
    if (m && (!best || m.index < best.index)) {
      const amount = parseFloat(m[p.num].replace(/,/g, ""));
      if (amount > 0) best = { index: m.index, amount, currency: normCurrency(m[p.cur]) };
    }
  }
  return best && { amount: best.amount, currency: best.currency };
}

// Merchant: an explicit label ("Merchant: X") wins, otherwise the first sensible "at X" / "to X".
const MERCHANT_LEADS = [
  /\b(?:merchant|payee|beneficiary|description)(?:\s+name)?\s*[:\-]\s*/gi,
  /\b(?:at|to)\s+(?=[A-Za-z])/gi,
];
// Where a merchant name ends: a following keyword, punctuation + space, a date, an amount, or the end.
const MERCHANT_END = /\s+(?:on|at|for|with|using|via|from|ref|reference|card|dated?|amount|available|avail|balance|bal|txn|transaction|is|has|was|and)\b|[.,;:|()]\s|[.,;:|()]?$|\s+\d{1,2}[\/.\-]\d|\s+\d{4}-\d|\s+(?:AED|USD|Dhs?|US\$|\$)/i;
// Phrases that follow "at"/"to" in bank boilerplate rather than a merchant name.
const NOT_MERCHANT = /^(?:your|you|the|us|our|this|that|be|inform|notify|avoid|view|check|help|access|contact|call|keep|ensure|protect|report|confirm|use|log|reach|receive|make|let|see|learn|read|update|unsubscribe|any|all|time|least|www|http|customer|dear|account|card|a|an)\b/i;

function cleanMerchant(raw) {
  const end = MERCHANT_END.exec(raw);
  const s = (end ? raw.slice(0, end.index) : raw).replace(/\s+/g, " ").replace(/[\s\-–:*]+$/, "").trim();
  if (s.length < 2 || NOT_MERCHANT.test(s) || /^\d+$/.test(s) || s.includes("@")) return null;
  return s.length > 40 ? s.slice(0, 40).trim() + "…" : s;
}

// Returns the merchant name from the text, or null.
function parseMerchant(text) {
  for (const re of MERCHANT_LEADS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const from = m.index + m[0].length;
      const name = cleanMerchant(text.slice(from, from + 80));
      if (name) return name;
    }
  }
  return null;
}

function makeDate(y, mo, d, h, mi) {
  const dt = new Date(+y, mo, +d, h ? +h : 12, mi ? +mi : 0);
  return dt.getMonth() === mo && dt.getDate() === +d ? dt.getTime() : null;
}

// Returns the transaction time (ms) from the text, falling back to the email's received time.
// Dates written as dd/mm/yyyy are read day-first.
function parseDate(text, receivedMs) {
  let t = null;
  let m;
  if ((m = /\b(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(text))) {
    t = makeDate(m[1], m[2] - 1, m[3], m[4], m[5]);
  } else if ((m = /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})(?:[ ,]+(?:at\s+)?(\d{1,2}):(\d{2}))?/i.exec(text))) {
    t = makeDate(m[3], m[2] - 1, m[1], m[4], m[5]);
  } else if ((m = /\b(\d{1,2})[ \-]([A-Za-z]{3})[A-Za-z]*[ \-,]+(\d{4})(?:[ ,]+(?:at\s+)?(\d{1,2}):(\d{2}))?/.exec(text))) {
    const mo = MONTHS.indexOf(m[2].toLowerCase());
    if (mo >= 0) t = makeDate(m[3], mo, m[1], m[4], m[5]);
  }
  // Ignore dates far from when the email arrived (likely a footer or statement date).
  if (t === null || Math.abs(t - receivedMs) > 31 * 864e5) return receivedMs;
  return t;
}

function htmlToText(html) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#36;|&dollar;/g, "$")
    .replace(/\s+/g, " ");
}

// ---------- Week / month math ----------

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function mondayOf(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function monthOf(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

// Converts between AED and USD at a fixed rate (AED per 1 USD).
function convert(amount, from, to, usdToAed) {
  if (from === to) return amount;
  return to === "AED" ? amount * usdToAed : amount / usdToAed;
}

// Totals per week, with every transaction converted into `currency`.
function weeklyTotals(txs, currency, usdToAed) {
  const weeks = {};
  for (const tx of txs) {
    const w = mondayOf(tx.t);
    weeks[w] = (weeks[w] || 0) + convert(tx.a, tx.c, currency, usdToAed);
  }
  return weeks;
}

function monthlyTotals(txs, currency, usdToAed) {
  const months = {};
  for (const tx of txs) {
    const m = monthOf(tx.t);
    months[m] = (months[m] || 0) + convert(tx.a, tx.c, currency, usdToAed);
  }
  return months;
}

// Returns {start, end} (end exclusive) of the week or month `offset` periods from the one containing `now`.
function periodRange(kind, offset, now = Date.now()) {
  if (kind === "month") {
    const d = new Date(now);
    return {
      start: new Date(d.getFullYear(), d.getMonth() + offset, 1).getTime(),
      end: new Date(d.getFullYear(), d.getMonth() + offset + 1, 1).getTime(),
    };
  }
  const s = new Date(mondayOf(now));
  s.setDate(s.getDate() + offset * 7);
  const e = new Date(s);
  e.setDate(e.getDate() + 7);
  return { start: s.getTime(), end: e.getTime() };
}

if (typeof module !== "undefined") {
  module.exports = { parseAmount, parseMerchant, parseDate, htmlToText, mondayOf, monthOf, convert, weeklyTotals, monthlyTotals, periodRange, dayKey };
}

// ---------- Browser app ----------

if (typeof document !== "undefined") {
  const $ = (id) => document.getElementById(id);
  const cfg = window.APP_CONFIG || {};
  const SVG = "http://www.w3.org/2000/svg";
  const THEMES = ["auto", "light", "dark"];
  const HISTORY_LEN = 12;
  const RATE = cfg.USD_TO_AED || 3.6725;
  let token = null;
  let tokenExpiry = 0;
  let tokenClient = null;

  // UI state (not saved): selected period, how far back, chosen day, search text, sort order.
  const state = { period: "week", offset: 0, day: null, search: "", sort: "date" };

  const load = (k, dflt) => {
    try { const v = localStorage.getItem(k); return v === null ? dflt : JSON.parse(v); } catch { return dflt; }
  };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  const getSenders = () => load(KEYS.senders, cfg.DEFAULT_SENDERS || []).filter((s) => EMAIL_RE.test(s));
  const getTxs = () => Object.values(load(KEYS.tx, {}));
  const setStatus = (msg) => { $("status").textContent = msg; };
  // `v` is the amount converted into the selected currency (set in render()).
  const sum = (list) => list.reduce((s, t) => s + t.v, 0);
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function fmt(amount, currency = $("currency").value) {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  }

  function fmtDay(ms, opts) {
    return new Date(ms).toLocaleDateString(undefined, opts);
  }

  function fmtTime(ms) {
    return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  function span(text) {
    const s = document.createElement("span");
    s.textContent = text;
    return s;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVG, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  // Draws a bar chart into an <svg>. items: [{label, value, on, showLabel}]
  function drawBars(svg, items, onTap) {
    const W = 320, H = 110, top = 4, base = H - 18;
    const max = Math.max(0, ...items.map((it) => it.value));
    const slot = W / items.length;
    const bw = Math.max(3, Math.min(26, slot * 0.62));
    const r = Math.min(6, bw / 2);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.replaceChildren(...items.map((it, i) => {
      const x = i * slot + (slot - bw) / 2;
      const h = max ? Math.max(it.value ? 3 : 0, (it.value / max) * (base - top)) : 0;
      const g = svgEl("g", { class: "bar" + (it.on ? " on" : "") });
      g.append(svgEl("rect", { class: "track", x, y: top, width: bw, height: base - top, rx: r }));
      if (h) g.append(svgEl("rect", { class: "fill", x, y: base - h, width: bw, height: h, rx: r }));
      if (it.showLabel) {
        const t = svgEl("text", { x: x + bw / 2, y: H - 3, "text-anchor": "middle" });
        t.textContent = it.label;
        g.append(t);
      }
      g.append(svgEl("rect", { x: i * slot, y: 0, width: slot, height: H, fill: "transparent" }));
      g.addEventListener("click", () => onTap(it));
      return g;
    }));
  }

  function periodLabel(kind, offset, range) {
    if (kind === "week") {
      if (offset === 0) return "This week";
      if (offset === -1) return "Last week";
      return "Week of " + fmtDay(range.start, { day: "numeric", month: "short", year: "numeric" });
    }
    if (offset === 0) return "This month";
    return fmtDay(range.start, { month: "long", year: "numeric" });
  }

  function renderHero(list, range, all) {
    $("hero-label").textContent = periodLabel(state.period, state.offset, range);
    const total = sum(list);
    $("total").textContent = fmt(total);
    const last = new Date(range.end - 1);
    const rangeText = state.period === "week"
      ? `${fmtDay(range.start, { day: "numeric", month: "short" })} – ${fmtDay(last, { day: "numeric", month: "short" })}`
      : fmtDay(range.start, { month: "long", year: "numeric" });
    $("hero-meta").textContent = `${rangeText} · ${plural(list.length, "transaction")}`;

    // Change vs the previous period
    const prev = periodRange(state.period, state.offset - 1);
    const prevTotal = sum(all.filter((t) => t.t >= prev.start && t.t < prev.end));
    const pill = $("change");
    if (prevTotal > 0) {
      const pct = Math.round(((total - prevTotal) / prevTotal) * 100);
      pill.textContent = `${pct > 0 ? "▲" : pct < 0 ? "▼" : ""} ${Math.abs(pct)}% vs last ${state.period}`;
      pill.hidden = false;
    } else {
      pill.hidden = true;
    }

    // Daily bars
    const byDay = {};
    for (const t of list) byDay[dayKey(t.t)] = (byDay[dayKey(t.t)] || 0) + t.v;
    const today = dayKey(Date.now());
    const items = [];
    for (const d = new Date(range.start); d.getTime() < range.end; d.setDate(d.getDate() + 1)) {
      const key = dayKey(d.getTime());
      const date = d.getDate();
      items.push({
        key,
        ms: d.getTime(),
        value: byDay[key] || 0,
        on: state.day ? key === state.day : key === today,
        label: state.period === "week" ? fmtDay(d, { weekday: "narrow" }) : String(date),
        showLabel: state.period === "week" || date === 1 || date % 5 === 0,
      });
    }
    drawBars($("chart"), items, (it) => {
      state.day = state.day === it.key ? null : it.key;
      render();
    });

    const sel = items.find((it) => it.key === state.day);
    $("chart-tip").textContent = sel
      ? `${fmtDay(sel.ms, { weekday: "short", day: "numeric", month: "short" })} · ${fmt(sel.value)}`
      : "Tap a bar to see that day";
  }

  function txRow(t, sub) {
    const li = el("li", "tx");
    const name = t.m || "Unknown";
    const main = el("div", "tx-main");
    // Show the amount in the currency it was spent in, plus the converted estimate if different.
    if (t.c !== $("currency").value) sub += ` · ≈ ${fmt(t.v)}`;
    main.append(el("div", "tx-name", name), el("div", "tx-sub", sub));
    li.append(el("span", "avatar", t.m ? name[0].toUpperCase() : "?"), main, el("span", "tx-amt", fmt(t.a, t.c)));
    return li;
  }

  function renderTable(list) {
    const q = state.search.trim().toLowerCase();
    let rows = list;
    if (state.day) rows = rows.filter((t) => dayKey(t.t) === state.day);
    if (q) rows = rows.filter((t) => (t.m || "unknown").toLowerCase().includes(q));

    const chip = $("clear-day");
    chip.hidden = !state.day;
    if (state.day) chip.textContent = fmtDay(new Date(state.day + "T12:00"), { weekday: "short", day: "numeric", month: "short" }) + " ✕";

    const out = [];
    if (state.sort === "amount") {
      [...rows].sort((a, b) => b.v - a.v).forEach((t) => {
        out.push(txRow(t, `${fmtDay(t.t, { weekday: "short", day: "numeric", month: "short" })} · ${fmtTime(t.t)}`));
      });
    } else {
      const sorted = [...rows].sort((a, b) => b.t - a.t);
      let current = null;
      for (let i = 0; i < sorted.length; i++) {
        const k = dayKey(sorted[i].t);
        if (k !== current) {
          current = k;
          const dayTotal = sum(sorted.filter((t) => dayKey(t.t) === k));
          const head = el("li", "day-head");
          head.append(span(fmtDay(sorted[i].t, { weekday: "short", day: "numeric", month: "short" })), span(fmt(dayTotal)));
          out.push(head);
        }
        out.push(txRow(sorted[i], fmtTime(sorted[i].t)));
      }
    }
    if (!out.length) out.push(el("li", "empty", q ? "No matching transactions" : "No transactions in this period"));
    $("tx").replaceChildren(...out);
  }

  function renderTopMerchants(list) {
    const total = sum(list);
    const by = {};
    for (const t of list) {
      const name = t.m || "Unknown";
      by[name] = by[name] || { name, total: 0, count: 0 };
      by[name].total += t.v;
      by[name].count++;
    }
    const top = Object.values(by).sort((a, b) => b.total - a.total).slice(0, 5);
    const rows = top.map((m) => {
      const li = el("li");
      const row = el("div", "top-row");
      const name = el("div", "tx-main");
      name.append(el("div", "tx-name", m.name), el("div", "tx-sub", plural(m.count, "payment")));
      row.append(name, el("span", "tx-amt", fmt(m.total)));
      const bar = el("div", "share");
      const fill = el("span");
      fill.style.width = (total ? (m.total / total) * 100 : 0).toFixed(1) + "%";
      bar.append(fill);
      li.append(row, bar);
      return li;
    });
    if (!rows.length) rows.push(el("li", "empty", "Nothing spent in this period"));
    $("top").replaceChildren(...rows);
  }

  function renderHistory(all) {
    const isWeek = state.period === "week";
    $("history-title").textContent = isWeek ? "Weekly totals" : "Monthly totals";
    const totals = (isWeek ? weeklyTotals : monthlyTotals)(all, $("currency").value, RATE);
    // Show the latest periods, unless the selected one is further back than that.
    const end = state.offset > -HISTORY_LEN ? 0 : state.offset;
    const items = [];
    for (let off = end - HISTORY_LEN + 1; off <= end; off++) {
      const r = periodRange(state.period, off);
      items.push({
        off,
        value: totals[r.start] || 0,
        on: off === state.offset,
        label: isWeek ? fmtDay(r.start, { day: "numeric", month: "short" }) : fmtDay(r.start, { month: "short" }),
        showLabel: !isWeek || (off - end) % 3 === 0,
      });
    }
    drawBars($("history"), items, (it) => {
      state.offset = it.off;
      state.day = null;
      render();
    });

    // Average of completed periods that had spending
    const done = items.filter((it) => it.off < 0 && it.value > 0);
    $("history-avg").textContent = done.length
      ? `Avg ${fmt(done.reduce((s, it) => s + it.value, 0) / done.length)} / ${state.period}`
      : "";
  }

  function render() {
    const currency = $("currency").value;
    const other = currency === "AED" ? "USD" : "AED";
    const all = getTxs().map((t) => ({ ...t, v: convert(t.a, t.c, currency, RATE) }));
    $("rate-note").textContent = `Totals in ${currency}. ${other} transactions are converted at a fixed rate `
      + `(1 USD = ${RATE} AED), so totals are estimates.`;
    const range = periodRange(state.period, state.offset);
    const list = all.filter((t) => t.t >= range.start && t.t < range.end);

    document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.period === state.period));
    $("next").disabled = state.offset >= 0;

    renderHero(list, range, all);
    renderTable(list);
    renderTopMerchants(list);
    renderHistory(all);
  }

  // ---------- Theme ----------

  function applyTheme(mode) {
    if (mode === "light" || mode === "dark") document.documentElement.dataset.theme = mode;
    else delete document.documentElement.dataset.theme;
    $("theme").dataset.mode = mode;
    $("theme").setAttribute("aria-label", "Theme: " + mode);
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    document.querySelector('meta[name="theme-color"]').setAttribute("content", bg);
  }

  // ---------- Gmail sync ----------

  async function gmail(path) {
    const res = await fetch(API + path, { headers: { Authorization: "Bearer " + token } });
    if (res.status === 401) { token = null; throw new Error("Session expired, tap Sync again."); }
    if (!res.ok) throw new Error("Gmail error " + res.status);
    return res.json();
  }

  function decodeB64Url(data) {
    const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  // Walks MIME parts and returns plain text, preferring text/plain over text/html.
  function bodyText(payload) {
    let plain = "";
    let html = "";
    (function walk(p) {
      if (!p) return;
      if (p.body && p.body.data) {
        if (p.mimeType === "text/plain") plain += decodeB64Url(p.body.data) + " ";
        else if (p.mimeType === "text/html") html += decodeB64Url(p.body.data) + " ";
      }
      (p.parts || []).forEach(walk);
    })(payload);
    return plain.trim() ? plain.replace(/\s+/g, " ") : htmlToText(html);
  }

  async function sync() {
    const senders = getSenders();
    if (!senders.length) { setStatus("Add your bank's sender email in Settings first."); return; }

    $("sync").disabled = true;
    $("sync").classList.add("loading");
    const started = Date.now();
    try {
      const stored = load(KEYS.tx, {});
      // Transactions saved before merchants were tracked have no `m`: re-read those emails once.
      const old = Object.values(stored).filter((t) => !("m" in t));
      const last = old.length ? 0 : load(KEYS.lastSync, 0);
      let since = last ? last - 864e5 : started - (cfg.FIRST_SYNC_DAYS || 90) * 864e5;
      if (old.length) since = Math.min(since, ...old.map((t) => t.t - 864e5));
      const q = `from:(${senders.join(" OR ")}) after:${Math.floor(since / 1000)}`;

      const ids = [];
      let pageToken = "";
      do {
        setStatus("Finding bank emails…");
        const page = await gmail(`/messages?q=${encodeURIComponent(q)}&maxResults=100${pageToken ? "&pageToken=" + pageToken : ""}`);
        (page.messages || []).forEach((m) => ids.push(m.id));
        pageToken = page.nextPageToken || "";
      } while (pageToken);

      const todo = ids.filter((id) => !stored[id] || !("m" in stored[id]));
      // Request only body parts and received time: no headers, subject or sender details.
      const part = "mimeType,body/data";
      const fields = `id,internalDate,payload(${part},parts(${part},parts(${part},parts(${part}))))`;

      let added = 0;
      let unparsed = 0;
      for (let i = 0; i < todo.length; i += 5) {
        setStatus(`Reading ${Math.min(i + 5, todo.length)} of ${todo.length}…`);
        const batch = await Promise.all(
          todo.slice(i, i + 5).map((id) => gmail(`/messages/${id}?format=full&fields=${encodeURIComponent(fields)}`))
        );
        for (const msg of batch) {
          const text = bodyText(msg.payload);
          const amt = parseAmount(text);
          if (!amt) { unparsed++; continue; }
          if (!stored[msg.id]) added++;
          stored[msg.id] = { a: amt.amount, c: amt.currency, t: parseDate(text, Number(msg.internalDate)), m: parseMerchant(text) };
        }
      }

      save(KEYS.tx, stored);
      save(KEYS.lastSync, started);
      setStatus(`Synced. ${plural(added, "new transaction")}` + (unparsed ? `, ${plural(unparsed, "email")} skipped (no amount found).` : "."));
      render();
    } catch (e) {
      setStatus(e.message);
    } finally {
      $("sync").disabled = false;
      $("sync").classList.remove("loading");
    }
  }

  function onSyncClick() {
    if (token && Date.now() < tokenExpiry) return sync();
    if (!window.google || !google.accounts) { setStatus("Google sign-in is still loading, try again."); return; }
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: cfg.GOOGLE_CLIENT_ID,
        scope: SCOPE,
        callback: (resp) => {
          if (resp.error) { setStatus("Sign-in failed: " + resp.error); return; }
          token = resp.access_token;
          tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
          sync();
        },
      });
    }
    tokenClient.requestAccessToken({ prompt: "" });
  }

  // ---------- Wire up ----------

  applyTheme(load(KEYS.theme, "auto"));
  $("theme").addEventListener("click", () => {
    const next = THEMES[(THEMES.indexOf($("theme").dataset.mode) + 1) % THEMES.length];
    save(KEYS.theme, next);
    applyTheme(next);
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme($("theme").dataset.mode));

  $("currency").value = load(KEYS.currency, "AED");
  $("currency").addEventListener("change", () => { save(KEYS.currency, $("currency").value); render(); });
  $("sync").addEventListener("click", onSyncClick);

  document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
    state.period = b.dataset.period;
    state.offset = 0;
    state.day = null;
    render();
  }));
  $("prev").addEventListener("click", () => { state.offset--; state.day = null; render(); });
  $("next").addEventListener("click", () => { if (state.offset < 0) { state.offset++; state.day = null; render(); } });
  $("clear-day").addEventListener("click", () => { state.day = null; render(); });
  $("search").addEventListener("input", () => { state.search = $("search").value; render(); });
  $("sort").addEventListener("change", () => { state.sort = $("sort").value; render(); });

  $("senders").value = getSenders().join("\n");
  $("save-senders").addEventListener("click", () => {
    const list = $("senders").value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const bad = list.filter((s) => !EMAIL_RE.test(s));
    if (bad.length) { setStatus("Not a valid email: " + bad.join(", ")); return; }
    save(KEYS.senders, list);
    save(KEYS.lastSync, 0); // re-scan history for newly added senders
    setStatus("Saved " + list.length + " sender" + (list.length === 1 ? "" : "s") + ".");
  });

  $("clear").addEventListener("click", () => {
    if (!confirm("Delete all saved transactions on this device?")) return;
    [KEYS.tx, KEYS.lastSync].forEach((k) => { try { localStorage.removeItem(k); } catch {} });
    render();
    setStatus("All data cleared.");
  });

  render();
}
