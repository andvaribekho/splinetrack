// Cerros pintados y túneles (artificiales o cavernas naturales, cerrados o abiertos a un costado con pilares).
// Coordenadas en metros, Z arriba.
import { SpatialGrid, clamp, rng } from './geometry.js';

// ---------- campo de cerros ----------

const fieldCache = new Map();

/** Distancia euclidiana al fondo (celdas con mask = 0), en celdas. Felzenszwalb & Huttenlocher. */
function edt(mask, nx, ny) {
  const INF = 1e20;
  const f = new Float64Array(Math.max(nx, ny));
  const d = new Float64Array(Math.max(nx, ny));
  const v = new Int32Array(Math.max(nx, ny));
  const z = new Float64Array(Math.max(nx, ny) + 1);
  const D = new Float64Array(nx * ny);
  for (let k = 0; k < D.length; k++) D[k] = mask[k] ? INF : 0;
  const pass = (n, get, set) => {
    for (let q = 0; q < n; q++) f[q] = get(q);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let sv = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (sv <= z[k]) { k--; sv = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = sv; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) ** 2 + f[v[k]]; }
    for (let q = 0; q < n; q++) set(q, d[q]);
  };
  for (let i = 0; i < nx; i++) pass(ny, (j) => D[j * nx + i], (j, val) => { D[j * nx + i] = val; });
  for (let j = 0; j < ny; j++) pass(nx, (i) => D[j * nx + i], (i, val) => { D[j * nx + i] = val; });
  for (let k = 0; k < D.length; k++) D[k] = Math.sqrt(D[k]);
  return D;
}

/**
 * Campo de altura de UN cerro. hill = {id, height, hard, flat (0..1), strokes:[{x,y,r,e}]} en metros.
 * La huella es la unión de los toques (los de borrar restan). El perfil depende de la distancia al borde:
 * suave = domo de coseno, rocoso = pared casi vertical + domo; «flat» ensancha la parte superior hasta una meseta.
 */
export function hillFieldOne(hill) {
  const adds = hill.strokes.filter((q) => !q.e);
  if (!adds.length) return null;
  const key = JSON.stringify([hill.height, hill.hard, hill.flat, hill.strokes]);
  const cached = fieldCache.get(hill.id);
  if (cached && cached.key === key) return cached.field;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of adds) { minX = Math.min(minX, q.x - q.r); maxX = Math.max(maxX, q.x + q.r); minY = Math.min(minY, q.y - q.r); maxY = Math.max(maxY, q.y + q.r); }
  const hc = clamp(Math.max(maxX - minX, maxY - minY) / 450, 0.4, 2.5);
  minX -= 2 * hc; minY -= 2 * hc; maxX += 2 * hc; maxY += 2 * hc;
  const nx = Math.ceil((maxX - minX) / hc) + 1, ny = Math.ceil((maxY - minY) / hc) + 1;
  const mask = new Uint8Array(nx * ny);
  for (const st of hill.strokes) {
    const i0 = Math.max(0, Math.floor((st.x - st.r - minX) / hc)), i1 = Math.min(nx - 1, Math.ceil((st.x + st.r - minX) / hc));
    const j0 = Math.max(0, Math.floor((st.y - st.r - minY) / hc)), j1 = Math.min(ny - 1, Math.ceil((st.y + st.r - minY) / hc));
    const r2 = st.r * st.r;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if ((minX + i * hc - st.x) ** 2 + (minY + j * hc - st.y) ** 2 <= r2) mask[j * nx + i] = st.e ? 0 : 1;
    }
  }
  let count = 0;
  for (let k = 0; k < mask.length; k++) count += mask[k];
  if (!count) { fieldCache.set(hill.id, { key, field: null }); return null; }
  const D = edt(mask, nx, ny);
  let Dmax = 0;
  for (let k = 0; k < D.length; k++) { D[k] = Math.max(0, D[k] - 0.5) * hc; if (D[k] > Dmax) Dmax = D[k]; }
  const H = hill.height, flat = clamp(hill.flat ?? 0, 0, 1);
  const dome = (t) => 0.5 * (1 - Math.cos(Math.PI * clamp(t, 0, 1)));
  const f = new Float32Array(nx * ny);
  const hash = (i, j) => { let h = (i * 374761393 + j * 668265263 + hill.id * 2246822519) ^ 0x5bd1e995; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  if (!hill.hard) {
    const dTop = Dmax + (Math.max(2 * hc, 0.18 * Dmax) - Dmax) * flat;
    for (let k = 0; k < f.length; k++) if (mask[k]) f[k] = H * dome(D[k] / Math.max(dTop, 1e-6));
    // suavizado leve para borrar las aristas del eje medio
    const tmp = new Float32Array(f.length);
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        let s = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          s += f[jj * nx + ii]; n++;
        }
        tmp[j * nx + i] = s / n;
      }
      f.set(tmp);
    }
  } else {
    const wc = Math.max(1.5 * hc, 1.2); // ancho de la pared (casi vertical)
    const a = 0.6; // fracción de la altura que es pared
    const dTop = Dmax + (wc - Dmax) * flat;
    const rough = 1 - 0.85 * flat;
    for (let k = 0; k < f.length; k++) {
      if (!mask[k]) continue;
      const i = k % nx, j = (k / nx) | 0;
      let v = H * (a * clamp(D[k] / wc, 0, 1) + (1 - a) * dome(D[k] / Math.max(dTop, 1e-6)));
      v *= 1 - 0.07 * rough + 0.14 * rough * hash(i >> 1, j >> 1);
      f[k] = v;
    }
  }
  const sample = (x, y) => {
    const fx = (x - minX) / hc, fy = (y - minY) / hc;
    if (fx < 0 || fy < 0 || fx >= nx - 1 || fy >= ny - 1) return 0;
    const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
    const A = f[j * nx + i], B = f[j * nx + i + 1], C = f[(j + 1) * nx + i], E = f[(j + 1) * nx + i + 1];
    return (A * (1 - tx) + B * tx) * (1 - ty) + (C * (1 - tx) + E * tx) * ty;
  };
  const field = { id: hill.id, sample, minX, minY, maxX, maxY, cell: hc, area: count * hc * hc, Dmax, height: H };
  fieldCache.set(hill.id, { key, field });
  return field;
}

