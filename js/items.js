// Elementos sobre la pista: charcos (discos azules), turbo pads (rectángulos con flecha) y nitro strips (franjas que siguen la pista).
// Se agrupan (A, B, C…); cada grupo reparte sus elementos al azar o dentro de zonas pintadas, de forma determinista (semilla).
// Las posiciones se guardan en coordenadas de pista (ruta k, largo s, desplazamiento lateral u), así se ajustan a la pista.
import { rng, clamp, nearestOnSamples } from './geometry.js';
import { frameAt } from './tunnels.js';

export const ITEM_TYPES = ['puddle', 'pad', 'strip'];
export const ITEM_PREFIX = { puddle: 'puddles', pad: 'turbopad', strip: 'nitrostrip' };
export const ITEM_LIFT = { puddle: 0.03, pad: 0.045, strip: 0.035 }; // m sobre la calzada (sin z-fighting)

/** Parámetros que los grupos comparten con el primer grupo (salvo que el grupo tenga «parámetros propios»). */
export const SHARED_KEYS = {
  puddle: ['max', 'count', 'size'],
  pad: ['max', 'count', 'width', 'length'],
  strip: ['max', 'count', 'maxLen', 'len', 'widthPct', 'lane'],
};
/** Grupo con los parámetros efectivos: los propios si es el primero o tiene custom; si no, los del primer grupo. */
export function effectiveGroup(g, first) {
  if (!first || first === g || g.custom) return g;
  const e = { ...g };
  for (const k of SHARED_KEYS[g.type]) e[k] = first[k];
  return e;
}

export function defaultGroup(type, gid, seed = 1) {
  const g = { gid, type, enabled: true, mode: 'random', max: type === 'strip' ? 6 : type === 'pad' ? 8 : 12, count: null, seed, paint: [], moves: {} };
  if (type === 'puddle') g.size = 4;
  if (type === 'pad') { g.width = 3; g.length = 5; }
  if (type === 'strip') { g.maxLen = 60; g.len = 40; g.widthPct = 10; g.lane = 'center'; }
  g.count = g.max;
  return g;
}

/** Próxima letra libre: A..Z, AA, AB… */
export function nextGroupId(groups) {
  const used = new Set(groups.map((g) => g.gid));
  for (let n = 0; n < 702; n++) {
    const id = n < 26 ? String.fromCharCode(65 + n) : String.fromCharCode(64 + Math.floor(n / 26)) + String.fromCharCode(65 + (n % 26));
    if (!used.has(id)) return id;
  }
  return `G${groups.length + 1}`;
}

export function itemName(type, gid, idx) { return `${ITEM_PREFIX[type]}${gid}-${idx + 1}`; }
export function groupName(type, gid) { return `${ITEM_PREFIX[type]}${gid}`; }

function wrapS(r, s) { return r.closed ? ((s % r.L) + r.L) % r.L : clamp(s, 0, r.L); }

/** Marco de la calzada en (k, s): adelante (con pendiente), lateral (con peralte) y normal de la superficie. */
export function trackFrame(layout, elev, k, s) {
  const r = layout.routes[k], e = elev.routes[k];
  const ss = wrapS(r, s);
  const F = frameAt(r, e, ss);
  const h = Math.max(0.5, r.ds);
  const za = frameAt(r, e, wrapS(r, ss - h)).z, zb = frameAt(r, e, wrapS(r, ss + h)).z;
  const grade = (zb - za) / (2 * h);
  let T = [F.tx, F.ty, grade];
  const lt = Math.hypot(...T); T = T.map((v) => v / lt);
  const Lr = F.L;
  let U = [T[1] * Lr[2] - T[2] * Lr[1], T[2] * Lr[0] - T[0] * Lr[2], T[0] * Lr[1] - T[1] * Lr[0]];
  const lu = Math.hypot(...U); U = U.map((v) => v / lu);
  const Lat = [U[1] * T[2] - U[2] * T[1], U[2] * T[0] - U[0] * T[2], U[0] * T[1] - U[1] * T[0]];
  return { F, T, Lat, U, w: F.w, at: (u, v = 0) => [F.x + Lat[0] * u + U[0] * v, F.y + Lat[1] * u + U[1] * v, F.z + Lat[2] * u + U[2] * v] };
}

/** Curvatura media en una ventana alrededor de s. */
function kMean(r, s, half) {
  const i0 = Math.round(wrapS(r, s) / r.ds);
  const win = Math.max(1, Math.round(half / r.ds));
  let acc = 0, n = 0;
  for (let d = -win; d <= win; d++) {
    const j = r.closed ? (((i0 + d) % r.n) + r.n) % r.n : clamp(i0 + d, 0, r.n - 1);
    acc += r.k[j]; n++;
  }
  return acc / n;
}

