// Ríos (sobre el terreno) y cascadas (sobre un cerro). Cada uno es la unión de los toques del pincel (los de borrar
// restan, en orden). Puede ir «posado» (solo una malla de agua sobre la superficie) o «socavado» (la superficie se
// hunde con paredes suaves o de roca y el agua queda dentro del cauce).
// river = {id, name, kind: 'river' | 'fall', hill, mode: 'surface' | 'carved', depth, walls: 'smooth' | 'rock',
//          wallSubdiv, strokes: [{x, y, r, e}]}   (en metros)
// Toques (0.79): círculo {x, y, r, e}; línea {x, y, x2, y2, r, e, c0, c1} (c0 / c1 = 's': extremo recto, si no redondo);
// suavizado {x, y, r, s} (redondea el borde de lo pintado antes, dentro de su radio; s = fuerza 0..1).
import Delaunator from '../vendor/delaunator.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export const RIVER_DEFAULTS = { mode: 'carved', depth: 2, walls: 'nat', wallSubdiv: 2 };
/** Subdivisiones extra → multiplicador de polígonos por m² (cada lado se divide n + 1 veces). */
export function subdivFactor(n) { const k = Math.max(0, Math.round(n ?? 1)); return (k + 1) * (k + 1); }

const cache = new Map();
/** Detalle del contorno de un río (m): cuánto puede apartarse el borde simplificado (y el relieve entre vértices). */
export function riverDetail(rv) { return clamp(Number.isFinite(rv && rv.contourDetail) ? rv.contourDetail : 8, 2, 40) / 100; }
/** ¿El toque es una línea? */
export const isLine = (q) => q && Number.isFinite(q.x2) && Number.isFinite(q.y2);
/** Distancia con signo al borde de un toque (> 0 dentro): círculo o línea con extremos redondos o rectos. */
export function strokeValue(q, x, y) {
  if (!isLine(q)) return q.r - Math.hypot(x - q.x, y - q.y);
  const dx = q.x2 - q.x, dy = q.y2 - q.y, L = Math.hypot(dx, dy);
  if (L < 1e-6) return q.r - Math.hypot(x - q.x, y - q.y);
  const ux = dx / L, uy = dy / L, px = x - q.x, py = y - q.y;
  const u = px * ux + py * uy, w = Math.abs(-px * uy + py * ux);
  // cada extremo: redondo (distancia al punto) o recto (caja hasta el extremo)
  if (u < 0 && q.c0 !== 's') return q.r - Math.hypot(u, w);
  if (u > L && q.c1 !== 's') return q.r - Math.hypot(u - L, w);
  const ex = u < 0 ? -u : u > L ? u - L : 0, ey = w - q.r;
  if (ex > 0 || ey > 0) return -Math.hypot(ex, Math.max(0, ey));
  return Math.min(-ey, q.c0 === 's' ? u : Infinity, q.c1 === 's' ? L - u : Infinity);
}
/** Caja de un toque (con su radio). */
export function strokeBox(q) {
  const xa = isLine(q) ? Math.min(q.x, q.x2) : q.x, xb = isLine(q) ? Math.max(q.x, q.x2) : q.x, ya = isLine(q) ? Math.min(q.y, q.y2) : q.y, yb = isLine(q) ? Math.max(q.y, q.y2) : q.y;
  return { x0: xa - q.r, x1: xb + q.r, y0: ya - q.r, y1: yb + q.r };
}
/** Los toques como círculos (las líneas, con círculos cada medio radio; sin los de suavizar): para pintar, iluminar y buscar. */
export function strokeCircles(strokes) {
  const out = [];
  for (const q of strokes || []) {
    if (q.s) continue;
    if (!isLine(q)) { out.push(q); continue; }
    const L = Math.hypot(q.x2 - q.x, q.y2 - q.y), n = Math.max(1, Math.ceil(L / Math.max(0.05, q.r * 0.5)));
    for (let k = 0; k <= n; k++) out.push({ x: q.x + ((q.x2 - q.x) * k) / n, y: q.y + ((q.y2 - q.y) * k) / n, r: q.r, e: q.e });
  }
  return out;
}
/** ¿El punto queda dentro de lo pintado? (el último toque que lo cubre manda; los de suavizar no cuentan) */
export function strokesContain(strokes, x, y) {
  let inside = false;
  for (const q of strokes || []) if (!q.s && strokeValue(q, x, y) >= 0) inside = !q.e;
  return inside;
}
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
/** Ángulo de las paredes de los ríos socavados (grados desde el lecho, como la pendiente de un talud; 90 = vertical). */
export const RIVER_ANGLES = { art: { def: 90, min: 45, max: 135 }, nat: { def: 71, min: 45, max: 85 } };
/**
 * Paredes de un río socavado (0.78, como los tramos socavados): 'art' (lisas, malla extruida desde el contorno) o 'nat'
 * (roca del terreno). Los tipos anteriores («suaves», «de roca») pasan a naturales.
 */