/** Punto dentro de la huella de un cerro (según el orden de sus toques). */
export function hillContains(hill, x, y) {
  let inside = false;
  for (const q of hill.strokes) if ((x - q.x) ** 2 + (y - q.y) ** 2 <= q.r * q.r) inside = !q.e;
  return inside;
}

// ---------- perfil del túnel ----------

/**
 * Perfil desde el piso en u = -W/2 (derecha), por arriba, hasta u = +W/2 (izquierda): [[u, v], ...] (u lateral, + = izquierda).
 * N ≈ número de puntos; las esquinas siempre quedan como vértices (para separar paredes y techo limpiamente).
 */
export function tunnelProfile(shape, W, H, N = 28) {
  const hw = W / 2;
  const segs = [];
  if (shape === 'square') {
    segs.push({ len: H, f: (t) => [-hw, t * H] });
    segs.push({ len: W, f: (t) => [-hw + t * W, H] });
    segs.push({ len: H, f: (t) => [hw, H - t * H] });
  } else if (shape === 'circle' || shape === 'oval') {
    const circle = shape === 'circle';
    const R = circle ? Math.max(hw, H / 1.7) : H / 1.25;
    const v0 = H - R;
    const a0 = Math.asin(clamp(-v0 / R, -1, 1));
    const aS = Math.PI - a0, aE = a0;
    segs.push({ len: R * (aS - aE), f: (t) => { const a = aS + (aE - aS) * t; return [hw * Math.cos(a), Math.max(0, v0 + R * Math.sin(a))]; } });
  } else {
    const rc = Math.min(hw, H) * 0.45;
    segs.push({ len: H - rc, f: (t) => [-hw, t * (H - rc)] });
    segs.push({ len: (Math.PI / 2) * rc, f: (t) => { const a = Math.PI - t * Math.PI / 2; return [-hw + rc + rc * Math.cos(a), H - rc + rc * Math.sin(a)]; } });
    segs.push({ len: W - 2 * rc, f: (t) => [-hw + rc + t * (W - 2 * rc), H] });
    segs.push({ len: (Math.PI / 2) * rc, f: (t) => { const a = Math.PI / 2 - t * Math.PI / 2; return [hw - rc + rc * Math.cos(a), H - rc + rc * Math.sin(a)]; } });
    segs.push({ len: H - rc, f: (t) => [hw, H - rc - t * (H - rc)] });
  }
  const per = segs.reduce((a, q) => a + q.len, 0);
  const M = Math.max(segs.length, N - 1);
  const pts = [segs[0].f(0)];
  for (const q of segs) {
    const n = Math.max(1, Math.round((M * q.len) / per));
    for (let k = 1; k <= n; k++) pts.push(q.f(k / n));
  }
  return pts;
}

