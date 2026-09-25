// Geometría de escena: malla de pista con UV, terreno y árboles (conos).
// Todo en metros, Z arriba. Devuelve arrays planos listos para three.js o para exportar.
import { SpatialGrid, rng, clamp, smoothstep } from './geometry.js';
import Delaunator from '../vendor/delaunator.js';
import { hillFieldOne, detectTunnels, tunnelTop, buildTunnelGeometry, portalBox, frameAt } from './tunnels.js';

export const DEFAULT_SCENE = {
  // pista
  trackTexDir: 'vertical', // 'vertical' = la textura corre a lo largo de la pista en V; 'horizontal' = en U
  trackTexReps: 100, // repeticiones a lo largo de la ruta principal
  trackTexOpacity: 1, // opacidad de la textura en la vista 3D (0 = solo colores por altura)
  skirts: true, // faldones laterales hacia el terreno
  // terreno
  terrain: false,
  terrainMargin: 120, // m alrededor de la pista
  terrainDensity: 55, // 1..100
  terrainMaxPolys: 200000,
  terrainGap: 0.3, // m bajo la superficie de la pista
  terrainFalloff: 60, // m para pasar de la altura de la pista al relieve general
  terrainTexRepX: 20,
  terrainTexRepY: 20,
  paintFactor: 4, // multiplicador de densidad en zonas pintadas
  // cerros y túneles
  hillBrush: 40, // m de radio
  hillHeight: 25, // m (valores para cerros nuevos)
  hillHard: false, // pared rocosa (true) o colina suave (false)
  hillFlat: 0, // 0 = cima redondeada, 1 = meseta plana
  hillDensity: 50, // 1..100 (celda 20 m .. 1 m)
  hillMaxTris: 20000,
  tunnelDensity: 50, // 1..100
  portalFrame: 1, // m de grosor del marco de la boca
  portalDepth: 1, // m que la boca sobresale del cerro
  tunnelShape: 'rounded', // 'square' | 'circle' | 'oval' | 'rounded'
  tunnelWidth: 18, // m (ancho interior)
  tunnelHeight: 8, // m (gálibo)
  tunnelRoof: 2.5, // m de cerro mínimo sobre el techo
  tunnelType: 'artificial', // 'artificial' | 'natural'
  caveSize: 0.3, // 0..1
  tunnelOpen: 'none', // 'none' | 'left' | 'right'
  tunnelPillars: 8,
  paintBrush: 25, // radio del pincel en m
  // árboles
  trees: false,
  treeSide: 'both', // 'left' | 'right' | 'both'
  treeDensity: 8, // árboles por 100 m y por lado
  treeScale: 1,
  treeOffset: 6, // m desde el borde de la pista
  treeSpread: 14, // m de dispersión extra
  treeSeed: 7,
  treeOnSlopes: false, // también en laderas de cerros
  treeOnTops: false, // también en la cima de cerros
  treeHillDensity: 4, // árboles por 1000 m² sobre cerros
  treeTilt: 0, // 0 = vertical, 100 = alineado con la normal del suelo
  // hierba (dos planos cruzados con textura con transparencia)
  grass: false,
  grassSide: 'both',
  grassDensity: 80, // matas por 100 m y por lado
  grassScale: 1,
  grassOffset: 1.5,
  grassSpread: 18,
  grassOnSlopes: false,
  grassOnTops: false,
  grassHillDensity: 60, // matas por 1000 m² sobre cerros
  grassTilt: 60,
  // borde (glow) de los nitro strips: paredes sin espesor, una cara, sin techo
  stripBorder: false,
  stripBorderHeight: 0.8, // m
  // pórtico de salida
  startGate: true,
  startText: 'START',
  startGateHeight: 7, // m libres sobre la calzada
};

/** Tamaño de celda del terreno a partir de la densidad (1..100) y del tope de polígonos. */
export function terrainCell(area, sp) {
  const d = clamp(sp.terrainDensity, 1, 100) / 100;
  let cell = 20 * Math.pow(1 / 20, d); // 20 m .. 1 m (escala logarítmica)
  const maxTris = Math.max(200, sp.terrainMaxPolys);
  const minCell = Math.sqrt((2 * area) / maxTris);
  return Math.max(cell, minCell);
}

function trackSamples(layout, elev) {
  const out = [];
  layout.routes.forEach((r, k) => {
    const e = elev.routes[k];
    for (let i = 0; i < r.n; i++) {
      const low = e.z[i] - Math.abs(Math.sin(e.roll[i])) * r.w[i] / 2;
      const bridge = !!(r.bridges && r.bridges.some((b) => { const d = r.closed ? (((r.s[i] - b.s0) % r.L) + r.L) % r.L : r.s[i] - b.s0; return d >= 0 && d <= b.s1 - b.s0; }));
      out.push({ x: r.x[i], y: r.y[i], z: low, zc: e.z[i], sr: Math.sin(e.roll[i]), tx: r.tx[i], ty: r.ty[i], w: r.w[i], k, i, j: out.length, bridge });
    }
  });
  return out;
}