export function riverWallsOf(rv) {
  const type = rv && rv.walls === 'art' ? 'art' : 'nat';
  const R = RIVER_ANGLES[type];
  const a0 = rv ? (type === 'art' ? rv.artAng : rv.natAng) ?? rv.wallAng : null; // un ángulo por tipo (como los tramos)
  const ang = clamp(Number.isFinite(a0) ? a0 : R.def, R.min, R.max);
  const st = rv && (rv.rockStyle === 'sharp' || rv.rockStyle === 'strata') ? rv.rockStyle : 'irregular';
  return {
    type, ang, lean: Math.abs(ang - 90) < 1e-6 ? 0 : 1 / Math.tan((ang * Math.PI) / 180),
    width: clamp(Number.isFinite(rv && rv.wallW) ? rv.wallW : 0.3, 0.1, 3),
    outer: rv && (rv.wallOuter === 'buried' || rv.wallOuter === 'hide') ? rv.wallOuter : 'show',
    style: st, rough: clamp(Number.isFinite(rv && rv.rockRough) ? rv.rockRough : 25, 0, 100), size: clamp(Number.isFinite(rv && rv.rockSize) ? rv.rockSize : 0.9, 0.3, 8),
    rockTouched: !!(rv && (Number.isFinite(rv.rockRough) || Number.isFinite(rv.rockSize) || rv.rockStyle)),
  };
}