/** Separa el perfil en paredes (tramos más verticales que horizontales) y techo: segmentos [a..b] son techo. */
export function profileSplit(prof) {
  let a = -1, b = -1;
  for (let q = 0; q < prof.length - 1; q++) {
    const du = Math.abs(prof[q + 1][0] - prof[q][0]), dv = Math.abs(prof[q + 1][1] - prof[q][1]);
    if (dv <= du + 1e-9) { if (a < 0) a = q; b = q; }
  }
  if (a < 0) { a = Math.floor((prof.length - 1) / 3); b = prof.length - 2 - a; }
  return { a, b };
}

/** Caja que ocupa la boca (marco incluido) en coordenadas locales (u lateral, v sobre la calzada). */
export function portalBox(sp, roadW) {
  const W = Math.max(sp.tunnelWidth, roadW + 1);
  const natural = sp.tunnelType === 'natural';
  const amp = natural ? 0.4 + 2.6 * sp.caveSize : 0;
  const ext = natural ? 1.35 * amp : 0;
  const thick = Math.max(0.05, sp.portalFrame ?? 1);
  return { A: W / 2 + ext + thick, B: sp.tunnelHeight + ext + thick, thick, depth: Math.max(0, sp.portalDepth ?? 1) };
}

// ---------- detección ----------

/**
 * Tramos de pista cubiertos por un cerro lo bastante alto para un túnel.
 * Devuelve runs [{id, k, s0, s1, e0, e1}] (e = extendido para cubrir los portales) y marca en cada muestra.
 */
export function detectTunnels(layout, elev, hill, sp) {
  const runs = [];
  if (!hill) return { runs, member: () => -1 };
  const need = sp.tunnelHeight + Math.max(sp.tunnelRoof, (sp.portalFrame ?? 1) + 0.3) + sp.terrainGap;
  const ext = 2;
  layout.routes.forEach((r, k) => {
    const cov = new Uint8Array(r.n);
    for (let i = 0; i < r.n; i++) cov[i] = hill.sample(r.x[i], r.y[i]) >= need ? 1 : 0;
    // corridas
    const raw = [];
    let i = 0;
    const n = r.n;
    // en rutas cerradas, empezar en una muestra no cubierta
    let start = 0;
    if (r.closed) { start = cov.indexOf(0); if (start < 0) start = 0; }
    for (let q = 0; q < n; ) {
      i = (start + q) % n;
      if (!cov[i]) { q++; continue; }
      const a = q;
      while (q < n && cov[(start + q) % n]) q++;
      raw.push([a, q - 1]);
    }
    // unir huecos cortos y descartar tramos muy cortos
    const merged = [];
    for (const rr of raw) {
      const last = merged[merged.length - 1];
      if (last && (rr[0] - last[1]) * r.ds < 15) last[1] = rr[1];
      else merged.push([...rr]);
    }
    for (const [qa, qb] of merged) {
      const len = (qb - qa + 1) * r.ds;
      if (len < 8) continue;
      const s0 = r.s[(start + qa) % n], s1 = s0 + len;
      runs.push({ id: runs.length, k, s0, s1, e0: s0 - ext, e1: s1 + ext, len });
    }
  });
  const member = (k, s) => {
    for (const t of runs) {
      if (t.k !== k) continue;
      const r = layout.routes[k];
      let ss = s;
      if (r.closed) { while (ss < t.e0) ss += r.L; while (ss > t.e1 + r.L) ss -= r.L; }
      if (ss >= t.e0 && ss <= t.e1) return t.id;
    }
    return -1;
  };
  return { runs, member };
}

// ---------- geometría ----------

