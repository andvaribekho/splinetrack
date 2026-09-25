// Convierte el layout crudo (en unidades del lienzo / imagen) en rutas muestreadas en metros,
// detecta cruces, solapamientos y horquillas problemáticas.
import {
  dedupe, smoothPolyline, resampleUniform, catmullRom, polylineLength, makeSampledRoute,
  nearestOnSamples, evalAt, segIntersect, SpatialGrid, arcDelta, clamp, movingAverage, smoothstep,
} from './geometry.js';

export const DEFAULT_GEOM = {
  lapLength: 1000, // m
  width: 14, // m
  useImageWidth: false,
  altWidthSame: true, // los atajos usan el ancho de la pista
  altWidth: 10, // m, si altWidthSame = false
  altInheritWidth: false, // los atajos toman el ancho de la pista en la salida y la llegada (transición)
  altFromCenter: true, // los atajos salen desde el eje de la pista (bajo ella); false = desde el borde
  detail: 14, // m entre puntos de control
  sketchSmooth: 3, // iteraciones de suavizado del trazo
};

function toWorldFactory(cx, cy, scale) {
  return {
    toWorld: (x, y) => [(x - cx) * scale, -(y - cy) * scale],
    toLayout: (X, Y) => [X / scale + cx, -Y / scale + cy],
  };
}

function withWidth(pts, gp, scale, fallback) {
  const hasW = pts.some((p) => p.length > 2 && isFinite(p[2]));
  return pts.map((p) => {
    let w = gp.width;
    if (gp.useImageWidth && hasW && isFinite(p[2])) w = clamp(p[2] * scale, 3, 80);
    else if (fallback) w = fallback;
    return [p[0], p[1], w];
  });
}

function buildGeometry(ptsWorld, closed, gp, ds, isCtrl = false) {
  let pts = dedupe(ptsWorld, 1e-6, closed);
  if (pts.length < 2) return null;
  if (isCtrl) {
    // Puntos de control editados a mano: el spline pasa exactamente por ellos.
    return resampleUniform(catmullRom(pts, closed, 12), ds, closed);
  }
  pts = smoothPolyline(pts, gp.sketchSmooth, closed);
  const ctrlStep = Math.max(gp.detail, ds * 2);
  let ctrl = resampleUniform(pts, ctrlStep, closed);
  if (ctrl.length < (closed ? 3 : 2)) ctrl = pts;
  const dense = catmullRom(ctrl, closed, 8);
  return resampleUniform(dense, ds, closed);
}

function finalizeWidth(uni, closed, gp) {
  if (!gp.useImageWidth) return uni;
  const w = new Float64Array(uni.map((p) => p[2]));
  const sm = movingAverage(w, 12, closed);
  return uni.map((p, i) => [p[0], p[1], sm[i]]);
}

/**
 * project: { main:{pts,closed}, alts:[{pts,keep,name}], start:[x,y]|null, reverse:bool }
 * gp: parámetros geométricos (DEFAULT_GEOM)
 */
