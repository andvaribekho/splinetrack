// Geometría de escena: malla de pista con UV, terreno y árboles (conos).
// Todo en metros, Z arriba. Devuelve arrays planos listos para three.js o para exportar.
import { SpatialGrid, rng, clamp, smoothstep, nearestOnSamples } from './geometry.js';
import Delaunator from '../vendor/delaunator.js';
import { riverField, subdivFactor } from './rivers.js';
import { hillFieldOne, detectTunnels, tunnelTop, buildTunnelGeometry, applyTunnelOverrides, portalBox, frameAt, edgeExtents, tunnelInnerWidth } from './tunnels.js';

export const DEFAULT_SCENE = {
  // pista
  trackTexDir: 'vertical', // 'vertical' = la textura corre a lo largo de la pista en V; 'horizontal' = en U
  trackTexReps: 100, // repeticiones a lo largo de la ruta principal
  trackTexOpacity: 1, // opacidad de la textura en la vista 3D (0 = solo colores por altura)
  trackMeshMode: 'uniform', // 'uniform' = secciones a distancia pareja; 'optimized' = más secciones en curvas que en rectas
  trackDensity: 100, // 1..100: separación entre secciones de 16 m (1) a la del muestreo (100)
  trackMaxTris: 200000, // tope de triángulos de la pista (manda sobre la densidad)
  trackAdapt: 0.5, // 0..1 (optimizado): 0 = las curvas tienen algo más que las rectas; 1 = las rectas mucho menos
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
  paintFactor: 4, // multiplicador de densidad de las pinceladas antiguas (sin valor propio)
  riverWallTile: 4, // metros por repetición de la textura de las paredes socavadas
  riverBrush: 6, riverMode: 'carved', riverDepth: 2, riverWalls: 'smooth', riverWallSubdiv: 2, // ríos y cascadas nuevos
  paintSubdiv: 1, // subdivisiones extra del pincel de densidad: cada pincelada nueva guarda f = (n + 1)²
  terrainType: 'forest', // 'forest' (bosque) | 'beach' (playa: costa hacia el agua) | 'mountain' (acantilado y pared de roca)
  coastSide: 'right', // playa: 'left' | 'right' | 'both'
  coastLand: 25, // m de tierra (irregular) entre la pista y la playa o el borde del acantilado
  coastBeach: 30, // m de la playa que baja hasta el agua
  coastHeight: 3, // m del agua bajo el punto más bajo de la pista (playa)
  cliffSide: 'left', // montaña: lado del acantilado ('left' | 'right'); al otro lado, pared de roca
  cliffHeight: 30, // m de caída del acantilado hasta el agua
  wallHeight: 25, // m de la pared de roca
  sculptBrush: 30, // radio del pincel de relieve (m)
  sculptStrength: 1.5, // m que sube o baja cada toque en el centro
  sculptDetail: true, // lo esculpido recibe más detalle (como lo pintado con densidad)
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
  tunnelOpen: 'none', // 'none' | 'left' | 'right' (valor general; cada túnel puede tener el suyo)
  caveRocks: true, // cavernas con rocas y estalactitas
  tunnelOverrides: [], // [{k, s, open, pillars}] ajustes propios por túnel
  tunnelPillars: 8,
  tunnelMeshMode: 'uniform', // 'uniform' | 'optimized' (secciones repartidas según la curvatura)
  tunnelMaxTris: 60000, // tope de triángulos por túnel
  tunnelAdapt: 0.5, // optimización (0 = mínimo, 1 = máximo)
  paintBrush: 25, // radio del pincel en m
  // árboles
  trees: false,
  treeSide: 'both', // 'left' | 'right' | 'both'
  treeDensity: 8, // árboles por 100 m y por lado
  treeScale: 1,
  treeOffset: 6, // m desde el borde de la pista
  treeSpread: 14, // m de dispersión extra
  treeSeed: 7,
  treeAssets: [], // ids de modelos de la biblioteca que reemplazan a los conos (vacío = conos)
  grassAssets: [], // ids de modelos que reemplazan a la hierba (vacío = planos cruzados)
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
  // bordes de la pista (se extruyen de la malla de la pista: misma densidad y optimización)
  dirtSide: 'none', // camino de tierra: 'none' | 'left' | 'right' | 'both'
  dirtWidth: 3, // m
  dirtTile: 4, // m de pista por repetición de la textura
  barrierSide: 'none', // barrera de contención: 'none' | 'left' | 'right' | 'both'
  barrierHeight: 0.8, // m
  barrierThick: 0.25, // m
  barrierTile: 4, // m por repetición de la textura (rojo + blanco)
  // bordes de los atajos (independientes de los de la pista)
  altDirtSide: 'none', altDirtWidth: 3, altDirtTile: 4,
  altBarrierSide: 'none', altBarrierHeight: 0.8, altBarrierThick: 0.25, altBarrierTile: 4,
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

export { edgeExtents } from './tunnels.js';

function trackSamples(layout, elev, sp = {}) {
  const out = [];
  const XR = layout.routes.map((r) => edgeExtents(sp, r)); // bordes de cada ruta (cada atajo tiene los suyos)
  layout.routes.forEach((r, k) => {
    const e = elev.routes[k];
    for (let i = 0; i < r.n; i++) {
      const low = e.z[i] - Math.abs(Math.sin(e.roll[i])) * r.w[i] / 2;
      const bridge = !!(r.bridges && r.bridges.some((b) => { const d = r.closed ? (((r.s[i] - b.s0) % r.L) + r.L) % r.L : r.s[i] - b.s0; return d >= 0 && d <= b.s1 - b.s0; }));
      const X = XR[k];
      // sección socavada: como un tramo suspendido (el terreno no se adapta), pero además la pista socava el terreno
      const cut = sp.cutRanges && sp.cutRanges.length ? cutZoneAt(layout, k, r.s[i], sp.cutRanges) : null;
      const susp = !!cut || !!(sp.suspRanges && isCovered(layout, k, r.s[i], sp.suspRanges)); // tramo suspendido: el terreno no se adapta
      const uL = r.w[i] / 2 + X.left, uR = r.w[i] / 2 + X.right; // calzada + camino de tierra + barrera
      out.push({ x: r.x[i], y: r.y[i], z: low, zc: e.z[i], sr: Math.sin(e.roll[i]), tx: r.tx[i], ty: r.ty[i], w: r.w[i], uL, uR, ew: 2 * Math.max(uL, uR), k, i, s: r.s[i], j: out.length, bridge, susp, cut, ds: r.ds });
    }
  });
  return out;
}

/**
 * Tramos de pista cubiertos (dentro de túneles o bajo otra pista en un cruce): [{k, s0, s1}].
 * tunnels: [{k, s0, s1}] (de boca a boca). Bajo un cruce, el largo cubierto depende del ancho de la pista de arriba
 * y del ángulo del cruce.
 */
export function coveredRanges(layout, elev, tunnels = []) {
  const out = [];
  for (const t of tunnels || []) if (t && Number.isFinite(t.s0)) out.push({ k: t.k, s0: t.s0, s1: t.s1 });
  for (const c of (elev && elev.crossings) || []) {
    const upA = c.up === 'a';
    const kl = upA ? c.rb : c.ra, sl = upA ? c.sb : c.sa, ku = upA ? c.ra : c.rb, su = upA ? c.sa : c.sb;
    const rl = layout.routes[kl], ru = layout.routes[ku];
    if (!rl || !ru) continue;
    const il = ((Math.round(sl / rl.ds) % rl.n) + rl.n) % rl.n, iu = ((Math.round(su / ru.ds) % ru.n) + ru.n) % ru.n;
    const sin = Math.abs(rl.tx[il] * ru.ty[iu] - rl.ty[il] * ru.tx[iu]);
    const half = (ru.w[iu] / 2) / Math.max(0.25, sin) + 1;
    out.push({ k: kl, s0: sl - half, s1: sl + half });
  }
  return out;
}
/** Sección socavada que contiene la posición sv de la ruta k (o null). ranges: [{k, s0, s1, walls, wallSubdiv}]. */
export function cutZoneAt(layout, k, sv, ranges) {
  const r = layout.routes[k];
  for (const c of ranges) {
    if (c.k !== k) continue;
    let d = sv - c.s0;
    if (r.closed) d = ((d % r.L) + r.L) % r.L;
    if (d >= -1e-6 && d <= c.s1 - c.s0 + 1e-6) return c;
  }
  return null;
}
/** ¿La posición sv de la ruta k está en un tramo cubierto? */
export function isCovered(layout, k, sv, ranges) {
  if (!ranges || !ranges.length) return false;
  const r = layout.routes[k];
  for (const c of ranges) {
    if (c.k !== k) continue;
    let ss = sv;
    if (r.closed) { while (ss < c.s0) ss += r.L; while (ss > c.s1 + r.L) ss -= r.L; }
    if (ss >= c.s0 && ss <= c.s1) return true;
  }
  return false;
}

/** Tramo de puente (índice en r.bridges) que contiene la posición sv, o -1. */
function bridgeIndexAt(r, sv) {
  if (!r.bridges) return -1;
  for (let bi = 0; bi < r.bridges.length; bi++) {
    const b = r.bridges[bi];
    const d = r.closed ? (((sv - b.s0) % r.L) + r.L) % r.L : sv - b.s0;
    if (d >= -1e-6 && d <= b.s1 - b.s0 + 1e-6) return bi;
  }
  return -1;
}

/**
 * Qué muestras de cada ruta se usan como secciones de la malla (densidad del trazado).
 * Uniforme: a distancia pareja. Optimizado: el mismo presupuesto repartido según cuánto cambia la pista
 * (curvatura en planta, curvatura vertical, peralte y ancho), así las rectas llevan menos secciones que las curvas.
 * Devuelve por ruta la lista creciente de filas q (0..n, n = vuelta completa en rutas cerradas).
 */
export function trackRows(layout, elev, spIn = {}) {
  const sp = { ...DEFAULT_SCENE, ...spIn };
  const cols = sp.skirts ? 5 : 3;
  const d = clamp(sp.trackDensity ?? 100, 1, 100);
  const per = layout.routes.map((r) => {
    const nq = r.closed ? r.n : r.n - 1; // segmentos entre muestras
    const hmax = Math.max(16, r.ds);
    const h = Math.exp(Math.log(hmax) + (Math.log(r.ds) - Math.log(hmax)) * (d - 1) / 99);
    return { r, nq, N: Math.max(2, Math.min(nq, Math.ceil(r.L / h))) };
  });
  // tope de triángulos
  const trisOf = (list) => list.reduce((a, p) => a + p.N * (cols - 1) * 2, 0);
  const cap = Math.max(200, sp.trackMaxTris || Infinity);
  const t0 = trisOf(per);
  if (t0 > cap) for (const p of per) p.N = Math.max(2, Math.floor(p.N * cap / t0));
  const opt = sp.trackMeshMode === 'optimized';
  const ratio = Math.exp(Math.log(1.6) + (Math.log(25) - Math.log(1.6)) * clamp(sp.trackAdapt ?? 0.5, 0, 1));
  return per.map(({ r, nq, N }, k) => {
    const e = elev.routes[k];
    const n = r.n;
    const at = (q) => ((q % n) + n) % n;
    // filas obligatorias: extremos y bordes de los tableros de puente
    const must = new Set([0, nq]);
    // bordes de los tramos cubiertos (túneles, bajo cruces): siempre una sección, para cortar el material justo ahí
    for (const R of [sp.coveredRanges, sp.suspRanges]) { // también los bordes de los tramos suspendidos
      if (!R || !R.some((c) => c.k === k)) continue;
      let prev = isCovered(layout, k, r.s[0], R);
      for (let q = 0; q < nq; q++) {
        const cur = isCovered(layout, k, q + 1 === n ? r.L : r.s[at(q + 1)], R);
        if (cur !== prev) { must.add(q); must.add(q + 1); }
        prev = cur;
      }
    }
    if (r.bridges && r.bridges.length) {
      for (let q = 0; q < nq; q++) {
        const a = bridgeIndexAt(r, r.s[at(q)]), b = bridgeIndexAt(r, q + 1 === n ? 0 : r.s[at(q + 1)]);
        if (a !== b) { must.add(q); must.add(q + 1); }
      }
    }
    let rowsSet;
    if (!opt) {
      rowsSet = new Set(must);
      for (let j = 0; j <= N; j++) rowsSet.add(Math.round((j * nq) / N));
    } else {
      // cuánto cambia la pista en cada segmento (0..1), ensanchado para que la densidad llegue antes de la curva
      const c = new Float64Array(nq);
      const ds = r.ds;
      for (let q = 0; q < nq; q++) {
        const i = at(q), ip = r.closed ? at(q - 1) : Math.max(0, q - 1), inx = r.closed ? at(q + 1) : Math.min(n - 1, q + 1);
        const kPlan = Math.abs(r.k[i]) * 40; // radio 40 m = máximo
        const zpp = e && e.z ? Math.abs(e.z[inx] - 2 * e.z[i] + e.z[ip]) / (ds * ds) * 50 : 0; // curvatura vertical (radio 50 m = máximo)
        const roll = e && e.roll ? Math.abs(e.roll[inx] - e.roll[ip]) / (2 * ds) * 60 : 0; // cambio de peralte
        const dw = Math.abs(r.w[inx] - r.w[ip]) / (2 * ds) * 6; // cambio de ancho
        c[q] = Math.min(1, Math.max(kPlan, zpp, roll, dw));
      }
      const half = Math.max(1, Math.round(6 / ds));
      const cm = new Float64Array(nq);
      for (let q = 0; q < nq; q++) { // máximo móvil
        let m = 0;
        for (let o = -half; o <= half; o++) { const j = r.closed ? ((q + o) % nq + nq) % nq : Math.min(nq - 1, Math.max(0, q + o)); if (c[j] > m) m = c[j]; }
        cm[q] = m;
      }
      const cum = new Float64Array(nq + 1);
      for (let q = 0; q < nq; q++) cum[q + 1] = cum[q] + 1 + (ratio - 1) * cm[q];
      const Wt = cum[nq];
      const pick = (Nt) => {
        const set = new Set(must);
        let q = 0;
        for (let j = 0; j <= Nt; j++) {
          const target = (j * Wt) / Nt;
          while (q < nq && cum[q + 1] < target) q++;
          set.add(target - cum[q] < cum[Math.min(nq, q + 1)] - target ? q : Math.min(nq, q + 1));
        }
        return set;
      };
      // en las curvas el reparto puede pedir más de una sección por muestra: se queda en una (el muestreo es el límite),
      // así la proporción entre rectas y curvas se respeta y el total nunca supera al uniforme
      rowsSet = pick(N);
    }
    return [...rowsSet].filter((q) => q >= 0 && q <= nq).sort((a, b) => a - b);
  });
}

/** Malla de la pista con UV (a lo largo x a lo ancho) y faldones opcionales. */
export function buildTrackMesh(layout, elev, spIn = {}) {
  const sp = { ...DEFAULT_SCENE, ...spIn };
  const Lmain = layout.routes[0].L;
  const repsPerM = Math.max(0.01, sp.trackTexReps) / Lmain;
  const skirt = sp.skirts ? sp.terrainGap + 0.8 : 0;
  const rowLists = trackRows(layout, elev, sp);
  const parts = layout.routes.map((r, k) => {
    const pos = [], uv = [], idx = [];
    const e = elev.routes[k];
    const n = r.n;
    const qList = rowLists[k];
    const rows = qList.length;
    // columnas: [faldón izq], izq, centro, der, [faldón der]
    const cols = sp.skirts ? 5 : 3;
    for (const q of qList) {
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
    const cIdx = []; // tramos cubiertos
    const sIdx = []; // tramos suspendidos
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
      const qa = qList[q], qb = qList[q + 1];
      const sa = r.s[qa % n], sb = qb === n ? r.L : r.s[qb % n];
      const ba = bridgeOf(sa), bb = bridgeOf(sb === r.L && r.closed ? 0 : sb);
      // material del cuadro: tablero de puente > tramo cubierto (túnel o bajo un cruce) > pista (o atajo)
      const tgt = ba >= 0 && ba === bb ? bIdx[ba] : isCovered(layout, k, (sa + sb) / 2, sp.coveredRanges) ? cIdx : isCovered(layout, k, (sa + sb) / 2, sp.suspRanges) ? sIdx : idx;
      for (let c2 = 0; c2 < cols - 1; c2++) {
        const a = q * cols + c2, b = a + 1, d = a + cols, e2 = d + 1;
        tgt.push(a, d, b, b, d, e2);
      }
    }
    return { name: r.name, k, alt: r.kind === 'alt', positions: new Float32Array(pos), uvs: new Float32Array(uv), indices: idx, coveredIdx: cIdx, suspIdx: sIdx, bridgeIdx: bIdx, bridgeNo: (r.bridges || []).map((b, k) => (b.idx ?? k) + 1) };
  });
  // malla combinada (vista previa), en grupos de material: pista, atajos, tramos cubiertos, tableros de puente
  const nPos = parts.reduce((a, p) => a + p.positions.length, 0);
  const positions = new Float32Array(nPos), uvs = new Float32Array((nPos / 3) * 2);
  const G = { main: [], alt: [], covered: [], bridge: [], susp: [] };
  let vo = 0;
  const altRanges = []; // tramo de cada atajo dentro del grupo de atajos: [{k, start, count}] (relativo al grupo)
  for (const p of parts) {
    positions.set(p.positions, vo * 3);
    uvs.set(p.uvs, vo * 2);
    if (p.alt) altRanges.push({ k: p.k, start: G.alt.length, count: p.indices.length });
    for (const i of p.indices) G[p.alt ? 'alt' : 'main'].push(i + vo);
    for (const i of p.coveredIdx) G.covered.push(i + vo);
    for (const i of p.suspIdx) G.susp.push(i + vo);
    for (const bi of p.bridgeIdx) for (const i of bi) G.bridge.push(i + vo);
    vo += p.positions.length / 3;
  }
  const indices = [...G.main, ...G.alt, ...G.covered, ...G.bridge, ...G.susp];
  const groups = [
    { start: 0, count: G.main.length, mat: 0 },
    { start: G.main.length, count: G.alt.length, mat: 1 },
    { start: G.main.length + G.alt.length, count: G.covered.length, mat: 2 },
    { start: G.main.length + G.alt.length + G.covered.length, count: G.bridge.length, mat: 3 },
    { start: G.main.length + G.alt.length + G.covered.length + G.bridge.length, count: G.susp.length, mat: 4 }, // suspendidos
  ];
  const trackCount = G.main.length + G.alt.length + G.covered.length + G.susp.length;
  const altGroups = altRanges.map((a) => ({ k: a.k, start: G.main.length + a.start, count: a.count }));
  // tramos cubiertos como objetos propios (exportación)
  const coveredParts = [];
  for (const p of parts) if (p.coveredIdx.length) coveredParts.push({ name: `${p.name}_cubierto`, alt: p.alt, ...compactMesh(p.positions, p.uvs, p.coveredIdx) });
  // tramos suspendidos como objetos propios (exportación), con su propio material
  const suspParts = [];
  for (const p of parts) if (p.suspIdx.length) suspParts.push({ name: `${p.name}_suspendido`, alt: p.alt, k: p.k, ...compactMesh(p.positions, p.uvs, p.suspIdx) });
  // tableros como objetos propios (exportación), con los vértices compactados
  const bridgeParts = [];
  for (const p of parts) {
    p.bridgeIdx.forEach((bi, k) => { if (bi.length) bridgeParts.push({ name: `puente_${String(p.bridgeNo[k]).padStart(2, '0')}`, bridge: p.bridgeNo[k] - 1, ...compactMesh(p.positions, p.uvs, bi) }); });
  }
  for (const p of parts) {
    if (p.bridgeIdx.some((b) => b.length) || p.coveredIdx.length || p.suspIdx.length) Object.assign(p, compactMesh(p.positions, p.uvs, p.indices));
    delete p.bridgeIdx; delete p.bridgeNo; delete p.coveredIdx; delete p.suspIdx;
  }
  return { positions, uvs, indices, groups, altGroups, trackCount, parts, coveredParts, bridgeParts, suspParts, rows: rowLists.map((q) => q.length) };
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
/** Ruido suave 2D (0..1) con semilla. */
function valueNoise2(seed) {
  const h = (i, j) => { let v = (i * 374761393 + j * 668265263 + seed * 2654435761) | 0; v = Math.imul(v ^ (v >>> 13), 1274126177); return ((v ^ (v >>> 16)) >>> 0) / 4294967296; };
  const sm = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const i = Math.floor(x), j = Math.floor(y), fx = sm(x - i), fy = sm(y - j);
    const a = h(i, j), b = h(i + 1, j), c = h(i, j + 1), d = h(i + 1, j + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

/**
 * Colores por vértice del terreno: pasto, arena (playa y fondo), roca (pendientes fuertes: acantilado y pared).
 * Van como atributo «colors» (RGB 0..1); con textura de terreno se usan como tinte.
 */
function terrainColors(T, TT, waterLevel, nearestSide) {
  const P = T.positions, I = T.indices, nv = P.length / 3;
  const nz = new Float32Array(nv), nl = new Float32Array(nv);
  // normales por vértice (solo la componente vertical importa)
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const l = Math.hypot(cx, cy, cz) || 1;
    for (const v of [a, b, c]) { nz[v] += Math.abs(cz) / l; nl[v] += 1; }
  }
  const C = new Float32Array(nv * 3);
  // colores en sRGB convertidos a lineal (three.js y glTF usan colores de vértice lineales)
  const lin = (c) => c.map((v) => Math.pow(v, 2.2));
  const GRASS = lin([0.31, 0.49, 0.23]), SAND = lin([0.85, 0.76, 0.56]), WET = lin([0.62, 0.55, 0.4]), ROCK = lin([0.5, 0.48, 0.44]);
  for (let v = 0; v < nv; v++) {
    const up = nl[v] ? nz[v] / nl[v] : 1;
    const z = P[v * 3 + 2];
    let col = GRASS;
    if (waterLevel != null) {
      const kind = nearestSide ? nearestSide(P[v * 3], P[v * 3 + 1]).kind : null;
      if (kind === 'coast' && z < waterLevel + 1.8) col = z < waterLevel - 0.3 ? WET : SAND;
      else if (z < waterLevel - 0.3) col = WET;
    }
    if (up < 0.62) col = ROCK; // acantilado, pared de roca o ladera muy empinada
    else if (up < 0.8 && col === GRASS) { const t = (0.8 - up) / 0.18; col = [GRASS[0] + (ROCK[0] - GRASS[0]) * t, GRASS[1] + (ROCK[1] - GRASS[1]) * t, GRASS[2] + (ROCK[2] - GRASS[2]) * t]; }
    C[v * 3] = col[0]; C[v * 3 + 1] = col[1]; C[v * 3 + 2] = col[2];
  }
  T.colors = C;
}

/**
 * Colores del terreno listos para usar: sin textura, los colores tal cual; con textura, un tinte (el pasto queda
 * blanco para no oscurecer la textura; arena y roca la tiñen). En bosque con textura: sin tinte (null).
 */
export function terrainTint(T, hasTex) {
  if (!T || !T.colors) return null;
  if (!hasTex) return T.colors;
  if (T.terrainType === 'forest') return null;
  const C = T.colors, out = new Float32Array(C.length);
  for (let i = 0; i < C.length; i += 3) {
    const grass = Math.abs(C[i] - Math.pow(0.31, 2.2)) < 0.01 && Math.abs(C[i + 1] - Math.pow(0.49, 2.2)) < 0.01;
    for (let k = 0; k < 3; k++) out[i + k] = grass ? 1 : Math.min(1, Math.pow(C[i + k], 1 / 2.2) * 1.2);
  }
  return out;
}

/**
 * Relieve esculpido a mano sobre el terreno: suma de toques [{x, y, r, h}] (m; h > 0 eleva, h < 0 hunde) con caída suave
 * (1 - (d/r)²)². Se rasteriza en una grilla fina y se muestrea con interpolación bilineal. null si no hay toques.
 */
export function sculptField(dabs) {
  if (!dabs || !dabs.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, rmin = Infinity;
  for (const d of dabs) { x0 = Math.min(x0, d.x - d.r); x1 = Math.max(x1, d.x + d.r); y0 = Math.min(y0, d.y - d.r); y1 = Math.max(y1, d.y + d.r); rmin = Math.min(rmin, d.r); }
  let c = clamp(rmin / 5, 0.4, 3);
  while (((x1 - x0) / c) * ((y1 - y0) / c) > 4e6) c *= 1.25; // tope de memoria
  const nx = Math.ceil((x1 - x0) / c) + 2, ny = Math.ceil((y1 - y0) / c) + 2;
  const F = new Float32Array(nx * ny);
  for (const d of dabs) {
    const i0 = Math.max(0, Math.floor((d.x - d.r - x0) / c)), i1 = Math.min(nx - 1, Math.ceil((d.x + d.r - x0) / c));
    const j0 = Math.max(0, Math.floor((d.y - d.r - y0) / c)), j1 = Math.min(ny - 1, Math.ceil((d.y + d.r - y0) / c));
    const r2 = d.r * d.r;
    for (let j = j0; j <= j1; j++) {
      const dy = y0 + j * c - d.y;
      for (let i = i0; i <= i1; i++) {
        const dx = x0 + i * c - d.x, q = (dx * dx + dy * dy) / r2;
        if (q < 1) { const f = 1 - q; F[j * nx + i] += d.h * f * f; }
      }
    }
  }
  const sample = (x, y) => {
    const fx = (x - x0) / c, fy = (y - y0) / c;
    if (fx < 0 || fy < 0 || fx >= nx - 1 || fy >= ny - 1) return 0;
    const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j, k = j * nx + i;
    return (F[k] * (1 - tx) + F[k + 1] * tx) * (1 - ty) + (F[k + nx] * (1 - tx) + F[k + nx + 1] * tx) * ty;
  };
  return { sample, bounds: { x0, y0, x1, y1 }, cell: c };
}

/**
 * paint: zonas de densidad [{x,y,r,e}] (formato anterior) o { density, sculpt } con el relieve esculpido
 * [{x,y,r,h}]; todo en metros. El relieve es parte de la misma malla del terreno.
 */
export function buildTerrain(layout, elev, spIn = {}, paintIn = null) {
  const sp = { ...DEFAULT_SCENE, ...spIn };
  const PI = Array.isArray(paintIn) || !paintIn ? { density: paintIn || null, sculpt: null } : paintIn;
  const sculptDabs = PI.sculpt && PI.sculpt.length ? PI.sculpt : null;
  const SF = sculptField(sculptDabs);
  // ríos sobre el terreno: los socavados hunden la malla (y reciben más detalle en el cauce y sus paredes)
  const RF = (PI.rivers || []).filter((rv) => rv.kind !== 'fall').map(riverField).filter(Boolean);
  // lo esculpido recibe más detalle (como una zona pintada de densidad)
  let paint = PI.density && PI.density.length ? PI.density : null;
  if (sculptDabs && sp.sculptDetail !== false) paint = [...(paint || []), ...sculptDabs.map((d) => ({ x: d.x, y: d.y, r: d.r, e: false }))];
  // secciones socavadas: más detalle en la zanja y sus paredes
  if (sp.cutRanges && sp.cutRanges.length) {
    for (const c of sp.cutRanges) {
      const r = layout.routes[c.k];
      if (!r) continue;
      const f = subdivFactor(c.wallSubdiv ?? 2);
      if (f <= 1) continue;
      const len = c.s1 - c.s0, step = Math.max(3, r.w[0] * 0.5);
      const reach = c.walls === 'nat' ? 12 : 4;
      const add = [];
      for (let sv = c.s0; sv <= c.s1 + 1e-6; sv += step) {
        const ss = r.closed ? ((sv % r.L) + r.L) % r.L : Math.min(r.L, sv);
        const i = Math.min(r.n - 1, Math.round(ss / r.ds)) % r.n;
        add.push({ x: r.x[i], y: r.y[i], r: r.w[i] / 2 + 4 + reach, e: false, f });
      }
      void len;
      paint = [...(paint || []), ...add];
    }
  }
  for (const F of RF) {
    if (F.river.mode !== 'carved') continue;
    const f = subdivFactor(F.river.wallSubdiv ?? 2);
    if (f > 1) paint = [...(paint || []), ...F.river.strokes.filter((q) => !q.e).map((q) => ({ x: q.x, y: q.y, r: q.r + F.wallW * 0.5 + 0.5, e: false, f }))];
  }
  const S = trackSamples(layout, elev, sp);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxW = 0;
  for (const p of S) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); maxW = Math.max(maxW, p.ew); }
  // tipo de terreno: bosque (normal), playa (costa hacia el agua) o montaña (acantilado a un lado, pared de roca al otro)
  const TT = sp.terrainType === 'beach' || sp.terrainType === 'mountain' ? sp.terrainType : 'forest';
  const special = TT !== 'forest';
  let zRoadMin = Infinity;
  for (const p of S) if (!p.bridge && !p.susp) zRoadMin = Math.min(zRoadMin, p.zc);
  if (!isFinite(zRoadMin)) zRoadMin = 0;
  const waterLevel = TT === 'beach' ? zRoadMin - Math.max(0.5, sp.coastHeight) : TT === 'mountain' ? zRoadMin - Math.max(2, sp.cliffHeight) : null;
  const landMax = Math.max(0, sp.coastLand) * 1.45;
  let M = sp.terrainMargin;
  if (special) M = Math.max(M, landMax + (TT === 'beach' ? Math.max(1, sp.coastBeach) * 1.4 : 6) + 50); // hay que ver el agua
  minX -= M; minY -= M; maxX += M; maxY += M;
  if (SF) { minX = Math.min(minX, SF.bounds.x0); minY = Math.min(minY, SF.bounds.y0); maxX = Math.max(maxX, SF.bounds.x1); maxY = Math.max(maxY, SF.bounds.y1); } // el terreno llega hasta lo esculpido
  for (const F of RF) { minX = Math.min(minX, F.bounds.x0 - 5); minY = Math.min(minY, F.bounds.y0 - 5); maxX = Math.max(maxX, F.bounds.x1 + 5); maxY = Math.max(maxY, F.bounds.y1 + 5); } // y hasta los ríos
  const W = maxX - minX, H = maxY - minY;
  const gap = sp.terrainGap;
  const fine = new SpatialGrid(Math.max(maxW, 8));
  for (const p of S) fine.insert(p.x, p.y, p);
  const sub = S.filter((p, j) => j % 4 === 0 && !p.bridge && !p.susp); // bajo un puente o un tramo suspendido el terreno no sube hasta la calzada
  const falloff = Math.max(5, sp.terrainFalloff);
  // costado de cada punto respecto de la pista (para playa / montaña): muestra más cercana y distancia lateral con signo
  const noise = valueNoise2((sp.treeSeed | 0) + 101);
  const sideKind = (sd) => {
    const has = (v, side) => v === 'both' || v === side;
    if (TT === 'beach') return has(sp.coastSide, sd > 0 ? 'left' : 'right') ? 'coast' : 'forest';
    if (TT === 'mountain') return (sp.cliffSide === 'right' ? -1 : 1) === sd ? 'cliff' : 'wall';
    return 'forest';
  };
  let nearestSide = null, nearSegments = null, extraPaint = [];
  if (special && sub.length) {
    const sideG = new SpatialGrid(25);
    for (const p of sub) sideG.insert(p.x, p.y, p);
    const Rq = landMax + (TT === 'beach' ? sp.coastBeach * 1.4 : 10) + 30;
    // respaldo lejos de la pista: muestra más cercana precalculada en una grilla gruesa
    const rg = 64, rx = W / rg, ry = H / rg, near = new Int32Array((rg + 1) * (rg + 1));
    for (let j = 0; j <= rg; j++) for (let i = 0; i <= rg; i++) {
      const x = minX + i * rx, y = minY + j * ry;
      let b = 0, bd = Infinity;
      for (let k = 0; k < sub.length; k++) { const d = (sub[k].x - x) ** 2 + (sub[k].y - y) ** 2; if (d < bd) { bd = d; b = k; } }
      near[j * (rg + 1) + i] = b;
    }
    const describe = (p, x, y) => {
      const u = (x - p.x) * -p.ty + (y - p.y) * p.tx;
      const sd = u >= 0 ? 1 : -1;
      return { p, sd, d: Math.abs(u) - (sd > 0 ? p.uL : p.uR), kind: sideKind(sd) };
    };
    /** Tramos de pista cercanos (hasta 3, de lugares distintos de la pista), el más cercano primero. */
    nearSegments = (x, y) => {
      const cand = [];
      sideG.query(x, y, Rq, (p) => cand.push([(p.x - x) ** 2 + (p.y - y) ** 2, p]));
      if (!cand.length) { const i = clamp(Math.round((x - minX) / rx), 0, rg), j = clamp(Math.round((y - minY) / ry), 0, rg); return [describe(sub[near[j * (rg + 1) + i]], x, y)]; }
      cand.sort((a, b) => a[0] - b[0]);
      const out = [];
      for (const [, p] of cand) {
        const r = layout.routes[p.k];
        if (out.some((o) => o.p.k === p.k && Math.min(Math.abs(o.p.s - p.s), r.closed ? r.L - Math.abs(o.p.s - p.s) : Infinity) < 40)) continue;
        out.push(describe(p, x, y));
        if (out.length === 3) break;
      }
      return out;
    };
    nearestSide = (x, y) => nearSegments(x, y)[0];
    // más detalle a lo largo del borde del acantilado y del pie de la pared de roca (corte más limpio)
    if (TT === 'mountain') {
      for (let k = 0; k < sub.length; k += 2) {
        const p = sub[k];
        for (const sd of [1, -1]) {
          const kind = sideKind(sd), ext = sd > 0 ? p.uL : p.uR;
          let off;
          if (kind === 'cliff') { const xg = p.x - p.ty * sd * (ext + sp.coastLand), yg = p.y + p.tx * sd * (ext + sp.coastLand); off = ext + sp.coastLand * (0.55 + 0.9 * noise(xg / 90, yg / 90)) + 1; }
          else off = ext + 6;
          extraPaint.push({ x: p.x - p.ty * sd * off, y: p.y + p.tx * sd * off, r: 9, e: false });
        }
      }
    }
  }
  /** Altura según el tipo de terreno respecto de un tramo (null = bosque, sin cambios). */
  const profileFor = (ns, x, y) => {
    if (ns.kind === 'forest') return null;
    const d = ns.d, zl = ns.p.zc - gap;
    const n1 = noise(x / 90, y / 90), n2 = noise(x / 45 + 7.3, y / 45 - 3.1), n3 = noise(x / 14 - 2, y / 14 + 5);
    const wl = sp.coastLand * (0.55 + 0.9 * n1); // costa irregular
    if (ns.kind === 'coast') {
      const bl = Math.max(1, sp.coastBeach) * (0.6 + 0.8 * n2);
      if (d < wl) return zl + 0.8 * (n3 - 0.5) * smoothstep(0, 10, d);
      const floor = waterLevel - 2;
      if (d < wl + bl) { const t = (d - wl) / bl; return zl + (floor - zl) * (t * t * (3 - 2 * t)); }
      return floor - Math.min(6, (d - wl - bl) * 0.06) - 0.6 * n3;
    }
    if (ns.kind === 'cliff') {
      if (d < wl) return zl + 0.6 * (n3 - 0.5) * smoothstep(0, 10, d);
      const floor = waterLevel - 3;
      if (d < wl + 2.5) return zl + (floor - zl) * ((d - wl) / 2.5); // corte abrupto
      return floor - 1.5 * n3;
    }
    // pared de roca
    const gapW = 3, run = 7, wh = Math.max(1, sp.wallHeight) * (0.8 + 0.4 * n1);
    if (d < gapW) return zl;
    if (d < gapW + run) { const t = (d - gapW) / run; return zl + wh * t * t * (3 - 2 * t) + 1.5 * (n3 - 0.5) * t; }
    return zl + wh + Math.min(wh * 0.4, (d - gapW - run) * 0.3 * n2) + 3 * (n3 - 0.5);
  };
  /**
   * Con varios tramos cerca (curvas cerradas, atajos) cada uno propone su altura y gana la más baja: así la pared de
   * un tramo no tapa a otro y el agua de un lado no queda cortada por un escalón. forestZ = altura normal (bosque).
   */
  const sideProfile = (x, y, forestZ) => {
    if (!nearSegments) return null;
    const segs = nearSegments(x, y);
    let z = null, any = false;
    for (const ns of segs) {
      const pz = profileFor(ns, x, y);
      if (pz != null) any = true;
      const v = pz ?? forestZ;
      z = z == null ? v : Math.min(z, v);
    }
    return any ? z : null;
  };
  const coarseG = new SpatialGrid(Math.max(falloff / 2, 10));
  for (const p of sub) coarseG.insert(p.x, p.y, p);
  // relieve general: IDW en una grilla gruesa
  const gx = 40, gy = 40;
  const base = new Float64Array((gx + 1) * (gy + 1));
  const idwPts = S.filter((p, j) => j % 12 === 0 && !p.bridge && !p.susp);
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
  const zoneAt = (x, y, rho, skip = null, only = 0) => { // only: 0 todas, 1 sin los tramos suspendidos, 2 solo ellos
    let zone = Infinity;
    fine.query(x, y, maxW / 2 + rho, (p) => {
      if (skip && skip[p.j] >= 0) return;
      if ((only === 1 && p.susp) || (only === 2 && !p.susp)) return;
      const dx = x - p.x, dy = y - p.y;
      const a = Math.abs(dx * p.tx + dy * p.ty);
      if (a > rho) return;
      const uv = dx * -p.ty + dy * p.tx;
      const h = Math.sqrt(rho * rho - a * a);
      const u0 = Math.max(-p.uR, uv - h), u1 = Math.min(p.uL, uv + h); // calzada + bordes (tierra, barrera)
      if (u0 > u1) return;
      const zmin = p.zc + Math.min(p.sr * u0, p.sr * u1);
      if (zmin < zone) zone = zmin;
    });
    return zone;
  };
  /** Altura de un vértice; rho = distancia máxima a la que un triángulo que lo usa puede cubrir la pista. */
  const anySusp = S.some((p) => p.susp);
  // bajo un tramo suspendido el terreno sigue su relieve natural: solo se baja si llegaría a tocar la pista
  // secciones socavadas: la pista baja bajo el terreno y abre una zanja con paredes artificiales (casi verticales,
  // lisas) o naturales (roca inclinada e irregular). cutInfo = altura de la zanja en (x,y) y el tipo de pared
  const anyCut = S.some((p) => p.cut);
  const cutNoise = valueNoise2((sp.treeSeed | 0) + 707);
  const cutInfo = (x, y) => {
    let best = Infinity, kind = null;
    fine.query(x, y, maxW / 2 + 26, (p) => {
      if (!p.cut) return;
      const dx = x - p.x, dy = y - p.y;
      const a = Math.abs(dx * p.tx + dy * p.ty);
      const u = dx * -p.ty + dy * p.tx;
      const ext = (u >= 0 ? p.uL : p.uR) + 0.4; // calzada + camino de tierra + barrera
      const nat = p.cut.walls === 'nat';
      const d = Math.hypot(Math.max(0, Math.abs(u) - ext), Math.max(0, a - p.ds * 0.6));
      const floor = p.z - gap;
      let z;
      if (!nat) z = floor + d * 14; // muro artificial: casi vertical
      else {
        const n = cutNoise(x / 2.3, y / 2.3), n2 = cutNoise(x / 0.9 + 31, y / 0.9 - 17);
        z = floor + d * (2.2 + 1.4 * n) + (d > 0.3 ? (n2 - 0.5) * 1.2 : 0); // roca: pendiente irregular
      }
      if (z < best) { best = z; kind = nat ? 'cutNat' : 'cutArt'; }
    });
    return { z: best, kind };
  };
  const heightAt0 = anySusp ? (x, y, rho) => {
    const zone = zoneAt(x, y, rho, null, 1);
    if (zone < Infinity) return zone - gap;
    let z = heightNat(x, y, rho);
    const zs = zoneAt(x, y, rho, null, 2);
    if (zs < Infinity) z = Math.min(z, zs - gap);
    if (anyCut) { const ci = cutInfo(x, y); if (ci.z < z) z = ci.z; }
    return z;
  } : (x, y, rho) => {
    const zone = zoneAt(x, y, rho);
    if (zone < Infinity) return zone - gap;
    return heightNat(x, y, rho);
  };
  function heightNat(x, y, rho) {
    let bd = Infinity, bz = 0, bw = 0;
    coarseG.query(x, y, falloff + maxW, (p) => {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; bz = p.z; bw = p.ew; }
    });
    const b = baseAt(x, y);
    // relieve esculpido: se desvanece en los primeros metros junto a la pista (la pista nunca queda enterrada)
    const sc = SF ? SF.sample(x, y) : 0;
    const t = bd === Infinity ? 1 : smoothstep(0, falloff, bd - bw / 2 - rho);
    const forestZ = bd === Infinity ? b : (bz - gap) * (1 - t) + b * t;
    const sideZ = sideProfile(x, y, forestZ); // playa / acantilado / pared de roca
    if (bd === Infinity) return (sideZ ?? b) + sc;
    const fade = SF ? smoothstep(0, 4, bd - bw / 2 - rho) : 0;
    return (sideZ ?? forestZ) + sc * fade;
  };
  // socavado de los ríos: se desvanece junto a la pista (nunca la deja colgando)
  const riverCarveRaw = (x, y) => {
    let c = 0;
    for (const F of RF) { const B = F.bounds; if (x < B.x0 || y < B.y0 || x > B.x1 || y > B.y1) continue; const v = F.carve(x, y); if (v > c) c = v; }
    return c;
  };
  const riverCarveAt = (x, y, rho = 0.5) => {
    const c = RF.length ? riverCarveRaw(x, y) : 0;
    if (c <= 0) return 0;
    let bd = Infinity, bw = 0;
    coarseG.query(x, y, falloff + maxW, (p) => { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; bw = p.ew; } });
    return bd === Infinity ? c : c * smoothstep(0, 4, bd - bw / 2 - rho);
  };
  const heightAt = RF.length ? (x, y, rho) => heightAt0(x, y, rho) - riverCarveAt(x, y, rho) : heightAt0;
  const origAt = (x, y) => heightAt0(x, y, 0.5);
  const inRiver = RF.length ? (x, y) => RF.some((F) => { const B = F.bounds; return x >= B.x0 && y >= B.y0 && x <= B.x1 && y <= B.y1 && F.sd(x, y) > -0.5; }) : null;
  if (extraPaint.length) paint = [...(paint || []), ...extraPaint];
  const painted = paint && paint.length && paint.some((st) => !st.e && (st.f ?? sp.paintFactor) > 1);
  const out = painted
    ? adaptiveMesh(minX, minY, W, H, sp, paint, heightAt)
    : gridMesh(minX, minY, W, H, sp, heightAt);
  out.bounds = { minX, minY, maxX, maxY };
  out.tunnels = [];
  out.sculpted = !!SF;
  out.terrainType = TT;
  out.waterLevel = waterLevel;
  terrainColors(out, TT, waterLevel, nearestSide);
  out.rivers = RF.length;
  // cauces socavados (ríos) y paredes de las secciones socavadas: sus triángulos van aparte, con su propio material
  const carvedRivers = RF.some((F) => F.river.mode === 'carved');
  if (carvedRivers || anyCut) {
    const cutCarve = (x, y) => { const ci = cutInfo(x, y); if (!ci.kind) return null; const zn = heightNat(x, y, 0.5); return zn - ci.z > 0.3 ? ci.kind : null; };
    const classify = (x, y) => (carvedRivers && riverCarveAt(x, y) > 0.05 ? 'river' : anyCut ? cutCarve(x, y) : null);
    splitParts(out, classify, { river: Math.max(0.5, sp.riverWallTile ?? 4), cutArt: Math.max(0.5, sp.cutWallTile ?? 4), cutNat: Math.max(0.5, sp.cutWallTile ?? 4) });
    out.wall = out.parts.river || null; // compatibilidad: cauces de los ríos
    out.cutWalls = { art: out.parts.cutArt || null, nat: out.parts.cutNat || null };
  }
  const groundAt = (x, y) => heightNat(x, y, 0.5); // nivel natural del suelo (sin las zanjas de las secciones socavadas)
  Object.defineProperty(out, 'ctx', { value: { S, fine, maxW, gap, zoneAt, heightAt, sp, origAt, riverCarveAt, inRiver, groundAt }, enumerable: false });
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
  // altura total de los cerros sobre el terreno: se unen tomando el máximo, salvo los cerros «encima» (onTop), que se
  // apoyan sobre los anteriores y suman su altura
  const combined = { sample: (x, y) => { let m = 0; for (const { f, h } of fields) { if (x < f.minX || y < f.minY || x > f.maxX || y > f.maxY) continue; const v = f.sample(x, y); if (v <= 0) continue; m = Math.max(m, (h.onTop ? m : 0) + v); } return m; } };
  const tun = detectTunnels(layout, elev, combined, sp);
  applyTunnelOverrides(layout, tun.runs, sp);
  res.tunnels = tun.runs;
  const runById = new Map(tun.runs.map((t) => [t.id, t]));
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
      const tsp = t.sp || sp, nat = tsp.tunnelType === 'natural'; // tipo propio del túnel
      const top = tunnelTop(tsp, t, ss);
      const vault = nat ? top / sp.tunnelHeight : 1;
      const half = tunnelInnerWidth(sp, p.w, layout.routes[p.k]) / 2 * vault + (nat ? 0.6 + 3 * sp.caveSize : 0) + 1;
      const q = { ...p, tun: id, top, half, open: t.openSide || 0 };
      tunReach = Math.max(tunReach, half + box.thick + 2 + (t.openSide ? 2 * sp.tunnelWidth : 0));
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
    let c0 = cells[hi];
    const x0 = f.minX, y0 = f.minY;
    // cascadas socavadas de este cerro (hunden su superficie) y zonas con más subdivisión (pintadas o paredes de cascada)
    const FF = (h.falls || []).map(riverField).filter(Boolean);
    const fallCarve = (x, y) => { let cv = 0; for (const F of FF) { const B = F.bounds; if (x < B.x0 || y < B.y0 || x > B.x1 || y > B.y1) continue; const v = F.carve(x, y); if (v > cv) cv = v; } return cv; };
    const subPaint = [...(h.subdiv || [])];
    for (const F of FF) {
      if (F.river.mode !== 'carved') continue;
      const fv = subdivFactor(F.river.wallSubdiv ?? 2);
      if (fv > 1) for (const q of F.river.strokes) if (!q.e) subPaint.push({ x: q.x, y: q.y, r: q.r + F.wallW * 0.5 + 0.5, e: false, f: fv });
    }
    // máscara de subdivisión (multiplicador por celda) sobre la caja del cerro
    let fmask = null, fmc = 0, fmw = 0, fmh = 0;
    const areas = new Map();
    if (subPaint.some((q) => !q.e && (q.f ?? 4) > 1)) {
      fmc = Math.max(0.3, Math.min(c0 / 2, Math.max(f.maxX - f.minX, f.maxY - f.minY) / 400));
      fmw = Math.ceil((f.maxX - f.minX) / fmc) + 1; fmh = Math.ceil((f.maxY - f.minY) / fmc) + 1;
      fmask = new Float32Array(fmw * fmh);
      for (const st of subPaint) {
        const fv = st.e ? 0 : Math.max(1, Math.round((st.f ?? 4) * 4) / 4);
        const i0 = Math.max(0, Math.floor((st.x - st.r - x0) / fmc)), i1 = Math.min(fmw - 1, Math.ceil((st.x + st.r - x0) / fmc));
        const j0 = Math.max(0, Math.floor((st.y - st.r - y0) / fmc)), j1 = Math.min(fmh - 1, Math.ceil((st.y + st.r - y0) / fmc));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (Math.hypot(x0 + i * fmc - st.x, y0 + j * fmc - st.y) <= st.r) fmask[j * fmw + i] = fv <= 1 ? 0 : fv;
      }
      for (let j = 0; j < fmh; j++) for (let i = 0; i < fmw; i++) {
        const fv = fmask[j * fmw + i];
        if (fv > 0 && f.sample(x0 + i * fmc, y0 + j * fmc) > 0) areas.set(fv, (areas.get(fv) || 0) + fmc * fmc);
      }
      if (!areas.size) fmask = null;
      else { // el tope de triángulos del cerro incluye lo subdividido
        let extra = 0;
        for (const [fv, ar] of areas) extra += ar * (fv - 1);
        c0 = Math.max(c0, Math.sqrt((2 * (f.area + extra)) / Math.max(50, h.maxTris ?? 20000)));
      }
    }
    const factorAt = (x, y) => { if (!fmask) return 0; const i = Math.round((x - x0) / fmc), j = Math.round((y - y0) / fmc); return i >= 0 && j >= 0 && i < fmw && j < fmh ? fmask[j * fmw + i] : 0; };
    const nx = Math.max(2, Math.ceil((f.maxX - f.minX) / c0)), ny = Math.max(2, Math.ceil((f.maxY - f.minY) / c0));
    const cx = (f.maxX - f.minX) / nx, cy = (f.maxY - f.minY) / ny;
    const baseAtH = (x, y) => { let tz = T.sample(x, y); if (h.onTop) for (const S2 of samplers) { const zs = S2.sample(x, y); if (zs > tz) tz = zs; } return tz; };
    // cima plana: con «parte superior plana» al máximo la cima es una meseta horizontal aunque el cerro se apoye en
    // un terreno o en otro cerro inclinado (se nivela a la base más alta bajo la cima)
    const flat = clamp(h.flat ?? 0, 0, 1), Hh = Math.max(0.01, h.height);
    let baseRef = null;
    if (flat > 0) {
      let best = -Infinity, best2 = -Infinity, hmax = 0;
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
        const x = x0 + i * cx, y = y0 + j * cy, hh = f.sample(x, y);
        if (hh <= 0) continue;
        hmax = Math.max(hmax, hh);
        const tz = baseAtH(x, y);
        if (hh >= 0.97 * Hh && tz > best) best = tz;
        if (hh >= 0.8 * Hh && tz > best2) best2 = tz;
      }
      baseRef = Number.isFinite(best) ? best : Number.isFinite(best2) ? best2 : null;
    }
    const surfOrig = (x, y, tz, hh) => {
      let z = tz + hh - sink;
      if (baseRef != null && hh > 0) z = Math.max(tz - sink, z + flat * (baseRef - tz) * clamp(hh / Hh, 0, 1));
      return z;
    };
    // puntos de la malla: grilla regular o, con zonas subdivididas, grilla gruesa + una fina por nivel (Delaunay)
    const PX = [], PY = [], PR = [];
    if (!fmask) {
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) { PX.push(x0 + i * cx); PY.push(y0 + j * cy); }
    } else {
      const rc = Math.hypot(cx, cy) * 1.05 + 0.5;
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
        const x = x0 + i * cx, y = y0 + j * cy;
        if (i === 0 || j === 0 || i === nx || j === ny || !factorAt(x, y)) { PX.push(x); PY.push(y); PR.push(rc); }
      }
      for (const fv of areas.keys()) {
        const cl = c0 / Math.sqrt(fv);
        const fx = Math.max(2, Math.ceil((f.maxX - f.minX) / cl)), fy = Math.max(2, Math.ceil((f.maxY - f.minY) / cl));
        const fcx = (f.maxX - f.minX) / fx, fcy = (f.maxY - f.minY) / fy, rf = Math.hypot(fcx, fcy) * 1.05 + 0.5;
        for (let j = 1; j < fy; j++) for (let i = 1; i < fx; i++) {
          const x = x0 + i * fcx + (j % 2) * fcx * 0.013, y = y0 + j * fcy + (i % 2) * fcy * 0.011;
          if (factorAt(x, y) === fv) { PX.push(x); PY.push(y); PR.push(rf); }
        }
      }
    }
    const rhoGrid = Math.hypot(cx, cy) * 1.05 + 0.5;
    const nv = PX.length;
    const X = new Float64Array(nv), Y = new Float64Array(nv), Z = new Float64Array(nv), TZ = new Float64Array(nv);
    for (let v = 0; v < nv; v++) {
      const x = PX[v], y = PY[v];
      const rho = fmask ? PR[v] : rhoGrid;
      // base: el terreno o, si el cerro va encima de otros, la superficie de los cerros anteriores
      const tz = baseAtH(x, y);
      const hh = f.sample(x, y);
      let z = surfOrig(x, y, tz, hh);
      if (FF.length && hh > 0.01) z -= fallCarve(x, y); // cauce de la cascada
      const zone = zoneAt(x, y, rho, tunId);
      if (zone < Infinity) z = Math.min(z, zone - gap); // la pista corta el cerro (trinchera)
      if (tunReach > 0 && hh > 0.01) {
        const nt = nearTunnel(x, y, tunReach);
        if (nt) {
          const { p, u } = nt;
          const onOpen = p.open && Math.sign(u) === p.open && Math.abs(u) > p.w / 2;
          if (!onOpen && hh <= 0.5) { /* borde del cerro: sin cambios */ } else if (onOpen) {
            // lado abierto: el cerro se despeja por completo (bajo el terreno, así no queda nada en el piso entre los pilares)
            if (Math.abs(u) < p.half + 2 * sp.tunnelWidth) z = Math.min(z, p.z - gap - 0.5, tz - 0.3);
          } else if (Math.abs(u) < p.half + 1 + box.thick) {
            z = Math.max(z, p.zc + p.top + cover); // el cerro cubre el techo del túnel
          }
        }
      }
      if (zone < Infinity) z = Math.min(z, zone - gap); // la pista fuera de túneles nunca queda bajo un cerro
      X[v] = x; Y[v] = y; Z[v] = z; TZ[v] = tz;
    }
    // triángulos: los de la grilla o los de la triangulación de Delaunay (sentido antihorario, normal hacia +Z)
    let TRI;
    if (!fmask) {
      TRI = new Uint32Array(nx * ny * 6);
      let q = 0;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i, b = a + 1, cI = a + nx + 1, d = cI + 1;
        TRI[q++] = a; TRI[q++] = b; TRI[q++] = d; TRI[q++] = a; TRI[q++] = d; TRI[q++] = cI;
      }
    } else {
      const co = new Float64Array(nv * 2);
      for (let v = 0; v < nv; v++) { co[v * 2] = X[v]; co[v * 2 + 1] = Y[v]; }
      const dt = new Delaunator(co).triangles;
      TRI = new Uint32Array(dt.length);
      for (let t = 0; t < dt.length; t += 3) { TRI[t] = dt[t]; TRI[t + 1] = dt[t + 2]; TRI[t + 2] = dt[t + 1]; }
    }
    const pos = [], uv = [], idx = [];
    for (let v = 0; v < nv; v++) {
      pos.push(X[v], Y[v], Z[v]);
      uv.push(((X[v] - bx0) / (bx1 - bx0)) * sp.terrainTexRepX, ((Y[v] - by0) / (by1 - by0)) * sp.terrainTexRepY);
    }
    const keptTri = new Uint8Array(TRI.length / 3);
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
    for (let t = 0; t < TRI.length; t += 3) tri(TRI[t], TRI[t + 1], TRI[t + 2], t / 3);
    let sample;
    if (!fmask) {
      sample = (x, y) => {
        const fx = (x - x0) / cx, fy = (y - y0) / cy;
        if (fx < 0 || fy < 0 || fx >= nx || fy >= ny) return -Infinity;
        const i = Math.min(nx - 1, Math.floor(fx)), j = Math.min(ny - 1, Math.floor(fy)), tx = fx - i, ty = fy - j;
        const a = j * (nx + 1) + i, b = a + 1, cI = a + nx + 1, d = cI + 1;
        const ti = (j * nx + i) * 2;
        if (tx >= ty) return keptTri[ti] ? Z[a] + (Z[b] - Z[a]) * tx + (Z[d] - Z[b]) * ty : -Infinity;
        return keptTri[ti + 1] ? Z[a] + (Z[d] - Z[cI]) * tx + (Z[cI] - Z[a]) * ty : -Infinity;
      };
    } else {
      // triangulación libre: grilla de aceleración sobre los triángulos conservados
      const gc = Math.max(c0, 2), acc = new Map();
      for (let t = 0; t < TRI.length; t += 3) {
        if (!keptTri[t / 3]) continue;
        const a = TRI[t], b = TRI[t + 1], cI = TRI[t + 2];
        const i0 = Math.floor((Math.min(X[a], X[b], X[cI]) - x0) / gc), i1 = Math.floor((Math.max(X[a], X[b], X[cI]) - x0) / gc);
        const j0 = Math.floor((Math.min(Y[a], Y[b], Y[cI]) - y0) / gc), j1 = Math.floor((Math.max(Y[a], Y[b], Y[cI]) - y0) / gc);
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = j * 100003 + i; let l = acc.get(k); if (!l) acc.set(k, (l = [])); l.push(t); }
      }
      sample = (x, y) => {
        const l = acc.get(Math.floor((y - y0) / gc) * 100003 + Math.floor((x - x0) / gc));
        if (!l) return -Infinity;
        for (const t of l) {
          const a = TRI[t], b = TRI[t + 1], cI = TRI[t + 2];
          const den = (Y[b] - Y[cI]) * (X[a] - X[cI]) + (X[cI] - X[b]) * (Y[a] - Y[cI]);
          if (Math.abs(den) < 1e-12) continue;
          const l1 = ((Y[b] - Y[cI]) * (x - X[cI]) + (X[cI] - X[b]) * (y - Y[cI])) / den;
          const l2 = ((Y[cI] - Y[a]) * (x - X[cI]) + (X[a] - X[cI]) * (y - Y[cI])) / den;
          const l3 = 1 - l1 - l2;
          if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) return l1 * Z[a] + l2 * Z[b] + l3 * Z[cI];
        }
        return -Infinity;
      };
    }
    const orig = (x, y) => surfOrig(x, y, baseAtH(x, y), f.sample(x, y));
    samplers.push({ f, sample, h, fallCarve, orig, FF });
    const name = h.name || `cerro_${String(h.id).padStart(2, '0')}`;
    const hillOut = { id: h.id, name, positions: new Float32Array(pos), uvs: new Float32Array(uv), indices: new Uint32Array(idx), tris: idx.length / 3, cell: Math.max(cx, cy), subdivided: !!fmask };
    if (FF.some((F) => F.river.mode === 'carved')) splitWalls(hillOut, fallCarve, Math.max(0.5, sp.riverWallTile ?? 4)); // cauces de las cascadas: material propio
    res.hills.push(hillOut);
    res.tris += idx.length / 3;
  });
  // superficie de un cerro concreto (con y sin el cauce de sus cascadas)
  const byId = (id) => samplers.find((q) => q.h.id === id);
  res.hillSample = (id, x, y) => { const q = byId(id); return q ? q.sample(x, y) : -Infinity; };
  res.hillOrig = (id, x, y) => { const q = byId(id); return q ? q.orig(x, y) : -Infinity; };
  res.fallCarve = (id, x, y) => { const q = byId(id); return q ? q.fallCarve(x, y) : 0; };
  if (samplers.some((q) => q.FF.length)) res.inFall = (x, y) => samplers.some((q) => q.FF.some((F) => { const B = F.bounds; return x >= B.x0 && y >= B.y0 && x <= B.x1 && y <= B.y1 && F.sd(x, y) > -0.5; }));
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