export function frameAt(r, e, s) {
  let ss = r.closed ? ((s % r.L) + r.L) % r.L : clamp(s, 0, r.L);
  const f = ss / r.ds;
  let i = Math.floor(f), t = f - i;
  const j = r.closed ? (i + 1) % r.n : Math.min(r.n - 1, i + 1);
  i = r.closed ? i % r.n : Math.min(i, r.n - 1);
  const x = r.x[i] + (r.x[j] - r.x[i]) * t, y = r.y[i] + (r.y[j] - r.y[i]) * t;
  const z = e.z[i] + (e.z[j] - e.z[i]) * t;
  const roll = e.roll[i] + (e.roll[j] - e.roll[i]) * t;
  const tx = r.tx[i], ty = r.ty[i];
  const w = r.w[i];
  const lx = -ty, ly = tx;
  const c = Math.cos(roll), sn = Math.sin(roll);
  return {
    x, y, z, w, tx, ty,
    L: [lx * c, ly * c, sn], // lateral inclinado por el peralte
    U: [-lx * sn, -ly * sn, c], // arriba inclinado
    at(u, v) { return [x + this.L[0] * u + this.U[0] * v, y + this.L[1] * u + this.U[1] * v, z + this.L[2] * u + this.U[2] * v]; },
  };
}