/** Malla de la pista con UV (a lo largo x a lo ancho) y faldones opcionales. */
export function buildTrackMesh(layout, elev, spIn = {}) {
  const sp = { ...DEFAULT_SCENE, ...spIn };
  const Lmain = layout.routes[0].L;
  const repsPerM = Math.max(0.01, sp.trackTexReps) / Lmain;
  const skirt = sp.skirts ? sp.terrainGap + 0.8 : 0;
  const parts = layout.routes.map((r, k) => {
    const pos = [], uv = [], idx = [];
    const e = elev.routes[k];
    const n = r.n;
    const rows = r.closed ? n + 1 : n;
    // columnas: [faldón izq], izq, centro, der, [faldón der]
    const cols = sp.skirts ? 5 : 3;
    for (let q = 0; q < rows; q++) {
      const i = q % n;
      const s = q === n ? r.L : r.s[i];
      const along = s * repsPerM;
      const lx = -r.ty[i], ly = r.tx[i];
      const c = Math.cos(e.roll[i]), sn = Math.sin(e.roll[i]);
      const hw = r.w[i] / 2;
      const ox = lx * c * hw, oy = ly * c * hw, oz = sn * hw;
      const P = [
        [r.x[i] + ox, r.y[i] + oy, e.z[i] + oz, 0],
        [r.x[i], r.y[i], e.z[i], 0.5],
        [r.x[i] - ox, r.y[i] - oy, e.z[i] - oz, 1],
      ];
      if (sp.skirts) {
        P.unshift([P[0][0] + lx * 0.2, P[0][1] + ly * 0.2, P[0][2] - skirt, -0.05]);
        P.push([P[P.length - 1][0] - lx * 0.2, P[P.length - 1][1] - ly * 0.2, P[P.length - 1][2] - skirt, 1.05]);
      }
      for (const p of P) {
        pos.push(p[0], p[1], p[2]);
        if (sp.trackTexDir === 'horizontal') uv.push(along, p[3]);
        else uv.push(p[3], along);
      }
    }
    // tablero de cada puente (tramo con el ancho del puente, sin las transiciones): índices aparte, con su propia textura
    const bIdx = (r.bridges || []).map(() => []);
    const bridgeOf = (sv) => {
      if (!r.bridges) return -1;
      for (let bi = 0; bi < r.bridges.length; bi++) {
        const b = r.bridges[bi];
        const d = r.closed ? (((sv - b.s0) % r.L) + r.L) % r.L : sv - b.s0;
        if (d >= -1e-6 && d <= b.s1 - b.s0 + 1e-6) return bi;
      }
      return -1;
    };
    for (let q = 0; q < rows - 1; q++) {
      const sa = r.s[q % n], sb = q + 1 === n ? r.L : r.s[(q + 1) % n];
      const ba = bridgeOf(sa), bb = bridgeOf(sb === r.L && r.closed ? 0 : sb);
      const tgt = ba >= 0 && ba === bb ? bIdx[ba] : idx;
      for (let c2 = 0; c2 < cols - 1; c2++) {
        const a = q * cols + c2, b = a + 1, d = a + cols, e2 = d + 1;
        tgt.push(a, d, b, b, d, e2);
      }
    }
    return { name: r.name, positions: new Float32Array(pos), uvs: new Float32Array(uv), indices: idx, bridgeIdx: bIdx, bridgeNo: (r.bridges || []).map((b, k) => (b.idx ?? k) + 1) };
  });
  // malla combinada (vista previa): primero todos los tramos de pista, luego los tableros de puente
  const nPos = parts.reduce((a, p) => a + p.positions.length, 0);
  const positions = new Float32Array(nPos), uvs = new Float32Array((nPos / 3) * 2);
  const indices = [], bIndices = [];
  let vo = 0;
  for (const p of parts) {
    positions.set(p.positions, vo * 3);
    uvs.set(p.uvs, vo * 2);
    for (const i of p.indices) indices.push(i + vo);
    for (const bi of p.bridgeIdx) for (const i of bi) bIndices.push(i + vo);
    vo += p.positions.length / 3;
  }
  const trackCount = indices.length;
  for (const i of bIndices) indices.push(i);
  // tableros como objetos propios (exportación), con los vértices compactados
  const bridgeParts = [];
  for (const p of parts) {
    p.bridgeIdx.forEach((bi, k) => { if (bi.length) bridgeParts.push({ name: `puente_${String(p.bridgeNo[k]).padStart(2, '0')}`, bridge: p.bridgeNo[k] - 1, ...compactMesh(p.positions, p.uvs, bi) }); });
  }
  for (const p of parts) {
    if (p.bridgeIdx.some((b) => b.length)) Object.assign(p, compactMesh(p.positions, p.uvs, p.indices));
    delete p.bridgeIdx; delete p.bridgeNo;
  }
  return { positions, uvs, indices, trackCount, parts, bridgeParts };
}

/** Deja solo los vértices usados por los índices. */
function compactMesh(P, U, idx) {
  const map = new Map(), pos = [], uv = [], out = [];
  for (const i of idx) {
    let j = map.get(i);
    if (j === undefined) { j = map.size; map.set(i, j); pos.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); uv.push(U[i * 2], U[i * 2 + 1]); }
    out.push(j);
  }
  return { positions: new Float32Array(pos), uvs: new Float32Array(uv), indices: out };
}

/**
 * Terreno bajo la pista. Sin zonas pintadas: grilla regular. Con zonas pintadas (paint, en metros):
 * nube de puntos más densa en lo pintado + triangulación de Delaunay, con el mismo tope de polígonos.
 * En ambos casos cada vértice queda bajo toda superficie de pista a menos de un triángulo de distancia,
 * así ningún triángulo puede atravesar la pista.
 */
export function buildTerrain(layout, elev, spIn = {}, paint = null) {
  const sp = { ...DEFAULT_SCENE, ...spIn };
  const S = trackSamples(layout, elev);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxW = 0;
  for (const p of S) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); maxW = Math.max(maxW, p.w); }
  const M = sp.terrainMargin;
  minX -= M; minY -= M; maxX += M; maxY += M;
  const W = maxX - minX, H = maxY - minY;
  const gap = sp.terrainGap;
  const fine = new SpatialGrid(Math.max(maxW, 8));
  for (const p of S) fine.insert(p.x, p.y, p);
  const sub = S.filter((p, j) => j % 4 === 0 && !p.bridge); // bajo un puente el terreno no sube hasta la calzada
  const falloff = Math.max(5, sp.terrainFalloff);
  const coarseG = new SpatialGrid(Math.max(falloff / 2, 10));
  for (const p of sub) coarseG.insert(p.x, p.y, p);
  // relieve general: IDW en una grilla gruesa
  const gx = 40, gy = 40;
  const base = new Float64Array((gx + 1) * (gy + 1));
  const idwPts = S.filter((p, j) => j % 12 === 0 && !p.bridge);
  for (let j = 0; j <= gy; j++) for (let i = 0; i <= gx; i++) {
    const x = minX + (W * i) / gx, y = minY + (H * j) / gy;
    let ws = 0, zs = 0;
    for (const p of idwPts) {
      const d2 = (p.x - x) ** 2 + (p.y - y) ** 2 + 400;
      const w = 1 / (d2 * d2);
      ws += w; zs += w * p.z;
    }
    base[j * (gx + 1) + i] = zs / ws - gap;
  }
  const baseAt = (x, y) => {
    const fx = clamp(((x - minX) / W) * gx, 0, gx - 1e-9), fy = clamp(((y - minY) / H) * gy, 0, gy - 1e-9);
    const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
    const a = base[j * (gx + 1) + i], b = base[j * (gx + 1) + i + 1];
    const c = base[(j + 1) * (gx + 1) + i], d = base[(j + 1) * (gx + 1) + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
  /** Altura mínima de la pista que un triángulo de radio rho centrado en (x,y) podría cubrir (Infinity si ninguna). */
  const zoneAt = (x, y, rho, skip = null) => {
    let zone = Infinity;
    fine.query(x, y, maxW / 2 + rho, (p) => {
      if (skip && skip[p.j] >= 0) return;
      const dx = x - p.x, dy = y - p.y;
      const a = Math.abs(dx * p.tx + dy * p.ty);
      if (a > rho) return;
      const uv = dx * -p.ty + dy * p.tx;
      const h = Math.sqrt(rho * rho - a * a);
      const u0 = Math.max(-p.w / 2, uv - h), u1 = Math.min(p.w / 2, uv + h);
      if (u0 > u1) return;
      const zmin = p.zc + Math.min(p.sr * u0, p.sr * u1);
      if (zmin < zone) zone = zmin;
    });
    return zone;
  };
  /** Altura de un vértice; rho = distancia máxima a la que un triángulo que lo usa puede cubrir la pista. */
  const heightAt = (x, y, rho) => {
    const zone = zoneAt(x, y, rho);
    if (zone < Infinity) return zone - gap;
    let bd = Infinity, bz = 0, bw = 0;
    coarseG.query(x, y, falloff + maxW, (p) => {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; bz = p.z; bw = p.w; }
    });
    const b = baseAt(x, y);
    if (bd === Infinity) return b;
    const t = smoothstep(0, falloff, bd - bw / 2 - rho);
    return (bz - gap) * (1 - t) + b * t;
  };
  const painted = paint && paint.length && sp.paintFactor > 1;
  const out = painted
    ? adaptiveMesh(minX, minY, W, H, sp, paint, heightAt)
    : gridMesh(minX, minY, W, H, sp, heightAt);
  out.bounds = { minX, minY, maxX, maxY };
  out.tunnels = [];
  Object.defineProperty(out, 'ctx', { value: { S, fine, maxW, gap, zoneAt, heightAt, sp }, enumerable: false });
  return out;
}

