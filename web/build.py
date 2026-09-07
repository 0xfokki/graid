# -*- coding: utf-8 -*-
"""Build index.html with the live pipeline in the hero.

The reference that inspired this treatment (monad.com) uses a Lottie animation
exported from After Effects. This version is procedural and driven by live data,
so its impact comes from the core glow, flowing wire dashes, and packet trails.
"""
import io
import sys

# DO NOT RUN THIS AS IT STANDS. index.html has been maintained by hand since the
# hero was rebuilt as laid-out cards, and this script still carries the older
# drawn-SVG version. Running it would quietly overwrite the current hero with the
# previous design. Port the changes into the CSS/JS/HERO blocks below before using
# it again, or delete it and treat index.html as the source.
sys.exit("build.py is stale - see the note above")


src = io.open("base.html", encoding="utf-8").read()

CSS = """
/* ── pipeline: a diagram that doubles as a live monitor ──────────────────── */
.heroPipe { position:relative; margin:0 -26px; padding:0; overflow:hidden; }
#pipe { display:block; width:100%; height:min(74vh,690px); }
.pipeText { padding:10px 26px 0; max-width:64ch; position:relative; z-index:2; }
/* The contract strip sits between the subtitle and diagram, with enough space
   on both sides to keep it separate from the copy and pipeline. */
#ca { margin:46px 26px 40px; position:relative; z-index:2; }
.pipeText h1 { font-size:clamp(28px,3.2vw,46px); }
.pipeText .lede { margin-top:14px; max-width:52ch; font-size:14px; }

.nodeBox { fill:#0d0f0b; stroke:#232620; stroke-width:1; }
.nodeBox.core { fill:#101309; stroke:#4a6b28; stroke-width:1.8; }
.nodeTx { font-family:'DM Mono',monospace; font-size:15px; letter-spacing:.14em;
  text-transform:uppercase; fill:#9aa093; }
.nodeTx.core { fill:#e8e8dd; font-size:27px; letter-spacing:.2em; }
.nodeTx.n { font-size:12px; fill:#575a52; letter-spacing:.05em; text-transform:none; }

/* Flowing wire dashes keep the diagram moving even between packets. */
.wire { fill:none; stroke:#23261f; stroke-width:1.2; }
.wire.flow { stroke:#4b6136; stroke-width:1.3; stroke-dasharray:4 11;
  animation:dashrun 1.05s linear infinite; }
@keyframes dashrun { to { stroke-dashoffset:-30; } }

/* Flash a node when a packet arrives so cause and effect remain visible. */
.nodeBox { transition:stroke .12s ease, fill .12s ease; }
.nodeBox.lit { stroke:#a8ff62; fill:#141a0d; }
.ring { fill:none; stroke:#a8ff62; pointer-events:none; }
.corePulse { animation:corebeat 3.4s ease-in-out infinite; transform-origin:center; }
@keyframes corebeat { 0%,100%{opacity:.55} 50%{opacity:1} }
@media (prefers-reduced-motion:reduce) {
  .wire.flow { animation:none; } .corePulse { animation:none; }
}
@media (max-width:900px) { #pipe { height:400px; } .pipeText { max-width:none; } }
"""