/**
 * Separa los triángulos socavados por un río o una cascada (lecho y paredes, donde carveAt > 5 cm) del resto de la
 * malla: mesh.baseIndices (el resto) y mesh.wall = malla compacta propia con UV que no se estiran en las paredes
 * verticales. mesh.indices queda completo (muestreo de alturas).
 */
/**
 * Separa triángulos de la malla por tipo: classify(x, y) → clave (o null = se queda en la malla base). Deja
 * mesh.baseIndices y mesh.parts = {clave: malla compacta con UV oblicuas (ver splitWalls)}. tiles: {clave: metros}.
 */
export function splitParts(mesh, classify, tiles = {}) {
  const P = mesh.positions, I = mesh.indices;
  const base = [], groups = {};
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const x = (P[a * 3] + P[b * 3] + P[c * 3]) / 3, y = (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3;
    const key = classify(x, y);
    if (key) (groups[key] || (groups[key] = [])).push(a, b, c); else base.push(a, b, c);
  }
  mesh.baseIndices = new Uint32Array(base);
  mesh.parts = {};
  for (const [key, list] of Object.entries(groups)) {
    const tile = tiles[key] || 4;
    const map = new Map(), pos = [], uv = [], idx = [];
    for (const v of list) {
      let k = map.get(v);
      if (k === undefined) {
        k = pos.length / 3;
        map.set(v, k);
        const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
        pos.push(x, y, z);
        uv.push((x + 0.5 * z) / tile, (y + z) / tile);
      }
      idx.push(k);
    }
    mesh.parts[key] = { positions: new Float32Array(pos), uvs: new Float32Array(uv), indices: new Uint32Array(idx), tris: idx.length / 3 };
  }
  return mesh;
}

