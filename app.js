// FOMO Desk · plan B app. View-only except the PAPER/LIVE switch.
// #d= (data path) is saved only to this device's localStorage.
// A one-time #code= is exchanged for a device token, then stripped. Legacy #t= still works.
(function () {
  "use strict";

  var STORAGE_KEY = "desk_data_path";
  var TOKEN_KEY = "desk_app_token";
  var POLL_MS = 15000;
  var CORE_FILES = [
    "state.json", "positions.json", "activity.json", "chart.json",
    "history.json", "bots.json", "account.json", "screen.json",
    "copy_picks.json", "settings.json"
  ];

  var reduced = false;
  try {
    reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (e) {}

  var dataPath = "";
  var store = {};
  var lastGoodAt = null;
  var offline = false;
  var retryIn = 0;
  var route = { page: "home" };
  var searchOpen = false;
  var searchQ = "";
  var chartRange = "LIVE";
  var liveBuf = 0;
  var seenActivityId = 0;
  var pollTimer = null;
  var tickTimer = null;
  var appToken = "";
  var modePending = false;
  var modeError = "";
  var modeBusy = false;
  var modeWanted = "";
  var modeIgnoreClicksUntil = 0;
  var pairingStatus = "";
  var pairingBusy = false;

  var $app = document.getElementById("app");
  var $offline = document.getElementById("offline");
  var $tabbar = document.getElementById("tabbar");

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function readDataPath() {
    var raw = (location.hash || "").replace(/^#/, "");
    var path = "";
    if (raw) {
      var params = new URLSearchParams(raw);
      path = (params.get("d") || "").trim();
    }
    if (path) {
      try { localStorage.setItem(STORAGE_KEY, path); } catch (e) {}
      return path;
    }
    try { return (localStorage.getItem(STORAGE_KEY) || "").trim(); } catch (e) { return ""; }
  }

  function readToken() {
    var raw = (location.hash || "").replace(/^#/, "");
    var token = "";
    if (raw) {
      var params = new URLSearchParams(raw);
      token = (params.get("t") || params.get("token") || "").trim();
    }
    if (token) {
      try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {}
      return token;
    }
    try { return (localStorage.getItem(TOKEN_KEY) || "").trim(); } catch (e) { return ""; }
  }

  function readPairCode() {
    var raw = (location.hash || "").replace(/^#/, "");
    if (!raw) return "";
    var params = new URLSearchParams(raw);
    return (params.get("code") || params.get("pair") || "").trim();
  }

  function storeToken(token) {
    token = String(token || "").trim();
    if (!token) return;
    try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {}
    appToken = token;
  }

  function writeHash() {
    var params = new URLSearchParams();
    // Keep d= out of the visible hash after first save so we never leak it
    // into shared screenshots of inner pages; it's already in localStorage.
    if (route.page && route.page !== "home") params.set("p", route.page);
    if (route.mint) params.set("mint", route.mint);
    if (route.tab) params.set("tab", route.tab);
    if (chartRange && chartRange !== "LIVE") params.set("range", chartRange);
    var next = params.toString();
    var cur = (location.hash || "").replace(/^#/, "");
    // Preserve a first-visit d= if that's all that's there and we haven't stored yet — already stored.
    var cleaned = cur;
    if (cleaned.indexOf("d=") === 0 || cleaned.indexOf("&d=") !== -1 || cleaned.indexOf("t=") !== -1 || cleaned.indexOf("token=") !== -1 || cleaned.indexOf("code=") !== -1 || cleaned.indexOf("pair=") !== -1) {
      var keep = new URLSearchParams(cleaned);
      keep.delete("d");
      keep.delete("t");
      keep.delete("token");
      keep.delete("code");
      keep.delete("pair");
      cleaned = keep.toString();
    }
    if (next !== cleaned) {
      history.replaceState(null, "", next ? "#" + next : location.pathname + location.search);
    }
  }

  function readRoute() {
    var raw = (location.hash || "").replace(/^#/, "");
    var p = new URLSearchParams(raw);
    // Strip d= from the address bar once saved
    if (p.get("d")) p.delete("d");
    if (p.get("t")) p.delete("t");
    if (p.get("token")) p.delete("token");
    if (p.get("code")) p.delete("code");
    if (p.get("pair")) p.delete("pair");
    route.page = p.get("p") || p.get("tab") || "home";
    route.mint = p.get("mint") || null;
    if (p.get("range")) chartRange = p.get("range");
    var tabs = { home: 1, bots: 1, activity: 1, account: 1 };
    if (!tabs[route.page] && route.page !== "coin" && route.page !== "audit" && route.page !== "live" && route.page !== "picks") {
      route.page = "home";
    }
  }

  function go(page, extra) {
    route = { page: page };
    if (extra) {
      if (extra.mint) route.mint = extra.mint;
    }
    writeHash();
    render();
    if ((page === "coin" || page === "audit") && route.mint) loadCoin(route.mint);
  }

  function relayUrl(name) {
    var base = window.DESK_RELAY_BASE;
    if (!base || !dataPath) return "";
    return base.replace(/\/$/, "") + "/storage/v1/object/public/desk/d/" +
      encodeURIComponent(dataPath) + "/" + name + "?cb=" + Date.now();
  }

  function fetchJson(name) {
    var url = relayUrl(name);
    if (!url) return Promise.reject(new Error("no url"));
    return fetch(url, { cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error("http " + res.status);
      return res.json();
    });
  }

  function fmtMoney(n, digits) {
    if (n == null || !isFinite(Number(n))) return "—";
    var d = digits == null ? 2 : digits;
    return Number(n).toLocaleString(undefined, {
      style: "currency", currency: "USD",
      minimumFractionDigits: d, maximumFractionDigits: d
    });
  }

  function fmtPct(n, digits) {
    if (n == null || !isFinite(Number(n))) return "—";
    var d = digits == null ? 2 : digits;
    var v = Number(n);
    var sign = v > 0 ? "+" : "";
    return sign + v.toFixed(d) + "%";
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    var t = typeof iso === "number" ? iso * (iso < 1e12 ? 1000 : 1) : Date.parse(iso);
    if (!isFinite(t)) return "—";
    return new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  function fmtAgo(isoOrTs) {
    if (isoOrTs == null || isoOrTs === "") return "—";
    var t = typeof isoOrTs === "number" ? isoOrTs * (isoOrTs < 1e12 ? 1000 : 1) : Date.parse(isoOrTs);
    if (!isFinite(t)) return "—";
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  function fmtAge(openedAt) {
    if (openedAt == null) return "";
    var t = typeof openedAt === "number" ? openedAt * (openedAt < 1e12 ? 1000 : 1) : Date.parse(openedAt);
    if (!isFinite(t)) return "";
    var h = (Date.now() - t) / 3600000;
    if (h < 1) return Math.max(1, Math.round(h * 60)) + "m old";
    if (h < 24) return Math.round(h) + "h old";
    return Math.round(h / 24) + "d old";
  }

  function currentMode() {
    return String((store.state && store.state.mode) || (store.account && store.account.mode) || "").toUpperCase();
  }

  function isPaper() {
    return currentMode() === "PAPER";
  }

  function paperPill() {
    return isPaper() ? '<span class="pill blue">PAPER</span>' : "";
  }

  function modePill() {
    var mode = currentMode();
    if (mode === "PAPER") return '<span class="pill blue">PAPER</span>';
    if (mode === "LIVE") return '<span class="pill red">LIVE</span>';
    return "";
  }

  function modeSwitchHtml() {
    var mode = modePending && modeWanted ? modeWanted : currentMode();
    var busy = modePending || modeBusy;
    var pending = modePending ? '<div class="ask">Switching to ' + esc(modeWanted || mode) + "…</div>" : "";
    var err = (!modePending && modeError) ? '<div class="ask">' + esc(modeError) + "</div>" : "";
    var pair = pairingStatus ? '<div class="ask">' + esc(pairingStatus) + "</div>" : "";
    return '<div class="mode-wrap">' +
      '<div class="mode-switch" role="group" aria-label="Desk mode">' +
        '<button type="button" data-act="mode" data-mode="PAPER" class="paper' + (mode === "PAPER" ? " on" : "") + '"' + (busy ? " disabled" : "") + ">PAPER</button>" +
        '<button type="button" data-act="mode" data-mode="LIVE" class="live' + (mode === "LIVE" ? " on" : "") + '"' + (busy ? " disabled" : "") + ">LIVE</button>" +
      "</div>" + pending + err + pair +
    "</div>";
  }

  function askNote() {
    return '<div class="ask">Ask in chat to change</div>';
  }

  function setOffline(on, seconds) {
    offline = !!on;
    retryIn = seconds || 0;
    if (!on) {
      $offline.classList.add("hidden");
      $offline.textContent = "";
      return;
    }
    var last = lastGoodAt ? fmtTime(new Date(lastGoodAt).toISOString()) : "—";
    $offline.textContent = "Desk offline · retrying in " + (retryIn || 15) + "s · last update " + last;
    $offline.classList.remove("hidden");
  }

  function botColor(name) {
    return ({
      scanner: "#64d2ff", analyst: "#ffd60a", brain: "#bf5af2",
      executor: "#00d35a", risk: "#ff6b9a"
    })[String(name || "").toLowerCase()] || "#fff";
  }

  function cap(s) {
    s = String(s || "");
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function odometerHtml(value) {
    var text = fmtMoney(value);
    if (reduced || value == null) return '<div class="odometer num">' + esc(text) + "</div>";
    var html = '<div class="odometer num" data-value="' + esc(text) + '">';
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (/\d/.test(ch)) {
        var digits = "0123456789".split("").map(function (d) { return '<i style="display:block;height:1em;line-height:1;font-style:normal">' + d + '</i>'; }).join("");
        html += '<span class="digit" data-d="' + ch + '" style="display:inline-block;height:1em;overflow:hidden;vertical-align:top"><span style="display:flex;flex-direction:column;transform:translateY(-' + Number(ch) + 'em)">' + digits + '</span></span>';
      } else {
        html += "<span>" + esc(ch) + "</span>";
      }
    }
    return html + "</div>";
  }

  function rollOdometer(el, nextValue) {
    var text = fmtMoney(nextValue);
    if (!el) return;
    if (reduced) { el.textContent = text; return; }
    if (el.getAttribute("data-value") !== text) {
      el.outerHTML = odometerHtml(nextValue);
    }
  }

  /* ---------- polling ---------- */

  function loadCore() {
    if (!dataPath || !window.DESK_RELAY_BASE) return Promise.resolve();
    var failed = 0;
    return Promise.all(CORE_FILES.map(function (name) {
      return fetchJson(name).then(function (data) {
        var key = name.replace(/\.json$/, "");
        store[key] = data;
      }).catch(function () { failed += 1; });
    })).then(function () {
      if (failed === CORE_FILES.length) {
        setOffline(true, 15);
      } else {
        lastGoodAt = Date.now();
        setOffline(false);
        var act = ((store.activity || {}).rows || [])[0];
        if (act && act.id && act.id > seenActivityId) {
          /* keep the previous id so the bell can light; first load seeds it */
          if (!loadCore._seeded) { seenActivityId = act.id; loadCore._seeded = true; }
        }
      }
      if (route.page === "coin" || route.page === "audit") {
        if (route.mint) return loadCoin(route.mint, true);
      }
    });
  }

  function loadCoin(mint, silent) {
    if (!mint) return Promise.resolve();
    store.coins = store.coins || {};
    store.candles = store.candles || {};
    store.audits = store.audits || {};
    return Promise.all([
      fetchJson("coin/" + mint + ".json").then(function (d) { store.coins[mint] = d; }).catch(function () {}),
      fetchJson("coin/" + mint + ".candles.json").then(function (d) { store.candles[mint] = d; }).catch(function () {}),
      fetchJson("audit/" + mint + ".json").then(function (d) { store.audits[mint] = d; }).catch(function () {})
    ]).then(function () {
      if (!silent) render();
      else if (route.mint === mint) paintCharts();
    });
  }

  /* ---------- chrome ---------- */

  function navbar(title, opts) {
    opts = opts || {};
    var back = opts.back
      ? '<button type="button" class="icon-btn" data-act="back" aria-label="Back">‹</button>'
      : '<button type="button" class="icon-btn" data-act="account" aria-label="Account"><span class="avatar">G</span></button>';
    var mid = opts.brand
      ? '<div class="title">Grok Bot ›</div>'
      : '<div class="title">' + esc(title || "") + (opts.paper ? " " + paperPill() : "") + "</div>";
    var right = "";
    if (opts.search) {
      right += '<button type="button" class="icon-btn" data-act="search" aria-label="Search">⌕</button>';
    }
    if (opts.bell) {
      var act = ((store.activity || {}).rows || [])[0];
      var dot = act && act.id && act.id > seenActivityId ? '<span class="bell-dot"></span>' : "";
      right += '<button type="button" class="icon-btn" data-act="activity" aria-label="Activity">bell' + dot + "</button>";
    }
    // replace the word "bell" with a simple glyph
    right = right.replace(">bell", ">⌁");
    return '<div class="navbar">' + back + mid + right + "</div>";
  }

  function showTabbar(on) {
    $tabbar.hidden = !on;
    $all(".tab-btn", $tabbar).forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-tab") === route.page);
    });
  }

  /* ---------- screens ---------- */

  function skeleton() {
    return navbar("Grok Bot ›", { brand: true }) +
      '<div class="skel block"></div><div class="skel line"></div><div class="skel line"></div>' +
      '<div class="skel block"></div><div class="skel block"></div>';
  }

  function needPathHtml() {
    return navbar("Grok Bot ›", { brand: true }) +
      '<div class="empty">Open the full desk link on this phone to start the live feed.</div>';
  }

  function activityRows(rows, limit) {
    rows = rows || [];
    if (limit) rows = rows.slice(0, limit);
    if (!rows.length) return "";
    return rows.map(function (r) {
      var kind = r.kind || "";
      var valClass = "right num";
      if (kind === "sold" || (r.value && String(r.value).charAt(0) === "+")) valClass += " green";
      if (kind === "stopped" || (r.value && String(r.value).indexOf("-") !== -1)) valClass += " red";
      var act = (kind === "rejected") ? "audit" : "coin";
      var mint = r.mint ? ' data-act="' + act + '" data-mint="' + esc(r.mint) + '"' : "";
      var fomo = r.link
        ? '<a class="btn" style="min-height:36px;padding:0 10px;font-size:13px;margin-top:6px" href="' + esc(r.link) + '" target="_blank" rel="noopener">Open on FOMO</a>'
        : "";
      return '<div class="row-44"' + mint + ">" +
        '<div class="left"><div>' + esc(r.title || kind || "—") + "</div>" +
        '<div class="sub">' + esc(r.subtitle || fmtTime(r.ts)) + "</div>" + fomo + "</div>" +
        '<div class="' + valClass + '">' + esc(r.value == null ? "" : r.value) + "</div></div>";
    }).join("");
  }

  function botMini(b) {
    var st = (b && b.status) || "stale";
    return '<div class="bot-mini" data-act="bots">' +
      '<div class="bot-name" style="color:' + botColor(b.name) + '">' +
      '<span class="dot-status ' + esc(st) + '"></span>' + esc(cap(b.name)) + "</div>" +
      '<div class="bot-status">' + esc(st) + "</div></div>";
  }

  function homeHtml() {
    var st = store.state || {};
    var screen = store.screen || {};
    var bots = (st.bots || (store.bots || {}).bots || []);
    var running = bots.filter(function (b) { return b.status === "running"; }).length;
    var act = (store.activity || {}).rows || [];
    var today = st.today_pct;
    var todayCls = today > 0 ? "up" : (today < 0 ? "down" : "");
    var todayTxt = today == null ? "" : '<span class="pct ' + todayCls + ' num">' + esc(fmtPct(today)) + "</span>";
    var mult = st.multiplier;
    var multTxt = (mult != null && isFinite(Number(mult)))
      ? '<span class="pill">' + esc(Number(mult).toFixed(2) + "×") + "</span>" : "";
    var liveLabel = screen.label || "Last frame —";
    var liveOn = !!screen.live;
    var lane = screen.lane || {};
    var laneTxt = lane.bot
      ? (cap(lane.bot) + (lane.status ? " · " + lane.status : ""))
      : (lane.status || "Idle");
    var laneColor = lane.bot ? botColor(lane.bot) : "var(--secondary)";
    var last = screen.last_order;
    var checks = "";
    if (last && last.checks) {
      ["screen", "api", "chain"].forEach(function (k) {
        var v = last.checks[k];
        var cls = v === true ? "ok" : (v === false ? "no" : "");
        var mark = v === true ? "✓" : (v === false ? "×" : "·");
        checks += '<span class="check ' + cls + '">' + k + " " + mark + "</span>";
      });
    }
    var lastLine = last
      ? esc((last.verdict === "done" || last.status === "done" ? "Bought" : cap(last.status || last.verdict || "Order")) +
          (last.mint ? "" : "") +
          (last.usd != null ? " · " + fmtMoney(last.usd) : "") +
          (last.status === "done" ? " · verified" : ""))
      : "No order yet";
    var emptyHome = (!act.length && !(st.positions || []).length)
      ? '<div class="empty">Waiting for the first trade</div>' : "";

    var search = "";
    if (searchOpen) {
      search = '<div class="search-wrap"><input id="q" type="search" placeholder="Name, symbol or mint" value="' +
        esc(searchQ) + '"></div><div class="feed">' + searchResults() + "</div>";
    }

    return navbar("Grok Bot ›", { brand: true, search: true, bell: true }) + search +
      '<div class="balance-block"><div class="balance-row">' + odometerHtml(st.balance) + modePill() + "</div>" +
      '<div class="today">' + todayTxt + multTxt + "</div>" +
      (st.note ? '<div class="desk-note">' + esc(st.note) + "</div>" : "") +
      modeSwitchHtml() +
      "</div>" +
      '<div class="ranges">' +
        ["LIVE", "1H", "4H", "1D", "1W", "ALL"].map(function (r) {
          return '<button type="button" data-act="range" data-range="' + r + '" class="' + (chartRange === r ? "on" : "") + '">' + r + "</button>";
        }).join("") +
      "</div>" +
      '<div class="chart-wrap"><canvas id="home-chart"></canvas></div>' +
      '<div class="section"><div class="section-h">Live screen</div>' +
        '<div class="card live-card" data-act="live">' +
          '<div class="live-frame" id="live-frame">' +
            '<div class="live-ph">' + esc(liveLabel) + "</div>" +
            '<img id="live-a" alt="">' +
            '<img id="live-b" alt="">' +
            '<div class="live-overlay"><span><span class="live-dot' + (liveOn ? " on" : "") + '"></span>' +
            esc(liveOn ? "Live · Bot's computer" : liveLabel) + "</span>" +
            '<span style="color:' + laneColor + '">' + esc(laneTxt) + "</span></div>" +
          "</div>" +
          '<div class="live-under">' + lastLine + '<span class="checks">' + checks + "</span></div>" +
        "</div></div>" +
      '<div class="section"><div class="section-h">Bots · ' + running + ' running <span class="more" data-act="bots">See all</span></div>' +
        '<div class="carousel">' + bots.map(botMini).join("") + "</div></div>" +
      '<div class="section"><div class="section-h">Activity <span class="more" data-act="activity">See all</span></div>' +
        '<div class="feed">' + (act.length ? activityRows(act, 5) : emptyHome || '<div class="empty">Nothing yet tonight</div>') + "</div></div>";
  }

  function searchResults() {
    var q = (searchQ || "").trim().toLowerCase();
    if (!q) return '<div class="dim" style="padding:8px 0">Type a name, symbol or mint.</div>';
    var hits = [];
    function add(row) {
      if (!row) return;
      var blob = ((row.name || "") + " " + (row.symbol || "") + " " + (row.mint || "") + " " + (row.title || "")).toLowerCase();
      if (blob.indexOf(q) !== -1) hits.push(row);
    }
    ((store.state || {}).positions || []).forEach(add);
    ((store.activity || {}).rows || []).forEach(add);
    var seen = {};
    var html = "";
    hits.forEach(function (h) {
      var mint = h.mint;
      if (!mint || seen[mint]) return;
      seen[mint] = 1;
      html += '<div class="search-hit" data-act="coin" data-mint="' + esc(mint) + '">' +
        "<div>" + esc(h.name || h.symbol || h.title || mint.slice(0, 6)) +
        '<div class="sub">' + esc(h.symbol || mint.slice(0, 8)) + "</div></div></div>";
    });
    return html || '<div class="dim" style="padding:8px 0">No matches.</div>';
  }

  function decisionLine(d) {
    var title = d.verdict || d.reason || d.title || "decision";
    var mint = d.mint;
    var link = d.link
      ? '<a href="' + esc(d.link) + '" target="_blank" rel="noopener">Open on FOMO</a>'
      : "";
    var open = mint ? ' data-act="coin" data-mint="' + esc(mint) + '"' : "";
    return '<div class="row-44"' + open + '><div class="left">' + esc(title) +
      (d.reason && d.verdict ? '<div class="sub">' + esc(d.reason) + "</div>" : "") +
      (link ? '<div class="sub">' + link + "</div>" : "") +
      '</div><div class="right">' + esc(fmtTime(d.ts)) + "</div></div>";
  }

  function botsHtml() {
    var pack = store.bots || {};
    var bots = pack.bots || (store.state || {}).bots || [];
    var dec = pack.decisions || {};
    var posOpen = ((store.state || {}).positions || []).length > 0;
    var settingsLink = '<div class="section"><button type="button" class="btn wide" data-act="account">Settings</button></div>';
    var html = navbar("Bots") + settingsLink;
    bots.forEach(function (b) {
      var name = b.name;
      var list = dec[name] || [];
      var count = list.length;
      var locked = name === "risk" && posOpen;
      var pauseLabel = b.paused || b.status === "paused" ? "Paused" : "Running";
      html += '<div class="section"><div class="bot-full">' +
        '<div class="bot-name" style="color:' + botColor(name) + '">' +
        '<span class="dot-status ' + esc(b.status || "") + '"></span>' + esc(cap(name)) + "</div>" +
        '<div class="bot-status">Today · ' + count + " recorded</div>" +
        '<div class="row-44"><div>Status</div><div class="pill grey">' + esc(pauseLabel) +
        (locked ? " · Risk locked while a position is open" : "") + "</div></div>" +
        askNote() +
        '<div class="sub" style="margin:10px 0 4px">Last 20 decisions</div>' +
        (list.length ? list.map(decisionLine).join("") : '<div class="dim">No decisions yet.</div>') +
        "</div></div>";
    });
    return html;
  }

  function activityHtml() {
    var rows = (store.activity || {}).rows || [];
    return navbar("Activity") +
      '<div class="feed" style="padding-top:8px">' +
      (rows.length ? activityRows(rows) : '<div class="empty">Nothing yet tonight</div>') +
      "</div>";
  }

  function coinHtml() {
    var mint = route.mint;
    var coin = (store.coins || {})[mint] || {};
    var posList = (store.state || {}).positions || [];
    var pos = coin.position || posList.filter(function (p) { return p.mint === mint; })[0];
    var name = coin.name || coin.symbol || (pos && (pos.name || pos.symbol)) || (mint ? mint.slice(0, 6) : "Coin");
    var symbol = coin.symbol || (pos && pos.symbol) || "";
    var price = coin.price != null ? coin.price : (pos && pos.price);
    var since = "";
    if (pos && pos.entry_price && price != null && pos.entry_price) {
      var pct = (price / pos.entry_price - 1) * 100;
      since = '<div class="' + (pct >= 0 ? "green" : "red") + ' num">' + (pct >= 0 ? "▲ " : "▼ ") + esc(fmtPct(pct)) + " since entry</div>";
    }
    var audit = (store.audits || {})[mint] || {};
    var layers = audit.layers || [];
    var passed = layers.filter(function (l) { return l.pass === true; }).length;
    var shield = layers.length ? passed + "/" + layers.length : "—";
    var link = coin.link || (pos && pos.link);
    var age = pos ? fmtAge(pos.opened_at) : "";
    var meta = [symbol, "Solana", age].filter(Boolean).join(" · ");
    return navbar(name, { back: true, paper: true }) +
      '<div class="balance-block">' +
        '<div class="sub">' + esc(meta) + ' · <span class="pill grey" data-act="audit" data-mint="' + esc(mint) + '">shield ' + esc(shield) + "</span></div>" +
        '<div class="odometer num" style="font-size:44px">' + esc(price == null ? "—" : fmtMoney(price, price < 1 ? 6 : 4)) + "</div>" +
        since +
      "</div>" +
      '<div class="coin-chart"><canvas id="coin-chart"></canvas></div>' +
      '<div class="tiles">' +
        tile("Market cap", coin.market_cap != null ? fmtMoney(coin.market_cap, 0) : "—") +
        tile("Liquidity", coin.liquidity_usd != null ? fmtMoney(coin.liquidity_usd, 0) : "—") +
        tile("Holders", coin.holders != null ? String(coin.holders) : "—") +
        tile("24H vol", coin.volume_m5 != null ? fmtMoney(coin.volume_m5, 0) + " (5m)" : "—") +
      "</div>" +
      (pos ? '<div class="section"><div class="card"><div>Your position · ' +
        esc(pos.size_usd != null ? fmtMoney(pos.size_usd) + " in" : "—") +
        " · Executor</div>" +
        '<div class="sub">Tokens ' + esc(pos.tokens != null ? String(pos.tokens) : "—") +
        (pos.pnl_usd != null ? " · " + fmtMoney(pos.pnl_usd) : "") + "</div></div></div>" : "") +
      '<div class="section stack">' +
        (link ? '<a class="btn blue wide" href="' + esc(link) + '" target="_blank" rel="noopener">Open on FOMO</a>' : "") +
        '<button type="button" class="btn wide" data-act="audit" data-mint="' + esc(mint) + '">Audit</button>' +
        askNote() +
      "</div>";
  }

  function tile(k, v) {
    return '<div class="tile"><div class="k">' + esc(k) + '</div><div class="v num">' + esc(v) + "</div></div>";
  }

  function auditHtml() {
    var mint = route.mint;
    var audit = (store.audits || {})[mint] || {};
    var coin = (store.coins || {})[mint] || {};
    var name = coin.name || coin.symbol || (mint ? mint.slice(0, 6) : "Audit");
    var layers = audit.layers || [];
    var discs = '<div class="discs">' + layers.map(function (l, i) {
      var cls = l.pass === true ? "ok" : (l.pass === false ? "no" : "");
      return '<div class="disc ' + cls + '">' + (l.n != null ? l.n : i + 1) + "</div>";
    }).join("") + "</div>";
    var rows = layers.map(function (l) {
      var mark = l.pass === true ? "✓" : (l.pass === false ? "×" : "·");
      return '<div class="layer"><div>' + esc(mark + " " + (l.name || "Layer")) +
        '</div><div class="val">' + esc(l.value || "—") + "</div></div>";
    }).join("");
    var social = audit.social || {};
    var score = audit.score || {};
    var socialLine = "";
    if (score.social == null && (store.state || {}).note && /social/i.test(store.state.note)) {
      socialLine = "Social: off";
    } else if (score.social_pts != null || social.social_pts != null) {
      socialLine = "Social +" + (score.social_pts != null ? score.social_pts : social.social_pts);
      if (social.reason) socialLine += " · " + social.reason;
    } else {
      socialLine = "Social: off";
    }
    var link = audit.link || coin.link;
    return navbar(name, { back: true }) +
      '<div class="section">' + discs + rows +
      '<div class="layer"><div>' + esc(socialLine) + "</div></div>" +
      (link ? '<a class="btn wide" style="margin-top:16px" href="' + esc(link) + '" target="_blank" rel="noopener">Open on FOMO</a>' : "") +
      "</div>";
  }

  function liveHtml() {
    var screen = store.screen || {};
    var link = "";
    var last = screen.last_order || {};
    if (last.link) link = '<a class="btn" href="' + esc(last.link) + '" target="_blank" rel="noopener">Open on FOMO</a>';
    else if (last.mint && ((store.coins || {})[last.mint] || {}).link) {
      link = '<a class="btn" href="' + esc(store.coins[last.mint].link) + '" target="_blank" rel="noopener">Open on FOMO</a>';
    }
    return '<div class="fs-live"><div class="navbar">' +
      '<button type="button" class="icon-btn" data-act="back" aria-label="Back">‹</button>' +
      '<div class="title">' + esc(screen.label || "Live screen") + "</div>" + link +
      "</div>" +
      '<div class="stage" id="live-stage"><img id="live-full" alt="Desk screen"></div></div>';
  }

  function settingGroups() {
    return [
      ["Scanner", ["min_liquidity_usd", "max_top10_pct", "max_h1_change_pct", "poll_s", "min_pool_age_min", "max_wait_min", "runner_h24_pct", "min_holders_growth_pct", "ws_silent_s", "dex_429_wait_s", "dex_max_rpm"]],
      ["Analyst", ["max_dev_pct", "min_lp_locked_pct", "max_bundled", "max_insider_pct", "max_delegated_accounts", "retries", "min_score", "alive_volume_h1", "fast_curve_min", "max_fresh_pct", "fresh_top_n", "analyst_liq_drop_pct"]],
      ["Social", ["social_weight", "social_max_per_h", "social_timeout_s", "shill_cut"]],
      ["Brain", ["risk_per_trade_pct", "full_size_score", "below_full_pct", "max_pool_pct", "min_ticket_usd", "max_ticket_usd", "max_trades_night"]],
      ["Executor", ["dip_pct", "dip_window_min", "dip_wait_min", "crash_pct", "tp_x", "tp_sell_pct", "trail_pct", "recheck_liq_drop_pct", "recheck_price_up_pct", "quote_timeout_s", "verify_timeout_s"]],
      ["Risk", ["risk_poll_s", "stop_pct", "stop_pct_slow", "timeout_h", "timeout_min_gain_pct", "night_loss_stop_pct", "pulled_drop_pct", "dev_dump_pct", "no_price_polls", "sell_retry_s"]],
      ["Desk", ["mode", "paper_start_cash", "night_start", "lock_time", "report_time", "notifier", "tz", "fee_pct", "push_rejects"]],
      ["Copy picks", ["copy_picks.every", "copy_picks.time"]]
    ];
  }

  function fmtSetting(key, val) {
    if (val == null || val === "") return "—";
    if (typeof val === "boolean") return val ? "on" : "off";
    if (typeof val === "number") return String(val);
    return String(val);
  }

  function accountHtml() {
    var acc = store.account || {};
    var st = store.state || {};
    var vals = ((store.settings || {}).values) || {};
    var mode = acc.mode || st.mode || "—";
    var profile = acc.profile_url
      ? '<a class="btn wide" href="' + esc(acc.profile_url) + '" target="_blank" rel="noopener">Your FOMO profile</a>'
      : '<div class="sub">FOMO profile · pending login</div>';
    var push = acc.push || {};
    var pushLine = (push.plan === "B" || push.note)
      ? (push.note || "Telegram only")
      : (push.connected ? "Notifications connected" : "Notifications not connected");

    var groups = settingGroups().map(function (g) {
      var rows = g[1].map(function (k) {
        var v = (k in vals) ? vals[k] : acc[k];
        if (k === "mode") v = mode;
        if (k === "rpc_url" || (typeof v === "string" && /^https?:/i.test(v))) v = "set on the desk";
        return '<div class="row-44"><div class="left">' + esc(k) + '</div><div class="setting-val">' + esc(fmtSetting(k, v)) + "</div></div>";
      }).join("");
      return '<div class="section"><div class="section-h">' + esc(g[0]) + "</div><div class=\"group\">" + rows + "</div>" + askNote() + "</div>";
    }).join("");

    return navbar("Account") +
      '<div class="section"><div class="card">' +
        '<div class="row-44"><div>Mode</div><div>' + esc(mode) + " " + modePill() + "</div></div>" +
        modeSwitchHtml() +
        '<div class="row-44"><div>Cash</div><div class="num">' + esc(fmtMoney(acc.cash != null ? acc.cash : st.cash)) + "</div></div>" +
      "</div></div>" +
      '<div class="section stack">' + profile +
        '<button type="button" class="btn wide" data-act="invite">Invite a friend</button>' +
        '<button type="button" class="btn wide" data-act="picks">Copy picks</button>' +
        '<button type="button" class="btn wide" data-act="live">Watch in Grok Bot</button>' +
      "</div>" +
      '<div class="section"><div class="card"><div>Pushes</div><div class="sub">' + esc(pushLine) + "</div></div></div>" +
      groups;
  }

  function picksHtml() {
    var pack = store.copy_picks || {};
    var traders = pack.traders || [];
    var pending = pack.keymap === "PENDING" || !traders.length;
    var hist = pack.history || [];
    var title = pack.title || "Copy picks";
    var body;
    if (pending) {
      var pendingNote = pack.note
        || (pack.keymap === "PENDING"
          ? "Leaderboard keys unmapped until a raw sample exists"
          : "Waiting for FOMO login");
      body = '<div class="empty">' + esc(pendingNote) + "</div>";
    } else {
      body = traders.map(function (t) {
        var buy = t.last_buy || {};
        var buyLine = buy.coin
          ? (buy.plain
              ? esc(buy.coin) + (buy.open_fomo ? ' · <a href="' + esc(buy.open_fomo) + '" target="_blank" rel="noopener">Open FOMO</a>' : "")
              : (buy.url
                  ? '<a href="' + esc(buy.url) + '" target="_blank" rel="noopener">' + esc(buy.coin) + " at $" + esc(buy.mcap != null ? String(buy.mcap) : "n/a") + "</a>"
                  : esc(buy.coin)))
          : "—";
        var enabled = !!t.copy_on_desk;
        var profile = t.profile_url
          ? '<a class="btn" href="' + esc(t.profile_url) + '" target="_blank" rel="noopener">Profile</a>'
          : "";
        return '<div class="picks-card">' +
          '<div class="handle">#' + esc(t.rank) + " " + esc(t.handle || "") + "</div>" +
          '<div class="picks-pnl"><span>7d ' + esc(fmtUsdSigned(t.pnl_7d)) + "</span><span>30d " + esc(fmtUsdSigned(t.pnl_30d)) + "</span></div>" +
          '<div class="sub">' + esc((t.trades != null ? t.trades + " trades" : "")) +
          (t.last_trade_ago ? " · last trade " + esc(t.last_trade_ago) : "") + "</div>" +
          '<div style="margin:10px 0">' + profile + "</div>" +
          '<div class="sub">Last buy · ' + buyLine + "</div>" +
          '<div class="row-44"><div>Copy on desk</div><span class="pill ' + (enabled ? "green" : "grey") + '">' +
          (enabled ? "On" : "Off") + "</span></div>" +
          '<div class="ask">Ask in chat to toggle</div>' +
          (t.why ? '<div class="sub" style="margin-top:8px">' + esc(t.why) + "</div>" : "") +
          "</div>";
      }).join("");
    }
    var histHtml = "";
    if (hist.length) {
      histHtml = '<div class="section"><div class="section-h">Last 7 lists</div><div class="group history-list">' +
        hist.map(function (h) {
          var names = (h.traders || []).map(function (x) { return x.handle; }).filter(Boolean).join(", ");
          return '<div class="row-44"><div class="left">' + esc(fmtTime(h.ts) || "") +
            '<div class="sub">' + esc(names || "—") + "</div></div></div>";
        }).join("") + "</div></div>";
    }
    return navbar("Copy picks", { back: true }) +
      '<div class="section"><div class="sub">' + esc(title) + "</div></div>" +
      '<div class="section">' + body + "</div>" + histHtml +
      (pack.footer ? '<div class="section dim">' + esc(pack.footer) + "</div>" : "");
  }

  function fmtUsdSigned(n) {
    if (n == null || !isFinite(Number(n))) return "n/a";
    var v = Number(n);
    var sign = v >= 0 ? "+" : "-";
    return sign + "$" + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) >= 10 ? 0 : 2 });
  }

  /* ---------- render ---------- */

  function render() {
    if (!dataPath) {
      showTabbar(false);
      $app.innerHTML = needPathHtml();
      return;
    }
    var main = { home: 1, bots: 1, activity: 1, account: 1 };
    showTabbar(!!main[route.page]);
    if (!store.state && !lastGoodAt) {
      $app.innerHTML = skeleton();
      return;
    }
    var html = "";
    if (route.page === "home") html = homeHtml();
    else if (route.page === "bots") html = botsHtml();
    else if (route.page === "activity") html = activityHtml();
    else if (route.page === "account") html = accountHtml();
    else if (route.page === "coin") html = coinHtml();
    else if (route.page === "audit") html = auditHtml();
    else if (route.page === "live") html = liveHtml();
    else if (route.page === "picks") html = picksHtml();
    else html = homeHtml();
    $app.innerHTML = html;
    paintCharts();
    loadLiveImages();
    if (searchOpen && $("#q")) {
      var inp = $("#q");
      inp.focus();
      inp.selectionStart = inp.value.length;
    }
  }

  function chartPayload(range) {
    range = range || "LIVE";
    if (range === "LIVE" && store.chart && store.chart.range === "LIVE") return store.chart;
    var hist = store.history || {};
    var ranges = hist.ranges || {};
    if (ranges[range]) return ranges[range];
    if (store.chart && range === (store.chart.range || "LIVE")) return store.chart;
    return { points: [], marks: [] };
  }

  function paintCharts() {
    if (route.page === "home" && window.DeskCharts && $("#home-chart")) {
      var payload = chartPayload(chartRange);
      var start = null;
      var pts = payload.points || [];
      if (pts.length) start = pts[0].value;
      window.DeskCharts.drawLine($("#home-chart"), {
        points: pts,
        marks: payload.marks || [],
        startValue: start,
        reduceMotion: reduced
      });
    }
    if (route.page === "coin" && window.DeskCharts && $("#coin-chart") && route.mint) {
      var pack = (store.candles || {})[route.mint] || {};
      var coin = (store.coins || {})[route.mint] || {};
      var candles = pack.candles || coin.candles || [];
      var pos = coin.position;
      var exit = pos && pos.stop_price;
      window.DeskCharts.drawCandles($("#coin-chart"), { candles: candles, exitPrice: exit, reduceMotion: reduced });
    }
  }

  function loadLiveImages() {
    var url = relayUrl("screen.jpg");
    if (!url || !dataPath) return;
    var screen = store.screen || {};
    if (screen.available === false && route.page !== "live") {
      /* keep the placeholder; still try in case the file appeared */
    }
    function apply(img) {
      if (!img) return;
      var swap = function (el) {
        if (!el) return;
        el.onload = function () {
          el.classList.add("show");
          var other = el.id === "live-a" ? $("#live-b") : $("#live-a");
          if (other) other.classList.remove("show");
        };
        el.src = url;
      };
      if (route.page === "home") {
        liveBuf = 1 - liveBuf;
        swap(liveBuf ? $("#live-b") : $("#live-a"));
      }
      if (route.page === "live") {
        var full = $("#live-full");
        if (full) full.src = url;
      }
    }
    apply(true);
  }

  $app.addEventListener("click", onClick);
  $app.addEventListener("input", function (ev) {
    if (ev.target && ev.target.id === "q") {
      searchQ = ev.target.value;
      var feed = ev.target.parentNode.nextSibling;
      if (feed) feed.innerHTML = searchResults();
    }
  });
  $tabbar.addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-tab]");
    if (!btn) return;
    searchOpen = false;
    if (btn.getAttribute("data-tab") === "activity") {
      var act = ((store.activity || {}).rows || [])[0];
      if (act && act.id) seenActivityId = act.id;
    }
    go(btn.getAttribute("data-tab"));
  });

  function onClick(ev) {
    var a = ev.target.closest("a");
    if (a && a.href && !a.getAttribute("data-act")) return; /* follow FOMO / profile links */
    var el = ev.target.closest("[data-act]");
    if (!el) return;
    var act = el.getAttribute("data-act");
    var mint = el.getAttribute("data-mint");
    if (act === "back") {
      if (route.page === "audit" && route.mint) { go("coin", { mint: route.mint }); return; }
      if (route.page === "picks") { go("account"); return; }
      if (route.page === "live") { go("home"); return; }
      go("home");
      return;
    }
    if (act === "account") { go("account"); return; }
    if (act === "activity") {
      var act0 = ((store.activity || {}).rows || [])[0];
      if (act0 && act0.id) seenActivityId = act0.id;
      go("activity"); return;
    }
    if (act === "bots") { go("bots"); return; }
    if (act === "picks") { go("picks"); return; }
    if (act === "live") { go("live"); return; }
    if (act === "coin" && mint) { go("coin", { mint: mint }); return; }
    if (act === "audit" && mint) { go("audit", { mint: mint }); return; }
    if (act === "search") { searchOpen = !searchOpen; render(); return; }
    if (act === "range") {
      chartRange = el.getAttribute("data-range") || "LIVE";
      render();
      return;
    }
    if (act === "mode") {
      ev.preventDefault();
      requestMode(el.getAttribute("data-mode"));
      return;
    }
    if (act === "invite") {
      ev.preventDefault();
      var url = (store.account || {}).signup_url;
      if (!url) return;
      if (navigator.share) {
        navigator.share({ title: "FOMO", url: url }).catch(function () { copyText(url); });
      } else {
        copyText(url);
      }
    }
  }

  function copyText(text) {
    function ok() {
      var note = document.createElement("div");
      note.className = "offline";
      note.style.color = "#fff";
      note.style.background = "rgba(10,132,255,0.25)";
      note.textContent = "Link copied";
      document.body.insertBefore(note, $offline.nextSibling || $app);
      setTimeout(function () { note.remove(); }, 2000);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok).catch(function () {
        window.prompt("Copy this link", text);
      });
    } else {
      window.prompt("Copy this link", text);
    }
  }

  function tickOffline() {
    if (!offline) return;
    retryIn = Math.max(0, retryIn - 1);
    var last = lastGoodAt ? fmtTime(new Date(lastGoodAt).toISOString()) : "—";
    $offline.textContent = "Desk offline · retrying in " + retryIn + "s · last update " + last;
  }

  /* ---------- boot ---------- */


  function hexBytes(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (x) {
      return ("0" + x.toString(16)).slice(-2);
    }).join("");
  }

  function randomNonce() {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return hexBytes(bytes);
  }

  function signModeCommand(token, parts) {
    var canonical = "v1|mode|" + parts.mode + "|" + (parts.confirm || "") + "|" + parts.ts + "|" + parts.nonce;
    var enc = new TextEncoder();
    return crypto.subtle.importKey("raw", enc.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
      .then(function (key) { return crypto.subtle.sign("HMAC", key, enc.encode(canonical)); })
      .then(hexBytes);
  }

  function confirmLive() {
    return new Promise(function (resolve) {
      var wrap = document.createElement("div");
      wrap.className = "mode-dialog";
      wrap.innerHTML = '<div class="mode-dialog-card" role="dialog" aria-modal="true" aria-labelledby="mode-dialog-title">' +
        '<h2 id="mode-dialog-title">Switch to LIVE?</h2>' +
        "<p>Real money trades</p>" +
        '<div class="mode-dialog-actions">' +
          '<button type="button" class="btn" data-choice="cancel">Cancel</button>' +
          '<button type="button" class="btn red" data-choice="ok">Switch to LIVE</button>' +
        "</div></div>";
      function finish(ok) {
        wrap.style.pointerEvents = "none";
        wrap.remove();
        modeIgnoreClicksUntil = Date.now() + 500;
        resolve(!!ok);
      }
      wrap.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var btn = ev.target.closest("[data-choice]");
        if (!btn) {
          if (ev.target === wrap) finish(false);
          return;
        }
        finish(btn.getAttribute("data-choice") === "ok");
      });
      document.body.appendChild(wrap);
    });
  }

  function requestMode(next) {
    next = String(next || "").toUpperCase();
    if (next !== "PAPER" && next !== "LIVE") return;
    if (modeBusy || modePending) return;
    if (Date.now() < modeIgnoreClicksUntil) return;
    if (next === currentMode() && !modeError && !modeWanted) return;
    if (!appToken) {
      modeError = "Open the one-time pairing link from Telegram once to enable the switch. Ask in chat for a new link if it expired.";
      render();
      return;
    }
    modeBusy = true;
    modeWanted = next;
    var go = Promise.resolve(true);
    if (next === "LIVE") go = confirmLive();
    go.then(function (ok) {
      if (!ok) {
        modeBusy = false;
        modeWanted = "";
        render();
        return;
      }
      modePending = true;
      modeError = "";
      render();
      return postModeCommand(next).then(function () {
        return waitForMode(next, 20);
      }).catch(function (err) {
        modeError = (err && err.message) ? err.message : "Switch failed";
      }).then(function () {
        modePending = false;
        modeBusy = false;
        if (currentMode() === next) modeWanted = "";
        modeIgnoreClicksUntil = Date.now() + 400;
        render();
      });
    });
  }

  function postModeCommand(mode) {
    var ts = Math.floor(Date.now() / 1000);
    var nonce = randomNonce();
    var confirm = mode === "LIVE" ? "LIVE" : "";
    var payload = { action: "mode", mode: mode, confirm: confirm || null, ts: ts, nonce: nonce };
    return signModeCommand(appToken, { mode: mode, confirm: confirm, ts: ts, nonce: nonce }).then(function (sig) {
      payload.sig = sig;
      return fetchJson("command_inbox.json").then(function (meta) {
        var url = meta && meta.upload;
        if (!url) throw new Error("Desk inbox is not ready. Try again in a few seconds.");
        return fetch(url, {
          method: "PUT",
          headers: { "content-type": "application/json", "x-upsert": "true" },
          body: JSON.stringify(payload)
        }).then(function (res) {
          if (res.ok) return res;
          return fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-upsert": "true" },
            body: JSON.stringify(payload)
          });
        }).then(function (res) {
          if (!res.ok) throw new Error("Could not send the mode command");
        });
      });
    });
  }

  function waitForMode(want, tries) {
    tries = tries || 6;
    function once(left) {
      return loadCore().then(function () {
        if (currentMode() === want) {
          modeError = "";
          return;
        }
        if (left <= 0) {
          modeError = "Sent. Waiting for the desk to apply the switch.";
          return;
        }
        return new Promise(function (resolve) { setTimeout(resolve, 2000); }).then(function () { return once(left - 1); });
      });
    }
    return once(tries);
  }

  function pairReason(reason) {
    if (reason === "expired") return "This link has expired. Ask in chat for a new one.";
    if (reason === "used") return "This link was already used. Ask in chat for a new one.";
    if (reason === "invalid") return "This pairing link is not valid. Ask in chat for a new one.";
    return "Pairing failed. Ask in chat for a new link.";
  }

  function putJson(url, payload) {
    return fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-upsert": "true" },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (res.ok) return res;
      return fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-upsert": "true" },
        body: JSON.stringify(payload)
      });
    });
  }

  function waitForPairResult(nonce, tries) {
    var name = "inbox/p" + nonce + ".json";
    function once(left) {
      return fetchJson(name).then(function (data) {
        if (data && data.ok && data.token) return data.token;
        if (data && data.ok === false) throw new Error(pairReason(data.reason));
        if (left <= 0) throw new Error("Pairing timed out. Ask in chat for a new link.");
        return new Promise(function (resolve) { setTimeout(resolve, 2000); }).then(function () {
          return once(left - 1);
        });
      }).catch(function (err) {
        if (err && err.message && err.message.indexOf("This link") === 0) throw err;
        if (err && err.message && err.message.indexOf("Pairing") === 0) throw err;
        if (left <= 0) throw new Error("Pairing timed out. Ask in chat for a new link.");
        return new Promise(function (resolve) { setTimeout(resolve, 2000); }).then(function () {
          return once(left - 1);
        });
      });
    }
    return once(tries || 15);
  }

  function redeemPairing(code) {
    if (!code || pairingBusy) return Promise.resolve();
    pairingBusy = true;
    pairingStatus = "Pairing this phone…";
    render();
    var nonce = randomNonce();
    return fetchJson("command_inbox.json").then(function (meta) {
      var url = meta && meta.pair_upload;
      if (!url) throw new Error("Desk inbox is not ready. Try again in a few seconds.");
      return putJson(url, { action: "pair", code: code, nonce: nonce, ts: Math.floor(Date.now() / 1000) }).then(function (res) {
        if (!res.ok) throw new Error("Could not send the pairing request");
        return waitForPairResult(nonce, 15);
      });
    }).then(function (token) {
      storeToken(token);
      pairingStatus = "This phone is paired. You can delete the Telegram message.";
      writeHash();
      render();
    }).catch(function (err) {
      pairingStatus = (err && err.message) ? err.message : "Pairing failed. Ask in chat for a new link.";
      render();
    }).then(function () {
      pairingBusy = false;
    });
  }

  function boot() {
    dataPath = readDataPath();
    var pairCode = readPairCode();
    appToken = readToken();
    readRoute();
    // Drop d=, t=, and the one-time code from the address bar after saving locally.
    writeHash();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(function () {});
    }
    if (!dataPath) {
      render();
      return;
    }
    if (!window.DESK_RELAY_BASE) {
      showTabbar(true);
      $app.innerHTML = navbar("Grok Bot ›", { brand: true }) +
        '<div class="empty">Relay is not configured.</div>';
      return;
    }
    render();
    if (pairCode) redeemPairing(pairCode);
    loadCore().then(render);
    pollTimer = setInterval(function () {
      loadCore().then(function () { render(); });
    }, POLL_MS);
    tickTimer = setInterval(tickOffline, 1000);
    window.addEventListener("hashchange", function () {
      dataPath = readDataPath() || dataPath;
      var laterCode = readPairCode();
      readRoute();
      writeHash();
      if (laterCode) redeemPairing(laterCode);
      render();
    });
    window.addEventListener("resize", function () { paintCharts(); });
  }

  boot();
})();
