// Utilidades geométricas 2D para polilíneas y splines.
// Un punto es un array [x, y, w?] (w = ancho opcional). Todo es funcional y sin estado.

export const TAU = Math.PI * 2;

export function dist(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Longitud total de la polilínea. */
export function polylineLength(pts, closed) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  if (closed && pts.length > 1) L += dist(pts[pts.length - 1], pts[0]);
  return L;
}

/** Quita puntos consecutivos casi duplicados (y el último si coincide con el primero en rutas cerradas). */
export function dedupe(pts, eps = 1e-6, closed = false) {
  if (pts.length === 0) return [];
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (dist(out[out.length - 1], pts[i]) > eps) out.push(pts[i]);
  }
  if (closed && out.length > 2 && dist(out[0], out[out.length - 1]) <= eps) out.pop();
  return out;
}

function lerpPt(a, b, t) {
  const n = Math.max(a.length, b.length);
  const r = new Array(n);
  for (let k = 0; k < n; k++) {
    const av = a[k] ?? b[k];
    const bv = b[k] ?? a[k];
    r[k] = av + (bv - av) * t;
  }
  return r;
}

/** Suavizado laplaciano (mantiene extremos si la ruta es abierta). */
export function smoothPolyline(pts, iterations = 2, closed = true, factor = 0.5) {
  let cur = pts.map((p) => p.slice());
  const n = cur.length;
  if (n < 3) return cur;
  for (let it = 0; it < iterations; it++) {
    const nxt = cur.map((p) => p.slice());
    for (let i = 0; i < n; i++) {
      if (!closed && (i === 0 || i === n - 1)) continue;
      const a = cur[(i - 1 + n) % n];
      const b = cur[(i + 1) % n];
      const p = cur[i];
      for (let k = 0; k < p.length; k++) {
        nxt[i][k] = p[k] + factor * ((a[k] + b[k]) * 0.5 - p[k]);
      }
    }
    cur = nxt;
  }
  return cur;
}

/** Suavizado Taubin (λ/μ): quita el temblor sin encoger la curva. */
export function taubinSmooth(pts, iterations, closed, lambda = 0.5, mu = -0.53) {
  let cur = pts;
  for (let i = 0; i < iterations; i++) {
    cur = smoothPolyline(cur, 1, closed, lambda);
    cur = smoothPolyline(cur, 1, closed, mu);
  }
  return cur;
}

/** Remuestrea la polilínea a paso uniforme por longitud de arco (interpola todos los componentes). */
export function resampleUniform(pts, step, closed) {
  const src = closed ? [...pts, pts[0]] : pts;
  const cum = [0];
  for (let i = 1; i < src.length; i++) cum.push(cum[i - 1] + dist(src[i - 1], src[i]));
  const L = cum[cum.length - 1];
  if (L === 0) return [pts[0].slice()];
  let n = Math.max(2, Math.round(L / step));
  const out = [];
  const count = closed ? n : n + 1;
  const h = L / n;
  let j = 0;
  for (let i = 0; i < count; i++) {
    const s = Math.min(i * h, L);
    while (j < cum.length - 2 && cum[j + 1] < s) j++;
    const seg = cum[j + 1] - cum[j];
    const t = seg > 0 ? (s - cum[j]) / seg : 0;
    out.push(lerpPt(src[j], src[j + 1], t));
  }
  return out;
}

/** Catmull-Rom centrípeto (alpha=0.5). Devuelve puntos densos. w se interpola linealmente. */
export function catmullRom(ctrl, closed, samplesPerSeg = 10, alpha = 0.5) {
  const n = ctrl.length;
  if (n < 2) return ctrl.map((p) => p.slice());
  const get = (i) => {
    if (closed) return ctrl[((i % n) + n) % n];
    if (i < 0) return lerpPt(ctrl[0], ctrl[1], -1); // extrapolación
    if (i >= n) return lerpPt(ctrl[n - 1], ctrl[n - 2], -1);
    return ctrl[i];
  };
  const segs = closed ? n : n - 1;
  const out = [];
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const t0 = 0;
    const t1 = t0 + Math.pow(Math.max(dist(p0, p1), 1e-9), alpha);
    const t2 = t1 + Math.pow(Math.max(dist(p1, p2), 1e-9), alpha);
    const t3 = t2 + Math.pow(Math.max(dist(p2, p3), 1e-9), alpha);
    const last = !closed && i === segs - 1;
    const m = last ? samplesPerSeg + 1 : samplesPerSeg;
    for (let k = 0; k < m; k++) {
      const u = k / samplesPerSeg;
      const t = t1 + (t2 - t1) * u;
      const pt = [0, 0];
      for (let c = 0; c < 2; c++) {
        const A1 = ((t1 - t) * p0[c] + (t - t0) * p1[c]) / (t1 - t0);
        const A2 = ((t2 - t) * p1[c] + (t - t1) * p2[c]) / (t2 - t1);
        const A3 = ((t3 - t) * p2[c] + (t - t2) * p3[c]) / (t3 - t2);
        const B1 = ((t2 - t) * A1 + (t - t0) * A2) / (t2 - t0);
        const B2 = ((t3 - t) * A2 + (t - t1) * A3) / (t3 - t1);
        pt[c] = ((t2 - t) * B1 + (t - t1) * B2) / (t2 - t1);
      }
      for (let c = 2; c < Math.max(p1.length, p2.length); c++) {
        pt[c] = lerp(p1[c] ?? p2[c], p2[c] ?? p1[c], u);
      }
      out.push(pt);
    }
  }
  return out;
}