export function buildLayout(project, gpIn = {}) {
  const gp = { ...DEFAULT_GEOM, ...gpIn };
  const warnings = [];
  if (!project.main || project.main.pts.length < 3) return null;
  const closed = project.main.closed !== false;
  const isCtrl = Array.isArray(project.main.ctrl) && project.main.ctrl.length >= (closed ? 3 : 2);
  let raw = dedupe(isCtrl ? project.main.ctrl : project.main.pts, 1e-6, closed);
  if (project.reverse) raw = raw.slice().reverse();
  if (raw.length < 3) return null;

  // Centro y escala: la vuelta suavizada debe medir lapLength.
  let cx = 0, cy = 0;
  for (const p of raw) { cx += p[0]; cy += p[1]; }
  cx /= raw.length; cy /= raw.length;
  const rawLen = polylineLength(isCtrl ? catmullRom(raw, closed, 12) : smoothPolyline(raw, gp.sketchSmooth, closed), closed);
  let scale = gp.lapLength / rawLen;
  // Con puntos editados a mano la escala queda fija: mover un punto no reescala toda la pista.
  const locked = isCtrl && isFinite(project.main.scale) && project.main.scale > 0;
  if (locked) {
    scale = project.main.scale;
    if (Array.isArray(project.main.center)) [cx, cy] = project.main.center;
  }
  const ds = clamp((locked ? rawLen * scale : gp.lapLength) / 1200, 0.75, 4);

  let mainUni = null, tw = null;
  for (let pass = 0; pass < (locked ? 0 : 2); pass++) {
    tw = toWorldFactory(cx, cy, scale);
    const w = withWidth(raw, gp, scale).map((p) => [...tw.toWorld(p[0], p[1]), p[2]]);
    mainUni = buildGeometry(w, closed, gp, ds, isCtrl);
    const L = polylineLength(mainUni, closed);
    scale *= gp.lapLength / L;
  }
  tw = toWorldFactory(cx, cy, scale);
  {
    const w = withWidth(raw, gp, scale).map((p) => [...tw.toWorld(p[0], p[1]), p[2]]);
    mainUni = finalizeWidth(buildGeometry(w, closed, gp, ds, isCtrl), closed, gp);
  }

  // Línea de meta: rota el inicio de la ruta cerrada.
  if (closed && project.start) {
    const [sx, sy] = tw.toWorld(project.start[0], project.start[1]);
    let bi = 0, bd = Infinity;
    mainUni.forEach((p, i) => {
      const d = Math.hypot(p[0] - sx, p[1] - sy);
      if (d < bd) { bd = d; bi = i; }
    });
    mainUni = mainUni.slice(bi).concat(mainUni.slice(0, bi));
  } else if (closed) {
    // Meta automática: el tramo más recto y lejos de cruces.
    const tmp = makeSampledRoute(mainUni, true, ds);
    tmp.id = 0; tmp.kind = 'main';
    const cr = detectCrossings([tmp], gp);
    const absK = new Float64Array(tmp.n);
    for (let i = 0; i < tmp.n; i++) absK[i] = Math.abs(tmp.k[i]);
    const sm = movingAverage(absK, Math.round(40 / ds), true);
    let bi = 0, bs = Infinity;
    for (let i = 0; i < tmp.n; i++) {
      let pen = 0;
      for (const c of cr) {
        const d = Math.min(Math.abs(arcDelta(tmp, tmp.s[i], c.sa)), Math.abs(arcDelta(tmp, tmp.s[i], c.sb)));
        if (d < 120) pen += (120 - d) * 0.01;
      }
      const sc = sm[i] + pen;
      if (sc < bs) { bs = sc; bi = i; }
    }
    mainUni = mainUni.slice(bi).concat(mainUni.slice(0, bi));
  }

  // Puentes: tramo entre dos puntos de control (a → b) con su propio ancho y transiciones suaves
  const bridges = [];
  if (isCtrl && Array.isArray(project.main.bridges) && project.main.bridges.length) {
    const n = mainUni.length;
    const nearestUni = (lp) => {
      const [wx, wy] = tw.toWorld(lp[0], lp[1]);
      let bi = 0, bd = Infinity;
      for (let i = 0; i < n; i++) { const d = (mainUni[i][0] - wx) ** 2 + (mainUni[i][1] - wy) ** 2; if (d < bd) { bd = d; bi = i; } }
      return bi;
    };
    const base = mainUni.map((p) => p[2]);
    const orig = mainUni.map((p) => p.slice());
    // normal izquierda del eje original (para desplazar el puente hacia un borde)
    const nrm = (i) => {
      const ia = closed ? (i - 1 + n) % n : Math.max(0, i - 1), ib = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
      const dx = orig[ib][0] - orig[ia][0], dy = orig[ib][1] - orig[ia][1], l = Math.hypot(dx, dy) || 1;
      return [-dy / l, dx / l];
    };
    let shifted = false;
    const trans = Math.max(4, gp.width * 0.8); // m de transición
    project.main.bridges.forEach((b, bIndex) => {
      if (!b || !b.a || !b.b || !(b.w > 0)) return;
      const ja = nearestUni(b.a), jb = nearestUni(b.b);
      let f = closed ? (jb - ja + n) % n : jb - ja, j0 = ja;
      if (closed) { const g = (ja - jb + n) % n; if (g < f) { f = g; j0 = jb; } } // el tramo corto entre ambos puntos
      else if (f < 0) { f = -f; j0 = jb; }
      if (f < 1) return;
      // con desplazamiento lateral la transición se alarga para que el eje no se quiebre (borde sin pliegues)
      const A = Math.abs(clamp(+b.off || 0, -1, 1)) * Math.max(0, (base[j0] - b.w) / 2);
      const tn = Math.round(Math.max(trans, Math.sqrt(12 * A * base[j0] / 2)) / ds);
      for (let d = -tn; d <= f + tn; d++) {
        const i = closed ? (((j0 + d) % n) + n) % n : j0 + d;
        if (i < 0 || i >= n) continue;
        const inside = d >= 0 && d <= f;
        const t = inside ? 1 : smoothstep(0, 1, 1 - (d < 0 ? -d : d - f) / tn);
        const w = base[i] + (b.w - base[i]) * t;
        // desplazamiento lateral: off = -1 (borde izquierdo) … 0 (centro) … 1 (borde derecho); el borde del puente
        // queda alineado con el borde de la pista, que es el límite
        const off = clamp(+b.off || 0, -1, 1);
        let px = mainUni[i][0], py = mainUni[i][1];
        if (off && t > 0) {
          const m = -off * Math.max(0, (base[i] - b.w) / 2) * t;
          const [nx, ny] = nrm(i);
          px = orig[i][0] + nx * m; py = orig[i][1] + ny * m;
          shifted = true;
        }
        mainUni[i] = [px, py, Math.abs(b.w - base[i]) > 1e-6 ? w : mainUni[i][2]];
      }
      bridges.push({ i0: j0, len: f, w: b.w, off: clamp(+b.off || 0, -1, 1), idx: bIndex, pa: null, pb: null });
    });
    // con desplazamiento, el eje cambió: se vuelve a muestrear uniforme y se ubica el tramo de cada puente
    if (shifted) {
      for (const b of bridges) {
        const ia = b.i0 % n, ib = closed ? (b.i0 + b.len) % n : Math.min(n - 1, b.i0 + b.len);
        b.pa = mainUni[ia].slice(0, 2); b.pb = mainUni[ib].slice(0, 2);
      }
      mainUni = resampleUniform(mainUni, ds, closed);
      const nn = mainUni.length;
      const near = (q, hint) => {
        let bi = hint, bd = Infinity;
        for (let d = -80; d <= 80; d++) {
          const i = closed ? (((hint + d) % nn) + nn) % nn : clamp(hint + d, 0, nn - 1);
          const e = (mainUni[i][0] - q[0]) ** 2 + (mainUni[i][1] - q[1]) ** 2;
          if (e < bd) { bd = e; bi = i; }
        }
        return bi;
      };
      for (const b of bridges) {
        const ja = near(b.pa, Math.round(b.i0 * nn / n)), jb = near(b.pb, Math.round((b.i0 + b.len) * nn / n));
        b.i0 = ja; b.len = closed ? (jb - ja + nn) % nn : Math.max(1, jb - ja);
      }
    }
  }
  const main = makeSampledRoute(mainUni, closed, ds);
  main.bridges = bridges.map((b) => ({ s0: b.i0 * main.ds, s1: (b.i0 + b.len) * main.ds, w: b.w, off: b.off || 0, idx: b.idx }));
  main.id = 0;
  main.kind = 'main';
  main.name = 'ruta_principal';
  const routes = [main];

  // Rutas alternativas
  (project.alts || []).forEach((alt, ai) => {
    if (alt.keep === false) return;
    const r = buildAlt(alt, ai, main, gp, tw, scale, ds, warnings);
    if (r) {
      r.id = routes.length;
      routes.push(r);
    }
  });

  const crossings = detectCrossings(routes, gp);
  const overlaps = detectOverlaps(routes, crossings, gp);
  const hairpins = detectHairpins(routes);
  for (const h of hairpins) {
    warnings.push({ level: 'warn', route: h.route, s: h.s, msg: `Horquilla muy cerrada en ${routes[h.route].name} (s≈${h.s.toFixed(0)} m): radio ${h.radius.toFixed(1)} m < medio ancho. La malla se autointersectará; baja el ancho o abre la curva.` });
  }
  for (const o of overlaps) {
    warnings.push({ level: 'warn', route: o.ra, s: o.sa0, msg: `Tramos superpuestos sin cruce: ${routes[o.ra].name} s≈${o.sa0.toFixed(0)}–${o.sa1.toFixed(0)} m con ${routes[o.rb].name} s≈${o.sb0.toFixed(0)}–${o.sb1.toFixed(0)} m (espiral o tramos paralelos demasiado cerca).` });
  }

  return {
    gp, scale, cx, cy, ds, routes, crossings, overlaps, warnings, scaleLocked: locked,
    toWorld: tw.toWorld, toLayout: tw.toLayout,
  };
}