/**
 * Cerros como mallas independientes (una por cerro) y túneles donde un cerro cubre la pista.
 * hills: [{id, name, height, hard, flat, density, maxTris, strokes:[{x,y,r,e}]}] en metros.
 * Devuelve {hills:[{id,name,positions,uvs,indices,tris,cell,sample}], tunnels (tramos), tunnelGeo, sample(x,y)}.
 */
export function buildHills(layout, elev, spIn, T, hills) {
  const sp = { ...DEFAULT_SCENE, ...spIn };
  const res = { hills: [], tunnels: [], tunnelGeo: [], sample: () => -Infinity, tris: 0 };
  if (!T || !hills || !hills.length) return res;
  const { S, maxW, gap, zoneAt } = T.ctx;
  const fields = [];
  for (const h of hills) { const f = hillFieldOne(h); if (f) fields.push({ h, f }); }
  if (!fields.length) return res;
  const combined = { sample: (x, y) => { let m = 0; for (const { f } of fields) { if (x < f.minX || y < f.minY || x > f.maxX || y > f.maxY) continue; const v = f.sample(x, y); if (v > m) m = v; } return m; } };
  const tun = detectTunnels(layout, elev, combined, sp);
  res.tunnels = tun.runs;
  const runById = new Map(tun.runs.map((t) => [t.id, t]));
  const natural = sp.tunnelType === 'natural';
  const openSide = sp.tunnelOpen === 'left' ? 1 : sp.tunnelOpen === 'right' ? -1 : 0;
  const box = portalBox(sp, layout.routes[0].w[0]);
  const cover = Math.max(sp.tunnelRoof, box.thick + 0.3);
  const tunId = new Int32Array(S.length).fill(-1);
  const tunGrid = new SpatialGrid(16);
  let tunReach = 0;
  if (tun.runs.length) {
    for (const p of S) {
      const r = layout.routes[p.k];
      const id = tun.member(p.k, r.s[p.i]);
      if (id < 0) continue;
      tunId[p.j] = id;
      const t = runById.get(id);
      let ss = r.s[p.i];
      if (r.closed) { while (ss < t.e0) ss += r.L; while (ss > t.e1) ss -= r.L; }
      const top = tunnelTop(sp, t, ss);
      const vault = natural ? top / sp.tunnelHeight : 1;
      const half = Math.max(sp.tunnelWidth, p.w + 1) / 2 * vault + (natural ? 0.6 + 3 * sp.caveSize : 0) + 1;
      const q = { ...p, tun: id, top, half };
      tunReach = Math.max(tunReach, half + box.thick + 2 + (openSide ? 2 * sp.tunnelWidth : 0));
      tunGrid.insert(p.x, p.y, q);
    }
  }
  const nearTunnel = (x, y, reach) => {
    let best = null, ba = Infinity;
    tunGrid.query(x, y, reach, (p) => {
      const dx = x - p.x, dy = y - p.y;
      const a = Math.abs(dx * p.tx + dy * p.ty);
      if (a > 3) return;
      const u = dx * -p.ty + dy * p.tx;
      if (Math.abs(u) > reach) return;
      if (a < ba) { ba = a; best = { p, u }; }
    });
    return best;
  };
  // mallas de túnel (el marco de la boca se mete en el cerro al menos una celda del cerro más grueso)
  let maxCell = 0;
  const cells = fields.map(({ h, f }) => {
    const d = clamp(h.density ?? 50, 1, 100) / 100;
    let c = 20 * Math.pow(1 / 20, d);
    const maxTris = Math.max(50, h.maxTris ?? 20000);
    c = Math.max(c, Math.sqrt((2 * f.area) / maxTris));
    maxCell = Math.max(maxCell, c);
    return c;
  });
  if (tun.runs.length) res.tunnelGeo = buildTunnelGeometry(layout, elev, sp, tun.runs, { collarIn: 1.5 * maxCell + 1 });
  const boxById = new Map(res.tunnelGeo.map((g) => [g.id, g.box]));
  const { minX: bx0, minY: by0, maxX: bx1, maxY: by1 } = T.bounds;
  const sink = 0.4;
  const samplers = [];
  fields.forEach(({ h, f }, hi) => {
    const c0 = cells[hi];
    const x0 = f.minX, y0 = f.minY;
    const nx = Math.max(2, Math.ceil((f.maxX - f.minX) / c0)), ny = Math.max(2, Math.ceil((f.maxY - f.minY) / c0));
    const cx = (f.maxX - f.minX) / nx, cy = (f.maxY - f.minY) / ny;
    const rho = Math.hypot(cx, cy) * 1.05 + 0.5;
    const nv = (nx + 1) * (ny + 1);
    const X = new Float64Array(nv), Y = new Float64Array(nv), Z = new Float64Array(nv), TZ = new Float64Array(nv);
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
      const v = j * (nx + 1) + i;
      const x = x0 + i * cx, y = y0 + j * cy;
      const tz = T.sample(x, y);
      const hh = f.sample(x, y);
      let z = tz + hh - sink;
      const zone = zoneAt(x, y, rho, tunId);
      if (zone < Infinity) z = Math.min(z, zone - gap); // la pista corta el cerro (trinchera)
      if (tunReach > 0 && hh > 0.5) {
        const nt = nearTunnel(x, y, tunReach);
        if (nt) {
          const { p, u } = nt;
          const onOpen = openSide && Math.sign(u) === openSide && Math.abs(u) > p.w / 2;
          if (onOpen) {
            if (Math.abs(u) < p.half + 2 * sp.tunnelWidth) z = Math.min(z, p.z - gap - 0.5); // lado abierto: se despeja
          } else if (Math.abs(u) < p.half + 1 + box.thick) {
            z = Math.max(z, p.zc + p.top + cover); // el cerro cubre el techo del túnel
          }
        }
      }
      if (zone < Infinity) z = Math.min(z, zone - gap); // la pista fuera de túneles nunca queda bajo un cerro
      X[v] = x; Y[v] = y; Z[v] = z; TZ[v] = tz;
    }
    const pos = [], uv = [], idx = [];
    for (let v = 0; v < nv; v++) {
      pos.push(X[v], Y[v], Z[v]);
      uv.push(((X[v] - bx0) / (bx1 - bx0)) * sp.terrainTexRepX, ((Y[v] - by0) / (by1 - by0)) * sp.terrainTexRepY);
    }
    const keptTri = new Uint8Array(nx * ny * 2);
    const below = (a) => Z[a] <= TZ[a] + 0.02;
    // recorte contra la caja de la boca / interior del túnel (piezas convexas fuera de la caja)
    const vert = (a) => ({ x: X[a], y: Y[a], z: Z[a], tz: TZ[a], uu: uv[a * 2], vv: uv[a * 2 + 1] });
    const lerpV = (A, B, t2) => ({ x: A.x + (B.x - A.x) * t2, y: A.y + (B.y - A.y) * t2, z: A.z + (B.z - A.z) * t2, tz: A.tz + (B.tz - A.tz) * t2, uu: A.uu + (B.uu - A.uu) * t2, vv: A.vv + (B.vv - A.vv) * t2 });
    const clipPoly = (poly, fn) => {
      const outP = [];
      for (let k = 0; k < poly.length; k++) {
        const A = poly[k], B = poly[(k + 1) % poly.length];
        const fa = fn(A), fb = fn(B);
        if (fa >= 0) outP.push(A);
        if ((fa >= 0) !== (fb >= 0)) outP.push(lerpV(A, B, fa / (fa - fb)));
      }
      return outP;
    };
    const emit = (poly) => {
      if (poly.length < 3) return;
      if (poly.every((q) => q.z <= q.tz + 0.02)) return;
      const base = pos.length / 3;
      for (const q of poly) { pos.push(q.x, q.y, q.z); uv.push(q.uu, q.vv); }
      for (let k = 1; k < poly.length - 1; k++) idx.push(base, base + k, base + k + 1);
    };
    const tri = (a, b, cI, ti) => {
      if (below(a) && below(b) && below(cI)) return;
      if (tunReach > 0) {
        const mx = (X[a] + X[b] + X[cI]) / 3, my = (Y[a] + Y[b] + Y[cI]) / 3;
        const nt = nearTunnel(mx, my, box.A + 2 * Math.max(cx, cy) + 2);
        if (nt) {
          const { p } = nt;
          const U = (q) => (q.x - p.x) * -p.ty + (q.y - p.y) * p.tx;
          const ZL = (q) => q.z - (p.zc + p.sr * clamp(U(q), -p.w / 2, p.w / 2));
          const bx = boxById.get(p.tun) || box;
          const B = bx.B, A = bx.A, c0v = -Math.min(0.25, gap * 0.8);
          const reg = (q) => { const zl = ZL(q), u = U(q); if (zl >= B) return 0; if (zl <= c0v) return 3; if (u >= A) return 1; if (u <= -A) return 2; return 4; };
          const V3 = [vert(a), vert(b), vert(cI)];
          const R = V3.map(reg);
          if (R[0] === R[1] && R[1] === R[2]) { if (R[0] === 4) return; idx.push(a, b, cI); keptTri[ti] = 1; return; }
          const pieces = [
            [(q) => ZL(q) - B],
            [(q) => B - ZL(q), (q) => ZL(q) - c0v, (q) => U(q) - A],
            [(q) => B - ZL(q), (q) => ZL(q) - c0v, (q) => -A - U(q)],
            [(q) => c0v - ZL(q)],
          ];
          for (const planes of pieces) {
            let poly = V3;
            for (const fn of planes) { poly = clipPoly(poly, fn); if (poly.length < 3) break; }
            emit(poly);
          }
          return;
        }
      }
      idx.push(a, b, cI);
      keptTri[ti] = 1;
    };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, cI = a + nx + 1, d = cI + 1;
      const ti = (j * nx + i) * 2;
      tri(a, b, d, ti);
      tri(a, d, cI, ti + 1);
    }
    const sample = (x, y) => {
      const fx = (x - x0) / cx, fy = (y - y0) / cy;
      if (fx < 0 || fy < 0 || fx >= nx || fy >= ny) return -Infinity;
      const i = Math.min(nx - 1, Math.floor(fx)), j = Math.min(ny - 1, Math.floor(fy)), tx = fx - i, ty = fy - j;
      const a = j * (nx + 1) + i, b = a + 1, cI = a + nx + 1, d = cI + 1;
      const ti = (j * nx + i) * 2;
      if (tx >= ty) return keptTri[ti] ? Z[a] + (Z[b] - Z[a]) * tx + (Z[d] - Z[b]) * ty : -Infinity;
      return keptTri[ti + 1] ? Z[a] + (Z[d] - Z[cI]) * tx + (Z[cI] - Z[a]) * ty : -Infinity;
    };
    samplers.push({ f, sample, h });
    const name = h.name || `cerro_${String(h.id).padStart(2, '0')}`;
    res.hills.push({ id: h.id, name, positions: new Float32Array(pos), uvs: new Float32Array(uv), indices: new Uint32Array(idx), tris: idx.length / 3, cell: Math.max(cx, cy) });
    res.tris += idx.length / 3;
  });
  res.sample = (x, y) => {
    let m = -Infinity;
    for (const { f, sample } of samplers) { if (x < f.minX || y < f.minY || x > f.maxX || y > f.maxY) continue; const v = sample(x, y); if (v > m) m = v; }
    return m;
  };
  /** Qué hay en (x,y): null = terreno; si no {kind: 'slope' | 'top', id, z}. La cima es donde el cerro supera el 85 % de su altura. */
  res.classify = (x, y) => {
    let best = null;
    const tz = T.sample(x, y);
    for (const { f, sample } of samplers) {
      if (x < f.minX || y < f.minY || x > f.maxX || y > f.maxY) continue;
      const z = sample(x, y);
      if (!(z > tz + 0.25) || (best && z <= best.z)) continue;
      const rel = f.sample(x, y) / Math.max(0.01, f.height);
      best = { kind: rel >= 0.85 ? 'top' : 'slope', id: f.id, z };
    }
    return best;
  };
  res.bboxes = samplers.map(({ f }) => ({ id: f.id, minX: f.minX, minY: f.minY, maxX: f.maxX, maxY: f.maxY, area: f.area }));
  return res;
}