export function riverField(rv) {
  const adds = (rv.strokes || []).filter((q) => !q.e && !q.s);
  if (!adds.length) return null;
  const RW = rv.kind === 'fall' ? null : riverWallsOf(rv);
  const key = JSON.stringify([rv.mode, rv.depth, rv.walls, rv.strokes, RW && [RW.ang, RW.style, RW.rough, RW.size]]);
  const hit = cache.get(rv.id + ':' + rv.kind);
  if (hit && hit.key === key) { hit.field.river = rv; hit.field.walls = RW; return hit.field; } // la forma no cambió (sí pueden sus opciones: ancho y caras exteriores de las lisas)
  const rs = adds.map((q) => q.r).sort((a, b) => a - b);
  const rMed = rs[rs.length >> 1], rMin = rs[0];
  // cascadas: paredes suaves o de roca (como antes); ríos: ancho de la pared = lo que avanza la roca al bajar
  const rock = !RW && rv.walls === 'rock';
  const depth0 = Math.max(0.1, rv.depth ?? 2);
  const wallW = RW ? (RW.type === 'nat' ? depth0 / Math.tan((RW.ang * Math.PI) / 180) : 0) : rock ? Math.max(0.25, 0.1 * rMed) : Math.max(0.8, 0.6 * rMed);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of adds) { const b = strokeBox(q); x0 = Math.min(x0, b.x0); x1 = Math.max(x1, b.x1); y0 = Math.min(y0, b.y0); y1 = Math.max(y1, b.y1); }
  let c = clamp(rMin / 5, 0.25, 2);
  while (((x1 - x0) / c) * ((y1 - y0) / c) > 3e6) c *= 1.25;
  const m = 2 * c;
  x0 -= m; y0 -= m; x1 += m; y1 += m;
  const nx = Math.ceil((x1 - x0) / c) + 1, ny = Math.ceil((y1 - y0) / c) + 1;
  const F = new Float32Array(nx * ny).fill(-1e3);
  for (const q of rv.strokes) { // en orden: los toques de borrar restan lo pintado antes; los de suavizar redondean lo anterior
    if (q.s) { smoothGrid(F, nx, ny, c, x0, y0, q, m); continue; }
    const b = strokeBox(q);
    const i0 = Math.max(0, Math.floor((b.x0 - m - x0) / c)), i1 = Math.min(nx - 1, Math.ceil((b.x1 + m - x0) / c));
    const j0 = Math.max(0, Math.floor((b.y0 - m - y0) / c)), j1 = Math.min(ny - 1, Math.ceil((b.y1 + m - y0) / c));
    const line = isLine(q);
    for (let j = j0; j <= j1; j++) {
      const yy = y0 + j * c, dy = yy - q.y;
      for (let i = i0; i <= i1; i++) {
        const v = line ? strokeValue(q, x0 + i * c, yy) : q.r - Math.hypot(x0 + i * c - q.x, dy), k = j * nx + i;
        if (q.e) { if (v > -m && -v < F[k]) F[k] = -v; } else if (v > F[k]) F[k] = v;
      }
    }
  }
  // adentro, la distancia real al borde de lo pintado (no la de cada toque): así el interior de un lago pintado con
  // muchos toques no tiene «lomas» entre ellos y los contornos interiores (pie de las paredes, lecho) quedan limpios.
  // Afuera, el máximo por toque ya es la distancia exacta a la unión.
  interiorDistance(F, nx, ny, c);
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
  // ríos (0.78): lisas = el cauce entero hasta el lecho (la pared es una malla aparte); naturales = roca en pendiente
  // (ángulo) con relieve según estilo, rugosidad y tamaño de las rocas. D = profundidad total (en los lagos, hasta su
  // nivel de lecho). La roca nunca baja del lecho ni sube del suelo natural, y su borde de arriba y su pie quedan limpios.
  const riverCarve = RW ? (x, y, D = depth) => {
    if (x < x0 || y < y0 || x > x1 || y > y1) return 0;
    const s = sd(x, y);
    if (RW.type === 'art') return s > 0 ? D : 0;
    if (s <= 0) return 0;
    const tg = Math.tan((RW.ang * Math.PI) / 180), k = RW.rough / 25, sz = RW.size, sc = sz * (2.3 / 0.9);
    const n = noise2(x / sc, y / sc, seed + 3), n2 = noise2(x / sz + 31, y / sz - 17, seed + 5);
    const c0 = Math.min(D, s * tg * (1 + 0.48 * (n - 0.5) * Math.min(2, k)));
    let hb = D - c0; // altura sobre el lecho
    const ramp = (v) => clamp((v - 0.3) / 0.5, 0, 1), fade = Math.min(ramp(s * tg), ramp(hb));
    if (RW.style === 'sharp') {
      const r1 = 1 - Math.abs(2 * n2 - 1), n3 = noise2(x / (sz * 0.45) + 7, y / (sz * 0.45) - 3, seed + 7), r2 = 1 - Math.abs(2 * n3 - 1);
      hb += (r1 * r1 * 1.3 + r2 * r2 * 0.45 - 0.62) * 1.5 * k * fade;
    } else if (RW.style === 'strata') {
      const hL = Math.max(0.35, sz * 1.1), t = hb / hL, fr = t - Math.floor(t);
      hb += (hL * (Math.floor(t) + smooth(0.55, 1, fr)) - hb) * Math.min(1, k) * fade + (n2 - 0.5) * 0.35 * k * fade;
    } else hb += (n2 - 0.5) * 1.2 * k * fade;
    return clamp(D - hb, 0, D);
  } : null;
  const carve = rv.mode === 'carved' && riverCarve ? riverCarve : rv.mode === 'carved'
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
  const field = { sd, carve, inside: (x, y) => sd(x, y) > 0, bounds: { x0, y0, x1, y1 }, cell: c, rMed, wallW, depth, river: rv, grid: { F, nx, ny, x0, y0, c }, rock, walls: RW };
  // contornos (memorizados por nivel) y forma (para saber si es un lago)
  const cont = new Map();
  field.contours = (iso, tol = 0.15, maxSeg = null) => {
    const key = `${iso}|${tol}|${maxSeg}`;
    if (!cont.has(key)) cont.set(key, simplifyLoops(marchingLoops(field.grid, iso), tol, maxSeg ?? clamp(rMed * 1.2, 1, 6)));
    return cont.get(key);
  };
  let shape = null;
  field.shape = () => {
    if (shape) return shape;
    let n = 0, mx = -Infinity;
    for (let k = 0; k < F.length; k++) { if (F[k] > 0) n++; if (F[k] > mx) mx = F[k]; }
    const loops = marchingLoops(field.grid, 0);
    let per = 0;
    for (const L of loops) for (let i = 0; i < L.length; i++) { const a2 = L[i], b2 = L[(i + 1) % L.length]; per += Math.hypot(b2[0] - a2[0], b2[1] - a2[1]); }
    const area = n * c * c, compact = per > 0 ? (4 * Math.PI * area) / (per * per) : 0;
    return (shape = { area, perimeter: per, maxSd: mx, compact, lakeLike: compact > 0.45 || (mx > 1.6 * rMed && compact > 0.2) });
  };
  /** ¿Es un lago? (tipo elegido en la tarjeta o, en automático, una zona rellena y compacta, no alargada) */
  field.isLake = () => { const t = field.river.waterType; return t === 'lake' ? true : t === 'river' ? false : field.shape().lakeLike; };
  cache.set(rv.id + ':' + rv.kind, { key, field });
  return field;
}

/**
 * Malla de agua de un río o cascada. surfZ(x,y) = altura de la superficie (ya socavada); origZ(x,y) = la superficie
 * antes de socavar; skip(x,y,z) = true donde no va agua (la pista a menos de ~1 m sobre el agua). Devuelve {positions, uvs, indices, tris} o null.
 */