function valueNoise(seed) {
  const h = (i, j) => { let v = (i * 374761393 + j * 668265263 + seed * 2654435761) | 0; v = Math.imul(v ^ (v >>> 13), 1274126177); return ((v ^ (v >>> 16)) >>> 0) / 4294967296; };
  const sm = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const i = Math.floor(x), j = Math.floor(y), fx = sm(x - i), fy = sm(y - j);
    const a = h(i, j), b = h(i + 1, j), c = h(i, j + 1), d = h(i + 1, j + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

/** Altura del techo (sobre la calzada) en s para un túnel; se usa para cubrirlo con el cerro. */
export function tunnelTop(sp, t, s) {
  const base = sp.tunnelHeight;
  if (sp.tunnelType !== 'natural') return base;
  const u = clamp((s - t.s0) / Math.max(1, t.s1 - t.s0), 0, 1);
  const vault = 1 + 1.8 * sp.caveSize * Math.pow(Math.sin(Math.PI * u), 2);
  return base * vault + (0.6 + 3 * sp.caveSize);
}

/** Densidad de polígonos del túnel (1..100) → puntos del perfil y paso a lo largo. */
export function tunnelResolution(sp) {
  const d = clamp(sp.tunnelDensity ?? 50, 1, 100) / 100;
  return { N: Math.round(8 + 56 * d) + 1, step: 6 * Math.pow(1 / 8, d) };
}

function meshOut(pos, uv, idx) {
  return { positions: new Float32Array(pos), uvs: new Float32Array(uv), indices: idx };
}

/**
 * Mallas de cada túnel, todas separadas: paredes, techo, veredas, boca de entrada, boca de salida,
 * estalactitas, rocas y pilares. opts.collarIn = cuánto se mete el marco de la boca dentro del cerro.
 */
export function buildTunnelGeometry(layout, elev, spIn, runs, opts = {}) {
  const sp = spIn;
  const out = [];
  const { N: Nreq, step } = tunnelResolution(sp);
  const collarIn = opts.collarIn ?? 3;
  for (const t of runs) {
    const r = layout.routes[t.k], e = elev.routes[t.k];
    const rand = rng(1000 + t.id * 7919 + (sp.treeSeed | 0));
    const noise = valueNoise(17 + t.id);
    const natural = sp.tunnelType === 'natural';
    const roadW = r.w[0];
    const W = Math.max(sp.tunnelWidth, roadW + 1);
    const Hb = sp.tunnelHeight;
    const prof = tunnelProfile(sp.tunnelShape, W, Hb, Nreq);
    const N = prof.length;
    const { a: ca, b: cb } = profileSplit(prof);
    const open = sp.tunnelOpen === 'left' ? 1 : sp.tunnelOpen === 'right' ? -1 : 0; // lado abierto: +1 izquierda
    const ns = Math.max(2, Math.ceil((t.e1 - t.e0) / step));
    const amp = natural ? 0.4 + 2.6 * sp.caveSize : 0;
    const keep = prof.map(([u, v]) => !(open && Math.sign(u) === open && v < Hb * 0.72 && Math.abs(u) > W * 0.2));
    const perim = [0];
    for (let q = 1; q < N; q++) perim.push(perim[q - 1] + Math.hypot(prof[q][0] - prof[q - 1][0], prof[q][1] - prof[q - 1][1]));
    const P = perim[N - 1];
    // secciones
    const ring = [];
    const openEdge = [];
    for (let a = 0; a <= ns; a++) {
      const s = t.e0 + ((t.e1 - t.e0) * a) / ns;
      const F = frameAt(r, e, s);
      const uIn = clamp((s - t.s0) / Math.max(1, t.s1 - t.s0), 0, 1);
      const vault = natural ? 1 + 1.8 * sp.caveSize * Math.pow(Math.sin(Math.PI * uIn), 2) * (0.75 + 0.5 * noise(t.id * 3.1, s / 40)) : 1;
      const loc = [], pts = [];
      for (let q = 0; q < N; q++) {
        let [u, v] = prof[q];
        if (natural) {
          const cv = Hb * 0.45;
          const du = u, dv = v - cv;
          const d = Math.hypot(du, dv) || 1;
          const nq = (perim[q] / P) * 27;
          const rough = amp * noise(nq * 0.9 + t.id * 11, s / 5.5) + amp * 0.35 * noise(nq * 2.3, s / 2.1);
          const k = vault + rough / d;
          u = du * k; v = Math.max(v <= 0.01 ? 0 : v, cv + dv * k);
          if (prof[q][1] <= 0.01) v = 0;
        }
        loc.push([u, v]);
        pts.push(F.at(u, v));
      }
      ring.push({ F, s, loc, pts, vault });
      if (open) {
        const qi = open > 0 ? keep.lastIndexOf(true) : keep.indexOf(true);
        openEdge.push({ s, F, u: loc[qi][0], v: pts[qi] });
      }
    }
    // tiras del perfil (q0..q1) a lo largo del túnel; normales hacia adentro
    const strip = (ranges) => {
      const pos = [], uv = [], idx = [];
      for (const [q0, q1] of ranges) {
        if (q1 <= q0) continue;
        const base = pos.length / 3, m = q1 - q0 + 1;
        for (let a = 0; a <= ns; a++) {
          for (let q = q0; q <= q1; q++) {
            const p = ring[a].pts[q];
            pos.push(p[0], p[1], p[2]);
            uv.push(perim[q] / 6, (ring[a].s - t.e0) / 6);
          }
        }
        for (let a = 0; a < ns; a++) for (let q = q0; q < q1; q++) {
          if (!keep[q] || !keep[q + 1]) continue;
          const i0 = base + a * m + (q - q0), i1 = i0 + 1, j0 = i0 + m, j1 = j0 + 1;
          idx.push(i0, i1, j0, i1, j1, j0);
        }
      }
      return meshOut(pos, uv, idx);
    };
    const walls = strip([[0, ca], [cb + 1, N - 1]]);
    const ceiling = strip([[ca, cb + 1]]);
    // veredas: de la orilla de la calzada al pie del muro, a nivel de la calzada
    const wpos = [], wuv = [], widx = [];
    const walk = (side) => {
      const base = wpos.length / 3;
      for (let a = 0; a <= ns; a++) {
        const { F, pts, s } = ring[a];
        const foot = pts[side > 0 ? N - 1 : 0];
        const edge = F.at(side * F.w / 2, 0);
        wpos.push(edge[0], edge[1], edge[2] + 0.02, foot[0], foot[1], foot[2] + 0.02);
        wuv.push(0, (s - t.e0) / 6, 1, (s - t.e0) / 6);
      }
      for (let a = 0; a < ns; a++) {
        const i0 = base + a * 2, i1 = i0 + 1, j0 = i0 + 2, j1 = i0 + 3;
        if (side > 0) widx.push(i0, j0, i1, i1, j0, j1); else widx.push(i0, i1, j0, i1, j1, j0);
      }
    };
    if (open !== 1) walk(1);
    if (open !== -1) walk(-1);
    const walkways = meshOut(wpos, wuv, widx);
    // bocas: marco con contorno exterior rectangular que sobresale del cerro (depth) y se mete en él (collarIn)
    // caja de la boca medida en los contornos reales de ambos extremos (+ grosor del marco)
    const box = portalBox(sp, roadW);
    {
      let mu = 0, mv = 0;
      for (const R of [ring[0], ring[ns]]) for (let q = 0; q < N; q++) if (keep[q]) { mu = Math.max(mu, Math.abs(R.loc[q][0])); mv = Math.max(mv, R.loc[q][1]); }
      box.A = mu + box.thick; box.B = mv + box.thick;
    }
    const cvC = Hb * 0.45;
    const toOuter = ([u, v]) => {
      // rayo desde el centro de la sección hasta el rectángulo [-A, A] x [0, B]
      const du = u, dv = v - cvC;
      let k = Infinity;
      if (Math.abs(du) > 1e-9) k = Math.min(k, box.A / Math.abs(du));
      if (dv > 1e-9) k = Math.min(k, (box.B - cvC) / dv);
      if (!isFinite(k)) k = 1;
      return [du * k, Math.max(0, cvC + dv * k)];
    };
    const portal = (atStart) => {
      const pos = [], uv = [], idx = [];
      const R0 = atStart ? ring[0] : ring[ns];
      const sEnd = R0.s;
      const dir = atStart ? -1 : 1; // hacia afuera del túnel
      const sFront = sEnd + dir * box.depth, sBack = sEnd - dir * collarIn, sIn = sEnd - dir * 0.3;
      const Ff = frameAt(r, e, sFront), Fb = frameAt(r, e, sBack), Fi = frameAt(r, e, sIn);
      const inner = R0.loc, outer = inner.map(toOuter);
      const qs = [];
      for (let q = 0; q < N; q++) if (keep[q]) qs.push(q);
      const quad = (A, B, C, D, uA, uB, vA, vB) => {
        // A-B arriba del borde, C-D abajo; dos triángulos
        const base = pos.length / 3;
        pos.push(...A, ...B, ...C, ...D);
        uv.push(uA, vA, uB, vA, uA, vB, uB, vB);
        if (dir > 0) idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
        else idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      };
      for (let k2 = 0; k2 < qs.length - 1; k2++) {
        const q = qs[k2], q1 = qs[k2 + 1];
        if (q1 !== q + 1) continue;
        const pu = perim[q] / 2, pu1 = perim[q1] / 2;
        // cara frontal (anillo entre contorno interior y exterior)
        quad(Ff.at(...inner[q]), Ff.at(...inner[q1]), Ff.at(...outer[q]), Ff.at(...outer[q1]), pu, pu1, 0, box.thick / 2);
        // superficie exterior (del frente hacia adentro del cerro)
        quad(Fb.at(...outer[q]), Fb.at(...outer[q1]), Ff.at(...outer[q]), Ff.at(...outer[q1]), pu, pu1, 0, (box.depth + collarIn) / 2);
        // superficie interior (del frente hasta el inicio del tubo)
        quad(Ff.at(...inner[q]), Ff.at(...inner[q1]), Fi.at(...inner[q]), Fi.at(...inner[q1]), pu, pu1, 0, (box.depth + 0.3) / 2);
      }
      // tapas en los extremos del contorno (piso y corte del lado abierto)
      for (const q of [qs[0], qs[qs.length - 1]]) {
        quad(Ff.at(...inner[q]), Ff.at(...outer[q]), Fb.at(...inner[q]), Fb.at(...outer[q]), 0, box.thick / 2, 0, (box.depth + collarIn) / 2);
      }
      return meshOut(pos, uv, idx);
    };
    const portals = [
      { suffix: 'boca_entrada', geo: portal(true) },
      { suffix: 'boca_salida', geo: portal(false) },
    ];
    // estalactitas y rocas (solo cavernas)
    const sPos = [], sIdx = [];
    const rPos = [], rIdx = [];
    if (natural) {
      const nSt = Math.round(((t.s1 - t.s0) / 4) * (0.3 + sp.caveSize * 1.7));
      for (let k2 = 0; k2 < nSt; k2++) {
        const a = Math.floor(rand() * ns);
        const q = Math.floor(ca + rand() * Math.max(1, cb - ca + 1));
        if (!keep[q]) continue;
        const { F, pts } = ring[a];
        const p = pts[q];
        const ceil = (p[2] - F.z);
        const room = ceil - Hb - 0.4;
        if (room < 0.6) continue;
        const len = Math.min(room, 0.6 + rand() * (1 + 4 * sp.caveSize));
        const rad = 0.25 + rand() * 0.6 * (0.5 + sp.caveSize);
        const base = sPos.length / 3;
        for (let m = 0; m < 6; m++) {
          const ang = (m / 6) * Math.PI * 2;
          sPos.push(p[0] + Math.cos(ang) * rad, p[1] + Math.sin(ang) * rad, p[2] + 0.3);
        }
        sPos.push(p[0], p[1], p[2] - len);
        for (let m = 0; m < 6; m++) sIdx.push(base + m, base + 6, base + ((m + 1) % 6));
      }
      const nRock = Math.round(((t.s1 - t.s0) / 6) * sp.caveSize * 2);
      for (let k2 = 0; k2 < nRock; k2++) {
        const a = Math.floor(rand() * ns);
        const side = rand() < 0.5 ? 1 : -1;
        if (side === open) continue;
        const { F, pts } = ring[a];
        const foot = pts[side > 0 ? N - 1 : 0];
        const wallU = Math.abs((foot[0] - F.x) * F.L[0] + (foot[1] - F.y) * F.L[1]);
        const minU = F.w / 2 + 1.2;
        if (wallU < minU + 0.8) continue;
        const u = side * (minU + rand() * (wallU - minU - 0.5));
        const rad = 0.4 + rand() * Math.min(2.2, (wallU - minU) * 0.5) * (0.5 + sp.caveSize);
        const c = F.at(u, rad * 0.5);
        const base = rPos.length / 3;
        const V = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -0.6]];
        for (const [vx, vy, vz] of V) {
          const j = 0.7 + rand() * 0.6;
          rPos.push(c[0] + vx * rad * j, c[1] + vy * rad * j, c[2] + vz * rad * j);
        }
        const F8 = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];
        for (const f of F8) rIdx.push(base + f[0], base + f[1], base + f[2]);
      }
    }
    // pilares en el lado abierto: cubo estirado con pivote en su base
    const pillars = [];
    if (open && sp.tunnelPillars > 0 && openEdge.length > 1) {
      const n = sp.tunnelPillars;
      for (let k2 = 0; k2 < n; k2++) {
        const f = (k2 + 0.5) / n;
        const s = t.s0 + (t.s1 - t.s0) * f;
        const F = frameAt(r, e, s);
        const a = Math.round(((s - t.e0) / (t.e1 - t.e0)) * ns);
        const edge = openEdge[Math.min(openEdge.length - 1, Math.max(0, a))];
        const u = open * Math.max(F.w / 2 + 0.8, Math.abs(edge.u) - 0.3);
        const baseP = F.at(u, 0);
        const topZ = edge.v[2];
        const h = Math.max(1, topZ - baseP[2]);
        pillars.push({ x: baseP[0], y: baseP[1], z: baseP[2], h, size: 1.1, angle: Math.atan2(F.ty, F.tx) });
      }
    }
    const stalactites = { positions: new Float32Array(sPos), indices: sIdx };
    const rocks = { positions: new Float32Array(rPos), indices: rIdx };
    const tris = (walls.indices.length + ceiling.indices.length + walkways.indices.length + portals.reduce((a2, p) => a2 + p.geo.indices.length, 0) + sIdx.length + rIdx.length) / 3 + pillars.length * 12;
    out.push({
      id: t.id, name: `tunel_${String(t.id + 1).padStart(2, '0')}`, len: t.s1 - t.s0, k: t.k,
      walls, ceiling, walkways, portals, stalactites, rocks, pillars, tris, box,
    });
  }
  return out;
}

/** Caja estirada con pivote en el centro de la base (para pilares). */
export function pillarGeometry(p) {
  const s = p.size / 2, h = p.h;
  const c = Math.cos(p.angle), sn = Math.sin(p.angle);
  const V = [[-s, -s, 0], [s, -s, 0], [s, s, 0], [-s, s, 0], [-s, -s, h], [s, -s, h], [s, s, h], [-s, s, h]]
    .map(([x, y, z]) => [x * c - y * sn, x * sn + y * c, z]);
  const I = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: new Float32Array(V.flat()), indices: I };
}

export { SpatialGrid };