function gridMesh(minX, minY, W, H, sp, heightAt) {
  const cell = terrainCell(W * H, sp);
  const nx = Math.max(2, Math.ceil(W / cell)), ny = Math.max(2, Math.ceil(H / cell));
  const cx = W / nx, cy = H / ny;
  const rho = Math.hypot(cx, cy) * 1.05 + 0.5;
  const heights = new Float32Array((nx + 1) * (ny + 1));
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) heights[j * (nx + 1) + i] = heightAt(minX + i * cx, minY + j * cy, rho);
  const pos = new Float32Array((nx + 1) * (ny + 1) * 3);
  const uv = new Float32Array((nx + 1) * (ny + 1) * 2);
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const v = j * (nx + 1) + i;
    pos[v * 3] = minX + i * cx; pos[v * 3 + 1] = minY + j * cy; pos[v * 3 + 2] = heights[v];
    uv[v * 2] = (i / nx) * sp.terrainTexRepX;
    uv[v * 2 + 1] = (j / ny) * sp.terrainTexRepY;
  }
  const idx = new Uint32Array(nx * ny * 6);
  let q = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
    idx[q++] = a; idx[q++] = b; idx[q++] = d;
    idx[q++] = a; idx[q++] = d; idx[q++] = c;
  }
  const sample = (x, y) => {
    const fx = clamp((x - minX) / cx, 0, nx - 1e-9), fy = clamp((y - minY) / cy, 0, ny - 1e-9);
    const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
    const a = heights[j * (nx + 1) + i], b = heights[j * (nx + 1) + i + 1];
    const c = heights[(j + 1) * (nx + 1) + i], d = heights[(j + 1) * (nx + 1) + i + 1];
    if (tx >= ty) return a + (b - a) * tx + (d - b) * ty;
    return a + (d - c) * tx + (c - a) * ty;
  };
  return { positions: pos, uvs: uv, indices: idx, nx, ny, cell: Math.max(cx, cy), cellFine: null, tris: nx * ny * 2, sample, adaptive: false };
}