function buildAlt(alt, ai, main, gp, tw, scale, ds, warnings) {
  const altCtrl = Array.isArray(alt.ctrl) && alt.ctrl.length >= 2;
  const pts = dedupe(altCtrl ? alt.ctrl : alt.pts, 1e-6, false);
  if (pts.length < 2) return null;
  let w = withWidth(pts, gp, scale).map((p) => [...tw.toWorld(p[0], p[1]), p[2]]);
  // ancho propio del atajo (por atajo > general de atajos > el de la pista); en los empalmes se hace una transición
  const own = alt.width > 0 ? alt.width : gp.altWidthSame === false && gp.altWidth > 0 ? gp.altWidth : null;
  if (own) w = w.map((p) => [p[0], p[1], own]);
  else if (!gp.useImageWidth) w = w.map((p) => [p[0], p[1], gp.width]);
  const name = alt.name || `atajo_${String(ai + 1).padStart(2, '0')}`;
  const P = (sv) => { const e = evalAt(main, main.closed ? sv : clamp(sv, 0, main.L)); return [e.x, e.y, e.w]; };
  // Tramo "propio" del atajo: puntos separados de la ruta principal más de 1,5 anchos.
  const dMain = w.map((p) => nearestOnSamples(main, p[0], p[1]).d);
  const sep = gp.width * 1.5;
  let iA = dMain.findIndex((d) => d > sep);
  let iB = dMain.length - 1 - [...dMain].reverse().findIndex((d) => d > sep);
  if (iA < 0 || iB - iA < 1) {
    warnings.push({ level: 'warn', msg: `${name}: casi todo el trazo está encima de la ruta principal; se ignoró.` });
    return null;
  }
  const endA = nearestOnSamples(main, w[0][0], w[0][1]);
  const endB = nearestOnSamples(main, w[w.length - 1][0], w[w.length - 1][1]);
  const snapTol = gp.width * 3;
  if (endA.d > snapTol || endB.d > snapTol) {
    warnings.push({ level: 'warn', msg: `${name}: sus extremos están lejos de la ruta principal (${Math.max(endA.d, endB.d).toFixed(0)} m). Se ajustaron igual.` });
  }
  // Orientación: el atajo debe salir y volver en el sentido de la ruta principal.
  const tA = evalTangent(main, endA.s), tB = evalTangent(main, endB.s);
  const scoreFwd = ((w[iA][0] - endA.x) * tA[0] + (w[iA][1] - endA.y) * tA[1]) + ((endB.x - w[iB][0]) * tB[0] + (endB.y - w[iB][1]) * tB[1]);
  const scoreRev = ((w[iB][0] - endB.x) * tB[0] + (w[iB][1] - endB.y) * tB[1]) + ((endA.x - w[iA][0]) * tA[0] + (endA.y - w[iA][1]) * tA[1]);
  let forward;
  if (Math.abs(scoreFwd - scoreRev) > gp.width * 0.8) forward = scoreFwd >= scoreRev;
  else {
    // ambiguo (sale perpendicular): el atajo salta el tramo más corto de la principal
    const skipFwd = main.closed ? (((endB.s - endA.s) % main.L) + main.L) % main.L : endB.s - endA.s;
    const skipRev = main.closed ? main.L - skipFwd : -skipFwd;
    forward = skipFwd >= 0 && (skipRev < 0 || skipFwd <= skipRev);
  }
  if (alt.flip) forward = !forward;
  if (!forward) {
    w = w.slice().reverse();
    const n = w.length - 1;
    [iA, iB] = [n - iB, n - iA];
  }
  // Núcleo suavizado
  let core = w.slice(iA, iB + 1);
  if (!altCtrl) {
    core = smoothPolyline(core, gp.sketchSmooth, false);
    core = core.length >= 2 ? resampleUniform(core, Math.max(gp.detail, ds * 2), false) : core;
  }
  const coreDense = core.length >= 2 ? catmullRom(core, false, 8) : core;
  const hermite = (P0, T0, P1, T1) => {
    const L = Math.hypot(P1[0] - P0[0], P1[1] - P0[1]);
    const n0 = Math.hypot(T0[0], T0[1]) || 1, n1 = Math.hypot(T1[0], T1[1]) || 1;
    const m0 = [T0[0] / n0 * L, T0[1] / n0 * L], m1 = [T1[0] / n1 * L, T1[1] / n1 * L];
    const steps = Math.max(2, Math.ceil(L / ds));
    const out = [];
    for (let k = 1; k < steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      out.push([
        h00 * P0[0] + h10 * m0[0] + h01 * P1[0] + h11 * m1[0],
        h00 * P0[1] + h10 * m0[1] + h01 * P1[1] + h11 * m1[1],
        P0[2] + (P1[2] - P0[2]) * t,
      ]);
    }
    return out;
  };
  const c0 = coreDense[0], c1 = coreDense[coreDense.length - 1];
  // La bifurcación se adelanta/atrasa según lo lejos que esté el núcleo, para dejar espacio a la curva.
  const n0 = nearestOnSamples(main, c0[0], c0[1]);
  const n1 = nearestOnSamples(main, c1[0], c1[1]);
  const clampS = (v) => (main.closed ? ((v % main.L) + main.L) % main.L : clamp(v, 0, main.L));
  const forkS = clampS(n0.s - Math.max(n0.d * 1.1, gp.width));
  const mergeS = clampS(n1.s + Math.max(n1.d * 1.1, gp.width));
  const m = coreDense.length;
  const cT0 = m > 3 ? [coreDense[3][0] - c0[0], coreDense[3][1] - c0[1]] : [c1[0] - c0[0], c1[1] - c0[1]];
  const cT1 = m > 3 ? [c1[0] - coreDense[m - 4][0], c1[1] - coreDense[m - 4][1]] : cT0;
  // Los atajos salen desde el BORDE de la pista (no desde el eje): quedan pegados borde con borde y no se superponen.
  // Si el atajo es más angosto, se conecta del lado hacia el que sale.
  const aw = own || (gp.useImageWidth ? c0[2] : gp.width);
  const inherit = !!gp.altInheritWidth;
  const edgePoint = (sv, toward) => {
    const e = evalAt(main, sv);
    const tx = main.tx[e.i], ty = main.ty[e.i];
    const lx = -ty, ly = tx;
    const side = Math.sign((toward[0] - e.x) * lx + (toward[1] - e.y) * ly) || 1;
    const wEnd = inherit ? e.w : aw;
    const u = gp.altFromCenter === false ? side * (e.w / 2 + wEnd / 2) : 0; // desde el eje (por defecto) o desde el borde
    return { p: [e.x + lx * u, e.y + ly * u, wEnd], u };
  };
  const eIn = edgePoint(forkS, c0), eOut = edgePoint(mergeS, c1);
  const pIn = eIn.p, pOut = eOut.p;
  const all = [
    pIn,
    ...hermite(pIn, evalTangent(main, forkS), c0, cT0),
    ...coreDense,
    ...hermite(c1, cT1, pOut, evalTangent(main, mergeS)),
    pOut,
  ];
  const uni = resampleUniform(dedupe(all, 1e-6, false), ds, false);
  const r = makeSampledRoute(uni, false, ds);
  r.kind = 'alt';
  r.altIndex = ai;
  r.name = name;
  r.forkS = forkS;
  r.mergeS = mergeS;
  r.forkU = eIn.u; // desplazamiento lateral del eje del atajo respecto del eje de la principal (+ = izquierda)
  r.mergeU = eOut.u;
  return r;
}