function inPaint(strokes, x, y) {
  let inside = false;
  for (const q of strokes) if ((x - q.x) ** 2 + (y - q.y) ** 2 <= q.r * q.r) inside = !q.e;
  return inside;
}

/** Dimensiones útiles del elemento (medio ancho lateral y medio largo). */
function dims(g, w) {
  if (g.type === 'puddle') return { hw: g.size / 2, hl: g.size / 2 };
  if (g.type === 'pad') return { hw: g.width / 2, hl: g.length / 2 };
  const sw = Math.max(0.1, (w * g.widthPct) / 100);
  return { hw: sw / 2, hl: g.len / 2 };
}

/** Lateral máximo para que el elemento quede dentro de la calzada. */
function uMax(w, hw) { return Math.max(0, w / 2 - hw - 0.25); }

function stripLaneU(g, r, s, w, hw, rand) {
  let lane = g.lane;
  if (lane === 'random') lane = ['center', 'inner', 'outer'][Math.floor(rand() * 3)];
  if (lane === 'center') return 0;
  const k = kMean(r, s, g.len / 2);
  const inner = k >= 0 ? 1 : -1; // giro a la izquierda: el interior es +u (izquierda)
  const mag = uMax(w, hw) * 0.8;
  return (lane === 'inner' ? inner : -inner) * mag;
}

/**
 * Genera los elementos de un grupo (hasta g.max, en orden determinista; se usan los primeros g.count).
 * paintW: zonas pintadas en metros [{x,y,r,e}]. Devuelve [{idx, k, s, u, moved}].
 */
export function placeGroup(layout, elev, g, paintW) {
  const routes = layout.routes.map((r, k) => ({ r, k })).filter(({ r }) => r.L > 1);
  const rand = rng(((g.seed | 0) * 2654435761 + g.gid.charCodeAt(0) * 97 + ITEM_TYPES.indexOf(g.type) * 7919) >>> 0);
  const out = [];
  const maxN = Math.max(0, g.max | 0);
  if (!routes.length || !maxN) return out;
  const painted = g.mode === 'painted';
  if (painted && !(paintW && paintW.some((q) => !q.e))) return out;
  // muestras candidatas (ruta, índice) con su peso
  const cands = [];
  let totalW = 0;
  for (const { r, k } of routes) {
    const step = Math.max(1, Math.round(1 / r.ds));
    const kAbs = g.type === 'strip' ? (() => { let a = 0; for (let i = 0; i < r.n; i++) a += Math.abs(r.k[i]); return a / r.n; })() : 0;
    for (let i = 0; i < r.n; i += step) {
      const s = r.s[i];
      if (painted && !inPaint(paintW, r.x[i], r.y[i])) continue;
      if (g.type === 'strip' && !r.closed && (s < g.len / 2 + 1 || s > r.L - g.len / 2 - 1)) continue;
      // los nitro strips privilegian las curvas
      const wgt = g.type === 'strip' ? Math.abs(kMean(r, s, g.len / 2)) + 0.25 * kAbs + 1e-5 : 1;
      totalW += wgt;
      cands.push({ k, i, s, wgt, cum: totalW });
    }
  }
  if (!cands.length) return out;
  const pick = () => {
    const t = rand() * totalW;
    let lo = 0, hi = cands.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cands[m].cum < t) lo = m + 1; else hi = m; }
    return cands[lo];
  };
  const tries = maxN * 80;
  for (let a = 0; a < tries && out.length < maxN; a++) {
    const c = pick();
    const r = layout.routes[c.k];
    const w = r.w[c.i];
    const { hw, hl } = dims(g, w);
    const s = c.s + (rand() - 0.5) * r.ds;
    let u;
    if (g.type === 'strip') u = stripLaneU(g, r, s, w, hw, rand);
    else u = (rand() * 2 - 1) * uMax(w, hw);
    // separación con los ya colocados
    let ok = true;
    for (const o of out) {
      if (o.k !== c.k) continue;
      let ds = Math.abs(o.s - s);
      if (r.closed) ds = Math.min(ds, r.L - ds);
      if (g.type === 'strip') { if (ds < g.len + 6) { ok = false; break; } }
      else if (Math.hypot(ds, o.u - u) < 2 * Math.max(hw, hl) + 1.5) { ok = false; break; }
    }
    if (!ok) continue;
    out.push({ idx: out.length, k: c.k, s, u, moved: false });
  }
  return out;
}

