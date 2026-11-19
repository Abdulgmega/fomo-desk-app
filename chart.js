/* Desk charts: home equity line + coin OHLCV candles. Never invent candles. */
(function (global) {
  "use strict";

  function dpr(canvas) {
    var ctx = canvas.getContext("2d");
    var ratio = global.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || canvas.width || 300;
    var cssH = canvas.clientHeight || canvas.height || 180;
    canvas.width = Math.max(1, Math.round(cssW * ratio));
    canvas.height = Math.max(1, Math.round(cssH * ratio));
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { ctx: ctx, w: cssW, h: cssH, ratio: ratio };
  }

  function niceMinMax(values) {
    var nums = values.filter(function (v) { return typeof v === "number" && isFinite(v); });
    if (!nums.length) return { min: 0, max: 1 };
    var min = Math.min.apply(null, nums);
    var max = Math.max.apply(null, nums);
    if (min === max) {
      var pad = Math.abs(min) * 0.02 || 1;
      return { min: min - pad, max: max + pad };
    }
    var span = max - min;
    return { min: min - span * 0.08, max: max + span * 0.16 };
  }

  function xAt(i, n, left, width) {
    if (n <= 1) return left + width / 2;
    return left + (width * i) / (n - 1);
  }

  function yAt(v, min, max, top, height) {
    if (max === min) return top + height / 2;
    return top + height - ((v - min) / (max - min)) * height;
  }

  function isCloseOnly(candles) {
    if (!candles || !candles.length) return true;
    var ohlc = 0;
    for (var i = 0; i < candles.length; i++) {
      var c = candles[i];
      var o = c.open, h = c.high, l = c.low, cl = c.close;
      if (o == null || h == null || l == null || cl == null) continue;
      if (o !== h || h !== l || l !== cl) ohlc++;
    }
    return ohlc === 0;
  }

  function drawLine(canvas, opts) {
    opts = opts || {};
    var points = (opts.points || []).filter(function (p) {
      return p && p.ts != null && typeof p.value === "number" && isFinite(p.value);
    }).sort(function (a, b) { return a.ts - b.ts; });
    var marks = (opts.marks || []).slice();
    var dim = dpr(canvas);
    var ctx = dim.ctx, w = dim.w, h = dim.h;
    ctx.clearRect(0, 0, w, h);
    var padL = 8, padR = 8, padT = 28, padB = 8;
    var left = padL, top = padT, width = Math.max(1, w - padL - padR), height = Math.max(1, h - padT - padB);
    if (!points.length) {
      ctx.fillStyle = "rgba(235,235,245,0.3)";
      ctx.font = "13px -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Waiting for the first trade", w / 2, h / 2);
      return;
    }
    var values = points.map(function (p) { return p.value; });
    var mm = niceMinMax(values);
    var start = typeof opts.startValue === "number" ? opts.startValue : points[0].value;

    // dashed start line
    if (typeof start === "number" && isFinite(start)) {
      var sy = yAt(start, mm.min, mm.max, top, height);
      ctx.save();
      ctx.strokeStyle = "rgba(235,235,245,0.3)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(left, sy);
      ctx.lineTo(left + width, sy);
      ctx.stroke();
      ctx.restore();
    }

    var n = points.length;
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
      var x = xAt(i, n, left, width);
      var y = yAt(points[i].value, mm.min, mm.max, top, height);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    // fill under line
    ctx.lineTo(xAt(n - 1, n, left, width), top + height);
    ctx.lineTo(xAt(0, n, left, width), top + height);
    ctx.closePath();
    var grad = ctx.createLinearGradient(0, top, 0, top + height);
    grad.addColorStop(0, "rgba(0,211,90,0.28)");
    grad.addColorStop(1, "rgba(0,211,90,0)");
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    for (i = 0; i < n; i++) {
      x = xAt(i, n, left, width);
      y = yAt(points[i].value, mm.min, mm.max, top, height);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#00d35a";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    // marks above the line; a later mark moves up a row, never overlaps
    var rowsUsed = [];
    marks.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    ctx.font = "11px ui-monospace, 'SF Mono', Menlo, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    marks.forEach(function (m) {
      if (m.ts == null) return;
      var idx = 0, best = Infinity;
      for (var j = 0; j < n; j++) {
        var dt = Math.abs(points[j].ts - m.ts);
        if (dt < best) { best = dt; idx = j; }
      }
      var mx = xAt(idx, n, left, width);
      var my = yAt(points[idx].value, mm.min, mm.max, top, height);
      var label = m.label || m.kind || "";
      var tw = Math.min(ctx.measureText(label).width + 10, 120);
      var row = 0;
      var ly;
      do {
        ly = my - 10 - row * 16;
        var clash = rowsUsed.some(function (u) {
          return Math.abs(u.x - mx) < (u.w + tw) / 2 && u.row === row;
        });
        if (!clash) break;
        row += 1;
      } while (row < 6);
      rowsUsed.push({ x: mx, w: tw, row: row });
      ctx.fillStyle = m.color || "#0a84ff";
      ctx.fillText(label, mx, Math.max(12, ly));
    });
  }

  function drawCandles(canvas, opts) {
    opts = opts || {};
    var candles = (opts.candles || []).filter(function (c) {
      return c && c.ts != null && typeof c.close === "number" && isFinite(c.close);
    }).sort(function (a, b) { return a.ts - b.ts; });
    var dim = dpr(canvas);
    var ctx = dim.ctx, w = dim.w, h = dim.h;
    ctx.clearRect(0, 0, w, h);
    var padL = 8, padR = 8, padT = 8, padB = 8;
    var left = padL, top = padT, width = Math.max(1, w - padL - padR), height = Math.max(1, h - padT - padB);
    if (!candles.length) {
      ctx.fillStyle = "rgba(235,235,245,0.3)";
      ctx.font = "13px -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No candles yet", w / 2, h / 2);
      return;
    }
    if (isCloseOnly(candles)) {
      drawLine(canvas, {
        points: candles.map(function (c) { return { ts: c.ts, value: c.close }; }),
        marks: [],
        startValue: opts.exitPrice
      });
      // redraw dashed exit if provided — drawLine already used startValue
      return;
    }
    var highs = candles.map(function (c) { return c.high != null ? c.high : c.close; });
    var lows = candles.map(function (c) { return c.low != null ? c.low : c.close; });
    if (typeof opts.exitPrice === "number") { highs.push(opts.exitPrice); lows.push(opts.exitPrice); }
    var mm = niceMinMax(highs.concat(lows));
    var n = candles.length;
    var gap = width / n;
    var bodyW = Math.max(1, Math.min(8, gap * 0.7));

    if (typeof opts.exitPrice === "number" && isFinite(opts.exitPrice)) {
      var ey = yAt(opts.exitPrice, mm.min, mm.max, top, height);
      ctx.save();
      ctx.strokeStyle = "#ff9f0a";
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(left, ey);
      ctx.lineTo(left + width, ey);
      ctx.stroke();
      ctx.restore();
    }

    for (var i = 0; i < n; i++) {
      var c = candles[i];
      var o = c.open != null ? c.open : c.close;
      var hi = c.high != null ? c.high : Math.max(o, c.close);
      var lo = c.low != null ? c.low : Math.min(o, c.close);
      var cl = c.close;
      var up = cl >= o;
      var color = up ? "#00d35a" : "#ff453a";
      var x = left + gap * (i + 0.5);
      var yH = yAt(hi, mm.min, mm.max, top, height);
      var yL = yAt(lo, mm.min, mm.max, top, height);
      var yO = yAt(o, mm.min, mm.max, top, height);
      var yC = yAt(cl, mm.min, mm.max, top, height);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yH);
      ctx.lineTo(x, yL);
      ctx.stroke();
      var topB = Math.min(yO, yC);
      var bh = Math.max(1, Math.abs(yC - yO));
      ctx.fillStyle = color;
      ctx.fillRect(x - bodyW / 2, topB, bodyW, bh);
    }
  }

  global.DeskCharts = { drawLine: drawLine, drawCandles: drawCandles, isCloseOnly: isCloseOnly };
})(window);
