// FOMO desk · live PAPER screen
// DATA_PATH comes from #d=... and is stored only in this phone's localStorage.
(function () {
  "use strict";

  var STORAGE_KEY = "desk_data_path";
  var POLL_MS = 15000;
  var STALE_MS = 60000;
  var lastUpdatedAt = null;
  var dataPath = "";

  var statusEl = document.getElementById("status");
  var statusLabel = document.getElementById("status-label");
  var modeEl = document.getElementById("mode");
  var balanceEl = document.getElementById("balance");
  var updatedEl = document.getElementById("updated");
  var msgEl = document.getElementById("msg");
  var noteEl = document.getElementById("note");

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

  function setStatus(kind, label) {
    statusEl.className = "status" + (kind ? " " + kind : "");
    statusLabel.textContent = label;
  }

  function showMsg(text) {
    if (!text) {
      msgEl.classList.add("hidden");
      msgEl.textContent = "";
      return;
    }
    msgEl.textContent = text;
    msgEl.classList.remove("hidden");
  }

  function formatBalance(value) {
    var n = Number(value);
    if (!isFinite(n)) return "—";
    return n.toLocaleString(undefined, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function formatTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "Updated —";
    return "Updated " + d.toLocaleString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }

  function refreshDot() {
    if (!lastUpdatedAt) {
      setStatus("", "Waiting");
      return;
    }
    var age = Date.now() - lastUpdatedAt;
    if (age <= STALE_MS) setStatus("live", "Live");
    else setStatus("stale", "Stale");
  }

  function applyState(state) {
    if (!state || typeof state !== "object") throw new Error("bad state");
    modeEl.textContent = state.mode || "—";
    balanceEl.textContent = formatBalance(state.balance);
    if (state.updated_at) {
      var t = new Date(state.updated_at).getTime();
      if (!isNaN(t)) lastUpdatedAt = t;
      updatedEl.textContent = formatTime(state.updated_at);
    }
    if (state.note) {
      noteEl.textContent = state.note;
      noteEl.classList.remove("hidden");
    }
    showMsg("");
    refreshDot();
  }

  function poll() {
    if (!dataPath) return;
    var base = window.DESK_RELAY_BASE;
    if (!base) {
      showMsg("Relay is not configured.");
      return;
    }
    var url = base + "/storage/v1/object/public/desk/d/" +
      encodeURIComponent(dataPath) + "/state.json?cb=" + Date.now();
    fetch(url, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("http " + res.status);
        return res.json();
      })
      .then(applyState)
      .catch(function () {
        showMsg("Could not read the live feed. Retrying…");
        refreshDot();
      });
  }

  dataPath = readDataPath();
  if (!dataPath) {
    setStatus("", "Waiting");
    showMsg("Open the full desk link on this phone to start the live feed.");
    return;
  }
  poll();
  setInterval(poll, POLL_MS);
  setInterval(refreshDot, 1000);
})();