function evalTangent(route, s) {
  const e = evalAt(route, s);
  return [route.tx[e.i], route.ty[e.i]];
}

/** Cruces reales (intersección de segmentos) entre rutas y consigo mismas. */
export function detectCrossings(routes, gp) {
  const found = [];
  const cell = Math.max(gp.width * 2, 8);
  for (let ra = 0; ra < routes.length; ra++) {
    for (let rb = ra; rb < routes.length; rb++) {
      const A = routes[ra], B = routes[rb];
      const grid = new SpatialGrid(cell);
      const segB = B.closed ? B.n : B.n - 1;
      for (let j = 0; j < segB; j++) {
        const j2 = (j + 1) % B.n;
        grid.insert((B.x[j] + B.x[j2]) / 2, (B.y[j] + B.y[j2]) / 2, j);
      }
      const segA = A.closed ? A.n : A.n - 1;
      const guardA = A.kind === 'alt' ? gp.detail * 1.6 + gp.width : 0;
      const guardB = B.kind === 'alt' ? gp.detail * 1.6 + gp.width : 0;
      for (let i = 0; i < segA; i++) {
        const i2 = (i + 1) % A.n;
        if (guardA && (A.s[i] < guardA || A.s[i] > A.L - guardA)) continue;
        const mx = (A.x[i] + A.x[i2]) / 2, my = (A.y[i] + A.y[i2]) / 2;
        grid.query(mx, my, cell, (j) => {
          if (ra === rb) {
            if (j <= i) return; // cada par una vez
            let d = Math.abs(i - j);
            if (A.closed) d = Math.min(d, A.n - d);
            if (d <= 3) return;
          }
          if (guardB && (B.s[j] < guardB || B.s[j] > B.L - guardB)) return;
          const j2 = (j + 1) % B.n;
          const hit = segIntersect(A.x[i], A.y[i], A.x[i2], A.y[i2], B.x[j], B.y[j], B.x[j2], B.y[j2]);
          if (!hit) return;
          const sa = A.s[i] + hit.t * A.ds;
          const sb = B.s[j] + hit.u * B.ds;
          const cross = A.tx[i] * B.ty[j] - A.ty[i] * B.tx[j];
          const angle = Math.asin(clamp(Math.abs(cross), 0, 1));
          found.push({
            ra, rb, sa, sb, angle,
            x: A.x[i] + hit.t * (A.x[i2] - A.x[i]),
            y: A.y[i] + hit.t * (A.y[i2] - A.y[i]),
          });
        });
      }
    }
  }
  // Fusiona intersecciones duplicadas cercanas (mismo cruce)
  const merged = [];
  for (const c of found) {
    const A = routes[c.ra], B = routes[c.rb];
    const m = merged.find((o) => o.ra === c.ra && o.rb === c.rb &&
      Math.abs(arcDelta(A, o.sa, c.sa)) < gp.width * 2.5 && Math.abs(arcDelta(B, o.sb, c.sb)) < gp.width * 2.5);
    if (!m) merged.push(c);
  }
  // Normaliza: en la misma ruta, "a" es el primer paso.
  for (const c of merged) {
    if (c.ra === c.rb && c.sb < c.sa) [c.sa, c.sb] = [c.sb, c.sa];
  }
  merged.sort((p, q) => (p.ra - q.ra) || (p.sa - q.sa));
  merged.forEach((c, k) => {
    c.id = k;
    c.pairs = crossingPairs(routes, c);
  });
  return merged;
}