/** Punto más cercano sobre una polilínea (de muestras con s acumulado). */
export function nearestOnSamples(route, x, y) {
  const { x: X, y: Y, s: S, n, closed } = route;
  let best = { d: Infinity, s: 0, i: 0, t: 0 };
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const ax = X[i], ay = Y[i], bx = X[j], by = Y[j];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = clamp(t, 0, 1);
    const px = ax + dx * t, py = ay + dy * t;
    const d = Math.hypot(x - px, y - py);
    if (d < best.d) {
      const s0 = S[i];
      const s1 = j === 0 ? route.L : S[j];
      best = { d, s: s0 + (s1 - s0) * t, i, t, x: px, y: py };
    }
  }
  return best;
}

/** Evalúa (x, y, w) en longitud de arco s de una ruta muestreada uniformemente. */
export function evalAt(route, s) {
  const { n, closed, L } = route;
  let ss = closed ? ((s % L) + L) % L : clamp(s, 0, L);
  const f = ss / route.ds;
  let i = Math.floor(f);
  let t = f - i;
  if (!closed && i >= n - 1) { i = n - 2; t = 1; }
  const j = closed ? (i + 1) % n : i + 1;
  i = closed ? i % n : i;
  return {
    x: lerp(route.x[i], route.x[j], t),
    y: lerp(route.y[i], route.y[j], t),
    w: lerp(route.w[i], route.w[j], t),
    i, t,
  };
}

/** Intersección de segmentos p1p2 y p3p4. Devuelve {t,u} o null. */
export function segIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const rX = bx - ax, rY = by - ay, sX = dx - cx, sY = dy - cy;
  const den = rX * sY - rY * sX;
  if (Math.abs(den) < 1e-12) return null;
  const qpX = cx - ax, qpY = cy - ay;
  const t = (qpX * sY - qpY * sX) / den;
  const u = (qpX * rY - qpY * rX) / den;
  if (t < 0 || t >= 1 || u < 0 || u >= 1) return null;
  return { t, u };
}

/** Grilla espacial simple para consultas de vecindad. */
export class SpatialGrid {
  constructor(cell) {
    this.cell = cell;
    this.map = new Map();
  }
  key(ix, iy) {
    return ix * 73856093 ^ iy * 19349663;
  }
  insert(x, y, item) {
    const ix = Math.floor(x / this.cell), iy = Math.floor(y / this.cell);
    const k = this.key(ix, iy);
    let b = this.map.get(k);
    if (!b) this.map.set(k, (b = []));
    b.push(item);
  }
  query(x, y, r, cb) {
    const c = this.cell;
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const y0 = Math.floor((y - r) / c), y1 = Math.floor((y + r) / c);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const b = this.map.get(this.key(ix, iy));
        if (b) for (const it of b) cb(it);
      }
    }
  }
}

/** Crea una ruta muestreada (arrays tipados) desde puntos uniformes [x,y,w]. */
export function makeSampledRoute(pts, closed, ds) {
  const n = pts.length;
  const x = new Float64Array(n), y = new Float64Array(n), w = new Float64Array(n), s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = pts[i][0];
    y[i] = pts[i][1];
    w[i] = pts[i][2];
  }
  let acc = 0;
  for (let i = 0; i < n; i++) {
    s[i] = acc;
    if (i < n - 1) acc += Math.hypot(x[i + 1] - x[i], y[i + 1] - y[i]);
  }
  if (closed) acc += Math.hypot(x[0] - x[n - 1], y[0] - y[n - 1]);
  const L = acc;
  const realDs = closed ? L / n : L / Math.max(1, n - 1);
  const route = { n, x, y, w, s, L, closed, ds: realDs };
  computeFrames(route);
  return route;
}

/** Tangentes y curvatura con signo (positiva = giro a la izquierda). */
export function computeFrames(route) {
  const { n, x, y, closed } = route;
  const tx = new Float64Array(n), ty = new Float64Array(n), k = new Float64Array(n);
  const idx = (i) => (closed ? (i + n) % n : clamp(i, 0, n - 1));
  for (let i = 0; i < n; i++) {
    const a = idx(i - 1), b = idx(i + 1);
    let dx = x[b] - x[a], dy = y[b] - y[a];
    const l = Math.hypot(dx, dy) || 1;
    tx[i] = dx / l;
    ty[i] = dy / l;
  }
  const h = 3; // curvatura con ventana más ancha para robustez
  for (let i = 0; i < n; i++) {
    const a = idx(i - h), b = idx(i + h);
    if (a === b) { k[i] = 0; continue; }
    let da = Math.atan2(ty[b], tx[b]) - Math.atan2(ty[a], tx[a]);
    while (da > Math.PI) da -= TAU;
    while (da < -Math.PI) da += TAU;
    const span = Math.abs(route.s[b] - route.s[a]) || route.ds * (2 * h);
    const spanFix = closed && span > route.L / 2 ? route.L - span : span;
    k[i] = da / (spanFix || 1);
  }
  route.tx = tx;
  route.ty = ty;
  route.k = k;
}

/** Área con signo (positiva = antihorario). */
export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Media móvil circular/abierta sobre un Float64Array. */
export function movingAverage(arr, half, closed) {
  const n = arr.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0, c = 0;
    for (let k = -half; k <= half; k++) {
      let j = i + k;
      if (closed) j = (j + n) % n;
      else if (j < 0 || j >= n) continue;
      acc += arr[j];
      c++;
    }
    out[i] = acc / c;
  }
  return out;
}

/** Diferencia de longitud de arco con envoltura para rutas cerradas. */
export function arcDelta(route, s1, s2) {
  const d = s2 - s1;
  if (!route.closed) return d;
  const L = route.L;
  return ((d % L) + L * 1.5) % L - L / 2;
}

/** PRNG determinista (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
