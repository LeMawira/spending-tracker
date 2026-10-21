// Spending Tracker
// Privacy rules enforced here:
//  1. Every Gmail request is a search restricted to the configured bank senders.
//  2. Message requests ask only for body content (no headers, subject or sender details).
//  3. Only {amount, currency, time} is stored, keyed by message id. Email text is discarded.

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const KEYS = { tx: "st.tx", lastSync: "st.lastSync", senders: "st.senders", currency: "st.currency" };
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

// ---------- Week math ----------

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

function weeklyTotals(txs, currency) {
  const weeks = {};
  for (const tx of txs) {
    if (tx.c !== currency) continue;
    const w = mondayOf(tx.t);
    weeks[w] = (weeks[w] || 0) + tx.a;
  }
  return weeks;
}

if (typeof module !== "undefined") {
  module.exports = { parseAmount, parseDate, htmlToText, mondayOf, weeklyTotals, dayKey };
}

// ---------- Browser app ----------

if (typeof document !== "undefined") {
  const $ = (id) => document.getElementById(id);
  const cfg = window.APP_CONFIG || {};
  let token = null;
  let tokenExpiry = 0;
  let tokenClient = null;

  const load = (k, dflt) => {
    try { const v = localStorage.getItem(k); return v === null ? dflt : JSON.parse(v); } catch { return dflt; }
  };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  const getSenders = () => load(KEYS.senders, cfg.DEFAULT_SENDERS || []).filter((s) => EMAIL_RE.test(s));
  const getTxs = () => Object.values(load(KEYS.tx, {}));
  const setStatus = (msg) => { $("status").textContent = msg; };

  function fmt(amount) {
    const currency = $("currency").value;
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  }

  function fmtDay(ms, opts) {
    return new Date(ms).toLocaleDateString(undefined, opts);
  }

  function render() {
    const currency = $("currency").value;
    const txs = getTxs().filter((t) => t.c === currency);
    const thisMonday = mondayOf(Date.now());

    // Daily totals for the current week
    const byDay = {};
    for (const t of txs) byDay[dayKey(t.t)] = (byDay[dayKey(t.t)] || 0) + t.a;
    const today = dayKey(Date.now());
    let weekTotal = 0;
    const dayRows = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(thisMonday);
      d.setDate(d.getDate() + i);
      const k = dayKey(d.getTime());
      const v = byDay[k] || 0;
      weekTotal += v;
      const li = document.createElement("li");
      if (k === today) li.className = "today";
      li.append(span(fmtDay(d, { weekday: "short", day: "numeric", month: "short" })), span(fmt(v)));
      dayRows.push(li);
    }
    $("days").replaceChildren(...dayRows);
    $("week-total").textContent = fmt(weekTotal);
    const sunday = new Date(thisMonday);
    sunday.setDate(sunday.getDate() + 6);
    $("week-range").textContent = `${fmtDay(thisMonday, { day: "numeric", month: "short" })} – ${fmtDay(sunday, { day: "numeric", month: "short" })}`;

    // Past weeks, newest first
    const weeks = weeklyTotals(txs, currency);
    const past = Object.keys(weeks).map(Number).filter((w) => w < thisMonday).sort((a, b) => b - a);
    const weekRows = past.map((w) => {
      const li = document.createElement("li");
      li.append(span("Week of " + fmtDay(w, { day: "numeric", month: "short", year: "numeric" })), span(fmt(weeks[w])));
      return li;
    });
    if (!weekRows.length) {
      const li = document.createElement("li");
      li.append(span("No past weeks yet"));
      li.className = "muted";
      weekRows.push(li);
    }
    $("weeks").replaceChildren(...weekRows);
  }

  function span(text) {
    const s = document.createElement("span");
    s.textContent = text;
    return s;
  }

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
    const started = Date.now();
    try {
      const last = load(KEYS.lastSync, 0);
      const since = last ? last - 864e5 : started - (cfg.FIRST_SYNC_DAYS || 90) * 864e5;
      const q = `from:(${senders.join(" OR ")}) after:${Math.floor(since / 1000)}`;

      const ids = [];
      let pageToken = "";
      do {
        setStatus("Finding bank emails…");
        const page = await gmail(`/messages?q=${encodeURIComponent(q)}&maxResults=100${pageToken ? "&pageToken=" + pageToken : ""}`);
        (page.messages || []).forEach((m) => ids.push(m.id));
        pageToken = page.nextPageToken || "";
      } while (pageToken);

      const stored = load(KEYS.tx, {});
      const todo = ids.filter((id) => !stored[id]);
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
          stored[msg.id] = { a: amt.amount, c: amt.currency, t: parseDate(text, Number(msg.internalDate)) };
          added++;
        }
      }

      save(KEYS.tx, stored);
      save(KEYS.lastSync, started);
      setStatus(`Synced. ${added} new transaction${added === 1 ? "" : "s"}` + (unparsed ? `, ${unparsed} email${unparsed === 1 ? "" : "s"} skipped (no amount found).` : "."));
      render();
    } catch (e) {
      setStatus(e.message);
    } finally {
      $("sync").disabled = false;
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

  $("currency").value = load(KEYS.currency, "AED");
  $("currency").addEventListener("change", () => { save(KEYS.currency, $("currency").value); render(); });
  $("sync").addEventListener("click", onSyncClick);

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