export function buildRiverWater(F, surfZ, origZ, skip = null) {
  const rv = F.river, carved = rv.mode === 'carved';
  const s = clamp(F.rMed / 2.5, 0.4, 3);
  const { x0, y0, x1, y1 } = F.bounds;
  const P = [];
  // puntos interiores (grilla con un leve desfase) + contorno de cada toque (el borde queda redondo)
  for (let y = y0 + s / 2, j = 0; y < y1; y += s, j++) for (let x = x0 + s / 2 + (j % 2) * s * 0.5; x < x1; x += s) if (F.sd(x, y) > s * 0.35) P.push(x, y);
  for (const q of strokeCircles(rv.strokes)) {
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
    ok[v] = skip && skip(x, y, z) ? 0 : 1;
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
  // sin agua donde la pista la tapa; bajo un puente (tablero con holgura sobre el agua) el agua sigue
  const skip = zoneAt ? (x, y, z) => zoneAt(x, y, 0.6) < z + 1.2 : null;
  for (const rv of rivers) {
    const F = riverField(rv);
    if (!F) continue;
    let geo = null;
    if (rv.kind === 'fall') {
      if (!HS || !HS.hillSample || (HS.hiddenHills && HS.hiddenHills.includes(rv.hill))) continue; // cascada de un cerro quitado
      geo = buildRiverWater(F, (x, y) => HS.hillSample(rv.hill, x, y), (x, y) => HS.hillOrig(rv.hill, x, y), skip);
    } else {
      // ríos y lagos (0.76): agua con los triángulos justos (plano con cortes, o copia del terreno si va posado) y lecho
      const M = riverMeshes(T, F, skip, T.ctx && T.ctx.riverLevels ? T.ctx.riverLevels.get(rv.id) : null);
      if (M.water) out.push({ id: rv.id, name: names.get(rv.id), kind: rv.kind, ...M.water, lake: M.lake, flat: M.flat, lakeSlope: M.lakeSlope, rect: M.rect, bed: M.bed ? { ...M.bed, name: `${names.get(rv.id)}_lecho` } : null });
      continue;
    }
    if (geo) out.push({ id: rv.id, name: names.get(rv.id), kind: rv.kind, ...geo });
  }
  return out;
}


// ---------------------------------------------------------------------------------------------------------------
// Contornos y planos simples (agua y lecho con los triángulos justos)

/** Contornos cerrados de la grilla de distancia (marching squares) al nivel iso: [[[x, y], …], …]. */
export function marchingLoops(G, iso) {
  const { F, nx, ny, x0, y0, c } = G;
  const val = (i, j) => F[j * nx + i] - iso;
  const pts = new Map(); // arista → punto
  const P = (key, xa, ya, va, xb, yb, vb) => {
    if (!pts.has(key)) { const t = va / (va - vb); pts.set(key, [xa + (xb - xa) * t, ya + (yb - ya) * t]); }
    return key;
  };
  const adj = new Map();
  const link = (a, b) => { (adj.get(a) || adj.set(a, []).get(a)).push(b); (adj.get(b) || adj.set(b, []).get(b)).push(a); };
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const v0 = val(i, j), v1 = val(i + 1, j), v2 = val(i + 1, j + 1), v3 = val(i, j + 1);
    const code = (v0 > 0 ? 1 : 0) | (v1 > 0 ? 2 : 0) | (v2 > 0 ? 4 : 0) | (v3 > 0 ? 8 : 0);
    if (code === 0 || code === 15) continue;
    const X = x0 + i * c, Y = y0 + j * c;
    const eB = () => P(`h${j * nx + i}`, X, Y, v0, X + c, Y, v1); // abajo
    const eR = () => P(`v${j * nx + i + 1}`, X + c, Y, v1, X + c, Y + c, v2); // derecha
    const eT = () => P(`h${(j + 1) * nx + i}`, X, Y + c, v3, X + c, Y + c, v2); // arriba
    const eL = () => P(`v${j * nx + i}`, X, Y, v0, X, Y + c, v3); // izquierda
    const mid = (v0 + v1 + v2 + v3) / 4 > 0;
    switch (code) {
      case 1: case 14: link(eL(), eB()); break;
      case 2: case 13: link(eB(), eR()); break;
      case 3: case 12: link(eL(), eR()); break;
      case 4: case 11: link(eR(), eT()); break;
      case 6: case 9: link(eB(), eT()); break;
      case 7: case 8: link(eL(), eT()); break;
      case 5: if (mid) { link(eL(), eT()); link(eB(), eR()); } else { link(eL(), eB()); link(eR(), eT()); } break;
      case 10: if (mid) { link(eL(), eB()); link(eR(), eT()); } else { link(eL(), eT()); link(eB(), eR()); } break;
      default: break;
    }
  }
  const seen = new Set(), loops = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const L = [];
    let prev = null, cur = start;
    while (cur != null && !seen.has(cur)) {
      seen.add(cur);
      L.push(pts.get(cur));
      const nb = adj.get(cur) || [];
      const nxt = nb.find((q) => q !== prev && !seen.has(q));
      prev = cur; cur = nxt ?? null;
    }
    if (L.length >= 3) loops.push(L);
  }
  return loops;
}