export function splitWalls(mesh, carveAt, tile = 4) {
  const P = mesh.positions, I = mesh.indices;
  const base = [], wall = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const x = (P[a * 3] + P[b * 3] + P[c * 3]) / 3, y = (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3;
    (carveAt(x, y) > 0.05 ? wall : base).push(a, b, c);
  }
  mesh.baseIndices = new Uint32Array(base);
  if (!wall.length) { mesh.wall = null; return mesh; }
  const map = new Map(), pos = [], uv = [], idx = [];
  for (const v of wall) {
    let k = map.get(v);
    if (k === undefined) {
      k = pos.length / 3;
      map.set(v, k);
      const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
      pos.push(x, y, z);
      // proyección oblicua: no se degenera ni en el lecho (plano XY) ni en paredes que miran a X o a Y
      uv.push((x + 0.5 * z) / tile, (y + z) / tile);
    }
    idx.push(k);
  }
  mesh.wall = { positions: new Float32Array(pos), uvs: new Float32Array(uv), indices: new Uint32Array(idx), tris: idx.length / 3 };
  return mesh;
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
  // 1) máscara de lo pintado: cada celda guarda el multiplicador de densidad de la última pincelada que la tocó
  //    (cada pincelada lleva su propio multiplicador «f»; las antiguas usan el general sp.paintFactor)
  const mc = Math.max(1, Math.max(W, H) / 600);
  const mw = Math.ceil(W / mc) + 1, mh = Math.ceil(H / mc) + 1;
  const mask = new Float32Array(mw * mh);
  const defF = Math.max(1, sp.paintFactor);
  for (const st of paint) {
    const fv = st.e ? 0 : Math.max(1, Math.round((st.f ?? defF) * 4) / 4);
    const i0 = Math.max(0, Math.floor((st.x - st.r - minX) / mc)), i1 = Math.min(mw - 1, Math.ceil((st.x + st.r - minX) / mc));
    const j0 = Math.max(0, Math.floor((st.y - st.r - minY) / mc)), j1 = Math.min(mh - 1, Math.ceil((st.y + st.r - minY) / mc));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (Math.hypot(minX + i * mc - st.x, minY + j * mc - st.y) <= st.r) mask[j * mw + i] = fv <= 1 ? 0 : fv;
    }
  }
  const factorAt = (x, y) => {
    const i = Math.round((x - minX) / mc), j = Math.round((y - minY) / mc);
    return i >= 0 && j >= 0 && i < mw && j < mh ? mask[j * mw + i] : 0;
  };
  // área por nivel de multiplicador
  const areas = new Map();
  for (let k = 0; k < mask.length; k++) if (mask[k] > 0) areas.set(mask[k], (areas.get(mask[k]) || 0) + mc * mc);
  let Ap = 0;
  for (const a of areas.values()) Ap += a;
  Ap = Math.min(W * H, Ap);
  const Ar = Math.max(0, W * H - Ap);
  // 2) espaciados: base según densidad; cada nivel pintado usa base / sqrt(f); todo se ajusta al tope de polígonos
  const d = clamp(sp.terrainDensity, 1, 100) / 100;
  let c = 20 * Math.pow(1 / 20, d);
  let pts = Ar / (c * c);
  for (const [fv, a] of areas) pts += (Math.min(a, W * H) * fv) / (c * c);
  const maxTris = Math.max(200, sp.terrainMaxPolys);
  if (2 * pts > maxTris) c *= Math.sqrt((2 * pts) / maxTris);
  // 3) puntos: grilla base fuera de lo pintado + una grilla fina por nivel (con un leve desfase para evitar degeneraciones)
  const P = [];
  const nx = Math.max(2, Math.ceil(W / c)), ny = Math.max(2, Math.ceil(H / c));
  const cx = W / nx, cy = H / ny;
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const x = minX + i * cx, y = minY + j * cy;
    const border = i === 0 || j === 0 || i === nx || j === ny;
    if (border || !factorAt(x, y)) P.push(x, y);
  }
  let cf = c;
  for (const fv of areas.keys()) {
    const cl = c / Math.sqrt(fv);
    cf = Math.min(cf, cl);
    const fx = Math.max(2, Math.ceil(W / cl)), fy = Math.max(2, Math.ceil(H / cl));
    const fcx = W / fx, fcy = H / fy;
    // recorre solo la caja de las celdas de este nivel
    for (let j = 1; j < fy; j++) {
      const y0 = minY + j * fcy;
      for (let i = 1; i < fx; i++) {
        const x = minX + i * fcx + (j % 2) * fcx * 0.013, y = y0 + (i % 2) * fcy * 0.011;
        if (factorAt(x, y) === fv) P.push(x, y);
      }
    }
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
    waterLevel: T.waterLevel ?? null,
    inWater: (T.ctx && T.ctx.inRiver) || (HS && HS.inFall) ? (x, y) => !!((T.ctx && T.ctx.inRiver && T.ctx.inRiver(x, y)) || (HS && HS.inFall && HS.inFall(x, y))) : null,
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
  const S = trackSamples(layout, elev, sp);
  let maxW = 0;
  for (const p of S) maxW = Math.max(maxW, p.ew);
  const g = new SpatialGrid(Math.max(maxW, 8));
  for (const p of S) g.insert(p.x, p.y, p);
  const placed = new SpatialGrid(Math.max(2, o.minSpace * 3));
  const out = [];
  const tilt = clamp(o.tilt ?? 0, 0, 100) / 100;
  const tryPlace = (x, y, zFallback) => {
    let ok = true;
    g.query(x, y, maxW / 2 + o.clear, (p) => { if (ok && Math.hypot(p.x - x, p.y - y) < p.ew / 2 + o.clear) ok = false; });
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
    if (ground && ground.waterLevel != null && z < ground.waterLevel + 1) return; // ni en el agua ni en la arena
    if (ground && ground.inWater && ground.inWater(x, y)) return; // ni en ríos ni en cascadas
    if (ground && ground.waterLevel != null && where === 'terrain' && groundNormal(ground, x, y)[2] < 0.7) return; // ni en el acantilado ni en la pared de roca
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
  // candidatos propios (zonas pintadas): se prueban en vez de los costados de la pista
  if (o.candidates) {
    for (const [x, y] of o.candidates) tryPlace(x, y, o.zAt ? o.zAt(x, y) : 0);
    return capList(out, o.max, rand);
  }
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
  return capList(out, o.max, rand);
}

/** Recorta la lista a «max» elementos elegidos al azar (con la misma semilla, siempre los mismos). */
function capList(list, max, rand) {
  if (!(max >= 0) || list.length <= max) return list;
  const idx = list.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx.slice(0, max).sort((a, b) => a - b).map((i) => list[i]);
}

/**
 * Set de elementos decorativos: dónde va cada instancia.
 * set: {mode:'road'|'painted', side, density (por 100 m y lado; en zonas pintadas, por 1000 m²), offset, spread, spacing,
 *       max, size, sizeVar (0..1), rot (grados de giro al azar), tilt (0..100, respecto de la normal), onSlopes, onTops, seed, paint}
 * paintW: zonas pintadas en metros [{x,y,r,e}]. Devuelve [{x, y, z, up, yaw, s}] (s = escala / tamaño).
 */
export function buildDecoInstances(layout, elev, spIn, ground, set, paintW = null) {
  const sp = { ...DEFAULT_SCENE, ...spIn };
  const seed = ((set.seed | 0) * 7919 + 17) >>> 0;
  let candidates = null;
  if (set.mode === 'painted') {
    candidates = [];
    const strokes = paintW || [];
    if (strokes.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const q of strokes) { x0 = Math.min(x0, q.x - q.r); x1 = Math.max(x1, q.x + q.r); y0 = Math.min(y0, q.y - q.r); y1 = Math.max(y1, q.y + q.r); }
      const step = Math.sqrt(1000 / Math.max(0.01, set.density || 10));
      const rnd = rng(seed ^ 0x5bd1e995);
      const nx = Math.ceil((x1 - x0) / step), ny = Math.ceil((y1 - y0) / step);
      if (nx * ny <= 600000) {
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
          const x = x0 + (i + rnd()) * step, y = y0 + (j + rnd()) * step;
          let inside = false; // el último toque que cubre el punto decide (pintar o borrar)
          for (const q of strokes) if ((x - q.x) ** 2 + (y - q.y) ** 2 <= q.r * q.r) inside = !q.e;
          if (inside) candidates.push([x, y]);
        }
      }
    }
  }
  const size = Math.max(0.05, set.size || 1);
  const pts = scatter(layout, elev, sp, ground, {
    seed, density: set.density ?? 10, side: set.side || 'both', offset: set.offset ?? 4, spread: set.spread ?? 20,
    minSpace: Math.max(0.1, set.spacing ?? size * 1.5), clear: 0.5 + size * 0.5,
    onSlopes: !!set.onSlopes, onTops: !!set.onTops, hillDensity: set.onSlopes || set.onTops ? (set.hillDensity ?? 5) : 0, tilt: set.tilt ?? 0,
    candidates, max: Number.isFinite(set.max) ? Math.max(0, set.max) : undefined,
    zAt: (x, y) => (ground ? ground.sample(x, y) : 0),
  });
  const rand = rng(seed ^ 0x27d4eb2d);
  const rot = Math.max(0, Math.min(360, set.rot ?? 360)) * (Math.PI / 180);
  const sv = Math.max(0, Math.min(1, set.sizeVar ?? 0.3));
  // rotación fija respecto de la pista: 0° = de frente al auto que viene (el frente del elemento es su -Y local),
  // con un giro propio para cada lado de la pista
  let fixedYaw = null;
  if (set.rotMode === 'fixed') {
    const g = new SpatialGrid(20);
    layout.routes.forEach((r) => { for (let i = 0; i < r.n; i += 2) g.insert(r.x[i], r.y[i], { r, i }); });
    const all = [];
    layout.routes.forEach((r) => { for (let i = 0; i < r.n; i += 4) all.push({ r, i }); });
    const dL = ((set.rotLeft ?? 0) * Math.PI) / 180, dR = ((set.rotRight ?? 0) * Math.PI) / 180;
    fixedYaw = (x, y) => {
      let best = null, bd = Infinity;
      g.query(x, y, 120, (q) => { const d = (q.r.x[q.i] - x) ** 2 + (q.r.y[q.i] - y) ** 2; if (d < bd) { bd = d; best = q; } });
      if (!best) for (const q of all) { const d = (q.r.x[q.i] - x) ** 2 + (q.r.y[q.i] - y) ** 2; if (d < bd) { bd = d; best = q; } }
      const { r, i } = best, tx = r.tx[i], ty = r.ty[i];
      const left = (x - r.x[i]) * -ty + (y - r.y[i]) * tx >= 0;
      return Math.atan2(-tx, ty) + (left ? dL : dR);
    };
  }
  return pts.map((p) => {
    const rr = rand();
    return { x: p.x, y: p.y, z: p.z, up: p.up, yaw: fixedYaw ? fixedYaw(p.x, p.y) : (rr - 0.5) * rot, s: 1 + (rand() * 2 - 1) * sv, pick: rand() };
  });
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
    // rotación aleatoria sobre su eje y sección levemente ovalada: cada árbol se ve distinto
    const yaw = rand() * Math.PI * 2, ex = 0.86 + 0.28 * rand(), ey = 0.86 + 0.28 * rand();
    return { x: p.x, y: p.y, z: p.z, base: base[2], basePos: base, up: p.up, h, r: rad, yaw, ex, ey, where: p.where };
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
      const a = (k2 / seg) * Math.PI * 2;
      const lx = Math.cos(a) * t.r * t.ex, ly = Math.sin(a) * t.r * t.ey; // local, antes del giro
      const cy = Math.cos(t.yaw), sy = Math.sin(t.yaw);
      const c = lx * cy - ly * sy, sn = lx * sy + ly * cy;
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
  const insts = [];
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
    insts.push({ x: p.x, y: p.y, z: p.z - 0.03, up: p.up, yaw, w, h }); // para reemplazar por modelos
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
  return { positions: pos, normals: nor, uvs: uv, indices: idx, count: n, tris: n * 4, insts };
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
/**
 * ¿Un pilar en (x, y), de lado «size», que sube hasta zTop, pisaría alguna calzada (con su camino de tierra y su
 * barrera) o un atajo que pase por debajo? La ruta que el pilar sostiene (ownK) no cuenta cerca de su propia
 * posición ownS (es el tablero de arriba).
 */