/** Pares de muestras (i en ra, j en rb) que se solapan en XY alrededor de un cruce. */
function crossingPairs(routes, c) {
  const A = routes[c.ra], B = routes[c.rb];
  const wa = evalAt(A, c.sa).w, wb = evalAt(B, c.sb).w;
  const wmax = Math.max(wa, wb);
  const sinA = Math.max(Math.sin(c.angle), 0.2);
  const R = Math.min(wmax / sinA + wmax * 0.5, wmax * 6);
  c.window = R;
  const pairs = [];
  const nA = Math.ceil(R / A.ds);
  const ia0 = Math.round(c.sa / A.ds);
  const ib0 = Math.round(c.sb / B.ds);
  const nB = Math.ceil((R * 1.5) / B.ds);
  const idx = (r, i) => (r.closed ? ((i % r.n) + r.n) % r.n : i);
  for (let k = -nA; k <= nA; k++) {
    const i = idx(A, ia0 + k);
    if (i < 0 || i >= A.n) continue;
    let best = -1, bd = Infinity;
    for (let m = -nB; m <= nB; m++) {
      const j = idx(B, ib0 + m);
      if (j < 0 || j >= B.n) continue;
      const d = Math.hypot(A.x[i] - B.x[j], A.y[i] - B.y[j]);
      if (d < bd) { bd = d; best = j; }
    }
    if (best >= 0 && bd < (A.w[i] + B.w[best]) / 2 + 1.0) pairs.push([i, best]);
  }
  if (pairs.length === 0) pairs.push([idx(A, ia0), idx(B, ib0)]);
  return pairs;
}