/** Simplifica contornos cerrados (Douglas-Peucker, tolerancia tol m) y parte los lados de más de maxSeg m. */
export function simplifyLoops(loops, tol = 0.15, maxSeg = 4) {
  const dp = (P, a, b, keep) => {
    let bi = -1, bd = tol;
    const [ax, ay] = P[a], [bx, by] = P[b], L = Math.hypot(bx - ax, by - ay) || 1e-9;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((bx - ax) * (ay - P[i][1]) - (ax - P[i][0]) * (by - ay)) / L; if (d > bd) { bd = d; bi = i; } }
    if (bi >= 0) { keep[bi] = 1; dp(P, a, bi, keep); dp(P, bi, b, keep); }
  };
  const out = [];
  for (const L of loops) {
    const n = L.length;
    // los dos puntos más alejados parten el contorno en dos cadenas abiertas
    let far = 0, fd = -1;
    for (let i = 1; i < n; i++) { const d = Math.hypot(L[i][0] - L[0][0], L[i][1] - L[0][1]); if (d > fd) { fd = d; far = i; } }
    if (fd < tol * 2) continue; // demasiado chico
    const P = [...L, L[0]], keep = new Uint8Array(n + 1);
    keep[0] = keep[far] = keep[n] = 1;
    dp(P, 0, far, keep); dp(P, far, n, keep);
    const S = [];
    for (let i = 0; i < n; i++) if (keep[i]) S.push(L[i]);
    const R = [];
    for (let i = 0; i < S.length; i++) {
      const A = S[i], B = S[(i + 1) % S.length], d = Math.hypot(B[0] - A[0], B[1] - A[1]), k = Math.ceil(d / maxSeg);
      for (let q = 0; q < k; q++) R.push([A[0] + ((B[0] - A[0]) * q) / k, A[1] + ((B[1] - A[1]) * q) / k]);
    }
    if (R.length >= 3) out.push(R);
  }
  return out;
}

/**
 * Plano con los triángulos justos: los vértices de los contornos (y, si hace falta, algunos adentro) triangulados;
 * solo quedan los triángulos cuyo centro está dentro (inside). zAt(x, y) = altura; se agregan puntos (cortes) solo donde
 * el plano se aleja de zAt más de tol (plano: ninguno). skip(x, y, z) = true donde no va (la pista lo tapa).
 * Devuelve {positions, uvs, indices, tris} o null.
 */
export function planeMesh(loops, inside, zAt, tol = 0.1, skip = null, uvTile = 4) {
  const P = [];
  for (const L of loops) for (const q of L) P.push(q[0], q[1]);
  if (P.length < 6) return null;
  let tri = null, coords = null, zs = null;
  const build = () => {
    coords = new Float64Array(P);
    const d = new Delaunator(coords);
    const nv = coords.length / 2;
    zs = new Float64Array(nv);
    for (let v = 0; v < nv; v++) zs[v] = zAt(coords[v * 2], coords[v * 2 + 1]);
    tri = [];
    for (let t = 0; t < d.triangles.length; t += 3) {
      const a = d.triangles[t], b = d.triangles[t + 1], c2 = d.triangles[t + 2];
      const mx = (coords[a * 2] + coords[b * 2] + coords[c2 * 2]) / 3, my = (coords[a * 2 + 1] + coords[b * 2 + 1] + coords[c2 * 2 + 1]) / 3;
      if (!inside(mx, my)) continue;
      tri.push(a, b, c2);
    }
  };
  build();
  if (Number.isFinite(tol)) {
    for (let it = 0; it < 8; it++) {
      const add = [];
      for (let t = 0; t < tri.length; t += 3) {
        const [a, b, c2] = [tri[t], tri[t + 1], tri[t + 2]];
        for (const [wa, wb, wc] of [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]]) {
          const x = wa * coords[a * 2] + wb * coords[b * 2] + wc * coords[c2 * 2], y = wa * coords[a * 2 + 1] + wb * coords[b * 2 + 1] + wc * coords[c2 * 2 + 1];
          const z = wa * zs[a] + wb * zs[b] + wc * zs[c2];
          if (Math.abs(zAt(x, y) - z) > tol) {
            const cx = (coords[a * 2] + coords[b * 2] + coords[c2 * 2]) / 3, cy = (coords[a * 2 + 1] + coords[b * 2 + 1] + coords[c2 * 2 + 1]) / 3;
            if (inside(cx, cy)) add.push(cx, cy);
            break;
          }
        }
      }
      if (!add.length || P.length / 2 > 60000) break;
      P.push(...add);
      build();
    }
  }
  const nv = coords.length / 2, idx = [];
  for (let t = 0; t < tri.length; t += 3) {
    const [a, b, c2] = [tri[t], tri[t + 1], tri[t + 2]];
    if (skip) {
      const mx = (coords[a * 2] + coords[b * 2] + coords[c2 * 2]) / 3, my = (coords[a * 2 + 1] + coords[b * 2 + 1] + coords[c2 * 2 + 1]) / 3;
      if (skip(mx, my, (zs[a] + zs[b] + zs[c2]) / 3)) continue;
    }
    idx.push(a, c2, b); // Delaunator entrega sentido horario: se invierte para que la normal mire hacia arriba
  }
  if (!idx.length) return null;
  const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  for (let v = 0; v < nv; v++) { pos[v * 3] = coords[v * 2]; pos[v * 3 + 1] = coords[v * 2 + 1]; pos[v * 3 + 2] = zs[v]; uv[v * 2] = coords[v * 2] / uvTile; uv[v * 2 + 1] = coords[v * 2 + 1] / uvTile; }
  return { positions: pos, uvs: uv, indices: new Uint32Array(idx), tris: idx.length / 3 };
}