function adaptiveMesh(minX, minY, W, H, sp, paint, heightAt) {
  // 1) máscara de lo pintado
  const mc = Math.max(1, Math.max(W, H) / 600);
  const mw = Math.ceil(W / mc) + 1, mh = Math.ceil(H / mc) + 1;
  const mask = new Uint8Array(mw * mh);
  for (const st of paint) {
    const i0 = Math.max(0, Math.floor((st.x - st.r - minX) / mc)), i1 = Math.min(mw - 1, Math.ceil((st.x + st.r - minX) / mc));
    const j0 = Math.max(0, Math.floor((st.y - st.r - minY) / mc)), j1 = Math.min(mh - 1, Math.ceil((st.y + st.r - minY) / mc));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (Math.hypot(minX + i * mc - st.x, minY + j * mc - st.y) <= st.r) mask[j * mw + i] = st.e ? 0 : 1;
    }
  }
  const isPainted = (x, y) => {
    const i = Math.round((x - minX) / mc), j = Math.round((y - minY) / mc);
    return i >= 0 && j >= 0 && i < mw && j < mh && mask[j * mw + i] === 1;
  };
  let pc = 0;
  for (let k = 0; k < mask.length; k++) pc += mask[k];
  const Ap = Math.min(W * H, pc * mc * mc), Ar = Math.max(0, W * H - Ap);
  // 2) espaciados: base según densidad, fino = base / sqrt(multiplicador); se ajustan al tope de polígonos
  const d = clamp(sp.terrainDensity, 1, 100) / 100;
  let c = 20 * Math.pow(1 / 20, d);
  const f = Math.sqrt(Math.max(1, sp.paintFactor));
  let cf = c / f;
  const pts = Ar / (c * c) + Ap / (cf * cf);
  const maxTris = Math.max(200, sp.terrainMaxPolys);
  if (2 * pts > maxTris) { const k = Math.sqrt((2 * pts) / maxTris); c *= k; cf *= k; }
  // 3) puntos: grilla base fuera de lo pintado + grilla fina dentro (con un leve desfase para evitar degeneraciones)
  const P = [];
  const nx = Math.max(2, Math.ceil(W / c)), ny = Math.max(2, Math.ceil(H / c));
  const cx = W / nx, cy = H / ny;
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const x = minX + i * cx, y = minY + j * cy;
    const border = i === 0 || j === 0 || i === nx || j === ny;
    if (border || !isPainted(x, y)) P.push(x, y);
  }
  const fx = Math.max(2, Math.ceil(W / cf)), fy = Math.max(2, Math.ceil(H / cf));
  const fcx = W / fx, fcy = H / fy;
  for (let j = 1; j < fy; j++) for (let i = 1; i < fx; i++) {
    const x = minX + i * fcx + (j % 2) * fcx * 0.013, y = minY + j * fcy + (i % 2) * fcy * 0.011;
    if (isPainted(x, y)) P.push(x, y);
  }
  const coords = new Float64Array(P);
  const del = new Delaunator(coords);
  const tri = del.triangles;
  const nv = coords.length / 2;
  // 4) rho por vértice = arista incidente más larga
  const rhoV = new Float64Array(nv);
  for (let t = 0; t < tri.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = tri[t + e], b = tri[t + ((e + 1) % 3)];
      const L = Math.hypot(coords[a * 2] - coords[b * 2], coords[a * 2 + 1] - coords[b * 2 + 1]);
      if (L > rhoV[a]) rhoV[a] = L;
      if (L > rhoV[b]) rhoV[b] = L;
    }
  }
  const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), hz = new Float32Array(nv);
  for (let v = 0; v < nv; v++) {
    const x = coords[v * 2], y = coords[v * 2 + 1];
    const z = heightAt(x, y, rhoV[v] * 1.05 + 0.5);
    hz[v] = z;
    pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
    uv[v * 2] = ((x - minX) / W) * sp.terrainTexRepX;
    uv[v * 2 + 1] = ((y - minY) / H) * sp.terrainTexRepY;
  }
  // Delaunator entrega triángulos en sentido horario (con Y hacia arriba): se invierten para que la normal mire a +Z
  const idx = new Uint32Array(tri.length);
  for (let t = 0; t < tri.length; t += 3) { idx[t] = tri[t]; idx[t + 1] = tri[t + 2]; idx[t + 2] = tri[t + 1]; }
  // 5) muestreo de altura: grilla de aceleración sobre los triángulos
  const gc = Math.max(c, 4);
  const acc = new Map();
  for (let t = 0; t < tri.length; t += 3) {
    const xs = [coords[tri[t] * 2], coords[tri[t + 1] * 2], coords[tri[t + 2] * 2]];
    const ys = [coords[tri[t] * 2 + 1], coords[tri[t + 1] * 2 + 1], coords[tri[t + 2] * 2 + 1]];
    const i0 = Math.floor((Math.min(...xs) - minX) / gc), i1 = Math.floor((Math.max(...xs) - minX) / gc);
    const j0 = Math.floor((Math.min(...ys) - minY) / gc), j1 = Math.floor((Math.max(...ys) - minY) / gc);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * 100003 + i;
      let l = acc.get(k);
      if (!l) acc.set(k, (l = []));
      l.push(t);
    }
  }
  const sample = (x, y) => {
    x = clamp(x, minX, minX + W); y = clamp(y, minY, minY + H);
    const l = acc.get(Math.floor((y - minY) / gc) * 100003 + Math.floor((x - minX) / gc)) || [];
    for (const t of l) {
      const a = tri[t], b = tri[t + 1], cc = tri[t + 2];
      const ax = coords[a * 2], ay = coords[a * 2 + 1], bx = coords[b * 2], by = coords[b * 2 + 1], qx = coords[cc * 2], qy = coords[cc * 2 + 1];
      const den = (by - qy) * (ax - qx) + (qx - bx) * (ay - qy);
      if (Math.abs(den) < 1e-12) continue;
      const l1 = ((by - qy) * (x - qx) + (qx - bx) * (y - qy)) / den;
      const l2 = ((qy - ay) * (x - qx) + (ax - qx) * (y - qy)) / den;
      const l3 = 1 - l1 - l2;
      if (l1 >= -1e-7 && l2 >= -1e-7 && l3 >= -1e-7) return l1 * hz[a] + l2 * hz[b] + l3 * hz[cc];
    }
    return heightAt(x, y, c);
  };
  return { positions: pos, uvs: uv, indices: idx, nx, ny, cell: c, cellFine: cf, tris: tri.length / 3, sample, adaptive: true, paintedArea: Ap };
}