/** Zonas donde dos tramos se superponen en planta sin cruzarse. */
function detectOverlaps(routes, crossings, gp) {
  const out = [];
  const inCrossing = (ra, sa, rb, sb) => crossings.some((c) => {
    const R = (c.window || gp.width * 3) * 1.6;
    const m1 = c.ra === ra && c.rb === rb && Math.abs(arcDelta(routes[ra], c.sa, sa)) < R && Math.abs(arcDelta(routes[rb], c.sb, sb)) < R;
    const m2 = c.ra === rb && c.rb === ra && Math.abs(arcDelta(routes[rb], c.sa, sb)) < R && Math.abs(arcDelta(routes[ra], c.sb, sa)) < R;
    return m1 || m2;
  });
  for (let ra = 0; ra < routes.length; ra++) {
    for (let rb = ra; rb < routes.length; rb++) {
      const A = routes[ra], B = routes[rb];
      const grid = new SpatialGrid(gp.width * 1.5);
      for (let j = 0; j < B.n; j++) grid.insert(B.x[j], B.y[j], j);
      const flagged = [];
      const step = Math.max(1, Math.round(2 / A.ds));
      for (let i = 0; i < A.n; i += step) {
        if (A.kind === 'alt' && (A.s[i] < gp.detail * 2.5 + gp.width || A.s[i] > A.L - gp.detail * 2.5 - gp.width)) continue;
        let hitJ = -1;
        grid.query(A.x[i], A.y[i], gp.width * 1.5, (j) => {
          if (hitJ >= 0) return;
          const lim = (A.w[i] + B.w[j]) / 2 - 0.5;
          if (Math.hypot(A.x[i] - B.x[j], A.y[i] - B.y[j]) > lim) return;
          if (ra === rb && Math.abs(arcDelta(A, A.s[i], A.s[j])) < Math.max(A.w[i], A.w[j]) * 3.2) return;
          if (B.kind === 'alt' && (B.s[j] < gp.detail * 2.5 + gp.width || B.s[j] > B.L - gp.detail * 2.5 - gp.width)) return;
          if (A.kind === 'alt' && B.kind === 'main' && A.id !== undefined) {
            // cerca de bifurcación/unión es normal que se toquen
            if (Math.abs(arcDelta(B, B.s[j], A.forkS)) < gp.width * 4 || Math.abs(arcDelta(B, B.s[j], A.mergeS)) < gp.width * 4) return;
          }
          if (inCrossing(ra, A.s[i], rb, B.s[j])) return;
          hitJ = j;
        });
        if (hitJ >= 0) flagged.push([i, hitJ]);
      }
      // agrupa por i contiguo
      let cur = null;
      for (const [i, j] of flagged) {
        if (ra === rb && j < i) continue; // evitar duplicado simétrico
        if (cur && i - cur.i1 <= step * 3) { cur.i1 = i; cur.j0 = Math.min(cur.j0, j); cur.j1 = Math.max(cur.j1, j); cur.pairs.push([i, j]); }
        else { cur = { ra, rb, i0: i, i1: i, j0: j, j1: j, pairs: [[i, j]] }; out.push(cur); }
      }
    }
  }
  return out
    .filter((o) => o.pairs.length >= 2)
    .map((o) => ({
      ...o,
      sa0: routes[o.ra].s[o.i0], sa1: routes[o.ra].s[o.i1],
      sb0: routes[o.rb].s[o.j0], sb1: routes[o.rb].s[o.j1],
    }));
}