/** Rectángulo (2 triángulos) a la altura z. */
function rectMesh(x0, y0, x1, y1, z, uvTile = 4) {
  return { positions: new Float32Array([x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z]), uvs: new Float32Array([x0 / uvTile, y0 / uvTile, x1 / uvTile, y0 / uvTile, x1 / uvTile, y1 / uvTile, x0 / uvTile, y1 / uvTile]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]), tris: 2, rect: true };
}

/**
 * Agua de un río posado que sigue el terreno: los mismos triángulos del terreno bajo el río, levantados lift m y
 * recortados justo en el contorno (así nunca queda bajo el suelo ni flotando en la orilla).
 */
export function waterFromTerrain(T, F, lift = 0.12, skip = null) {
  const P0 = T.positions, I = T.baseIndices || T.indices, { x0, y0, x1, y1 } = F.bounds;
  const map = new Map(), pos = [], idx = [];
  const sdv = new Map();
  const sdOf = (v) => { let d = sdv.get(v); if (d === undefined) { d = F.sd(P0[v * 3], P0[v * 3 + 1]); sdv.set(v, d); } return d; };
  const vert = (key, x, y, z) => { let k = map.get(key); if (k === undefined) { k = pos.length / 3; map.set(key, k); pos.push(x, y, z + lift); } return k; };
  for (let t = 0; t < I.length; t += 3) {
    const vs = [I[t], I[t + 1], I[t + 2]];
    let out = 0;
    for (const v of vs) { const x = P0[v * 3], y = P0[v * 3 + 1]; if (x < x0 || y < y0 || x > x1 || y > y1) out++; }
    if (out === 3) continue;
    const D = vs.map(sdOf);
    if (D.every((d) => d <= 0.15)) {
      // los tres vértices en la orilla (o afuera): decide el centro (un triángulo que cruza el río de orilla a orilla va entero)
      const cx = (P0[vs[0] * 3] + P0[vs[1] * 3] + P0[vs[2] * 3]) / 3, cy = (P0[vs[0] * 3 + 1] + P0[vs[1] * 3 + 1] + P0[vs[2] * 3 + 1]) / 3;
      if (F.sd(cx, cy) <= 0.05 || D.some((d) => d < -0.15)) { if (D.every((d) => d <= 0)) continue; }
      else for (let k = 0; k < 3; k++) D[k] = Math.max(D[k], 1e-6);
    }
    const poly = [];
    for (let k = 0; k < 3; k++) {
      const a = vs[k], b = vs[(k + 1) % 3], da = D[k], db = D[(k + 1) % 3];
      if (da > 0) poly.push(vert(a, P0[a * 3], P0[a * 3 + 1], P0[a * 3 + 2]));
      if ((da > 0) !== (db > 0)) {
        const tt = da / (da - db), key = a < b ? `${a}-${b}` : `${b}-${a}`;
        poly.push(vert(key, P0[a * 3] + (P0[b * 3] - P0[a * 3]) * tt, P0[a * 3 + 1] + (P0[b * 3 + 1] - P0[a * 3 + 1]) * tt, P0[a * 3 + 2] + (P0[b * 3 + 2] - P0[a * 3 + 2]) * tt));
      }
    }
    if (skip) {
      const cx = (P0[vs[0] * 3] + P0[vs[1] * 3] + P0[vs[2] * 3]) / 3, cy = (P0[vs[0] * 3 + 1] + P0[vs[1] * 3 + 1] + P0[vs[2] * 3 + 1]) / 3, cz = (P0[vs[0] * 3 + 2] + P0[vs[1] * 3 + 2] + P0[vs[2] * 3 + 2]) / 3 + lift;
      if (skip(cx, cy, cz)) continue;
    }
    for (let k = 1; k < poly.length - 1; k++) idx.push(poly[0], poly[k], poly[k + 1]);
  }
  if (!idx.length) return null;
  const uv = new Float32Array((pos.length / 3) * 2);
  for (let v = 0; v < pos.length / 3; v++) { uv[v * 2] = pos[v * 3] / 4; uv[v * 2 + 1] = pos[v * 3 + 1] / 4; }
  return { positions: new Float32Array(pos), uvs: uv, indices: new Uint32Array(idx), tris: idx.length / 3 };
}