JS = r"""
/* ── pipeline ───────────────────────────────────────────────────────────────
   Structure and paths use SVG. Packets are SVG circles with radial fills
   instead of filters, since filters on hundreds of elements hurt frame rate.
   Motion combines flowing wire dashes, packet trails, and a slowly pulsing core. */
(function pipe() {
  var svg = document.getElementById("pipe");
  if (!svg) return;
  var NS = "http://www.w3.org/2000/svg";
  var still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var W = 1400, H = 700;
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  var IN = [
    ["launch event", "TokenLaunched log"],
    ["creator buy", "from the launch tx"],
    ["deployer history", "rolling hour"],
    ["socials · fees · pair", "token record"]
  ];
  var OUT = [
    ["money came", "#a8ff62", "outside buyers showed up"],
    ["nothing came", "#ff653d", "the curve stayed empty"],
    ["still waiting", "#6f7268", "inside the two-hour window"]
  ];

  function mk(t, a) { var e = document.createElementNS(NS, t); for (var k in a) e.setAttribute(k, a[k]); return e; }

  // ── glows and fills ─────────────────────────────────────────────────────
  var defs = mk("defs", {});
  function glow(id, col, mid) {
    var g = mk("radialGradient", { id: id });
    g.appendChild(mk("stop", { offset: "0%", "stop-color": col, "stop-opacity": mid || ".55" }));
    g.appendChild(mk("stop", { offset: "55%", "stop-color": col, "stop-opacity": ".10" }));
    g.appendChild(mk("stop", { offset: "100%", "stop-color": col, "stop-opacity": "0" }));
    defs.appendChild(g);
  }
  glow("gCore", "#a8ff62", ".38");
  glow("gLime", "#a8ff62", "1");
  glow("gRed", "#ff653d", "1");
  glow("gGrey", "#9aa093", "1");
  svg.appendChild(defs);

  var gGlow = mk("g", {}), gW = mk("g", {}), gN = mk("g", {}), gP = mk("g", {});
  svg.appendChild(gGlow); svg.appendChild(gW); svg.appendChild(gN); svg.appendChild(gP);

  var inX = 18, inW = 288, CX = 462, CW = 300, CH = 208, CY = H / 2 - 104;
  var outX = W - 302, outW = 284;

  // Soft green glow behind the core, adapted from the reference.
  gGlow.appendChild(mk("circle", { cx: CX + CW / 2, cy: CY + CH / 2, r: 340,
    fill: "url(#gCore)", "class": still ? "" : "corePulse" }));

  function box(x, y, w, h, label, sub, cls) {
    var g = mk("g", {});
    var big = (cls || "").indexOf("core") >= 0;
    // Center both text lines on the card axis.
    var rx = big ? 44 : h / 2;
    g.appendChild(mk("rect", { x: x, y: y, width: w, height: h, rx: rx,
      "class": "nodeBox " + (cls || "") }));
    var tx = mk("text", { x: x + w / 2, y: y + (sub ? h / 2 - (big ? 10 : 5) : h / 2 + 5),
      "text-anchor": "middle", "class": "nodeTx " + (cls || "") });
    tx.textContent = label; g.appendChild(tx);
    if (sub) { var s = mk("text", { x: x + w / 2, y: y + h / 2 + (big ? 24 : 17),
      "text-anchor": "middle", "class": "nodeTx n" }); s.textContent = sub; g.appendChild(s); }
    return g;
  }

  var ins = [], outs = [];
  IN.forEach(function (row, i) {
    var y = 44 + i * 152;
    var bIn = box(inX, y, inW, 96, row[0], row[1]);
    gN.appendChild(bIn);
    var d = "M " + (inX + inW) + " " + (y + 48) + " C " + (inX + inW + 120) + " " + (y + 31) +
            ", " + (CX - 120) + " " + (CY + CH / 2) + ", " + CX + " " + (CY + CH / 2);
    gW.appendChild(mk("path", { d: d, "class": "wire" }));
    var f = mk("path", { d: d, "class": "wire flow", style: "animation-delay:" + (i * 0.28) + "s" });
    gW.appendChild(f);
    ins.push({ el: f, from: bIn.querySelector("rect"), to: null });
  });

  var coreBox = box(CX, CY, CW, CH, "score", "seven measured features", "core");
  gN.appendChild(coreBox);
  var coreRect = coreBox.querySelector("rect");
  ins.forEach(function (w) { w.to = coreRect; });
  var wX = CX + CW + 62, wW = 186;
  gN.appendChild(box(wX, CY + 56, wW, 96, "write it down", "before the answer"));
  var dMid = "M " + (CX + CW) + " " + (CY + CH / 2) + " L " + wX + " " + (CY + 104);
  gW.appendChild(mk("path", { d: dMid, "class": "wire" }));
  gW.appendChild(mk("path", { d: dMid, "class": "wire flow" }));

  var midX = wX + wW;
  OUT.forEach(function (row, i) {
    var y = 74 + i * 202;
    var g = box(outX, y, outW, 96, row[0], row[2]);
    g.querySelector("rect").setAttribute("stroke", i === 2 ? "#232620" : row[1] + "4a");
    g.querySelector("text").setAttribute("fill", row[1]);
    gN.appendChild(g);
    var d = "M " + midX + " " + (CY + 104) + " C " + (midX + 90) + " " + (CY + 104) +
            ", " + (outX - 90) + " " + (y + 48) + ", " + outX + " " + (y + 48);
    gW.appendChild(mk("path", { d: d, "class": "wire" }));
    var f = mk("path", { d: d, "class": "wire flow", style: "animation-delay:" + (i * 0.4) + "s" });
    gW.appendChild(f);
    outs.push({ el: f, colour: row[1], to: g.querySelector("rect"),
      grad: i === 0 ? "gLime" : i === 1 ? "gRed" : "gGrey" });
  });

  // ── packets with trails ─────────────────────────────────────────────────
  var packets = [], TRAIL = 4;
  function spawn(side, which) {
    var set = side === "in" ? ins : outs;
    var w = which != null ? set[which] : set[(Math.random() * set.length) | 0];
    var grad = w.grad || "gGrey";
    var parts = [];
    for (var i = 0; i < TRAIL; i++) {
      var c = mk("circle", { r: 11 - i * 1.9, fill: "url(#" + grad + ")", opacity: 0 });
      gP.appendChild(c); parts.push(c);
    }
    if (w.from) flash(w.from);
    packets.push({ parts: parts, path: w.el, len: w.el.getTotalLength(), to: w.to,
      t: -0.02, sp: 0.0090 + Math.random() * 0.0040 });
    if (packets.length > 220) {
      var old = packets.shift();
      old.parts.forEach(function (e) { e.remove(); });
    }
  }

  var litTimers = new WeakMap();
  function flash(rect) {
    if (!rect) return;
    rect.classList.add("lit");
    clearTimeout(litTimers.get(rect));
    litTimers.set(rect, setTimeout(function () { rect.classList.remove("lit"); }, 190));
  }
  // An occasional expanding ring adds a larger gesture above the small motion.
  function ring() {
    var c = mk("circle", { cx: CX + CW / 2, cy: CY + CH / 2, r: CW / 2,
      "class": "ring", "stroke-width": 1.4, opacity: 0.5 });
    gGlow.appendChild(c);
    var t0 = performance.now();
    (function grow(now) {
      var k = (now - t0) / 2100;
      if (k >= 1) { c.remove(); return; }
      c.setAttribute("r", CW / 2 + k * 300);
      c.setAttribute("opacity", (1 - k) * 0.38);
      c.setAttribute("stroke-width", 1.4 * (1 - k * 0.6));
      requestAnimationFrame(grow);
    })(t0);
  }

  var last = performance.now();
  function tick(now) {
    var dt = Math.min(64, now - last); last = now;
    for (var i = packets.length - 1; i >= 0; i--) {
      var p = packets[i];
      p.t += p.sp * (dt / 16);
      if (p.t >= 1 && !p.hit) { p.hit = 1; flash(p.to); }
      if (p.t >= 1.05) { p.parts.forEach(function (e) { e.remove(); }); packets.splice(i, 1); continue; }
      for (var j = 0; j < p.parts.length; j++) {
        var tj = p.t - j * 0.018;
        if (tj < 0 || tj > 1) { p.parts[j].setAttribute("opacity", 0); continue; }
        var pt = p.path.getPointAtLength(tj * p.len);
        p.parts[j].setAttribute("cx", pt.x);
        p.parts[j].setAttribute("cy", pt.y);
        var fade = tj < 0.10 ? tj / 0.10 : tj > 0.90 ? (1 - tj) / 0.10 : 1;
        p.parts[j].setAttribute("opacity", fade * (j === 0 ? 0.95 : 0.4 - j * 0.09));
      }
    }
    requestAnimationFrame(tick);
  }

  if (!still) {
    requestAnimationFrame(tick);
    // Keep motion continuous regardless of current network activity. Live
    // launches add extra packets and make the flow denser.
    setInterval(function () { spawn("in"); }, 150);
    setInterval(function () { spawn("out"); }, 300);
    setInterval(ring, 2600);
    ring();
    try {
      var es2 = new EventSource("/api/feed");
      es2.onmessage = function (e) {
        var d = JSON.parse(e.data);
        if (!d.hello) { spawn("in"); setTimeout(function () { spawn("in"); }, 120); }
      };
    } catch (err) {}
  }

  fetch("/api/scoreboard").then(function (r) { return r.json(); }).then(function (b) {
    var n = document.getElementById("pipeN");
    if (n) n.textContent = num(b.resolved);
    if (still) return;
    var rate = b.eventRate == null ? 0.33 : b.eventRate;
    // The green share on the right matches the measured event rate.
    setInterval(function () {
      var r = Math.random();
      spawn("out", r < rate ? 0 : r < 0.93 ? 1 : 2);
    }, 380);
  }).catch(function () {});
})();
"""