export function pillarBlocked(layout, elev, spIn, x, y, size, zTop, ownK = -1, ownS = null) {
  const sp = { ...DEFAULT_SCENE, ...(spIn || {}) };
  for (let k = 0; k < layout.routes.length; k++) {
    const r = layout.routes[k], e = elev.routes[k];
    if (!e) continue;
    // muestra más cercana; en la ruta del propio pilar, lejos de su posición (la misma ruta puede pasar por debajo)
    let i = -1;
    if (k === ownK && ownS != null) {
      let bd = Infinity;
      for (let q = 0; q < r.n; q++) {
        const d = Math.abs(r.s[q] - ownS);
        if (Math.min(d, r.closed ? r.L - d : d) < 3 * r.w[q] + size) continue;
        const dd = (r.x[q] - x) ** 2 + (r.y[q] - y) ** 2;
        if (dd < bd) { bd = dd; i = q; }
      }
      if (i < 0) continue;
    } else i = Math.min(r.n - 1, Math.max(0, nearestOnSamples(r, x, y).i));
    const X = edgeExtents(sp, r);
    const u = (x - r.x[i]) * -r.ty[i] + (y - r.y[i]) * r.tx[i];
    const a = Math.abs((x - r.x[i]) * r.tx[i] + (y - r.y[i]) * r.ty[i]);
    if (a > r.ds * 1.5 + size) continue;
    const ext = r.w[i] / 2 + (u >= 0 ? X.left : X.right) + size * 0.75 + 0.3;
    if (Math.abs(u) > ext) continue;
    if (e.z[i] > zTop - 0.3) continue; // esa ruta pasa por arriba del pilar: no la pisa
    return true;
  }
  return false;
}
/** Busca, alrededor de sv (y dentro de [lo, hi]), la posición más cercana de la ruta k donde un pilar no pise nada. */
function clearPillarS(layout, elev, sp, k, sv, lo, hi, size, zTopAt) {
  const r = layout.routes[k];
  const step = Math.max(1.5, size * 1.2);
  for (let q = 0; q <= 40; q++) {
    const off = q === 0 ? 0 : Math.ceil(q / 2) * step * (q % 2 ? 1 : -1);
    const s2 = sv + off;
    if (s2 < lo || s2 > hi) continue;
    const ss = r.closed ? ((s2 % r.L) + r.L) % r.L : clamp(s2, 0, r.L);
    const i = Math.min(r.n - 1, Math.max(0, Math.round(ss / r.ds))) % r.n;
    if (!pillarBlocked(layout, elev, sp, r.x[i], r.y[i], size, zTopAt(i), k, ss)) return { s: ss, i };
  }
  return null;
}