/** Distancia al borde (hacia adentro) donde el agua de un río socavado toca la pared (perfil = p). */
export function riverWaterIso(F) {
  const p = F.rock ? 0.2 : 0.25;
  if (F.wallW <= 0) return 0;
  let a = 0, b = F.wallW;
  for (let k = 0; k < 30; k++) { const m = (a + b) / 2; if (smooth(0, F.wallW, m) < p) a = m; else b = m; }
  return (a + b) / 2;
}

/**
 * Agua (y lecho) de un río con las reglas de la 0.76. levels = {Lb, Lw} de los lagos socavados (buildTerrain).
 * Devuelve {water, bed, lake, flat, lakeSlope, rect}.
 */
export function riverMeshes(T, F, skip, levels = null) {
  const rv = F.river, carved = rv.mode === 'carved', lake = F.isLake();
  const origAt = T.ctx && T.ctx.origAt ? T.ctx.origAt : (x, y) => T.sample(x, y);
  const res = { water: null, bed: null, lake, flat: false, lakeSlope: false, rect: false };
  const B = F.bounds;
  if (carved) {
    // el agua llega hasta el borde de arriba (queda bajo las paredes, tapada por el terreno): así no hay rendijas entre el
    // agua y la pared aunque la roca sea irregular; el lecho llega bajo el pie de las paredes
    // lisas: el agua y el lecho llegan hasta la cara aunque esté inclinada (si cuelga, pasan bajo ella; si se abre, llegan
    // bajo la tapa y quedan tapados); naturales: el lecho llega bajo el pie de la roca
    const art = F.walls && F.walls.type === 'art', k = art ? F.walls.lean : 0;
    const dk = riverDetail(rv) / 0.08, ct = 0.15 * dk; // «Detalle del contorno» (8 cm = como antes)
    // (lisas: el contorno simplificado puede quedar hasta ct adentro: el agua y el lecho se corren eso más afuera, bajo la pared)
    const wIso = art ? Math.min(0.03, k * (0.3 * F.depth + 0.3) - 0.05) - ct : 0.03;
    const bIso = art ? Math.min(0, k * (F.depth + 0.5)) - 0.3 - ct : Math.max(0, F.wallW - 0.3);
    const flat = lake && levels;
    res.flat = !!flat;
    const zW = flat ? () => levels.Lw : (x, y) => origAt(x, y) - 0.3 * F.depth;
    const zB = flat ? () => levels.Lb - 0.05 : (x, y) => origAt(x, y) - F.depth - 0.05; // un poco bajo el pie (sin parpadeo)
    // rectángulo (lago): solo si fuera del lago el terreno queda más alto que el plano en todo el rectángulo
    const rectOk = (iso, z, margin = 0.05) => {
      const L = F.contours(iso);
      if (!L.length) return null;
      let a = Infinity, b = Infinity, c2 = -Infinity, d = -Infinity;
      for (const Lp of L) for (const [x, y] of Lp) { a = Math.min(a, x); b = Math.min(b, y); c2 = Math.max(c2, x); d = Math.max(d, y); }
      const st = Math.max(0.5, Math.min(c2 - a, d - b) / 40);
      for (let y = b; y <= d + 1e-6; y += st) for (let x = a; x <= c2 + 1e-6; x += st) {
        if (F.sd(x, y) > iso) continue;
        const zt = Math.min(T.sample(x, y), T.ctx && T.ctx.heightAt ? T.ctx.heightAt(x, y, 0.5) : Infinity); // la malla y el relieve
        if (zt < z + margin || (skip && skip(x, y, z))) return null;
      }
      return rectMesh(a, b, c2, d, z);
    };
    if (flat && rv.lakeRect) {
      res.water = rectOk(wIso, levels.Lw);
      if (rv.bed) res.bed = rectOk(bIso, levels.Lb - 0.05, 0.005);
      res.rect = !!res.water;
    }
    if (!res.water) res.water = planeMesh(F.contours(wIso, ct), (x, y) => F.sd(x, y) > wIso, zW, flat ? Infinity : 0.1 * dk, skip);
    if (rv.bed && !res.bed) res.bed = planeMesh(F.contours(bIso, ct), (x, y) => F.sd(x, y) > bIso, zB, flat ? Infinity : 0.1 * dk, null);
    return res;
  }
  // posado: el agua sigue el terreno (copia de sus triángulos) o simplificada (con la tolerancia elegida)
  const tol = Math.max(0.02, (rv.waterTol ?? 5) / 100);
  if (lake) {
    let lo = Infinity, hi = -Infinity;
    const st = Math.max(0.5, F.cell * 2);
    for (let y = B.y0; y <= B.y1; y += st) for (let x = B.x0; x <= B.x1; x += st) if (F.sd(x, y) > 0) { const z = T.sample(x, y); lo = Math.min(lo, z); hi = Math.max(hi, z); }
    if (hi - lo < 0.3) { // casi plano: agua plana
      res.flat = true;
      res.water = planeMesh(F.contours(0), (x, y) => F.sd(x, y) > 0, () => hi + 0.12, Infinity, skip);
      return res;
    }
    res.lakeSlope = true; // en pendiente: sigue el terreno (para un lago plano, socavado)
  }
  res.water = rv.waterMode === 'simple'
    ? planeMesh(F.contours(0), (x, y) => F.sd(x, y) > 0, (x, y) => T.sample(x, y) + 0.12, tol, skip)
    : waterFromTerrain(T, F, 0.12, skip);
  return res;
}