HERO = """  <div class="hero heroPipe">
    <div class="pipeText">
      <div class="eyebrow"><span class="a">◈</span> pons · survival</div>
      <h1>Real-time AI intelligence for <em>token launches</em></h1>
      <p class="lede">
        An autonomous on-chain agent that analyzes every launch as it happens—identifying
        which tokens have the strongest potential to attract real capital.
      </p>
    </div>
    <div id="ca"></div>
    <svg id="pipe"></svg>
  </div>
  <div class="figures" id="figures"></div>
"""

s = src.replace("/* ── metrics row ─", CSS + "\n/* ── metrics row ─")
FIG = '<div class="figures" id="figures"></div>'
a = s.index('  <div class="hero">')
figEnd = s.index(FIG) + len(FIG)
b = s.index("</div>", figEnd) + 6          # Close .hero itself, not its inner block.
assert s[:b].count("<div") - s[:b].count("</div>") == s[:a].count("<div") - s[:a].count("</div>"), "unbalanced div tags"
s = s[:a] + HERO + s[b:]
s = s.replace("</script>", JS + "\n</script>")
s = s.replace("<title>pons·survival</title>", "<title>pons·survival — pipeline</title>")
io.open("index.html", "w", encoding="utf-8").write(s)
print("index.html:", len(s), "chars")