/** Terreno + cerros como un solo suelo para apoyar árboles y hierba. */
export function makeGround(T, HS) {
  if (!T) return null;
  return {
    sample: (x, y) => Math.max(T.sample(x, y), HS ? HS.sample(x, y) : -Infinity),
    classify: HS && HS.classify ? HS.classify : () => null,
    bboxes: HS && HS.bboxes ? HS.bboxes : [],
  };
}

/** Normal del suelo por diferencias finitas. */
function groundNormal(ground, x, y, d = 1) {
  const zx = ground.sample(x + d, y) - ground.sample(x - d, y);
  const zy = ground.sample(x, y + d) - ground.sample(x, y - d);
  const nx = -zx / (2 * d), ny = -zy / (2 * d);
  const l = Math.hypot(nx, ny, 1);
  return [nx / l, ny / l, 1 / l];
}

/**
 * Reparte objetos (árboles o hierba) a los costados de la pista y, si se pide, sobre laderas y cimas de cerros.
 * o: {density (por 100 m y lado), side, offset, spread, minSpace, clear, onSlopes, onTops, hillDensity (por 1000 m²), tilt (0..100), seed}
 * Devuelve [{x, y, z, up:[ux,uy,uz], slope (tan del ángulo entre el eje y la normal), where}]
 */
function scatter(layout, elev, sp, ground, o) {
  const rand = rng(o.seed >>> 0);
  const S = trackSamples(layout, elev);
  let maxW = 0;
  for (const p of S) maxW = Math.max(maxW, p.w);
  const g = new SpatialGrid(Math.max(maxW, 8));
  for (const p of S) g.insert(p.x, p.y, p);
  const placed = new SpatialGrid(Math.max(2, o.minSpace * 3));
  const out = [];
  const tilt = clamp(o.tilt ?? 0, 0, 100) / 100;
  const tryPlace = (x, y, zFallback) => {
    let ok = true;
    g.query(x, y, maxW / 2 + o.clear, (p) => { if (ok && Math.hypot(p.x - x, p.y - y) < p.w / 2 + o.clear) ok = false; });
    if (!ok) return;
    placed.query(x, y, o.minSpace, (t) => { if (ok && Math.hypot(t.x - x, t.y - y) < o.minSpace) ok = false; });
    if (!ok) return;
    let where = 'terrain';
    if (ground && ground.classify) {
      const c = ground.classify(x, y);
      if (c) where = c.kind;
    }
    if (where === 'slope' && !o.onSlopes) return;
    if (where === 'top' && !o.onTops) return;
    const z = ground ? ground.sample(x, y) : zFallback;
    let up = [0, 0, 1], cosA = 1;
    if (ground) {
      const n = groundNormal(ground, x, y);
      const ux = n[0] * tilt, uy = n[1] * tilt, uz = 1 - tilt + n[2] * tilt;
      const l = Math.hypot(ux, uy, uz);
      up = [ux / l, uy / l, uz / l];
      cosA = clamp(up[0] * n[0] + up[1] * n[1] + up[2] * n[2], 0.05, 1);
    }
    const t = { x, y, z, up, slope: Math.sqrt(1 - cosA * cosA) / cosA, where };
    out.push(t);
    placed.insert(x, y, t);
  };
  const sides = o.side === 'left' ? [1] : o.side === 'right' ? [-1] : [1, -1];
  const step = 100 / Math.max(0.1, o.density);
  layout.routes.forEach((r, k) => {
    const e = elev.routes[k];
    for (const side of sides) {
      for (let s0 = rand() * step; s0 < r.L; s0 += step * (0.6 + 0.8 * rand())) {
        const i = Math.min(r.n - 1, Math.floor(s0 / r.ds));
        const lx = -r.ty[i], ly = r.tx[i];
        const off = r.w[i] / 2 + o.offset + rand() * o.spread;
        const x = r.x[i] + lx * off * side + (rand() - 0.5) * 2;
        const y = r.y[i] + ly * off * side + (rand() - 0.5) * 2;
        tryPlace(x, y, e.z[i] - sp.terrainGap);
      }
    }
  });
  // sobre los cerros: grilla con variación, con densidad por área
  if ((o.onSlopes || o.onTops) && o.hillDensity > 0 && ground && ground.bboxes) {
    const sp2 = Math.sqrt(1000 / o.hillDensity);
    for (const bb of ground.bboxes) {
      const nx = Math.ceil((bb.maxX - bb.minX) / sp2), ny = Math.ceil((bb.maxY - bb.minY) / sp2);
      if (nx * ny > 400000) continue;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const x = bb.minX + (i + rand()) * sp2, y = bb.minY + (j + rand()) * sp2;
        const c = ground.classify(x, y);
        if (!c || c.id !== bb.id) continue;
        tryPlace(x, y, 0);
      }
    }
  }
  return out;
}