/** Aplica cantidad y movimientos manuales. */
export function resolveGroup(layout, elev, g, paintW) {
  const base = placeGroup(layout, elev, g, paintW);
  const n = Math.min(base.length, Math.max(0, g.count ?? g.max));
  const removed = new Set(g.removed || []);
  const list = base.slice(0, n).filter((it) => !removed.has(it.idx)); // los borrados a mano no aparecen (conservan su número)
  for (const it of list) {
    const m = g.moves && g.moves[it.idx];
    if (m && layout.routes[m.k]) { it.k = m.k; it.s = wrapS(layout.routes[m.k], m.s); it.u = m.u; it.moved = true; }
    const r = layout.routes[it.k];
    const i = clamp(Math.round(wrapS(r, it.s) / r.ds), 0, r.n - 1);
    const { hw } = dims(g, r.w[i]);
    it.u = clamp(it.u, -uMax(r.w[i], hw), uMax(r.w[i], hw));
  }
  return list;
}

/** Proyecta un punto XY a la pista: {k, s, u, d} (la ruta más cercana). */
export function projectToTrack(layout, x, y) {
  let best = null;
  layout.routes.forEach((r, k) => {
    const n = nearestOnSamples(r, x, y);
    if (!best || n.d < best.d) {
      const i = n.i;
      const u = (x - n.x) * -r.ty[i] + (y - n.y) * r.tx[i];
      best = { k, s: n.s, u, d: n.d };
    }
  });
  return best;
}

/**
 * Instancias con geometría: {type, gid, idx, name, k, s, u, moved, origin, basis:[T, Lat, U] | null, positions, uvs, indices, footprint}
 * La geometría es local al origen (pivote en la base, sobre la calzada). Charcos y pads usan la base (T, Lat, U);
 * las franjas siguen la pista y quedan en ejes del mundo (basis = null) con el origen en su punto medio.
 */
export function buildItemInstance(layout, elev, g, it, opts = {}) {
  const r = layout.routes[it.k];
  const fr = trackFrame(layout, elev, it.k, it.s);
  const lift = ITEM_LIFT[g.type];
  const origin = fr.at(it.u, 0);
  const name = itemName(g.type, g.gid, it.idx);
  const pos = [], uv = [], idx = [];
  let basis = [fr.T, fr.Lat, fr.U];
  let footprint;
  if (g.type === 'puddle') {
    const R = g.size / 2, seg = 28;
    pos.push(0, 0, lift); uv.push(0.5, 0.5);
    for (let q = 0; q < seg; q++) { const a = (q / seg) * Math.PI * 2; pos.push(Math.cos(a) * R, Math.sin(a) * R, lift); uv.push(0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)); }
    for (let q = 0; q < seg; q++) idx.push(0, 1 + q, 1 + ((q + 1) % seg));
    footprint = { kind: 'circle', r: R };
  } else if (g.type === 'pad') {
    const hl = g.length / 2, hw = g.width / 2;
    pos.push(-hl, -hw, lift, hl, -hw, lift, hl, hw, lift, -hl, hw, lift);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1); // u a lo largo (la flecha apunta hacia +u = adelante)
    idx.push(0, 1, 2, 0, 2, 3);
    footprint = { kind: 'rect', hl, hw };
  } else {
    const w = fr.w, hw = Math.max(0.05, (w * g.widthPct) / 100 / 2);
    const n = Math.max(2, Math.ceil(g.len / 1));
    const center = [], edgeA = [], edgeB = [], ups = [], fwd = [];
    for (let q = 0; q <= n; q++) {
      const s = it.s - g.len / 2 + (g.len * q) / n;
      const f = trackFrame(layout, elev, it.k, s);
      const a = f.at(it.u - hw, lift), b = f.at(it.u + hw, lift), c = f.at(it.u, 0);
      pos.push(a[0] - origin[0], a[1] - origin[1], a[2] - origin[2], b[0] - origin[0], b[1] - origin[1], b[2] - origin[2]);
      // UV: u de un borde al otro (0..1), v a lo largo (una repetición cada ancho de la franja: baldosas cuadradas)
      const v = (g.len * q) / n / (2 * hw);
      uv.push(0, v, 1, v);
      center.push(c); edgeA.push(a); edgeB.push(b); ups.push(f.U); fwd.push(f.T);
    }
    for (let q = 0; q < n; q++) { const a = q * 2; idx.push(a, a + 3, a + 1, a, a + 2, a + 3); } // normal hacia arriba
    basis = null;
    footprint = { kind: 'strip', hw, pts: center };
    // borde: paredes sin espesor que suben desde el contorno de la franja (una sola cara, hacia afuera, sin techo)
    if (opts.border && opts.border.h > 0) {
      const H = opts.border.h;
      const bp = [], bu = [], bi = [];
      let per = 0;
      const wall = (P0, P1, U0, U1, out) => {
        const base = bp.length / 3;
        const L01 = Math.hypot(P1[0] - P0[0], P1[1] - P0[1], P1[2] - P0[2]);
        const pts = [P0, P1, [P1[0] + U1[0] * H, P1[1] + U1[1] * H, P1[2] + U1[2] * H], [P0[0] + U0[0] * H, P0[1] + U0[1] * H, P0[2] + U0[2] * H]];
        for (const p of pts) bp.push(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]);
        bu.push(per / H, 0, (per + L01) / H, 0, (per + L01) / H, 1, per / H, 1);
        per += L01;
        // sentido de giro según hacia dónde debe mirar la cara
        const e1 = [P1[0] - P0[0], P1[1] - P0[1], P1[2] - P0[2]], e2 = [U0[0], U0[1], U0[2]];
        const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
        if (nx * out[0] + ny * out[1] + nz * out[2] >= 0) bi.push(base, base + 1, base + 2, base, base + 2, base + 3);
        else bi.push(base, base + 2, base + 1, base, base + 3, base + 2);
      };
      const lat = (q) => { const U = ups[q], T = fwd[q]; return [U[1] * T[2] - U[2] * T[1], U[2] * T[0] - U[0] * T[2], U[0] * T[1] - U[1] * T[0]]; }; // U × T = izquierda
      // lado A (u - hw): afuera = -izquierda; lado B (u + hw): afuera = +izquierda
      for (let q = 0; q < n; q++) { const L1 = lat(q); wall(edgeA[q], edgeA[q + 1], ups[q], ups[q + 1], [-L1[0], -L1[1], -L1[2]]); }
      wall(edgeA[n], edgeB[n], ups[n], ups[n], fwd[n]);
      for (let q = n; q > 0; q--) wall(edgeB[q], edgeB[q - 1], ups[q], ups[q - 1], lat(q));
      wall(edgeB[0], edgeA[0], ups[0], ups[0], [-fwd[0][0], -fwd[0][1], -fwd[0][2]]);
      var border = { positions: new Float32Array(bp), uvs: new Float32Array(bu), indices: bi };
    }
  }
  return { type: g.type, gid: g.gid, idx: it.idx, name, k: it.k, s: it.s, u: it.u, moved: it.moved, origin, basis, footprint,
    positions: new Float32Array(pos), uvs: new Float32Array(uv), indices: idx, border: typeof border !== 'undefined' ? border : null };
}