/**
 * Pilares de los tramos suspendidos: sp.suspRanges = [{k, s0, s1, pillars}]; cada tramo lleva «pillars» pilares
 * repartidos a lo largo, desde bajo la calzada hasta el suelo (ground.sample: terreno y cerros). Si el suelo está
 * a menos de 0,6 m no hace falta pilar. Devuelve [{x, y, zTop, zBot, size, angle, zone, n}] (zone = índice del tramo).
 */
export function suspPillars(layout, elev, sp, ground = null) {
  const out = [];
  (sp.suspRanges || []).forEach((z, zi) => {
    const r = layout.routes[z.k], e = elev.routes[z.k];
    if (!r || !e) return;
    const n = Math.max(0, Math.round(z.pillars ?? 3));
    const len = z.s1 - z.s0;
    let cnt = 0;
    const zTopAt = (i) => e.z[i] - Math.abs(Math.sin(e.roll[i])) * r.w[i] * 0.25 - 0.25;
    for (let q = 0; q < n; q++) {
      const sv0 = z.s0 + (len * (q + 0.5)) / n;
      // nunca sobre otra calzada, su camino de tierra o un atajo: se corre a lo largo del tramo hasta un lugar libre
      const size0 = Math.min(2.2, Math.max(0.8, r.w[0] * 0.12));
      const lo = z.s0 + (len * q) / n, hi = z.s0 + (len * (q + 1)) / n;
      const c = clearPillarS(layout, elev, sp, z.k, sv0, lo, hi, size0, zTopAt);
      if (!c) continue;
      const i = c.i;
      const zTop = zTopAt(i);
      const g = ground ? ground.sample(r.x[i], r.y[i]) : NaN;
      const zBot = (Number.isFinite(g) ? g : Math.min(...e.z) - 2) - 0.3;
      if (zTop - zBot < 0.6) continue;
      out.push({ x: r.x[i], y: r.y[i], zTop, zBot, size: Math.min(2.2, Math.max(0.8, r.w[i] * 0.12)), angle: Math.atan2(r.ty[i], r.tx[i]), zone: zi, n: ++cnt });
    }
  });
  return out;
}