/** Distancia (transformada exacta, Felzenszwalb) desde cada celda de adentro (F > 0) a la de afuera más cercana. */
function interiorDistance(F, nx, ny, c) {
  const INF = 1e20, n = nx * ny, D = new Float64Array(n);
  let any = false;
  for (let k = 0; k < n; k++) { if (F[k] > 0) { D[k] = INF; any = true; } else D[k] = 0; }
  if (!any) return;
  const m = Math.max(nx, ny), f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
  const pass = (len) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let sq;
      for (;;) { const p = v[k]; sq = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p); if (sq <= z[k] && k > 0) k--; else break; }
      if (sq <= z[k]) { v[0] = q; z[0] = -INF; z[1] = INF; k = 0; continue; }
      k++; v[k] = q; z[k] = sq; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; const p = v[k]; d[q] = (q - p) * (q - p) + f[p]; }
  };
  for (let i = 0; i < nx; i++) { for (let j = 0; j < ny; j++) f[j] = D[j * nx + i]; pass(ny); for (let j = 0; j < ny; j++) D[j * nx + i] = d[j]; }
  for (let j = 0; j < ny; j++) { for (let i = 0; i < nx; i++) f[i] = D[j * nx + i]; pass(nx); for (let i = 0; i < nx; i++) D[j * nx + i] = d[i]; }
  // junto al borde quedan los valores exactos de los toques (así un borde recto, como el de una línea, sigue recto)
  for (let k = 0; k < n; k++) if (F[k] > 1.5 * c) { const e = Math.sqrt(D[k]) * c - 0.5 * c; if (e > F[k]) F[k] = e; }
}

/**
 * Pincel de suavizar: dentro de su radio, el campo se promedia con sus vecinos (caja de radio b), con un peso que se
 * apaga hacia el borde del pincel. Redondea las esquinas, quita las ondas entre toques y los salientes finos.
 */
function smoothGrid(F, nx, ny, c, x0, y0, q, m) {
  const R = q.r, st = clamp(Number.isFinite(q.s) ? q.s : 0.5, 0.05, 1);
  const nb = Math.max(1, Math.round(clamp(0.3 * R * st, c, 6) / c));
  const i0 = Math.max(0, Math.floor((q.x - R - x0) / c) - nb), i1 = Math.min(nx - 1, Math.ceil((q.x + R - x0) / c) + nb);
  const j0 = Math.max(0, Math.floor((q.y - R - y0) / c) - nb), j1 = Math.min(ny - 1, Math.ceil((q.y + R - y0) / c) + nb);
  if (i1 <= i0 || j1 <= j0) return;
  const w = i1 - i0 + 1, h = j1 - j0 + 1, lo = -(m + (nb + 2) * c);
  const A = new Float32Array(w * h), B = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) A[j * w + i] = Math.max(lo, F[(j0 + j) * nx + i0 + i]);
  // caja separable (en x y después en y)
  for (let j = 0; j < h; j++) { let acc = 0, cnt = 0; for (let i = -nb; i < w + nb; i++) { const a = i + nb; if (a < w) { acc += A[j * w + a]; cnt++; } const r = i - nb - 1; if (r >= 0 && r < w) { acc -= A[j * w + r]; cnt--; } if (i >= 0 && i < w) B[j * w + i] = acc / cnt; } }
  for (let i = 0; i < w; i++) { let acc = 0, cnt = 0; for (let j = -nb; j < h + nb; j++) { const a = j + nb; if (a < h) { acc += B[a * w + i]; cnt++; } const r = j - nb - 1; if (r >= 0 && r < h) { acc -= B[r * w + i]; cnt--; } if (j >= 0 && j < h) A[j * w + i] = acc / cnt; } }
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x = x0 + (i0 + i) * c, y = y0 + (j0 + j) * c, d = Math.hypot(x - q.x, y - q.y);
    if (d >= R) continue;
    const t = 1 - smooth(0.55 * R, R, d), k = (j0 + j) * nx + i0 + i, v0 = F[k];
    if (v0 < lo && A[j * w + i] <= lo + 1e-6) continue; // lejos de todo: sigue vacío
    F[k] = v0 + (A[j * w + i] - Math.max(lo, v0)) * t;
  }
}
