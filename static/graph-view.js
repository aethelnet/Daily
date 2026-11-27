/* Daily Interactive Force-Directed Routing Graph (100% vanilla Canvas, zero CDNs/deps)
 * Obsidian-inspired calm signed-graph visualization:
 *   - Velocity-Verlet force layout (Coulomb repulsion + Hooke edge springs + subtle group cohesion + auto-sleep)
 *   - Signed directional curves (+ emerald, - coral, optional dashed violet hypotheses)
 *   - Symmetric opposing arcs for bidirectional / circular loops (A -> B and B -> A never overlap)
 *   - Animated flow particles along connected edges when a node is hovered or selected
 *   - Full mouse & touch drag, background pan, wheel/button zoom, click-to-focus & quick-wire actions
 */
(() => {
  "use strict";

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function hexToRgba(hex, alpha) {
    const s = String(hex || "").trim();
    const m = /^#([0-9a-f]{6})$/i.exec(s);
    if (!m) return `rgba(110,120,130,${alpha})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }

  function fmtW(n) {
    const num = Number(n || 0);
    const r = Math.round(num * 100) / 100;
    return Number.isInteger(r) ? String(r) : String(r);
  }

  function quadPoint(x0, y0, cx, cy, x1, y1, t) {
    const mt = 1 - t;
    return {
      x: mt * mt * x0 + 2 * mt * t * cx + t * t * x1,
      y: mt * mt * y0 + 2 * mt * t * cy + t * t * y1,
    };
  }

  function createForceGraph(opts) {
    const canvas = opts.canvas;
    const readoutEl = opts.readoutEl;
    const getThemeColors = () => {
      const cs = getComputedStyle(document.body || document.documentElement);
      const get = (k, fb) => (cs.getPropertyValue(k) || "").trim() || fb;
      return {
        bg: get("--surface", "#ffffff"),
        text: get("--text", "#1c2422"),
        text2: get("--text-2", "#4b5a55"),
        muted: get("--muted", "#73827d"),
        border: get("--border", "#e2e6e3"),
        pos: get("--pos", "#1e8554"),
        neg: get("--neg", "#c8503c"),
        ai: get("--ai", "#6e5cc2"),
        accent: get("--accent", "#368470"),
      };
    };

    const ctx = canvas.getContext("2d");
    let width = 640;
    let height = 370;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    // Persistent physics state keyed by habit id
    const posCache = new Map();
    let nodes = [];
    let nodeById = new Map();
    let edges = [];
    let rawHabits = [];
    let rawEdges = [];
    let todayById = new Map();
    let liquidById = {};

    // View options & camera
    let showHyps = false;
    let onlyConnected = false;
    let camX = 0;
    let camY = 0;
    let camZoom = 1;

    // Interaction state
    let hoveredId = null;
    let selectedId = null;
    let dragNode = null;
    let dragMoved = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let isPanning = false;
    let panStartX = 0;
    let panStartY = 0;
    let panCamStartX = 0;
    let panCamStartY = 0;
    let activePointerId = null;

    // Simulation energy & animation loop
    let alpha = 0;
    let rafId = null;
    let animPhase = 0;
    let lastFrameTs = 0;
    let theme = getThemeColors();

    const tr = (key, vars) => (opts.t ? opts.t(key, vars) : key);

    function resize() {
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;
      width = Math.round(rect.width);
      height = Math.round(rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      theme = getThemeColors();
      scheduleFrame();
    }

    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(canvas);

    function screenToWorld(sx, sy) {
      return {
        x: (sx - width / 2) / camZoom + camX,
        y: (sy - height / 2) / camZoom + camY,
      };
    }

    function worldToScreen(wx, wy) {
      return {
        x: (wx - camX) * camZoom + width / 2,
        y: (wy - camY) * camZoom + height / 2,
      };
    }

    function rebuildGraph(reheat = 0.65) {
      theme = getThemeColors();
      const allowedTypes = showHyps ? new Set(["rollup", "hypothesis"]) : new Set(["rollup"]);
      const activeIds = new Set(rawHabits.map((h) => h.id));

      const filteredEdges = rawEdges.filter(
        (e) =>
          allowedTypes.has(e.relation_type) &&
          activeIds.has(e.source_id) &&
          activeIds.has(e.target_id) &&
          e.source_id !== e.target_id
      );

      // Compute degree & bidirectional pair lookup
      const degIn = new Map();
      const degOut = new Map();
      const pairKeys = new Set();
      for (const e of filteredEdges) {
        degOut.set(e.source_id, (degOut.get(e.source_id) || 0) + 1);
        degIn.set(e.target_id, (degIn.get(e.target_id) || 0) + 1);
        pairKeys.add(`${e.source_id}=>${e.target_id}`);
      }

      const visibleHabits = onlyConnected
        ? rawHabits.filter((h) => (degIn.get(h.id) || 0) + (degOut.get(h.id) || 0) > 0)
        : rawHabits;

      const N = visibleHabits.length;
      const initR = Math.max(75, Math.min(180, 42 + N * 6));

      // Compute organic Liquid Balloon target radii (14d half-life exponential decay: active habits swell, reduced habits deflate over weeks!)
      const masses = visibleHabits.map((h) => Number((liquidById[h.id] && liquidById[h.id].mass) || 0));
      const refMass = Math.max(2.6, ...masses);
      const calcTargetRadius = (h, deg) => {
        const m = Number((liquidById[h.id] && liquidById[h.id].mass) || 0);
        const frac = m > 0 ? Math.min(1, Math.log1p(m * 1.35) / Math.log1p(refMass * 1.35)) : 0;
        return clamp(7.5 + frac * 17.5 + Math.min(1.5, deg * 0.25), 7.5, 25.5);
      };

      nodes = visibleHabits.map((h, idx) => {
        const cached = posCache.get(h.id);
        const angle = (idx / Math.max(1, N)) * Math.PI * 2 - Math.PI / 2;
        const tInfo = todayById.get(h.id);
        const liq = liquidById[h.id] || { mass: 0, trend: 0 };
        const inCnt = degIn.get(h.id) || 0;
        const outCnt = degOut.get(h.id) || 0;
        const deg = inCnt + outCnt;
        const targetR = calcTargetRadius(h, deg);
        const startR = cached && typeof cached.r === "number" ? cached.r : targetR;
        return {
          id: h.id,
          name: h.name,
          color: h.color || "#368470",
          kind: h.kind || "neutral",
          group: (h.group_name || "").trim(),
          inCnt,
          outCnt,
          deg,
          r: startR,
          targetR,
          mass: Number(liq.mass || 0),
          trend: Number(liq.trend || 0),
          direct: tInfo ? Number(tInfo.direct || 0) : 0,
          routed: tInfo ? Number(tInfo.routed || 0) : 0,
          effective: tInfo ? Number(tInfo.effective || 0) : 0,
          active: !!(tInfo && tInfo.active_since),
          x: cached ? cached.x : Math.cos(angle) * initR + (idx % 3 - 1) * 8,
          y: cached ? cached.y : Math.sin(angle) * initR + ((idx + 1) % 3 - 1) * 8,
          vx: cached ? cached.vx * 0.3 : 0,
          vy: cached ? cached.vy * 0.3 : 0,
        };
      });

      nodeById = new Map(nodes.map((n) => [n.id, n]));

      // Group parallel edges (e.g. rollup + hypothesis between same source -> target)
      const dirMulti = new Map();
      edges = filteredEdges
        .filter((e) => nodeById.has(e.source_id) && nodeById.has(e.target_id))
        .map((e) => {
          const dk = `${e.source_id}=>${e.target_id}`;
          const idx = dirMulti.get(dk) || 0;
          dirMulti.set(dk, idx + 1);
          const hasReverse = pairKeys.has(`${e.target_id}=>${e.source_id}`);
          return {
            id: e.id,
            source: nodeById.get(e.source_id),
            target: nodeById.get(e.target_id),
            weight: Number(e.weight || 0),
            type: e.relation_type,
            isAi: !!e.is_ai,
            hasReverse,
            parallelIdx: idx,
          };
        });

      if (selectedId && !nodeById.has(selectedId)) {
        selectedId = null;
        if (opts.onSelectChange) opts.onSelectChange(null);
      }
      if (hoveredId && !nodeById.has(hoveredId)) hoveredId = null;

      alpha = Math.max(alpha, reheat);
      renderReadout();
      scheduleFrame();
    }

    function stepPhysics() {
      const n = nodes.length;
      if (!n) return;

      const repulseK = 2800;
      const springLenBase = n > 14 ? 112 : 98;
      const gravityK = 0.018;
      const groupK = 0.008;

      // Pairwise repulsion & soft group cohesion
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let dist2 = dx * dx + dy * dy;
          if (dist2 < 1) {
            dx = (i % 2 ? 1 : -1) * 0.8;
            dy = (j % 2 ? 1 : -1) * 0.8;
            dist2 = dx * dx + dy * dy;
          }
          const dist = Math.sqrt(dist2);
          const minSep = a.r + b.r + 24;
          const rep = (repulseK / Math.max(dist2, minSep * minSep)) * alpha;
          const fx = (dx / dist) * rep;
          const fy = (dy / dist) * rep;
          a.vx -= fx;
          a.vy -= fy;
          b.vx += fx;
          b.vy += fy;

          // Subtle pull for nodes in the same habit group
          if (a.group && a.group === b.group && dist > 78) {
            const gf = (dist - 78) * groupK * alpha;
            a.vx += (dx / dist) * gf;
            a.vy += (dy / dist) * gf;
            b.vx -= (dx / dist) * gf;
            b.vy -= (dy / dist) * gf;
          }
        }
      }

      // Edge springs
      for (const e of edges) {
        const a = e.source;
        const b = e.target;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const strength = clamp(Math.abs(e.weight), 0.15, 1.5);
        const rest = springLenBase - Math.min(20, strength * 12);
        const k = (e.type === "hypothesis" ? 0.018 : 0.034) * alpha;
        const f = (dist - rest) * k;
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }

      // Centering gravity + viscous velocity integration
      const damp = dragNode ? 0.72 : 0.78;
      const speedCap = dragNode ? 5.5 : 11;
      let maxSpeed = 0;
      for (const nd of nodes) {
        if (dragNode && nd.id === dragNode.id) {
          nd.vx = 0;
          nd.vy = 0;
          continue;
        }
        // Isolated nodes orbit cleanly at gentle outer radius
        const gMult = nd.deg === 0 ? 0.9 : 1.15;
        nd.vx -= nd.x * gravityK * gMult * alpha;
        nd.vy -= nd.y * gravityK * gMult * alpha;
        nd.vx *= damp;
        nd.vy *= damp;
        const sp = Math.hypot(nd.vx, nd.vy);
        if (sp > speedCap) {
          nd.vx = (nd.vx / sp) * speedCap;
          nd.vy = (nd.vy / sp) * speedCap;
        }
        nd.x += nd.vx;
        nd.y += nd.vy;
        if (sp > maxSpeed) maxSpeed = sp;
      }

      // Overdamped position-based collision separation (prevents overlap without elastic bounce)
      let maxCorr = 0;
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        const aPinned = !!(dragNode && a.id === dragNode.id);
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          const bPinned = !!(dragNode && b.id === dragNode.id);
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let dist2 = dx * dx + dy * dy;
          const minSep = a.r + b.r + 22;
          if (dist2 >= minSep * minSep) continue;
          if (dist2 < 0.01) {
            dx = (i % 2 ? 1 : -1) * 0.5;
            dy = (j % 2 ? 1 : -1) * 0.5;
            dist2 = dx * dx + dy * dy;
          }
          const dist = Math.sqrt(dist2);
          const ux = dx / dist;
          const uy = dy / dist;
          const push = Math.min(2.8, (minSep - dist) * 0.16);
          if (push > maxCorr) maxCorr = push;
          if (aPinned && !bPinned) {
            b.x += ux * push;
            b.y += uy * push;
            b.vx *= 0.65;
            b.vy *= 0.65;
          } else if (bPinned && !aPinned) {
            a.x -= ux * push;
            a.y -= uy * push;
            a.vx *= 0.65;
            a.vy *= 0.65;
          } else if (!aPinned && !bPinned) {
            const half = push * 0.5;
            a.x -= ux * half;
            a.y -= uy * half;
            b.x += ux * half;
            b.y += uy * half;
          }
        }
      }

      for (const nd of nodes) {
        posCache.set(nd.id, { x: nd.x, y: nd.y, vx: nd.vx, vy: nd.vy, r: nd.r });
      }

      alpha *= alpha < 0.18 ? 0.965 : 0.985;
      if (alpha < 0.008 && maxSpeed < 0.05 && maxCorr < 0.12) {
        alpha = 0;
      }
    }

    function edgeCurveGeom(e) {
      const a = e.source;
      const b = e.target;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist;
      const uy = dy / dist;
      const nx = -uy;
      const ny = ux;
      // Symmetric opposing arcs for circular/bidirectional pairs (e.g. Coding <-> Upgrade)
      const curveMag = e.hasReverse ? 24 + e.parallelIdx * 16 : e.parallelIdx > 0 ? 18 * e.parallelIdx : 7;
      const mx = (a.x + b.x) * 0.5 + nx * curveMag;
      const my = (a.y + b.y) * 0.5 + ny * curveMag;
      // Start & end trimmed cleanly to node rims
      const tStart = clamp((a.r + 2) / dist, 0.02, 0.35);
      const tEnd = clamp(1 - (b.r + 5) / dist, 0.65, 0.98);
      const p0 = quadPoint(a.x, a.y, mx, my, b.x, b.y, tStart);
      const p1 = quadPoint(a.x, a.y, mx, my, b.x, b.y, tEnd);
      const pMid = quadPoint(a.x, a.y, mx, my, b.x, b.y, 0.5);
      // Tangent at end for crisp arrowhead orientation
      const tx = 2 * (1 - tEnd) * (mx - a.x) + 2 * tEnd * (b.x - mx);
      const ty = 2 * (1 - tEnd) * (my - a.y) + 2 * tEnd * (b.y - my);
      const ang = Math.atan2(ty, tx);
      return { x0: p0.x, y0: p0.y, cx: mx, cy: my, x1: p1.x, y1: p1.y, midX: pMid.x, midY: pMid.y, ang };
    }

    function draw() {
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      // Subtle architectural dot grid
      const gridStep = 28 * camZoom;
      if (gridStep >= 14) {
        ctx.fillStyle = hexToRgba(theme.muted, 0.14);
        const offX = ((width / 2 - camX * camZoom) % gridStep + gridStep) % gridStep;
        const offY = ((height / 2 - camY * camZoom) % gridStep + gridStep) % gridStep;
        for (let gx = offX; gx < width; gx += gridStep) {
          for (let gy = offY; gy < height; gy += gridStep) {
            ctx.fillRect(gx - 0.6, gy - 0.6, 1.2, 1.2);
          }
        }
      }

      if (!nodes.length) {
        ctx.fillStyle = theme.muted;
        ctx.font = "13px system-ui, -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(tr("graph_empty"), width / 2, height / 2);
        ctx.restore();
        return;
      }

      const focusId = hoveredId || selectedId;
      const connectedNodes = new Set();
      if (focusId) {
        connectedNodes.add(focusId);
        for (const e of edges) {
          if (e.source.id === focusId) connectedNodes.add(e.target.id);
          if (e.target.id === focusId) connectedNodes.add(e.source.id);
        }
      }

      // Transform into world coordinates
      ctx.translate(width / 2, height / 2);
      ctx.scale(camZoom, camZoom);
      ctx.translate(-camX, -camY);

      // 1. Draw edges
      for (const e of edges) {
        const isFocusEdge = !focusId || e.source.id === focusId || e.target.id === focusId;
        const g = edgeCurveGeom(e);
        const isHyp = e.type === "hypothesis";
        const targetKind = (e.target && e.target.kind) || "neutral";
        const valenceCol =
          targetKind === "max"
            ? e.weight < 0
              ? theme.pos
              : theme.neg
            : targetKind === "min"
              ? e.weight >= 0
                ? theme.pos
                : theme.neg
              : theme.accent;
        const baseCol = valenceCol;
        const lineAlpha = focusId ? (isFocusEdge ? 0.92 : 0.1) : isHyp ? 0.58 : 0.65;
        const lineW = clamp(1.1 + Math.abs(e.weight) * 1.4, 1.2, 3.2) / Math.sqrt(camZoom);

        ctx.save();
        ctx.strokeStyle = hexToRgba(baseCol, lineAlpha);
        ctx.lineWidth = isFocusEdge && focusId ? lineW * 1.25 : lineW;
        if (isHyp) ctx.setLineDash([2.5 / camZoom, 4 / camZoom]);
        else if (e.weight < 0) ctx.setLineDash([8 / camZoom, 3.5 / camZoom]);
        ctx.beginPath();
        ctx.moveTo(g.x0, g.y0);
        ctx.quadraticCurveTo(g.cx, g.cy, g.x1, g.y1);
        ctx.stroke();
        ctx.setLineDash([]);

        // Directional arrowhead strictly into target rim
        const headLen = (isFocusEdge && focusId ? 7.5 : 6) / Math.sqrt(camZoom);
        ctx.fillStyle = hexToRgba(baseCol, Math.min(1, lineAlpha + 0.12));
        ctx.beginPath();
        ctx.moveTo(g.x1, g.y1);
        ctx.lineTo(g.x1 - headLen * Math.cos(g.ang - 0.42), g.y1 - headLen * Math.sin(g.ang - 0.42));
        ctx.lineTo(g.x1 - headLen * Math.cos(g.ang + 0.42), g.y1 - headLen * Math.sin(g.ang + 0.42));
        ctx.closePath();
        ctx.fill();

        // Subtle moving flow particle along highlighted edges (shows source -> target direction in motion!)
        if (focusId && isFocusEdge) {
          const tFlow = (animPhase + (e.parallelIdx * 0.33)) % 1;
          const pt = quadPoint(g.x0, g.y0, g.cx, g.cy, g.x1, g.y1, tFlow);
          ctx.fillStyle = baseCol;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 2.7 / Math.sqrt(camZoom), 0, Math.PI * 2);
          ctx.fill();

          // Crisp weight label pill on focused edges (? prefix for hypotheses, KI for TabPFN edges)
          const pfx = isHyp ? "? " : e.isAi ? "KI " : "";
          const wLbl = `${pfx}${e.weight >= 0 ? "+" : ""}${fmtW(e.weight)}`;
          ctx.font = `600 ${Math.round(10 / Math.sqrt(camZoom))}px ui-monospace, SFMono-Regular, monospace`;
          const tw = ctx.measureText(wLbl).width;
          const padX = 4 / Math.sqrt(camZoom);
          const pillH = 14 / Math.sqrt(camZoom);
          ctx.fillStyle = hexToRgba(theme.bg, 0.92);
          ctx.beginPath();
          ctx.roundRect(g.midX - tw / 2 - padX, g.midY - pillH / 2, tw + padX * 2, pillH, 4 / Math.sqrt(camZoom));
          ctx.fill();
          ctx.strokeStyle = hexToRgba(baseCol, 0.42);
          ctx.lineWidth = 0.8 / Math.sqrt(camZoom);
          ctx.stroke();
          ctx.fillStyle = baseCol;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(wLbl, g.midX, g.midY + 0.5);
        }
        ctx.restore();
      }

      // 2. Draw nodes
      for (const nd of nodes) {
        const isFocus = nd.id === focusId;
        const isRelated = !focusId || connectedNodes.has(nd.id);
        const nodeAlpha = isRelated ? 1 : 0.2;

        ctx.save();
        ctx.globalAlpha = nodeAlpha;

        // Subtle outer glow if logged today or active timer
        if (nd.active || nd.direct > 0 || Math.abs(nd.routed) > 1e-6 || isFocus) {
          const haloR = nd.r + (isFocus ? 6.5 : nd.active ? 5.5 + Math.sin(animPhase * Math.PI * 2) * 1.5 : 4);
          ctx.fillStyle = hexToRgba(nd.color, isFocus ? 0.24 : 0.16);
          ctx.beginPath();
          ctx.arc(nd.x, nd.y, haloR, 0, Math.PI * 2);
          ctx.fill();
        }

        // Main circular flat node (crisp, rich solid fill — liquid feel comes from motion & radius, not 3D gloss)
        ctx.fillStyle = nd.color;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, nd.r, 0, Math.PI * 2);
        ctx.fill();

        // Crisp rim
        ctx.strokeStyle = isFocus ? theme.text : hexToRgba(theme.bg, 0.85);
        ctx.lineWidth = (isFocus ? 2 : 1.3) / Math.sqrt(camZoom);
        ctx.stroke();

        // Label below node
        const fontSize = Math.round((isFocus ? 12 : 11) / Math.sqrt(camZoom));
        ctx.font = `${isFocus ? 600 : 500} ${fontSize}px system-ui, -apple-system, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const ly = nd.y + nd.r + 4 / Math.sqrt(camZoom);
        // Soft halo under text for legibility over edges
        ctx.lineWidth = 3 / Math.sqrt(camZoom);
        ctx.strokeStyle = hexToRgba(theme.bg, 0.88);
        ctx.strokeText(nd.name, nd.x, ly);
        ctx.fillStyle = isFocus ? theme.text : theme.text2;
        ctx.fillText(nd.name, nd.x, ly);
        ctx.restore();
      }

      ctx.restore();
    }

    function tick(ts) {
      rafId = null;
      const dt = lastFrameTs ? Math.min(0.05, (ts - lastFrameTs) / 1000) : 0.016;
      lastFrameTs = ts;
      let radiiMorphing = false;
      for (const nd of nodes) {
        const diff = (nd.targetR ?? nd.r) - nd.r;
        if (Math.abs(diff) > 0.06) {
          nd.r += diff * 0.14;
          radiiMorphing = true;
          const prev = posCache.get(nd.id);
          if (prev) prev.r = nd.r;
        } else if (nd.targetR != null) {
          nd.r = nd.targetR;
        }
      }
      if (alpha > 0 || radiiMorphing) {
        if (radiiMorphing && alpha < 0.08) alpha = 0.08;
        stepPhysics();
      }
      const hasFlowAnim = !!(hoveredId || selectedId || nodes.some((nd) => nd.active));
      if (hasFlowAnim) {
        animPhase = (animPhase + dt * 0.42) % 1;
      }
      draw();
      if (alpha > 0 || hasFlowAnim || radiiMorphing) {
        rafId = requestAnimationFrame(tick);
      } else {
        lastFrameTs = 0;
      }
    }

    function scheduleFrame() {
      if (!rafId) {
        rafId = requestAnimationFrame(tick);
      }
    }

    function hitNode(sx, sy) {
      const p = screenToWorld(sx, sy);
      let best = null;
      let bestD = Infinity;
      for (const nd of nodes) {
        const hitR = Math.max(nd.r + 7 / camZoom, 15 / camZoom);
        const d = Math.hypot(nd.x - p.x, nd.y - p.y);
        if (d <= hitR && d < bestD) {
          best = nd;
          bestD = d;
        }
      }
      return best;
    }

    function renderReadout() {
      if (!readoutEl) return;
      const nd = selectedId ? nodeById.get(selectedId) : hoveredId ? nodeById.get(hoveredId) : null;
      if (!nd) {
        readoutEl.innerHTML = `<span class="muted sm-text">${tr("graph_hint")}</span>`;
        return;
      }
      const todayTxt =
        nd.effective !== 0 || nd.direct !== 0
          ? ` · ${tr("today")}: ${fmtW(nd.effective)}`
          : "";
      const trendTxt =
        Math.abs(nd.trend || 0) >= 0.08
          ? ` · ${nd.trend > 0 ? tr("graph_trend_up") : tr("graph_trend_down")}`
          : "";
      const actionsHtml = selectedId
        ? `<div class="row-inline" style="gap:5px;margin-left:auto;">
            <button type="button" class="btn ghost sm" data-gact="src" data-gid="${nd.id}">${tr("graph_set_src")}</button>
            <button type="button" class="btn ghost sm" data-gact="dst" data-gid="${nd.id}">${tr("graph_set_dst")}</button>
            <button type="button" class="btn ghost sm" data-gact="edit" data-gid="${nd.id}">Edit</button>
            <button type="button" class="btn ghost sm" data-gact="clear" title="${tr("btn_close")}">✕</button>
          </div>`
        : "";
      const safeName = String(nd.name)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      readoutEl.innerHTML = `
        <div class="row-inline" style="gap:7px;min-width:0;flex-wrap:wrap;">
          <span class="ev-dot" style="background:${nd.color}"></span>
          <strong>${safeName}</strong>
          <span class="muted mono sm-text">${tr("graph_node_stats", { ins: nd.inCnt, outs: nd.outCnt })}${todayTxt}${trendTxt}</span>
        </div>
        ${actionsHtml}`;
    }

    if (readoutEl) {
      readoutEl.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-gact]");
        if (!btn) return;
        const act = btn.dataset.gact;
        const gid = btn.dataset.gid;
        if (act === "clear") {
          selectedId = null;
          if (opts.onSelectChange) opts.onSelectChange(null);
          renderReadout();
          scheduleFrame();
          return;
        }
        if (opts.onNodeAction && gid) opts.onNodeAction(act, gid);
      });
    }

    // Pointer events (unified Mouse + Touch!)
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      activePointerId = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
      const hit = hitNode(sx, sy);
      dragMoved = false;
      panStartX = sx;
      panStartY = sy;
      if (hit) {
        dragNode = hit;
        const w = screenToWorld(sx, sy);
        dragOffsetX = hit.x - w.x;
        dragOffsetY = hit.y - w.y;
        canvas.style.cursor = "grabbing";
        scheduleFrame();
      } else {
        isPanning = true;
        panCamStartX = camX;
        panCamStartY = camY;
        canvas.style.cursor = "grabbing";
      }
    });

    canvas.addEventListener("pointermove", (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (dragNode && e.pointerId === activePointerId) {
        if (!dragMoved && Math.hypot(sx - panStartX, sy - panStartY) > 4) {
          dragMoved = true;
        }
        if (!dragMoved) return;
        const w = screenToWorld(sx, sy);
        dragNode.x = w.x + dragOffsetX;
        dragNode.y = w.y + dragOffsetY;
        dragNode.vx = 0;
        dragNode.vy = 0;
        posCache.set(dragNode.id, { x: dragNode.x, y: dragNode.y, vx: 0, vy: 0, r: dragNode.r });
        alpha = Math.max(alpha, 0.14);
        scheduleFrame();
        return;
      }

      if (isPanning && e.pointerId === activePointerId) {
        if (Math.hypot(sx - panStartX, sy - panStartY) > 4) dragMoved = true;
        camX = panCamStartX - (sx - panStartX) / camZoom;
        camY = panCamStartY - (sy - panStartY) / camZoom;
        scheduleFrame();
        return;
      }

      if (e.pointerType === "mouse") {
        const hit = hitNode(sx, sy);
        const nextHover = hit ? hit.id : null;
        if (nextHover !== hoveredId) {
          hoveredId = nextHover;
          canvas.style.cursor = hit ? "pointer" : "grab";
          renderReadout();
          scheduleFrame();
        }
      }
    });

    const endPointer = (e) => {
      if (e.pointerId !== activePointerId) return;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {}
      if (dragNode && !dragMoved) {
        selectedId = selectedId === dragNode.id ? null : dragNode.id;
        if (opts.onSelectChange) opts.onSelectChange(selectedId);
        renderReadout();
      } else if (isPanning && !dragMoved && selectedId) {
        selectedId = null;
        if (opts.onSelectChange) opts.onSelectChange(null);
        renderReadout();
      }
      dragNode = null;
      isPanning = false;
      activePointerId = null;
      canvas.style.cursor = hoveredId ? "pointer" : "grab";
      scheduleFrame();
    };
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);
    canvas.addEventListener("pointerleave", () => {
      if (!dragNode && hoveredId) {
        hoveredId = null;
        renderReadout();
        scheduleFrame();
      }
    });

    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const before = screenToWorld(sx, sy);
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        camZoom = clamp(camZoom * factor, 0.35, 3.2);
        const after = screenToWorld(sx, sy);
        camX += before.x - after.x;
        camY += before.y - after.y;
        scheduleFrame();
      },
      { passive: false }
    );

    function fitView() {
      if (!nodes.length) {
        camX = 0;
        camY = 0;
        camZoom = 1;
        scheduleFrame();
        return;
      }
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const nd of nodes) {
        if (nd.x - 40 < minX) minX = nd.x - 40;
        if (nd.x + 40 > maxX) maxX = nd.x + 40;
        if (nd.y - 30 < minY) minY = nd.y - 30;
        if (nd.y + 42 > maxY) maxY = nd.y + 42;
      }
      const spanX = Math.max(120, maxX - minX);
      const spanY = Math.max(120, maxY - minY);
      camX = (minX + maxX) * 0.5;
      camY = (minY + maxY) * 0.5;
      camZoom = clamp(Math.min((width - 28) / spanX, (height - 28) / spanY), 0.45, 1.55);
      scheduleFrame();
    }

    return {
      update({ habits, edges: edgeList, todayHabits, liquidByHabit, reheat = 0.55 }) {
        rawHabits = Array.isArray(habits) ? habits : [];
        rawEdges = Array.isArray(edgeList) ? edgeList : [];
        todayById = new Map((Array.isArray(todayHabits) ? todayHabits : []).map((h) => [h.id, h]));
        if (liquidByHabit && typeof liquidByHabit === "object") liquidById = liquidByHabit;
        resize();
        rebuildGraph(reheat);
      },
      setOptions(next = {}) {
        if (typeof next.showHyps === "boolean") showHyps = next.showHyps;
        if (typeof next.onlyConnected === "boolean") onlyConnected = next.onlyConnected;
        rebuildGraph(0.45);
      },
      getNodesSnapshot() {
        return nodes.map((nd) => ({
          id: nd.id,
          x: Math.round(nd.x * 10) / 10,
          y: Math.round(nd.y * 10) / 10,
          r: Math.round(nd.r * 10) / 10,
          targetR: Math.round((nd.targetR ?? nd.r) * 10) / 10,
          mass: nd.mass,
          trend: nd.trend,
        }));
      },
      reheat() {
        posCache.clear();
        rebuildGraph(1.0);
        setTimeout(fitView, 450);
      },
      fit: fitView,
      zoomBy(mult) {
        camZoom = clamp(camZoom * mult, 0.35, 3.2);
        scheduleFrame();
      },
      clearSelection() {
        if (!selectedId) return;
        selectedId = null;
        renderReadout();
        scheduleFrame();
      },
      refreshTheme() {
        theme = getThemeColors();
        scheduleFrame();
      },
      resize,
    };
  }

  window.DailyForceGraph = { create: createForceGraph };
})();