export function bridgePillars(layout, elev, terrain = null, sp = null) {
  const out = [];
  const r = layout.routes[0], e = elev.routes[0];
  (r.bridges || []).forEach((b, bi) => {
    const len = b.s1 - b.s0;
    const n = Math.max(1, Math.round(len / 18));
    for (let q = 1; q < n || (n === 1 && q === 1); q++) {
      const s = b.s0 + (len * q) / Math.max(2, n);
      // nunca sobre otra calzada (la que pasa por debajo del puente), su camino de tierra o un atajo
      const size0 = Math.max(1.5, r.w[0] * 0.18), half = len / Math.max(2, n) / 2;
      const c = clearPillarS(layout, elev, sp, 0, s, Math.max(b.s0 + 1, s - half), Math.min(b.s1 - 1, s + half), size0, (ii) => e.z[ii] - 0.6);
      if (!c) { if (n === 1) break; continue; }
      const i = c.i;
      const zTop = e.z[i] - 0.6;
      const zBot = terrain ? terrain.sample(r.x[i], r.y[i]) - 0.3 : Math.min(...e.z) - 2;
      if (zTop - zBot < 1.2) continue;
      out.push({ x: r.x[i], y: r.y[i], zTop, zBot, size: Math.max(1.5, r.w[i] * 0.18), angle: Math.atan2(r.ty[i], r.tx[i]), bridge: b.idx ?? bi });
      if (n === 1) break;
    }
  });
  return out;
}
