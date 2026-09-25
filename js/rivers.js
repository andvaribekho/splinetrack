// Ríos (sobre el terreno) y cascadas (sobre un cerro). Cada uno es la unión de los toques del pincel (los de borrar
// restan, en orden). Puede ir «posado» (solo una malla de agua sobre la superficie) o «socavado» (la superficie se
// hunde con paredes suaves o de roca y el agua queda dentro del cauce).
// river = {id, name, kind: 'river' | 'fall', hill, mode: 'surface' | 'carved', depth, walls: 'smooth' | 'rock',
//          wallSubdiv, strokes: [{x, y, r, e}]}   (en metros)
import Delaunator from '../vendor/delaunator.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export const RIVER_DEFAULTS = { mode: 'carved', depth: 2, walls: 'smooth', wallSubdiv: 2 };
/** Subdivisiones extra → multiplicador de polígonos por m² (cada lado se divide n + 1 veces). */
export function subdivFactor(n) { const k = Math.max(0, Math.round(n ?? 1)); return (k + 1) * (k + 1); }

const cache = new Map();
function hash2(i, j, s) { let h = (i * 374761393 + j * 668265263 + s * 2246822519) ^ 0x5bd1e995; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function noise2(x, y, s) {
  const i = Math.floor(x), j = Math.floor(y), tx = x - i, ty = y - j;
  const u = tx * tx * (3 - 2 * tx), v = ty * ty * (3 - 2 * ty);
  const a = hash2(i, j, s), b = hash2(i + 1, j, s), c = hash2(i, j + 1, s), d = hash2(i + 1, j + 1, s);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/**
 * Campo de un río: distancia con signo al borde (sd > 0 dentro) en una grilla, y la profundidad del socavado.
 * Devuelve null si no tiene toques. {sd(x,y), carve(x,y), inside(x,y), bounds, cell, rMed, wallW, river}
 */
export function riverField(rv) {
  const adds = (rv.strokes || []).filter((q) => !q.e);
  if (!adds.length) return null;
  const key = JSON.stringify([rv.mode, rv.depth, rv.walls, rv.strokes]);
  const hit = cache.get(rv.id + ':' + rv.kind);
  if (hit && hit.key === key) return hit.field;
  const rs = adds.map((q) => q.r).sort((a, b) => a - b);
  const rMed = rs[rs.length >> 1], rMin = rs[0];
  const rock = rv.walls === 'rock';
  const wallW = rock ? Math.max(0.25, 0.1 * rMed) : Math.max(0.8, 0.6 * rMed);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of adds) { x0 = Math.min(x0, q.x - q.r); x1 = Math.max(x1, q.x + q.r); y0 = Math.min(y0, q.y - q.r); y1 = Math.max(y1, q.y + q.r); }
  let c = clamp(rMin / 5, 0.25, 2);
  while (((x1 - x0) / c) * ((y1 - y0) / c) > 3e6) c *= 1.25;
  const m = 2 * c;
  x0 -= m; y0 -= m; x1 += m; y1 += m;
  const nx = Math.ceil((x1 - x0) / c) + 1, ny = Math.ceil((y1 - y0) / c) + 1;
  const F = new Float32Array(nx * ny).fill(-1e3);
  for (const q of rv.strokes) { // en orden: los toques de borrar restan lo pintado antes
    const R = q.r + m;
    const i0 = Math.max(0, Math.floor((q.x - R - x0) / c)), i1 = Math.min(nx - 1, Math.ceil((q.x + R - x0) / c));
    const j0 = Math.max(0, Math.floor((q.y - R - y0) / c)), j1 = Math.min(ny - 1, Math.ceil((q.y + R - y0) / c));
    for (let j = j0; j <= j1; j++) {
      const dy = y0 + j * c - q.y;
      for (let i = i0; i <= i1; i++) {
        const v = q.r - Math.hypot(x0 + i * c - q.x, dy), k = j * nx + i;
        if (q.e) { if (v > -m && -v < F[k]) F[k] = -v; } else if (v > F[k]) F[k] = v;
      }
    }
  }
  const sd = (x, y) => {
    const fx = (x - x0) / c, fy = (y - y0) / c;
    if (fx < 0 || fy < 0 || fx >= nx - 1 || fy >= ny - 1) return -1e3;
    const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j, k = j * nx + i;
    return (F[k] * (1 - tx) + F[k + 1] * tx) * (1 - ty) + (F[k + nx] * (1 - tx) + F[k + nx + 1] * tx) * ty;
  };
  const depth = Math.max(0.1, rv.depth ?? 2);
  const seed = (rv.id | 0) * 13 + 7;
  // perfil del cauce: paredes suaves (curva en S ancha) o de roca (casi verticales, con el borde irregular)
  const profile = (x, y, s) => {
    if (s <= -wallW) return 0;
    if (!rock) return smooth(0, wallW, s);
    const n = noise2(x / 1.7, y / 1.7, seed) - 0.5;
    return smooth(0, wallW, s + n * 0.35 * rMed * 0.5);
  };
  const carve = rv.mode === 'carved'
    ? (x, y) => {
      if (x < x0 || y < y0 || x > x1 || y > y1) return 0;
      const s = sd(x, y);
      if (s <= -wallW) return 0;
      const p = profile(x, y, s);
      if (p <= 0) return 0;
      const bed = rock ? 0.92 + 0.16 * noise2(x / 3, y / 3, seed + 1) : 1; // lecho algo irregular en roca
      return depth * p * bed;
    }
    : () => 0;
  const field = { sd, carve, inside: (x, y) => sd(x, y) > 0, bounds: { x0, y0, x1, y1 }, cell: c, rMed, wallW, depth, river: rv };
  cache.set(rv.id + ':' + rv.kind, { key, field });
  return field;
}

/**
 * Malla de agua de un río o cascada. surfZ(x,y) = altura de la superficie (ya socavada); origZ(x,y) = la superficie
 * antes de socavar; skip(x,y) = true donde no va agua (la pista). Devuelve {positions, uvs, indices, tris} o null.
 */
export function buildRiverWater(F, surfZ, origZ, skip = null) {
  const rv = F.river, carved = rv.mode === 'carved';
  const s = clamp(F.rMed / 2.5, 0.4, 3);
  const { x0, y0, x1, y1 } = F.bounds;
  const P = [];
  // puntos interiores (grilla con un leve desfase) + contorno de cada toque (el borde queda redondo)
  for (let y = y0 + s / 2, j = 0; y < y1; y += s, j++) for (let x = x0 + s / 2 + (j % 2) * s * 0.5; x < x1; x += s) if (F.sd(x, y) > s * 0.35) P.push(x, y);
  for (const q of rv.strokes) {
    const n = Math.max(8, Math.ceil((2 * Math.PI * q.r) / s));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2, x = q.x + Math.cos(a) * q.r, y = q.y + Math.sin(a) * q.r;
      if (Math.abs(F.sd(x, y)) < F.cell * 0.75) P.push(x, y);
    }
  }
  if (P.length < 6) return null;
  const coords = new Float64Array(P);
  const del = new Delaunator(coords);
  const tri = del.triangles;
  const nv = coords.length / 2;
  const zv = new Float32Array(nv), ok = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) {
    const x = coords[v * 2], y = coords[v * 2 + 1];
    // socavado: el agua llena el cauce hasta un 30 % de la profundidad bajo el borde; posado: apenas sobre el suelo
    const z = carved ? origZ(x, y) - 0.3 * F.depth : surfZ(x, y) + 0.12;
    if (!Number.isFinite(z)) continue;
    zv[v] = z;
    ok[v] = skip && skip(x, y) ? 0 : 1;
  }
  const idx = [];
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t], b = tri[t + 1], c = tri[t + 2];
    if (!ok[a] || !ok[b] || !ok[c]) continue;
    const mx = (coords[a * 2] + coords[b * 2] + coords[c * 2]) / 3, my = (coords[a * 2 + 1] + coords[b * 2 + 1] + coords[c * 2 + 1]) / 3;
    if (F.sd(mx, my) <= 0) continue;
    idx.push(a, c, b); // Delaunator entrega sentido horario: se invierte para que la normal mire hacia arriba
  }
  if (!idx.length) return null;
  const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  for (let v = 0; v < nv; v++) {
    pos[v * 3] = coords[v * 2]; pos[v * 3 + 1] = coords[v * 2 + 1]; pos[v * 3 + 2] = zv[v];
    uv[v * 2] = coords[v * 2] / 4; uv[v * 2 + 1] = coords[v * 2 + 1] / 4;
  }
  return { positions: pos, uvs: uv, indices: new Uint32Array(idx), tris: idx.length / 3 };
}