/** Todas las instancias de todos los grupos. groups = {puddle:[...], pad:[...], strip:[...]}; paintToWorld convierte zonas. */
export function computeItems(layout, elev, groups, paintToWorld = (p) => p, opts = {}) {
  const out = [];
  if (!layout || !elev || !groups) return out;
  for (const type of ITEM_TYPES) {
    const list0 = groups[type] || [];
    for (const g0 of list0) {
      const g = effectiveGroup(g0, list0[0]);
      if (!g.enabled) { out.push({ type, gid: g.gid, name: groupName(type, g.gid), items: [], enabled: false }); continue; }
      const list = resolveGroup(layout, elev, g, g.mode === 'painted' ? paintToWorld(g.paint || []) : null);
      out.push({ type, gid: g.gid, name: groupName(type, g.gid), enabled: true, items: list.map((it) => buildItemInstance(layout, elev, g, it, opts)) });
    }
  }
  return out;
}

/** Elemento bajo un punto XY (m): {type, gid, idx} o null. */
export function itemAt(inst, x, y, tol = 0.5) {
  let best = null, bd = Infinity;
  for (const grp of inst) for (const it of grp.items) {
    let d;
    const dx = x - it.origin[0], dy = y - it.origin[1];
    if (it.footprint.kind === 'circle') d = Math.hypot(dx, dy) - it.footprint.r;
    else if (it.footprint.kind === 'rect') {
      const [T, Lat] = it.basis;
      const a = Math.abs(dx * T[0] + dy * T[1]) - it.footprint.hl, b = Math.abs(dx * Lat[0] + dy * Lat[1]) - it.footprint.hw;
      d = Math.max(a, b);
    } else {
      d = Infinity;
      const P = it.footprint.pts;
      for (let q = 0; q < P.length - 1; q++) {
        const ax = P[q][0], ay = P[q][1], bx = P[q + 1][0], by = P[q + 1][1];
        const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1;
        const t = clamp(((x - ax) * vx + (y - ay) * vy) / l2, 0, 1);
        d = Math.min(d, Math.hypot(x - ax - vx * t, y - ay - vy * t) - it.footprint.hw);
      }
    }
    if (d <= tol && d < bd) { bd = d; best = { type: it.type, gid: it.gid, idx: it.idx }; }
  }
  return best;
}