/** Base ortonormal (A, B) perpendicular a U. */
function basis(U) {
  const ref = Math.abs(U[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let A = [U[1] * ref[2] - U[2] * ref[1], U[2] * ref[0] - U[0] * ref[2], U[0] * ref[1] - U[1] * ref[0]];
  const l = Math.hypot(...A); A = A.map((v) => v / l);
  const B = [U[1] * A[2] - U[2] * A[1], U[2] * A[0] - U[0] * A[2], U[0] * A[1] - U[1] * A[0]];
  return [A, B];
}

/** Árboles (conos) a los costados de la pista y, opcionalmente, en laderas y cimas de cerros. */
export function buildTrees(layout, elev, spIn = {}, ground = null) {
  const sp = { ...DEFAULT_SCENE, ...spIn };
  const pts = scatter(layout, elev, sp, ground, {
    seed: sp.treeSeed, density: sp.treeDensity, side: sp.treeSide, offset: sp.treeOffset, spread: sp.treeSpread,
    minSpace: 3.2 * sp.treeScale, clear: 1.5 + 2.6 * sp.treeScale,
    onSlopes: sp.treeOnSlopes, onTops: sp.treeOnTops, hillDensity: sp.treeHillDensity, tilt: sp.treeTilt,
  });
  const rand = rng((sp.treeSeed ^ 0x9e3779b9) >>> 0);
  const trees = pts.map((p) => {
    const h = 9 * sp.treeScale * (0.75 + 0.5 * rand());
    const rad = h * (0.26 + 0.06 * rand());
    // se hunde lo necesario para que el borde de la base no flote en pendiente
    const sink = 0.3 + Math.min(0.6 * h, rad * p.slope);
    const base = [p.x - p.up[0] * sink, p.y - p.up[1] * sink, p.z - p.up[2] * sink];
    return { x: p.x, y: p.y, z: p.z, base: base[2], basePos: base, up: p.up, h, r: rad, where: p.where };
  });
  // malla combinada de conos (8 lados + base)
  const seg = 8;
  const pos = new Float32Array(trees.length * (seg + 2) * 3);
  const idx = new Uint32Array(trees.length * seg * 6);
  let v = 0, q = 0;
  for (const t of trees) {
    const b = v;
    const [A, B] = basis(t.up);
    const [bx, by, bz] = t.basePos;
    for (let k2 = 0; k2 < seg; k2++) {
      const a = (k2 / seg) * Math.PI * 2, c = Math.cos(a) * t.r, sn = Math.sin(a) * t.r;
      pos[v * 3] = bx + A[0] * c + B[0] * sn; pos[v * 3 + 1] = by + A[1] * c + B[1] * sn; pos[v * 3 + 2] = bz + A[2] * c + B[2] * sn; v++;
    }
    pos[v * 3] = bx + t.up[0] * t.h; pos[v * 3 + 1] = by + t.up[1] * t.h; pos[v * 3 + 2] = bz + t.up[2] * t.h; const apex = v++;
    pos[v * 3] = bx; pos[v * 3 + 1] = by; pos[v * 3 + 2] = bz; const bottom = v++;
    // el orden depende de la orientación de (A, B, U): se asegura que la normal mire hacia afuera
    const right = (A[1] * B[2] - A[2] * B[1]) * t.up[0] + (A[2] * B[0] - A[0] * B[2]) * t.up[1] + (A[0] * B[1] - A[1] * B[0]) * t.up[2] > 0;
    for (let k2 = 0; k2 < seg; k2++) {
      const a = b + k2, c = b + ((k2 + 1) % seg);
      if (right) { idx[q++] = a; idx[q++] = c; idx[q++] = apex; idx[q++] = c; idx[q++] = a; idx[q++] = bottom; }
      else { idx[q++] = c; idx[q++] = a; idx[q++] = apex; idx[q++] = a; idx[q++] = c; idx[q++] = bottom; }
    }
  }
  return { positions: pos, indices: idx, count: trees.length, trees };
}

/** Hierba: dos planos cruzados por mata, con UV para una textura con transparencia. Normales hacia arriba (luz pareja). */
export function buildGrass(layout, elev, spIn = {}, ground = null) {
  const sp = { ...DEFAULT_SCENE, ...spIn };
  const pts = scatter(layout, elev, sp, ground, {
    seed: (sp.treeSeed * 31 + 7) >>> 0, density: sp.grassDensity, side: sp.grassSide, offset: sp.grassOffset, spread: sp.grassSpread,
    minSpace: 0.55 * sp.grassScale, clear: 0.4,
    onSlopes: sp.grassOnSlopes, onTops: sp.grassOnTops, hillDensity: sp.grassHillDensity, tilt: sp.grassTilt,
  });
  const rand = rng((sp.treeSeed * 131 + 3) >>> 0);
  const n = pts.length;
  const pos = new Float32Array(n * 8 * 3), nor = new Float32Array(n * 8 * 3), uv = new Float32Array(n * 8 * 2);
  const idx = new Uint32Array(n * 12);
  let v = 0, q = 0;
  for (const p of pts) {
    const w = 1.3 * sp.grassScale * (0.75 + 0.5 * rand());
    const h = 0.9 * sp.grassScale * (0.7 + 0.6 * rand());
    const [A0, B0] = basis(p.up);
    const yaw = rand() * Math.PI;
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    const A = [A0[0] * c + B0[0] * sn, A0[1] * c + B0[1] * sn, A0[2] * c + B0[2] * sn];
    const B = [-A0[0] * sn + B0[0] * c, -A0[1] * sn + B0[1] * c, -A0[2] * sn + B0[2] * c];
    const sink = 0.05 + Math.min(0.4 * h, (w / 2) * p.slope);
    const bx = p.x - p.up[0] * sink, by = p.y - p.up[1] * sink, bz = p.z - p.up[2] * sink;
    for (const D of [A, B]) {
      const base = v;
      const corners = [[-0.5, 0, 0, 0], [0.5, 0, 1, 0], [0.5, 1, 1, 1], [-0.5, 1, 0, 1]];
      for (const [a, b, tu, tv] of corners) {
        pos[v * 3] = bx + D[0] * a * w + p.up[0] * b * h;
        pos[v * 3 + 1] = by + D[1] * a * w + p.up[1] * b * h;
        pos[v * 3 + 2] = bz + D[2] * a * w + p.up[2] * b * h;
        nor[v * 3] = p.up[0]; nor[v * 3 + 1] = p.up[1]; nor[v * 3 + 2] = p.up[2];
        uv[v * 2] = tu; uv[v * 2 + 1] = tv;
        v++;
      }
      idx[q++] = base; idx[q++] = base + 1; idx[q++] = base + 2;
      idx[q++] = base; idx[q++] = base + 2; idx[q++] = base + 3;
    }
  }
  return { positions: pos, normals: nor, uvs: uv, indices: idx, count: n, tris: n * 4 };
}

/**
 * Pórtico de salida en s = 0 de la ruta principal: dos postes, viga, cartel con texto y línea a cuadros.
 * Las posiciones son relativas a origin (centro de la calzada en la salida): el pivote queda en la base, al centro.
 */
export function buildStartGate(layout, elev, spIn = {}) {
  const sp = { ...DEFAULT_SCENE, ...spIn };
  const r = layout.routes[0], e = elev.routes[0];
  const F = frameAt(r, e, 0);
  const T = [F.tx, F.ty, 0], Lt = [-F.ty, F.tx, 0];
  const O = [F.x, F.y, F.z];
  const w = F.w, H = Math.max(3, sp.startGateHeight), bh = 2.4, post = 0.8, span = w / 2 + 1.4;
  const P = (u, f, z) => [Lt[0] * u + T[0] * f, Lt[1] * u + T[1] * f, z];
  const mk = () => ({ pos: [], uv: [], idx: [] });
  // cara con 4 esquinas (orden alrededor del borde) y la dirección hacia afuera: se ajusta el sentido de giro
  const face = (m, c, uvs, outDir) => {
    const base = m.pos.length / 3;
    for (let k = 0; k < 4; k++) { m.pos.push(...c[k]); m.uv.push(...uvs[k]); }
    const a = c[0], b = c[1], d = c[2];
    const n = [(b[1] - a[1]) * (d[2] - a[2]) - (b[2] - a[2]) * (d[1] - a[1]), (b[2] - a[2]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[2] - a[2]), (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0])];
    const ok = n[0] * outDir[0] + n[1] * outDir[1] + n[2] * outDir[2] >= 0;
    if (ok) m.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else m.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  const boxM = (m, u0, u1, f0, f1, z0, z1) => {
    const U = [1, 1, 0, 0, 1];
    const c = (u, f, z) => P(u, f, z);
    const neg = (v) => v.map((x) => -x);
    const Lu = Lt, Tf = T, Z = [0, 0, 1];
    face(m, [c(u0, f0, z0), c(u1, f0, z0), c(u1, f0, z1), c(u0, f0, z1)], [[0, 0], [1, 0], [1, 1], [0, 1]], neg(Tf));
    face(m, [c(u1, f1, z0), c(u0, f1, z0), c(u0, f1, z1), c(u1, f1, z1)], [[0, 0], [1, 0], [1, 1], [0, 1]], Tf);
    face(m, [c(u0, f1, z0), c(u0, f0, z0), c(u0, f0, z1), c(u0, f1, z1)], [[0, 0], [1, 0], [1, 1], [0, 1]], neg(Lu));
    face(m, [c(u1, f0, z0), c(u1, f1, z0), c(u1, f1, z1), c(u1, f0, z1)], [[0, 0], [1, 0], [1, 1], [0, 1]], Lu);
    face(m, [c(u0, f0, z1), c(u1, f0, z1), c(u1, f1, z1), c(u0, f1, z1)], [[0, 0], [1, 0], [1, 1], [0, 1]], Z);
    face(m, [c(u0, f1, z0), c(u1, f1, z0), c(u1, f0, z0), c(u0, f0, z0)], [[0, 0], [1, 0], [1, 1], [0, 1]], neg(Z));
    return U;
  };
  const frame = mk();
  const edgeZ = (u) => F.at(u, 0)[2] - F.z;
  for (const side of [-1, 1]) {
    const uc = side * (w / 2 + 0.9);
    boxM(frame, uc - post / 2, uc + post / 2, -post / 2, post / 2, Math.min(edgeZ(side * w / 2), 0) - 0.6, H + bh);
  }
  boxM(frame, -span, span, -0.45, 0.45, H, H + bh);
  // cartel: al frente (mirando hacia los autos que llegan) y atrás, texto legible desde ambos lados
  const banner = mk();
  const ub = w / 2 + 0.4;
  face(banner, [P(ub, -0.47, H + 0.15), P(-ub, -0.47, H + 0.15), P(-ub, -0.47, H + bh - 0.15), P(ub, -0.47, H + bh - 0.15)], [[0, 0], [1, 0], [1, 1], [0, 1]], [-T[0], -T[1], 0]);
  face(banner, [P(-ub, 0.47, H + 0.15), P(ub, 0.47, H + 0.15), P(ub, 0.47, H + bh - 0.15), P(-ub, 0.47, H + bh - 0.15)], [[0, 0], [1, 0], [1, 1], [0, 1]], T);
  // línea de salida a cuadros sobre la calzada (sigue el peralte)
  const line = mk();
  const F0 = frameAt(r, e, -1), F1 = frameAt(r, e, 1);
  const rel = (p) => [p[0] - O[0], p[1] - O[1], p[2] - O[2] + 0.04];
  face(line, [rel(F0.at(-w / 2, 0)), rel(F0.at(w / 2, 0)), rel(F1.at(w / 2, 0)), rel(F1.at(-w / 2, 0))], [[0, 0], [w / 2, 0], [w / 2, 1], [0, 1]], [0, 0, 1]);
  const pack = (m) => ({ positions: new Float32Array(m.pos), uvs: new Float32Array(m.uv), indices: m.idx });
  return { origin: O, angle: Math.atan2(F.ty, F.tx), frame: pack(frame), banner: pack(banner), line: pack(line), text: sp.startText || 'START', tris: (frame.idx.length + banner.idx.length + line.idx.length) / 3 };
}

/** Pilares bajo los puentes de la ruta principal: [{x, y, zTop, zBot, size, angle, bridge}] (pivote en la base). */
export function bridgePillars(layout, elev, terrain = null) {
  const out = [];
  const r = layout.routes[0], e = elev.routes[0];
  (r.bridges || []).forEach((b, bi) => {
    const len = b.s1 - b.s0;
    const n = Math.max(1, Math.round(len / 18));
    for (let q = 1; q < n || (n === 1 && q === 1); q++) {
      const s = b.s0 + (len * q) / Math.max(2, n);
      const i = ((Math.round(s / r.ds) % r.n) + r.n) % r.n;
      const zTop = e.z[i] - 0.6;
      const zBot = terrain ? terrain.sample(r.x[i], r.y[i]) - 0.3 : Math.min(...e.z) - 2;
      if (zTop - zBot < 1.2) continue;
      out.push({ x: r.x[i], y: r.y[i], zTop, zBot, size: Math.max(1.5, r.w[i] * 0.18), angle: Math.atan2(r.ty[i], r.tx[i]), bridge: b.idx ?? bi });
      if (n === 1) break;
    }
  });
  return out;
}