function detectHairpins(routes) {
  const out = [];
  for (const r of routes) {
    let inBad = false;
    for (let i = 0; i < r.n; i++) {
      const rad = 1 / Math.max(Math.abs(r.k[i]), 1e-9);
      const bad = rad < r.w[i] / 2;
      if (bad && !inBad) out.push({ route: r.id ?? 0, s: r.s[i], radius: rad });
      inBad = bad;
    }
  }
  return out;
}

/** Genera puntos de control editables (en coordenadas del lienzo) desde un trazo crudo. */
export function deriveControlPoints(pts, closed, spacing, smoothIter) {
  let p = dedupe(pts, 1e-6, closed);
  if (p.length < 2) return p.map((q) => q.slice());
  p = smoothPolyline(p, smoothIter, closed);
  let c = resampleUniform(p, spacing, closed);
  if (c.length < (closed ? 4 : 3)) c = resampleUniform(p, polylineLength(p, closed) / (closed ? 6 : 4), closed);
  return c.map((q) => q.map((v) => +v.toFixed(3)));
}

/** Remuestrea puntos de control siguiendo el spline actual (para tener más o menos puntos). */
export function respaceControlPoints(ctrl, closed, spacing) {
  const dense = catmullRom(ctrl, closed, 16);
  let c = resampleUniform(dense, spacing, closed);
  if (c.length < (closed ? 4 : 3)) return ctrl;
  return c.map((q) => q.map((v) => +v.toFixed(3)));
}