/** Nombre de exportación: rio_NN / cascada_NN (numerados por separado). */
export function riverNames(rivers) {
  let nr = 0, nf = 0;
  const out = new Map();
  for (const rv of rivers || []) out.set(rv.id, rv.name || (rv.kind === 'fall' ? `cascada_${String(++nf).padStart(2, '0')}` : `rio_${String(++nr).padStart(2, '0')}`));
  return out;
}

/**
 * Mallas de agua de todos los ríos y cascadas. T = terreno (buildTerrain), HS = cerros (buildHills).
 * Devuelve [{id, name, kind, positions, uvs, indices, tris}].
 */
export function buildRivers(T, HS, rivers) {
  const out = [];
  if (!T || !rivers || !rivers.length) return out;
  const names = riverNames(rivers);
  const zoneAt = T.ctx && T.ctx.zoneAt;
  const skip = zoneAt ? (x, y) => zoneAt(x, y, 0.6) < Infinity : null;
  for (const rv of rivers) {
    const F = riverField(rv);
    if (!F) continue;
    let geo = null;
    if (rv.kind === 'fall') {
      if (!HS || !HS.hillSample) continue;
      geo = buildRiverWater(F, (x, y) => HS.hillSample(rv.hill, x, y), (x, y) => HS.hillOrig(rv.hill, x, y), skip);
    } else {
      geo = buildRiverWater(F, (x, y) => T.sample(x, y), (x, y) => (T.ctx && T.ctx.origAt ? T.ctx.origAt(x, y) : T.sample(x, y)), skip);
    }
    if (geo) out.push({ id: rv.id, name: names.get(rv.id), kind: rv.kind, ...geo });
  }
  return out;
}
