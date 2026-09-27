// Geometría de escena: malla de pista con UV, terreno y árboles (conos).
// Todo en metros, Z arriba. Devuelve arrays planos listos para three.js o para exportar.
import { SpatialGrid, rng, clamp, smoothstep, nearestOnSamples } from './geometry.js';
import Delaunator from '../vendor/delaunator.js';
import { riverField, subdivFactor } from './rivers.js';
import { DEFAULT_SCULPT_CURVE } from './sculptcurve.js';
import { SHADOW_DEFAULTS } from './shadows.js';
import { convexHull2, hillFieldOne, detectTunnels, tunnelTop, buildTunnelGeometry, applyTunnelOverrides, portalBox, frameAt, edgeExtents, edgeParams, dirtWidthAt, tunnelInnerWidth } from './tunnels.js';

export const DEFAULT_SCENE = {
  ...SHADOW_DEFAULTS, // planos de sombra (shadows.js)
  // pista
  trackTexDir: 'vertical', // 'vertical' = la textura corre a lo largo de la pista en V; 'horizontal' = en U
  trackTexReps: 100, // repeticiones a lo largo de la ruta principal
  trackTexOpacity: 1, // opacidad de la textura en la vista 3D (0 = solo colores por altura)
  trackMeshMode: 'uniform', // 'uniform' = secciones a distancia pareja; 'optimized' = más secciones en curvas que en rectas
  trackDensity: 100, // 1..100: separación entre secciones de 16 m (1) a la del muestreo (100)
  trackDivs: 0, // divisiones a lo ancho de la pista (edges a lo largo entre los bordes); 0 = solo los bordes
  trackMaxTris: 200000, // tope de triángulos de la pista (manda sobre la densidad)
  trackAdapt: 0.5, // 0..1 (optimizado): 0 = las curvas tienen algo más que las rectas; 1 = las rectas mucho menos
  skirts: true, // faldones laterales hacia el terreno
  tunnelTriggers: true, // triggers (cubos invisibles) en la entrada y la salida de cada túnel
  triggerDepth: 1, // m a lo largo de la pista (triggers de túnel)
  triggerHeight: 6, // m de alto (triggers de túnel)
  showTriggers: true, // se ven en la vista 3D (semitransparentes); en la exportación son invisibles
  transSubdiv: true, // «Subdividir transiciones»: divisiones a lo largo donde la pista cambia de ancho (la textura no se tuerce)
  transDivs: [0.07, 0.47, 0.53, 0.93],
  transStep: 3, // m entre secciones agregadas en las transiciones
  transKeepLines: false, // «Mantener el ancho de las líneas»: las franjas angostas conservan su ancho en metros en todo el tramo con otro ancho // posiciones de esas divisiones (fracción del ancho desde el borde izquierdo)
  tsmoothBrush: 25, // pincel «Suavizar pista»: radio (m), fuerza por toque (0..1) y si suaviza también las alturas
  tsmoothStrength: 0.5,
  tsmoothZ: false,
  tunnelTexTile: 6, // metros por repetición de las texturas de los túneles
  skirtHeight: 1.1, // m que bajan los faldones desde el borde (pista y camino de tierra); como mínimo la separación del terreno + 0.1
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
  sculptCurve: DEFAULT_SCULPT_CURVE, // curva de caída del pincel de relieve [[t, f], ...] (sculptcurve.js)
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
  treeSingle: true, // «single mesh»: los árboles se exportan como una sola malla; sin marcar se editan uno a uno
  treeBake: null, // lista fija de árboles (editados a mano): [[lx, ly, alto/escala, radio/escala, giro, ex, ey, n.º original], …] en coordenadas del mapa
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
  dirtTransition: 12, // m: transición del camino de tierra entre tramos de distinto ancho (0 = corte)
  collision: false, // geometría de colisión (invisible) en la exportación: camino de tierra y costados
  collDirt: true, // colisión del camino de tierra (plano de una cara, como el camino)
  collSides: true, // costados: paredes invisibles en el borde (camino de tierra o pista)
  collHeight: 3, // m: alto de los costados (se recorta bajo otra calzada que pase por arriba)
  collThick: 1, // m: grosor de los costados hacia afuera (0 = plano de una cara que mira a la pista)
  showCollision: true, // mostrarla (semitransparente) en la vista 3D
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
/** Cuánto bajan los faldones (pista y camino de tierra) desde el borde. */
export function skirtDepth(sp) { const g = sp.terrainGap ?? 0.3; const h = Number.isFinite(sp.skirtHeight) ? sp.skirtHeight : g + 0.8; return Math.max(g + 0.1, h); }

export function trackSamples(layout, elev, sp = {}) {
  const out = [];
  // bordes de cada ruta (cada atajo tiene los suyos): barrera de la ruta + camino de tierra en cada muestra (los tramos
  // pueden tener lados y anchos propios)
  const PR = layout.routes.map((r) => edgeParams(sp, r));
  const barExt = (P, key) => (P.barrierSide === 'both' || P.barrierSide === key ? Math.max(0.05, P.barrierThick ?? 0.25) + 0.15 : 0);
  layout.routes.forEach((r, k) => {
    const e = elev.routes[k];
    for (let i = 0; i < r.n; i++) {
      const low = e.z[i] - Math.abs(Math.sin(e.roll[i])) * r.w[i] / 2;
      const bridge = !!(r.bridges && r.bridges.some((b) => { if (b.type === 'track' || b.type === 'cut') return false; const d = r.closed ? (((r.s[i] - b.s0) % r.L) + r.L) % r.L : r.s[i] - b.s0; return d >= 0 && d <= b.s1 - b.s0; }));
      const P = PR[k], X = { left: dirtWidthAt(sp, r, k, r.s[i], 1, P) + barExt(P, 'left'), right: dirtWidthAt(sp, r, k, r.s[i], -1, P) + barExt(P, 'right') };
      // sección socavada: como un tramo suspendido (el terreno no se adapta), pero además la pista socava el terreno
      const cut = sp.cutRanges && sp.cutRanges.length ? cutZoneAt(layout, k, r.s[i], sp.cutRanges) : null;
      // puente o tramo suspendido: el terreno no se adapta (queda su relieve natural; solo se baja si tocaría la calzada)
      const susp = !!cut || bridge || !!(sp.suspRanges && isCovered(layout, k, r.s[i], sp.suspRanges));
      const uL = r.w[i] / 2 + X.left, uR = r.w[i] / 2 + X.right; // calzada + camino de tierra + barrera
      // tramo elevado con suelo guardado: el terreno bajo él queda a esa altura (no sigue a la pista al subirla)
      const gz = susp && !cut ? suspGroundAt(layout, k, r.s[i], sp.suspRanges) : null;
      out.push({ gz, x: r.x[i], y: r.y[i], z: low, zc: e.z[i], sr: Math.sin(e.roll[i]), tx: r.tx[i], ty: r.ty[i], w: r.w[i], uL, uR, ew: 2 * Math.max(uL, uR), k, i, s: r.s[i], j: out.length, bridge, susp, cut, ds: r.ds });
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

/**
 * Suelo guardado de un tramo elevado en la posición sv (la altura que tenía la pista al marcarlo), o null.
 * ranges = sp.suspRanges con {k, s0, s1, ground: [[t 0..1, z], ...]}.
 */
export function suspGroundAt(layout, k, sv, ranges) {
  if (!ranges || !ranges.length) return null;
  const r = layout.routes[k];
  for (const c of ranges) {
    if (c.k !== k || !c.ground || c.ground.length < 2) continue;
    let ss = sv;
    if (r.closed) { while (ss < c.s0) ss += r.L; while (ss > c.s1 + r.L) ss -= r.L; }
    if (ss < c.s0 || ss > c.s1) continue;
    const t = c.s1 > c.s0 ? (ss - c.s0) / (c.s1 - c.s0) : 0, G = c.ground;
    if (t <= G[0][0]) return G[0][1];
    for (let i = 1; i < G.length; i++) if (t <= G[i][0]) { const u = (t - G[i - 1][0]) / Math.max(1e-9, G[i][0] - G[i - 1][0]); return G[i - 1][1] + (G[i][1] - G[i - 1][1]) * u; }
    return G[G.length - 1][1];
  }
  return null;
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
/** Divisiones a lo ancho de la pista (edges a lo largo, entre los bordes): 0 por defecto. */
export function trackDivsOf(sp) { return Math.max(0, Math.min(16, Math.round(sp.trackDivs ?? 0))); }
/** Columnas de vértices de cada sección de la malla de la pista. */
export function trackCols(sp) { return trackDivsOf(sp) + 2 + (sp.skirts ? 2 : 0); }
/** Divisiones de las transiciones de ancho (ordenadas, dentro de (0, 1)); [] si no se subdivide. */
export function transDivsOf(sp) {
  if (sp.transSubdiv === false || !Array.isArray(sp.transDivs)) return [];
  return [...new Set(sp.transDivs.filter((t) => Number.isFinite(t) && t > 0.002 && t < 0.998).map((t) => +t.toFixed(4)))].sort((a, b) => a - b);
}
/** ¿Cambia el ancho de la ruta entre las muestras q y q + 1? (transición entre un ancho y otro) */
function widthChanges(r, q) { const n = r.n, a = ((q % n) + n) % n, b = (((q + 1) % n) + n) % n; return Math.abs(r.w[a] - r.w[b]) > 1e-4; }

export function trackRows(layout, elev, spIn = {}) {
  const sp = { ...DEFAULT_SCENE, ...spIn };
  const cols = trackCols(sp);
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
      let dirtW = null; // ancho de los caminos de tierra (con transiciones): donde cambia, más secciones
      if (r.bridges && r.bridges.length && (sp.dirtTransition ?? 12) > 0) {
        const P = edgeParams(sp, r);
        dirtW = new Float64Array(n);
        for (let i = 0; i < n; i++) dirtW[i] = dirtWidthAt(sp, r, k, r.s[i], 1, P) + dirtWidthAt(sp, r, k, r.s[i], -1, P);
      }
      const ds = r.ds;
      for (let q = 0; q < nq; q++) {
        const i = at(q), ip = r.closed ? at(q - 1) : Math.max(0, q - 1), inx = r.closed ? at(q + 1) : Math.min(n - 1, q + 1);
        const kPlan = Math.abs(r.k[i]) * 40; // radio 40 m = máximo
        const zpp = e && e.z ? Math.abs(e.z[inx] - 2 * e.z[i] + e.z[ip]) / (ds * ds) * 50 : 0; // curvatura vertical (radio 50 m = máximo)
        const roll = e && e.roll ? Math.abs(e.roll[inx] - e.roll[ip]) / (2 * ds) * 60 : 0; // cambio de peralte
        const dw = Math.abs(r.w[inx] - r.w[ip]) / (2 * ds) * 6; // cambio de ancho
        const ddw = dirtW ? Math.abs(dirtW[inx] - dirtW[ip]) / (2 * ds) * 6 : 0; // transición del camino de tierra
        c[q] = Math.min(1, Math.max(kPlan, zpp, roll, dw, ddw));
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
    // «Subdividir transiciones»: más secciones donde cambia el ancho (una cada transStep m), así los trapecios son chicos
    if (transDivsOf(sp).length) {
      const step = Math.max(1, Math.round(clamp(sp.transStep ?? 3, 0.5, 20) / r.ds));
      let inT = false, last = -1e9;
      for (let q = 0; q < nq; q++) {
        const ch = widthChanges(r, q);
        if (ch && (!inT || q - last >= step)) { rowsSet.add(q); last = q; }
        if (!ch && inT) rowsSet.add(q); // fin de la transición
        inT = ch;
      }
      if (inT) rowsSet.add(nq);
    }
    return [...rowsSet].filter((q) => q >= 0 && q <= nq).sort((a, b) => a - b);
  });
}

/** Malla de la pista con UV (a lo largo x a lo ancho) y faldones opcionales. */
export function buildTrackMesh(layout, elev, spIn = {}) {
  const sp = { ...DEFAULT_SCENE, ...spIn };
  const Lmain = layout.routes[0].L;
  const repsPerM = Math.max(0.01, sp.trackTexReps) / Lmain;
  const skirt = sp.skirts ? skirtDepth(sp) : 0;
  const rowLists = trackRows(layout, elev, sp);
  const parts = layout.routes.map((r, k) => {
    const pos = [], uv = [], idx = [];
    const e = elev.routes[k];
    const n = r.n;
    const qList = rowLists[k];
    const rows = qList.length;
    // columnas: [faldón izq], borde izq, divisiones a lo ancho (trackDivs, por defecto ninguna), borde der, [faldón der]
    const divs = trackDivsOf(sp), tdivs = transDivsOf(sp);
    const baseT = Array.from({ length: divs + 2 }, (_, c2) => c2 / (divs + 1));
    // filas que tocan una transición de ancho: llevan además las divisiones de «Subdividir transiciones»
    const segChanges = (qa, qb) => { for (let q2 = qa; q2 < qb; q2++) if (widthChanges(r, q2)) return true; return false; };
    // ancho «normal» de la ruta (el más común): con «Mantener el ancho de las líneas», toda fila con otro ancho lleva
    // las divisiones (no solo las de la transición), así las líneas conservan su ancho en metros de punta a punta
    const keep = tdivs.length && sp.transKeepLines;
    let W0 = 0;
    if (keep) { const cnt = new Map(); for (let i2 = 0; i2 < n; i2++) { const k2 = r.w[i2].toFixed(2); cnt.set(k2, (cnt.get(k2) || 0) + 1); } let best = 0; for (const [k2, c2] of cnt) if (c2 > best) { best = c2; W0 = +k2; } }
    const inTrans = tdivs.length ? qList.map((qq, j) => (keep && Math.abs(r.w[qq % n] - W0) > 1e-3) || (j > 0 && segChanges(qList[j - 1], qq)) || (j < qList.length - 1 && segChanges(qq, qList[j + 1]))) : null;
    const tsAll = tdivs.length ? [...new Set([...baseT, ...tdivs])].sort((a, b) => a - b) : baseT;
    // posición geométrica de cada división (fracción del ancho actual) para que las franjas angostas (< 15 % del ancho:
    // líneas) midan en metros lo mismo que con el ancho normal y las anchas (carriles) absorban el cambio
    const bandsU = keep ? [0, ...tdivs, 1] : null;
    const geomOf = (w) => {
      if (!keep || Math.abs(w - W0) < 1e-3) return null;
      const bw = bandsU.slice(1).map((u, k2) => u - bandsU[k2]);
      const fixed = bw.map((b) => b < 0.15);
      const fixedM = bw.reduce((a, b, k2) => a + (fixed[k2] ? b * W0 : 0), 0);
      const stretchU = bw.reduce((a, b, k2) => a + (fixed[k2] ? 0 : b), 0);
      if (fixedM >= w * 0.98 || stretchU <= 0) return null; // no caben: todo proporcional
      const out = new Map();
      let acc = 0;
      for (let k2 = 0; k2 < bw.length - 1; k2++) { acc += fixed[k2] ? (bw[k2] * W0) / w : ((w - fixedM) * (bw[k2] / stretchU)) / w; out.set(bandsU[k2 + 1], acc); }
      return out;
    };
    const rowV = []; // por fila: {surf: [[t, índice]] de izquierda a derecha, skL, skR}
    for (let j = 0; j < qList.length; j++) {
      const q = qList[j];
      const i = q % n;
      const s = q === n ? r.L : r.s[i];
      const along = s * repsPerM;
      const lx = -r.ty[i], ly = r.tx[i];
      const c = Math.cos(e.roll[i]), sn = Math.sin(e.roll[i]);
      const hw = r.w[i] / 2;
      const ox = lx * c * hw, oy = ly * c * hw, oz = sn * hw;
      const put = (x, y, z, t) => { pos.push(x, y, z); if (sp.trackTexDir === 'horizontal') uv.push(along, t); else uv.push(t, along); return pos.length / 3 - 1; };
      const ts = inTrans && inTrans[j] ? tsAll : baseT;
      const G = inTrans && inTrans[j] ? geomOf(r.w[i]) : null; // con «Mantener el ancho de las líneas»: dónde va cada división
      const surf = ts.map((t) => { const g = G && G.has(t) ? G.get(t) : t, f = 1 - 2 * g; return [g, put(r.x[i] + ox * f, r.y[i] + oy * f, e.z[i] + oz * f, t)]; }).sort((a, b) => a[0] - b[0]); // la sección es una recta (el peralte es rígido)
      const row = { surf, skL: -1, skR: -1 };
      if (sp.skirts) {
        const a = surf[0][1], b = surf[surf.length - 1][1];
        row.skL = put(pos[a * 3] + lx * 0.2, pos[a * 3 + 1] + ly * 0.2, pos[a * 3 + 2] - skirt, -0.05);
        row.skR = put(pos[b * 3] - lx * 0.2, pos[b * 3 + 1] - ly * 0.2, pos[b * 3 + 2] - skirt, 1.05);
      }
      rowV.push(row);
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
    // faldones: no van del lado donde hay camino de tierra (el camino tiene su propio faldón hasta el terreno)
    const P = sp.skirts ? edgeParams(sp, r) : null;
    const dirtRow = sp.skirts ? qList.map((qq) => { const sv = qq === n ? r.L : r.s[qq % n]; return [dirtWidthAt(sp, r, k, sv, 1, P) > 0, dirtWidthAt(sp, r, k, sv, -1, P) > 0]; }) : null;
    for (let q = 0; q < rows - 1; q++) {
      const qa = qList[q], qb = qList[q + 1];
      const sa = r.s[qa % n], sb = qb === n ? r.L : r.s[qb % n];
      const noSkL = sp.skirts && (dirtRow[q][0] || dirtRow[q + 1][0]), noSkR = sp.skirts && (dirtRow[q][1] || dirtRow[q + 1][1]);
      const ba = bridgeOf(sa), bb = bridgeOf(sb === r.L && r.closed ? 0 : sb);
      // material del cuadro: tablero de puente > tramo cubierto (túnel o bajo un cruce) > pista (o atajo)
      const tgt = ba >= 0 && ba === bb ? bIdx[ba] : isCovered(layout, k, (sa + sb) / 2, sp.coveredRanges) ? cIdx : isCovered(layout, k, (sa + sb) / 2, sp.suspRanges) ? sIdx : idx;
      const A = rowV[q], B = rowV[q + 1];
      // faldones (el izquierdo y el derecho, salvo bajo el camino de tierra)
      if (sp.skirts && !noSkL) { const a = A.skL, b = A.surf[0][1], d = B.skL, e2 = B.surf[0][1]; tgt.push(a, d, b, b, d, e2); }
      if (sp.skirts && !noSkR) { const a = A.surf[A.surf.length - 1][1], b = A.skR, d = B.surf[B.surf.length - 1][1], e2 = B.skR; tgt.push(a, d, b, b, d, e2); }
      // calzada: «cremallera» entre las dos filas (con las mismas divisiones son cuadros; si una tiene más, se une en
      // abanico, sin vértices sueltos)
      const SA = A.surf, SB = B.surf;
      let ia = 0, ib = 0;
      while (ia < SA.length - 1 || ib < SB.length - 1) {
        const ta = ia < SA.length - 1 ? SA[ia + 1][0] : Infinity, tb = ib < SB.length - 1 ? SB[ib + 1][0] : Infinity;
        if (Math.abs(ta - tb) < 1e-9) { tgt.push(SA[ia][1], SB[ib][1], SA[ia + 1][1], SA[ia + 1][1], SB[ib][1], SB[ib + 1][1]); ia++; ib++; }
        else if (ta < tb) { tgt.push(SA[ia][1], SB[ib][1], SA[ia + 1][1]); ia++; }
        else { tgt.push(SA[ia][1], SB[ib][1], SB[ib + 1][1]); ib++; }
      }
    }
    return { name: r.name, k, alt: r.kind === 'alt', positions: new Float32Array(pos), uvs: new Float32Array(uv), indices: idx, coveredIdx: cIdx, suspIdx: sIdx, bridgeIdx: bIdx, bridgeNo: (r.bridges || []).map((b, k) => (b.idx ?? k) + 1), bridgeTy: (r.bridges || []).map((b) => b.type || 'bridge') };
  });
  // malla combinada (vista previa), en grupos de material: pista, atajos, tramos cubiertos, tableros de puente
  const nPos = parts.reduce((a, p) => a + p.positions.length, 0);
  const positions = new Float32Array(nPos), uvs = new Float32Array((nPos / 3) * 2);
  const G = { main: [], alt: [], covered: [], bridge: [], susp: [] };
  let vo = 0;
  const altRanges = []; // tramo de cada atajo dentro del grupo de atajos: [{k, start, count}] (relativo al grupo)
  const bridgeRanges = []; // tablero de cada puente dentro del grupo de puentes (textura propia de cada puente)
  for (const p of parts) {
    positions.set(p.positions, vo * 3);
    uvs.set(p.uvs, vo * 2);
    if (p.alt) altRanges.push({ k: p.k, start: G.alt.length, count: p.indices.length });
    for (const i of p.indices) G[p.alt ? 'alt' : 'main'].push(i + vo);
    for (const i of p.coveredIdx) G.covered.push(i + vo);
    for (const i of p.suspIdx) G.susp.push(i + vo);
    p.bridgeIdx.forEach((bi, kb) => { if (bi.length) bridgeRanges.push({ bridge: p.bridgeNo[kb] - 1, start: G.bridge.length, count: bi.length }); for (const i of bi) G.bridge.push(i + vo); });
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
  const bridgeGroups = bridgeRanges.map((b) => ({ bridge: b.bridge, start: G.main.length + G.alt.length + G.covered.length + b.start, count: b.count }));
  // tramos cubiertos como objetos propios (exportación)
  const coveredParts = [];
  for (const p of parts) if (p.coveredIdx.length) coveredParts.push({ name: `${p.name}_cubierto`, alt: p.alt, ...compactMesh(p.positions, p.uvs, p.coveredIdx) });
  // tramos suspendidos como objetos propios (exportación), con su propio material
  const suspParts = [];
  for (const p of parts) if (p.suspIdx.length) suspParts.push({ name: `${p.name}_suspendido`, alt: p.alt, k: p.k, ...compactMesh(p.positions, p.uvs, p.suspIdx) });
  // tableros como objetos propios (exportación), con los vértices compactados
  const bridgeParts = [];
  for (const p of parts) {
    p.bridgeIdx.forEach((bi, k) => { if (bi.length) bridgeParts.push({ name: `${p.bridgeTy[k] === 'track' ? 'tramo' : p.bridgeTy[k] === 'cut' ? 'socavado' : 'puente'}_${String(p.bridgeNo[k]).padStart(2, '0')}`, type: p.bridgeTy[k], bridge: p.bridgeNo[k] - 1, ...compactMesh(p.positions, p.uvs, bi) }); });
  }
  for (const p of parts) {
    if (p.bridgeIdx.some((b) => b.length) || p.coveredIdx.length || p.suspIdx.length) Object.assign(p, compactMesh(p.positions, p.uvs, p.indices));
    delete p.bridgeIdx; delete p.bridgeNo; delete p.bridgeTy; delete p.coveredIdx; delete p.suspIdx;
  }
  return { positions, uvs, indices, groups, altGroups, bridgeGroups, trackCount, parts, coveredParts, bridgeParts, suspParts, rows: rowLists.map((q) => q.length) };
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
 * Relieve esculpido a mano sobre el terreno: suma de toques [{x, y, r, h, lut?}] (m; h > 0 eleva, h < 0 hunde) con caída
 * según la curva del pincel (lut = tabla f(d/r) de sculptcurve.js) o, sin ella, (1 - (d/r)²)².Se rasteriza en una grilla fina y se muestrea con interpolación bilineal. null si no hay toques.
 */
/** Multiplicador de polígonos de una pincelada: > 1 aumenta (redondeado a cuartos), < 1 disminuye (mín. 1/64). */
function paintFv(f) {
  if (!(f > 0)) return 1;
  if (f < 1) return Math.max(1 / 64, f);
  return Math.max(1, Math.round(f * 4) / 4);
}
export function sculptField(dabs) {
  if (!dabs || !dabs.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, rmin = Infinity;
  for (const d of dabs) {
    x0 = Math.min(x0, d.x - d.r); x1 = Math.max(x1, d.x + d.r); y0 = Math.min(y0, d.y - d.r); y1 = Math.max(y1, d.y + d.r);
    // curvas con bordes empinados (meseta) necesitan una grilla más fina para que el borde no se ablande
    let sl = 1.6;
    if (Array.isArray(d.lut) && d.lut.length > 2) { const n = d.lut.length - 1; for (let i = 1; i <= n; i++) sl = Math.max(sl, (d.lut[i - 1] - d.lut[i]) * n); }
    rmin = Math.min(rmin, d.r / Math.min(6, sl / 1.6));
  }
  let c = clamp(rmin / 5, 0.4, 3);
  while (((x1 - x0) / c) * ((y1 - y0) / c) > 4e6) c *= 1.25; // tope de memoria
  const nx = Math.ceil((x1 - x0) / c) + 2, ny = Math.ceil((y1 - y0) / c) + 2;
  const F = new Float32Array(nx * ny);
  for (const d of dabs) {
    const i0 = Math.max(0, Math.floor((d.x - d.r - x0) / c)), i1 = Math.min(nx - 1, Math.ceil((d.x + d.r - x0) / c));
    const j0 = Math.max(0, Math.floor((d.y - d.r - y0) / c)), j1 = Math.min(ny - 1, Math.ceil((d.y + d.r - y0) / c));
    const r2 = d.r * d.r;
    if (d.smooth) { smoothDab(F, nx, ny, c, x0, y0, d, i0, i1, j0, j1); continue; } // suavizar: ni eleva ni hunde
    const lut = Array.isArray(d.lut) && d.lut.length > 2 ? d.lut : null, ln = lut ? lut.length - 1 : 0;
    for (let j = j0; j <= j1; j++) {
      const dy = y0 + j * c - d.y;
      for (let i = i0; i <= i1; i++) {
        const dx = x0 + i * c - d.x, q = (dx * dx + dy * dy) / r2;
        if (q < 1) {
          if (lut) { const u = Math.sqrt(q) * ln, k = u | 0, a = u - k; F[j * nx + i] += d.h * (lut[k] * (1 - a) + lut[k + 1] * a); }
          else { const f = 1 - q; F[j * nx + i] += d.h * f * f; }
        }
      }
    }
  }
  const sample = (x, y) => {
    const fx = (x - x0) / c, fy = (y - y0) / c;
    if (fx < 0 || fy < 0 || fx >= nx - 1 || fy >= ny - 1) return 0; // (fuera del relieve esculpido)
    const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j, k = j * nx + i;
    return (F[k] * (1 - tx) + F[k + 1] * tx) * (1 - ty) + (F[k + nx] * (1 - tx) + F[k + nx + 1] * tx) * ty;
  };
  return { sample, bounds: { x0, y0, x1, y1 }, cell: c };
}

/**
 * Toque de suavizado sobre el relieve esculpido: difusión (como el calor) solo dentro del pincel, con la caída del
 * pincel y la fuerza (h: 5 o más = máximo). Conserva el volumen: no eleva ni hunde, solo reparte (baja las cimas y
 * rellena los bordes).
 */
function smoothDab(F, nx, ny, c, x0, y0, d, i0, i1, j0, j1) {
  const w = i1 - i0 + 1, h = j1 - j0 + 1;
  if (w < 3 || h < 3) return;
  const k = clamp(Math.abs(d.h) / 5, 0.05, 1), r2 = d.r * d.r;
  const lut = Array.isArray(d.lut) && d.lut.length > 2 ? d.lut : null, ln = lut ? lut.length - 1 : 0;
  const G = new Float32Array(w * h); // conductividad de cada celda (0 fuera del pincel: nada sale del pincel)
  for (let j = 0; j < h; j++) {
    const dy = y0 + (j0 + j) * c - d.y;
    for (let i = 0; i < w; i++) {
      const dx = x0 + (i0 + i) * c - d.x, q = (dx * dx + dy * dy) / r2;
      if (q >= 1) continue;
      let f;
      if (lut) { const u = Math.sqrt(q) * ln, kk = u | 0, a = u - kk; f = lut[kk] * (1 - a) + lut[kk + 1] * a; } else { const t = 1 - q; f = t * t; }
      G[j * w + i] = 0.24 * k * f;
    }
  }
  const br = Math.max(1, (d.r * 0.25) / c);
  const iters = Math.min(40, Math.max(2, Math.round(br * br * 0.5)));
  let A = new Float32Array(w * h), B = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) A[j * w + i] = F[(j0 + j) * nx + i0 + i];
  for (let it = 0; it < iters; it++) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const q = j * w + i, g = G[q];
      let v = A[q];
      if (g > 0) {
        if (i > 0) v += Math.min(g, G[q - 1]) * (A[q - 1] - A[q]);
        if (i < w - 1) v += Math.min(g, G[q + 1]) * (A[q + 1] - A[q]);
        if (j > 0) v += Math.min(g, G[q - w]) * (A[q - w] - A[q]);
        if (j < h - 1) v += Math.min(g, G[q + w]) * (A[q + w] - A[q]);
      }
      B[q] = v;
    }
    const t = A; A = B; B = t;
  }
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (G[j * w + i] > 0) F[(j0 + j) * nx + i0 + i] = A[j * w + i];
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
  const S = trackSamples(layout, elev, sp);
  // secciones socavadas: más detalle en la zanja y sus paredes
  if (sp.cutRanges && sp.cutRanges.length) {
    for (const c of sp.cutRanges) {
      const r = layout.routes[c.k];
      if (!r) continue;
      if (c.walls !== 'nat') continue; // paredes lisas: malla propia con la densidad de la pista (el terreno no suma detalle ahí)
      const f = subdivFactor(c.wallSubdiv ?? 2);
      if (f <= 1) continue;
      const len = c.s1 - c.s0, step = Math.max(3, r.w[0] * 0.5);
      const reach = c.walls === 'nat' ? 12 : 4;
      const add = [];
      for (let sv = c.s0; sv <= c.s1 + 1e-6; sv += step) {
        const ss = r.closed ? ((sv % r.L) + r.L) % r.L : Math.min(r.L, sv);
        const i = Math.min(r.n - 1, Math.round(ss / r.ds)) % r.n;
        const q = S.find((p) => p.k === c.k && p.i === i); // ancho con el camino de tierra y la barrera
        add.push({ x: r.x[i], y: r.y[i], r: (q ? Math.max(q.uL, q.uR) : r.w[i] / 2) + 4 + reach, e: false, f });
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
  // bajo un puente o un tramo suspendido el terreno no sube hasta la calzada; en un tramo elevado con suelo guardado el
  // terreno toma ese suelo (como si la pista siguiera ahí, a la altura que tenía al marcarlo)
  const groundOf = (p) => ({ ...p, z: p.gz, zc: p.gz, sr: 0, susp: false, virt: true });
  const sub = S.filter((p, j) => j % 4 === 0 && !p.bridge && (!p.susp || p.gz != null)).map((p) => (p.susp ? groundOf(p) : p));
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
  const idwPts = S.filter((p, j) => j % 12 === 0 && !p.bridge && (!p.susp || p.gz != null)).map((p) => (p.susp ? groundOf(p) : p));
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
      if ((only === 1 && p.susp) || (only === 2 && !p.susp) || (only === 3 && (!p.susp || p.cut))) return;
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
  const rockZ = (cut, floor, d, x, y, sg) => {
    const R = rockOf(cut), sz = R.size, k = R.rough / 25; // k = 1: la roca de siempre (25 %, 0,9 m, irregular)
    const sc = sz * (2.3 / 0.9);
    const n = cutNoise(x / sc, y / sc), n2 = cutNoise(x / sz + 31, y / sz - 17);
    const tg = Math.tan((cutAngle(cut, sg) * Math.PI) / 180) / 2.9; // ángulo de la pared (71° = pendiente de siempre)
    let z = floor + d * (2.9 + 1.4 * (n - 0.5) * Math.min(2, k)) * tg;
    const fade = Math.min(1, Math.max(0, (d - 0.3) / 0.5)); // el pie queda limpio
    if (R.style === 'sharp') { // crestas y aristas (ruido «ridged», con una octava más chica)
      const r1 = 1 - Math.abs(2 * n2 - 1), n3 = cutNoise(x / (sz * 0.45) + 7, y / (sz * 0.45) - 3), r2 = 1 - Math.abs(2 * n3 - 1);
      z += (r1 * r1 * 1.3 + r2 * r2 * 0.45 - 0.62) * 1.5 * k * fade;
    } else if (R.style === 'strata') { // capas: repisas casi planas y frentes empinados
      const hL = Math.max(0.35, sz * 1.1), t = (z - floor) / hL, fr = t - Math.floor(t);
      const zt = floor + hL * (Math.floor(t) + smoothstep(0.55, 1, fr));
      z += (zt - z) * Math.min(1, k) * fade + (n2 - 0.5) * 0.35 * k * fade;
    } else z += (n2 - 0.5) * 1.2 * k * fade;
    return Math.max(floor, z);
  };
  const cutInfo = (x, y) => {
    let best = Infinity, kind = null, idx = null;
    fine.query(x, y, maxW / 2 + 26, (p) => {
      if (!p.cut) return;
      const dx = x - p.x, dy = y - p.y;
      const a = Math.abs(dx * p.tx + dy * p.ty);
      const u = dx * -p.ty + dy * p.tx;
      const nat = p.cut.walls === 'nat';
      const ext = (u >= 0 ? p.uL : p.uR) + (nat ? 0.4 : 0.05); // calzada + camino de tierra + barrera (pared lisa: justo en su línea)
      // (en el lado de afuera de una curva las muestras se separan con la distancia lateral: la tolerancia a lo largo crece)
      const d = Math.hypot(Math.max(0, Math.abs(u) - ext), Math.max(0, a - p.ds * (0.6 + Math.abs(u) / 20)));
      const floor = p.z - gap;
      let z;
      if (!nat) { if (d > 1e-3) return; z = floor; } // pared lisa: la pone una malla propia extruida desde la pista (0.64); el terreno solo baja dentro
      else {
        z = rockZ(p.cut, floor, d, x, y, u >= 0 ? 1 : -1); // roca: pendiente con relieve (estilo, rugosidad, tamaño)
      }
      if (z < best) { best = z; kind = nat ? 'cutNat' : 'cutArt'; idx = p.cut.idx ?? 0; }
    });
    return { z: best, kind, idx };
  };
  const heightAt0 = anySusp ? (x, y, rho) => {
    const zone = zoneAt(x, y, rho, null, 1);
    const zs = zoneAt(x, y, rho, null, 3); // puentes y tramos suspendidos (en los socavados manda la zanja: cutInfo)
    let z;
    if (zone < Infinity) z = Math.min(zone, zs) - gap; // junto al extremo de un puente: tampoco sobre su tablero
    else {
      z = heightNat(x, y, rho);
      if (zs < Infinity) z = Math.min(z, zs - gap);
    }
    // dentro de una zanja manda su piso, también junto a sus extremos (ahí un triángulo grande alcanza la pista de afuera,
    // más alta, y sin esto el vértice quedaba a esa altura: sobre la rampa de entrada)
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
  // lagos socavados: lecho y agua planos. Lb = lecho (el punto más bajo del borde menos la profundidad), Lw = agua (0,3 de
  // la profundidad bajo ese borde); el cauce baja hasta Lb aunque el suelo suba (así el lecho nunca asoma sobre el agua)
  const riverLevels = new Map();
  const lakeLevels = (F) => {
    if (F.river.mode !== 'carved' || !F.isLake()) return null;
    if (riverLevels.has(F.river.id)) return riverLevels.get(F.river.id);
    let lo = Infinity;
    for (const L of F.contours(0)) for (const [x, y] of L) lo = Math.min(lo, heightAt0(x, y, 0.5));
    const lv = Number.isFinite(lo) ? { Lb: lo - F.depth, Lw: lo - 0.3 * F.depth } : null;
    riverLevels.set(F.river.id, lv);
    return lv;
  };
  const riverCarveRaw = (x, y) => {
    let c = 0;
    for (const F of RF) {
      const B = F.bounds; if (x < B.x0 || y < B.y0 || x > B.x1 || y > B.y1) continue;
      let v = F.carve(x, y);
      if (v > 0) { const lv = lakeLevels(F); if (lv) v = (v / F.depth) * Math.max(F.depth, heightAt0(x, y, 0.5) - lv.Lb); }
      if (v > c) c = v;
    }
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
  const painted = paint && paint.length && paint.some((st) => !st.e && paintFv(st.f ?? sp.paintFactor) !== 1); // más o menos polígonos
  // paredes lisas: estaciones (las mismas secciones que la pista) y puntos guía del terreno junto a ellas
  const anyArt = S.some((p) => p.cut && p.cut.walls !== 'nat');
  const capW = 0.3; // tapa angosta: el terreno se recorta justo en la pared (0.67), la tapa solo remata el borde
  const artSt = anyArt ? cutArtStations(layout, elev, sp, S, (x, y) => heightNat(x, y, 0.5), gap, capW) : [];
  // ríos: puntos guía en sus contornos (borde, media pared, pie y adentro del pie si va socavado; el borde si va posado)
  const riverGuides = [];
  for (const F of RF) {
    // (pocas filas y puntos separados según el ancho del río: dan la forma de las paredes y el borde del corte del lecho
    // sin sumar muchos triángulos)
    // socavado: la forma de las paredes la da «Densidad de las paredes» y el corte del lecho es exacto aunque no haya
    // puntos (los triángulos se recortan en el contorno): sin puntos extra. Posado con el agua «como el terreno»: una fila
    // en la orilla, así el agua sigue bien el contorno.
    const isos = F.river.mode === 'carved' || F.river.waterMode === 'simple' ? [] : [0];
    const st = clamp(F.rMed / 1.5, 1.5, 4);
    for (const iso of isos) for (const L of F.contours(iso, 0.08, st)) for (const [x, y] of L) riverGuides.push({ x, y, zMax: null });
  }
  const guides0 = S.some((p) => p.cut) ? cutGuidePoints(artSt, S, capW, layout, 2.5, (x, y) => heightNat(x, y, 0.5), gap, (cut) => 20 * Math.pow(1 / 20, clamp(sp.terrainDensity, 1, 100) / 100) / Math.sqrt(subdivFactor(cut.wallSubdiv ?? 2))) : null; // también con paredes naturales
  const guides = guides0 || riverGuides.length ? [...(guides0 || []), ...riverGuides] : null;
  const out = painted || guides
    ? adaptiveMesh(minX, minY, W, H, sp, paint || [], heightAt, guides)
    : gridMesh(minX, minY, W, H, sp, heightAt);
  out.bounds = { minX, minY, maxX, maxY };
  out.cutGuides = guides0 ? guides0.length : 0;
  out.riverGuides = riverGuides.length;
  out.tunnels = [];
  out.sculpted = !!SF;
  out.terrainType = TT;
  out.waterLevel = waterLevel;
  terrainColors(out, TT, waterLevel, nearestSide);
  out.rivers = RF.length;
  // cauces socavados (ríos) y paredes de las secciones socavadas: sus triángulos van aparte, con su propio material
  const carvedRivers = RF.some((F) => F.river.mode === 'carved');
  // paredes lisas de los tramos socavados: malla propia que sube desde el borde exterior de la pista (después del camino de
  // tierra y la barrera) hasta el suelo natural, con una tapa arriba y una cara exterior que baja bajo el suelo. En su
  // franja el terreno se abre (esos triángulos se quitan), así no hay escalones ni rampas contra la pared.
  if (carvedRivers || anyCut) {
    // tramos socavados: fuera el terreno bajo la pista (antes de separar la roca de las paredes naturales, que también se
    // corta). Línea de corte: paredes lisas, la de la pared; naturales, justo bajo el borde de la pista (10 cm adentro)
    let cutClip = null;
    if (anyCut) {
      // pared lisa inclinada hacia afuera: el corte sigue el borde de arriba de la cara (bajo la tapa), no su base
      const extOf = (p, u) => {
        const sg = u >= 0 ? 1 : -1, e = (sg > 0 ? p.uL : p.uR);
        if (p.cut.walls === 'nat') return e - 0.1;
        const k = cutLean(cutAngle(p.cut, sg));
        if (k <= 0) return e + 0.05;
        const zEdge = p.zc + p.sr * sg * (e + 0.05), lx = -p.ty * sg, ly = p.tx * sg;
        let off = k * Math.max(0.35, heightNat(p.x + lx * (e + 0.05), p.y + ly * (e + 0.05), 0.5) + 0.05 - zEdge);
        off = k * Math.max(0.35, heightNat(p.x + lx * (e + 0.05 + off), p.y + ly * (e + 0.05 + off), 0.5) + 0.05 - zEdge);
        return e + 0.05 + off + Math.min(0.15, wallOf(p.cut).width / 2);
      };
      const infoOf = (p, x, y, loose) => {
        const dx = x - p.x, dy = y - p.y, a = Math.abs(dx * p.tx + dy * p.ty), u = dx * -p.ty + dy * p.tx;
        const dd = Math.abs(u) - extOf(p, u);
        return { a, u, dd: loose ? Math.max(dd, a - p.ds) : dd, nat: p.cut.walls === 'nat', floor: p.z - gap };
      };
      const wallAt = (x, y) => {
        let best = null;
        fine.query(x, y, maxW / 2 + 4, (p) => {
          if (!p.cut) return;
          const w = infoOf(p, x, y, false);
          if (w.a > p.ds * (0.75 + Math.abs(w.u) / 20) || (best && w.a >= best.a)) return;
          best = w;
        });
        return best;
      };
      const wallAtLoose = (x, y) => {
        let best = null, bd = Infinity;
        fine.query(x, y, maxW / 2 + 30, (p) => {
          if (!p.cut) return;
          const d = (p.x - x) ** 2 + (p.y - y) ** 2;
          if (d < bd) { bd = d; best = p; }
        });
        return best ? infoOf(best, x, y, true) : null;
      };
      cutClip = { wallAt, wallAtLoose };
    }
    // ríos socavados: fuera el terreno del lecho (a partir del pie de las paredes; junto a la pista, donde el cauce se
    // desvanece, no se corta). Con «Lecho», un plano simple lo cubre; si no, solo queda el agua.
    const CR = RF.filter((F) => F.river.mode === 'carved');
    const rivAt = CR.length ? (x, y) => {
      let best = null;
      for (const F of CR) {
        const Bd = F.bounds;
        if (x < Bd.x0 || y < Bd.y0 || x > Bd.x1 || y > Bd.y1) continue;
        const sdv = F.sd(x, y);
        if (sdv < F.wallW - 2) continue;
        const dd = Math.max((F.wallW + 0.15) - sdv, 0.9 * F.depth - riverCarveAt(x, y)); // < 0: en el lecho
        if (!best || dd < best.dd) best = { dd, river: true };
      }
      return best;
    } : null;
    if (cutClip || rivAt) {
      const both = (a, b) => (!a ? b : !b ? a : b.dd < a.dd ? b : a);
      const W0 = (x, y) => both(cutClip ? cutClip.wallAt(x, y) : null, rivAt ? rivAt(x, y) : null);
      const WL = (x, y) => both(cutClip ? cutClip.wallAtLoose(x, y) : null, rivAt ? rivAt(x, y) : null);
      clipTerrainAtCuts(out, W0, (x, y) => {
        const w = W0(x, y) || WL(x, y);
        if (w && w.river) return heightAt(x, y, 0.5); // borde del lecho: la altura del cauce
        return w && w.nat ? Math.min(w.floor, heightNat(x, y, 0.5)) : heightNat(x, y, 0.5);
      }, WL);
    }
    const cutCarve = (x, y) => { const ci = cutInfo(x, y); if (!ci.kind || ci.kind === 'cutArt') return null; const zn = heightNat(x, y, 0.5); return zn - ci.z > 0.3 ? `cutNat:${ci.idx}` : null; }; // roca: una parte por tramo
    // paredes naturales: un triángulo es roca si cualquiera de sus vértices quedó bajo el suelo natural (> 0,15 m) dentro
    // de un socavado natural (antes se miraba solo el centro: los triángulos grandes que bajan del borde al pie quedaban
    // de pasto, como cuñas verdes en la pared). Solo es pasto lo que queda entero sobre el suelo natural.
    const PV = out.positions, natV = new Map();
    const natOfV = (v) => {
      let k = natV.get(v);
      if (k !== undefined) return k;
      const x = PV[v * 3], y = PV[v * 3 + 1];
      k = null;
      // dentro de la zanja: la superficie de la roca ahí queda bajo el suelo natural (no se mira la altura del vértice,
      // que en triángulos grandes se suaviza)
      const ci = cutInfo(x, y);
      if (ci.kind === 'cutNat' && heightNat(x, y, 0.5) - ci.z > 0.15) k = `cutNat:${ci.idx}`;
      natV.set(v, k);
      return k;
    };
    const classify = (x, y, a, b, c) => {
      if (carvedRivers && riverCarveAt(x, y) > 0.05) return 'river';
      if (!anyCut) return null;
      const byCentroid = cutCarve(x, y);
      if (byCentroid || a == null) return byCentroid;
      return natOfV(a) || natOfV(b) || natOfV(c);
    };
    splitParts(out, classify, { river: Math.max(0.5, sp.riverWallTile ?? 4), cutArt: Math.max(0.5, sp.cutWallTile ?? 4), cutNat: Math.max(0.5, sp.cutWallTile ?? 4) });
    out.wall = out.parts.river || null; // compatibilidad: cauces de los ríos
    // roca de las paredes naturales: todas juntas (vista) y una parte por tramo (textura propia / exportación)
    const natParts = Object.entries(out.parts).filter(([k]) => k.startsWith('cutNat:')).map(([k, q]) => ({ idx: +k.slice(7), ...q }));
    let nat = null;
    if (natParts.length) {
      // UV de la roca alineadas a la pared (sin estirarse en pendientes empinadas): u = largo del pie de la roca en cada
      // lado (acumulado por tramo, con ajuste a un número entero de repeticiones si se pide), v = distancia subiendo por
      // la roca desde el pie (con adaptación: la textura termina en el borde de arriba)
      const foot = new Map(); // `${j}:${lado}` → {c: largo acumulado del pie, t: repetición efectiva, N, UV}
      const byK = new Map();
      for (const p of S) { if (!byK.has(p.k)) byK.set(p.k, []); byK.get(p.k).push(p); }
      for (const list of byK.values()) {
        const n = list.length;
        let st = list.findIndex((p) => !(p.cut && p.cut.walls === 'nat'));
        if (st < 0) st = 0;
        const runs = [];
        let cur = null;
        for (let q = 0; q < n; q++) { const p = list[(st + q) % n]; if (p.cut && p.cut.walls === 'nat') { if (!cur) runs.push((cur = [])); cur.push(p); } else cur = null; }
        for (const run of runs) for (const sg of [1, -1]) {
          const UV = wallUVOf(run[0].cut, sp), sinA = Math.sin((cutAngle(run[0].cut, sg) * Math.PI) / 180);
          const fp = run.map((p) => { const e = (sg > 0 ? p.uL : p.uR) + 0.4; return [p.x - p.ty * sg * e, p.y + p.tx * sg * e]; });
          const c = [0];
          for (let q = 1; q < run.length; q++) c.push(c[q - 1] + Math.hypot(fp[q][0] - fp[q - 1][0], fp[q][1] - fp[q - 1][1]));
          const Lt = c[c.length - 1], t = UV.snap && Lt > 0.5 ? Lt / Math.max(1, Math.round(Lt / UV.x)) : UV.x;
          let hs = 0;
          run.forEach((p, q) => { hs += Math.max(0, heightNat(fp[q][0], fp[q][1], 0.5) - (p.z - gap)) / Math.max(0.2, sinA); });
          const N = Math.max(1, Math.round(hs / run.length / UV.y));
          const tanA = Math.tan((cutAngle(run[0].cut, sg) * Math.PI) / 180);
          run.forEach((p, q) => foot.set(`${p.j}:${sg}`, { c: c[q], t, N, UV, sinA: Math.max(0.2, sinA), tanA: Math.max(0.2, tanA) }));
        }
      }
      for (const q of natParts) {
        const P = q.positions, U = q.uvs;
        for (let v = 0; v < P.length / 3; v++) {
          const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
          let best = null, ba = Infinity;
          fine.query(x, y, maxW / 2 + 26, (p) => {
            if (!p.cut || p.cut.walls !== 'nat') return;
            const d2 = (p.x - x) ** 2 + (p.y - y) ** 2;
            if (d2 < ba) { ba = d2; best = p; }
          });
          if (!best) continue;
          const p = best, dx = x - p.x, dy = y - p.y, u = dx * -p.ty + dy * p.tx, sg = u >= 0 ? 1 : -1, F = foot.get(`${p.j}:${sg}`);
          if (!F) continue;
          const a = dx * p.tx + dy * p.ty, dd = Math.abs(u) - ((sg > 0 ? p.uL : p.uR) + 0.4), d = Math.max(0, dd), h = Math.max(0, z - (p.z - gap));
          // distancia sobre la roca desde el pie: por la pendiente (h / sen θ) y, pasado el borde de arriba, por el suelo
          const up = dd < 0 ? dd : h / F.sinA + Math.max(0, d - h / F.tanA), H = Math.max(0.3, heightNat(x, y, 0.5) - (p.z - gap)), f = F.UV.fit;
          U[v * 2] = (F.c + a) / F.t;
          U[v * 2 + 1] = (1 - f) * (up / F.UV.y) + f * Math.min(1, h / H) * F.N;
        }
      }
      const P = [], U = [], I = [];
      for (const q of natParts) { const b = P.length / 3; P.push(...q.positions); U.push(...q.uvs); for (const v of q.indices) I.push(b + v); }
      nat = { positions: new Float32Array(P), uvs: new Float32Array(U), indices: new Uint32Array(I), tris: I.length / 3, parts: natParts };
      out.parts.cutNat = nat;
    }
    out.cutWalls = { art: anyArt ? cutArtWalls(artSt, capW, Math.max(0.5, sp.cutWallTile ?? 4), sp) : null, nat };
  }
  for (const F of RF) lakeLevels(F); // niveles de los lagos (para su agua y su lecho)
  const groundAt = (x, y) => heightNat(x, y, 0.5); // nivel natural del suelo (sin las zanjas de las secciones socavadas)
  Object.defineProperty(out, 'ctx', { value: { S, fine, maxW, gap, zoneAt, heightAt, sp, origAt, riverCarveAt, inRiver, groundAt, cutStations: artSt, cutInfo, riverLevels }, enumerable: false });
  return out;
}

/**
 * Cerros como mallas independientes (una por cerro) y túneles donde un cerro cubre la pista.
 * hills: [{id, name, height, hard, flat, density, maxTris, strokes:[{x,y,r,e}]}] en metros.
 * Devuelve {hills:[{id,name,positions,uvs,indices,tris,cell,sample}], tunnels (tramos), tunnelGeo, sample(x,y)}.
 */
export function buildHills(layout, elev, spIn, T, hills) {
  const sp = { ...DEFAULT_SCENE, ...spIn };
  const res = { hills: [], tunnels: [], tunnelGeo: [], hiddenHills: [], sample: () => -Infinity, tris: 0 };
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
      const vault = nat ? top / tsp.tunnelHeight : 1;
      const half = tunnelInnerWidth(tsp, p.w, layout.routes[p.k]) / 2 * vault + (nat ? 0.6 + 3 * tsp.caveSize : 0) + 1;
      // marco y techo propios del túnel
      if (!t.box) { t.box = portalBox(tsp, layout.routes[t.k].w[0]); t.cover = Math.max(sp.tunnelRoof, t.box.thick + 0.3); }
      const q = { ...p, tun: id, top, half, open: t.openSide || 0, thick: t.box.thick, cover: t.cover, tw: tsp.tunnelWidth };
      tunReach = Math.max(tunReach, half + t.box.thick + 2 + (t.openSide ? 2 * tsp.tunnelWidth : 0), t.box.A + 2);
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
  // «Quitar cerro» en un túnel: los cerros que lo contienen no se generan (siguen definiendo el túnel)
  const hidden = new Set();
  for (const t of tun.runs) {
    if (!t.noHill) continue;
    const r = layout.routes[t.k];
    for (let ss = t.s0; ss <= t.s1; ss += Math.max(1, r.ds * 2)) {
      const i = ((Math.round(ss / r.ds) % r.n) + r.n) % r.n, x = r.x[i], y = r.y[i];
      for (const { h, f } of fields) if (!hidden.has(h.id) && x >= f.minX && y >= f.minY && x <= f.maxX && y <= f.maxY && f.sample(x, y) > 0) hidden.add(h.id);
    }
  }
  res.hiddenHills = [...hidden];
  for (const g of res.tunnelGeo) { // cerros que contienen a cada túnel (para la tarjeta: «afecta a …»)
    const t = runById.get(g.id), r = layout.routes[t.k], ids = new Set();
    for (let ss = t.s0; ss <= t.s1; ss += Math.max(1, r.ds * 2)) {
      const i = ((Math.round(ss / r.ds) % r.n) + r.n) % r.n, x = r.x[i], y = r.y[i];
      for (const { h, f } of fields) if (x >= f.minX && y >= f.minY && x <= f.maxX && y <= f.maxY && f.sample(x, y) > 0) ids.add(h.id);
    }
    g.hillIds = [...ids];
  }
  const boxById = new Map(res.tunnelGeo.map((g) => [g.id, g.box]));
  // contorno de cada boca (con la forma del túnel) para recortar el cerro: polígono convexo en (u lateral, altura sobre
  // la calzada), que baja un poco bajo el nivel de la calzada; cada lado con su función «afuera» (> 0 fuera del polígono)
  const c0vAll = -Math.min(0.25, gap * 0.8);
  const clipById = new Map(res.tunnelGeo.filter((g) => g.outline && g.outline.length >= 3).map((g) => {
    const floor = g.outline.filter((q) => q[1] <= 0.01).map((q) => q[0]);
    const u0 = floor.length ? Math.min(...floor) : -g.box.A, u1 = floor.length ? Math.max(...floor) : g.box.A;
    const poly = convexHull2([...g.outline, [u0, c0vAll], [u1, c0vAll]]);
    const edges = poly.map((a, i) => { const b = poly[(i + 1) % poly.length], ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1; return { ax: a[0], ay: a[1], nx: ey / l, ny: -ex / l }; });
    return [g.id, edges];
  }));
  const boxA = Math.max(box.A, ...res.tunnelGeo.map((g) => (g.box ? g.box.A : 0)));
  const { minX: bx0, minY: by0, maxX: bx1, maxY: by1 } = T.bounds;
  const sink = 0.4;
  const samplers = [];
  fields.forEach(({ h, f }, hi) => {
    if (hidden.has(h.id)) return; // cerro quitado: queda solo el túnel
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
    if (subPaint.some((q) => !q.e && paintFv(q.f ?? 4) !== 1)) {
      fmc = Math.max(0.3, Math.min(c0 / 2, Math.max(f.maxX - f.minX, f.maxY - f.minY) / 400));
      fmw = Math.ceil((f.maxX - f.minX) / fmc) + 1; fmh = Math.ceil((f.maxY - f.minY) / fmc) + 1;
      fmask = new Float32Array(fmw * fmh);
      for (const st of subPaint) {
        const fv = st.e ? 0 : paintFv(st.f ?? 4);
        const i0 = Math.max(0, Math.floor((st.x - st.r - x0) / fmc)), i1 = Math.min(fmw - 1, Math.ceil((st.x + st.r - x0) / fmc));
        const j0 = Math.max(0, Math.floor((st.y - st.r - y0) / fmc)), j1 = Math.min(fmh - 1, Math.ceil((st.y + st.r - y0) / fmc));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (Math.hypot(x0 + i * fmc - st.x, y0 + j * fmc - st.y) <= st.r) fmask[j * fmw + i] = fv === 1 ? 0 : fv;
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
            if (Math.abs(u) < p.half + 2 * p.tw) z = Math.min(z, p.z - gap - 0.5, tz - 0.3);
          } else if (Math.abs(u) < p.half + 1 + p.thick) {
            z = Math.max(z, p.zc + p.top + p.cover); // el cerro cubre el techo del túnel
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
        const nt = nearTunnel(mx, my, boxA + 2 * Math.max(cx, cy) + 2);
        if (nt) {
          const { p } = nt;
          const U = (q) => (q.x - p.x) * -p.ty + (q.y - p.y) * p.tx;
          const ZL = (q) => q.z - (p.zc + p.sr * clamp(U(q), -p.w / 2, p.w / 2));
          const V3 = [vert(a), vert(b), vert(cI)];
          const edges = clipById.get(p.tun);
          let pieces;
          if (edges) {
            // afuera del contorno de la boca (con la forma del túnel): lado i afuera y los anteriores adentro
            const fOut = edges.map((E2) => (q) => (U(q) - E2.ax) * E2.nx + (ZL(q) - E2.ay) * E2.ny);
            const vals = V3.map((q) => fOut.map((fn) => fn(q)));
            if (vals.every((vs) => vs.every((v) => v <= 0))) return; // dentro del hueco de la boca
            for (let e2 = 0; e2 < fOut.length; e2++) if (vals.every((vs) => vs[e2] >= 0)) { idx.push(a, b, cI); keptTri[ti] = 1; return; } // todo fuera de un mismo lado
            pieces = fOut.map((fn, e2) => [fn, ...fOut.slice(0, e2).map((g2) => (q) => -g2(q))]);
          } else {
            const bx = boxById.get(p.tun) || box;
            const B = bx.B, A = bx.A, c0v = -Math.min(0.25, gap * 0.8);
            const reg = (q) => { const zl = ZL(q), u = U(q); if (zl >= B) return 0; if (zl <= c0v) return 3; if (u >= A) return 1; if (u <= -A) return 2; return 4; };
            const R = V3.map(reg);
            if (R[0] === R[1] && R[1] === R[2]) { if (R[0] === 4) return; idx.push(a, b, cI); keptTri[ti] = 1; return; }
            pieces = [
              [(q) => ZL(q) - B],
              [(q) => B - ZL(q), (q) => ZL(q) - c0v, (q) => U(q) - A],
              [(q) => B - ZL(q), (q) => ZL(q) - c0v, (q) => -A - U(q)],
              [(q) => c0v - ZL(q)],
            ];
          }
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
/**
 * Ángulo de cada pared de un tramo socavado, en grados, medido desde el piso de la zanja: 90 = vertical; menos de 90 la
 * pared se abre hacia afuera (talud); más de 90 cuelga sobre la pista (solo las lisas: las naturales son el terreno).
 */
export const CUT_ANGLES = { art: { def: 90, min: 45, max: 135 }, nat: { def: 71, min: 45, max: 85 } };
/** Ángulo de la pared izquierda (sg > 0) o derecha (sg < 0) de un socavado (p.cut). */
export function cutAngle(cut, sg) {
  const R = CUT_ANGLES[cut && cut.walls === 'nat' ? 'nat' : 'art'];
  const a = cut ? (sg > 0 ? cut.angL : cut.angR) : null;
  return clamp(Number.isFinite(a) ? a : R.def, R.min, R.max);
}
/** Roca de las paredes naturales de un socavado: estilo ('irregular' | 'sharp' | 'strata'), rugosidad (0–100 %) y
 *  tamaño de las rocas (m). Por defecto, la de siempre. */
export function rockOf(cut) {
  const st = cut && (cut.rockStyle === 'sharp' || cut.rockStyle === 'strata') ? cut.rockStyle : 'irregular';
  return { style: st, rough: clamp(Number.isFinite(cut && cut.rough) ? cut.rough : 25, 0, 100), size: clamp(Number.isFinite(cut && cut.rockSize) ? cut.rockSize : 0.9, 0.3, 8) };
}
/** Pared lisa de un socavado: ancho (tapa, m) y caras exteriores ('show' | 'buried' = solo las que se ven | 'hide'). */
export function wallOf(cut) {
  const w = cut && Number.isFinite(cut.wallW) ? cut.wallW : 0.3;
  const o = cut && (cut.outer === 'buried' || cut.outer === 'hide') ? cut.outer : 'show';
  return { width: clamp(w, 0.1, 3), outer: o };
}
/**
 * Mapeo de la textura de las paredes de un socavado: repetición a lo largo (x) y en la altura (y) en metros, adaptación
 * a la altura (fit 0–1: 0 = metros exactos; 1 = la textura termina justo en el borde de arriba) y ajuste a un número
 * entero de repeticiones a lo largo (snap). El tramo usa los suyos (uvOwn) o los generales de la escena.
 */
export function wallUVOf(cut, sp = {}) {
  const t0 = Math.max(0.5, +sp.cutWallTile || 4);
  const G = { x: Number.isFinite(sp.cutWallTileX) ? sp.cutWallTileX : t0, y: Number.isFinite(sp.cutWallTileY) ? sp.cutWallTileY : t0, fit: +sp.cutWallFit || 0, snap: !!sp.cutWallSnap };
  const O = cut && cut.uvOwn ? { x: cut.tileX ?? G.x, y: cut.tileY ?? G.y, fit: cut.uvFit ?? G.fit, snap: cut.uvSnap ?? G.snap } : G;
  return { x: clamp(+O.x || t0, 0.1, 200), y: clamp(+O.y || t0, 0.1, 200), fit: clamp((+O.fit || 0) / 100, 0, 1), snap: !!O.snap }; // fit en %
}
/** Desplazamiento horizontal hacia afuera por metro de altura (cotangente; 0 en 90°). */
export const cutLean = (deg) => (Math.abs(deg - 90) < 1e-6 ? 0 : 1 / Math.tan((deg * Math.PI) / 180));

/**
 * Estaciones de las paredes lisas de los tramos socavados: las mismas secciones que la malla de la pista (trackRows:
 * densidad, «Optimizada», tope de triángulos y transiciones), así la base de la pared sigue el borde de la pista, del
 * camino de tierra y de la barrera sin cortes. Entre dos estaciones se agregan solo las que hacen falta para que el
 * borde de arriba siga el suelo natural (sobre la cuerda, sin salirse de la línea de la pista).
 * Cada pared tiene su ángulo (cutAngle): la cara interior sube desde la base inclinada hacia afuera (< 90°) o sobre la
 * pista (> 90°); la tapa va de su borde de arriba hacia afuera (y, si cuelga, hasta pasar la línea de la base).
 * Devuelve [{key (tramo), sg (+1 izquierda, -1 derecha), lean, rows: [{ix, iy (base, en la línea de la pared), nx, ny
 * (hacia afuera), zEdge (borde de la pista), zb (pie), bx, by (pie de la cara), tx, ty (borde de arriba de la cara),
 * ox, oy (borde de afuera de la tapa), top, zo, s}]}].
 */
export function cutArtStations(layout, elev, sp, S, nat, gap, capW) {
  const isArt = (p) => p && p.cut && p.cut.walls !== 'nat';
  if (!S.some(isArt)) return [];
  const rowsK = trackRows(layout, elev, { ...sp, skirts: sp.terrain && sp.skirts }).map((qs, k) => new Set(qs.map((q) => q % layout.routes[k].n)));
  const byRoute = new Map();
  for (const p of S) { if (!byRoute.has(p.k)) byRoute.set(p.k, []); byRoute.get(p.k).push(p); }
  const out = [];
  const TOL_UP = 0.12, TOL_DOWN = 0.35; // cuánto puede quedar el suelo sobre / bajo el borde recto de la pared
  const finish = (r) => {
    const k = r.lean;
    const cw = r.capW ?? capW; // ancho de la pared (tapa) de este tramo
    let top = Math.max(r.zb + 0.35, Math.max(nat(r.ix, r.iy), nat(r.ix + r.nx * cw, r.iy + r.ny * cw)) + 0.05);
    for (let it = 0; it < (k ? 3 : 1); it++) { // la altura mueve el borde de arriba (inclinada) y el borde, la altura
      const off = k * Math.max(0, top - r.zEdge), oo = Math.max(off, 0) + cw;
      r.tx = r.ix + r.nx * off; r.ty = r.iy + r.ny * off;
      r.ox = r.ix + r.nx * oo; r.oy = r.iy + r.ny * oo;
      const mid = cw > 0.6 ? nat((r.tx + r.ox) / 2, (r.ty + r.oy) / 2) : -Infinity; // tapa ancha: que el suelo no asome al medio
      top = Math.max(r.zb + 0.35, Math.max(nat(r.tx, r.ty), nat(r.ox, r.oy), mid) + 0.05);
    }
    r.top = top;
    const bo = k * (r.zb - r.zEdge); // el pie sigue la misma inclinación (bajo la barrera / el camino)
    r.bx = r.ix + r.nx * bo; r.by = r.iy + r.ny * bo;
    r.natO = nat(r.ox, r.oy);
    r.zo = Math.min(top, r.natO) - 1;
    return r;
  };
  const L = (A, B, t, f) => A[f] + (B[f] - A[f]) * t;
  const lerp = (A, B, t) => {
    let nx = L(A, B, t, 'nx'), ny = L(A, B, t, 'ny');
    const h = Math.hypot(nx, ny) || 1; nx /= h; ny /= h;
    return finish({ ix: L(A, B, t, 'ix'), iy: L(A, B, t, 'iy'), nx, ny, zEdge: L(A, B, t, 'zEdge'), zb: L(A, B, t, 'zb'), s: L(A, B, t, 's'), lean: A.lean, capW: A.capW, extra: true });
  };
  for (const [k, list] of byRoute) {
    const n = list.length;
    let start = list.findIndex((p) => !isArt(p));
    if (start < 0) start = 0;
    const runs = [];
    let cur = null;
    for (let q = 0; q < n; q++) {
      const p = list[(start + q) % n];
      if (isArt(p)) { if (!cur) runs.push((cur = [])); cur.push(p); } else cur = null;
    }
    const rows = rowsK[k] || new Set();
    for (const run of runs) {
      if (run.length < 2) continue;
      const key = run[0].cut.idx ?? 0;
      const keep = run.filter((p, j) => j === 0 || j === run.length - 1 || rows.has(p.i));
      for (const sg of [1, -1]) {
        const lean = cutLean(cutAngle(run[0].cut, sg));
        const wallW = wallOf(run[0].cut).width;
        const st = keep.map((p) => {
          const ext = (sg > 0 ? p.uL : p.uR) + 0.05, lx = -p.ty * sg, ly = p.tx * sg, zEdge = p.zc + p.sr * sg * ext;
          return finish({ ix: p.x + lx * ext, iy: p.y + ly * ext, nx: lx, ny: ly, zEdge, zb: zEdge - Math.max(0.35, gap + 0.05), s: p.s, i: p.i, lean, capW: wallW });
        });
        const res = [st[0]];
        const refine = (A, B, depth) => {
          if (depth > 7 || Math.hypot(B.ix - A.ix, B.iy - A.iy) < 1.5) return;
          let need = false;
          for (const t of [0.25, 0.5, 0.75]) {
            const dev = lerp(A, B, t).top - (A.top + (B.top - A.top) * t);
            if (dev > TOL_UP || dev < -TOL_DOWN) { need = true; break; }
          }
          if (!need) return;
          const M = lerp(A, B, 0.5);
          refine(A, M, depth + 1); res.push(M); refine(M, B, depth + 1);
        };
        for (let j = 1; j < st.length; j++) { refine(st[j - 1], st[j], 0); res.push(st[j]); }
        out.push({ key, sg, k, lean, rows: res, cut: run[0].cut });
      }
    }
  }
  return out;
}

/**
 * Malla de las paredes lisas (cara interior, tapa, cara exterior, pie y extremos) a partir de sus estaciones
 * (cutArtStations). UV sin deformación: a lo largo, el largo de cada borde de cada cara (en una curva, la cara de adentro
 * y la de afuera miden lo suyo); en la altura, el largo sobre la cara. Repetición X / Y, adaptación a la altura y ajuste a
 * un número entero de repeticiones según wallUVOf. Cada tramo lleva sus índices por parte: face (cara interior y pie),
 * top (tapa) y out (cara exterior y extremos), para texturas distintas. Caras exteriores: según wallOf(cut).outer.
 */
export function cutArtWalls(stations, capW, tile = 4, sp = {}) {
  const parts = new Map(); // por tramo socavado (idx): {pos, uv, face, top, out}
  for (const { key, sg, rows, cut } of stations) {
    if (rows.length < 2) continue;
    if (!parts.has(key)) parts.set(key, { pos: [], uv: [], face: [], top: [], out: [] });
    const Pt = parts.get(key), pos = Pt.pos, uv = Pt.uv;
    const UV = wallUVOf(cut, { cutWallTile: tile, ...sp }), W = wallOf(cut);
    // largo acumulado de un borde (polilínea) y su repetición efectiva (ajustada a un número entero si se pide)
    const along = (fx, fy) => {
      const c = [0];
      for (let j = 1; j < rows.length; j++) c.push(c[j - 1] + Math.hypot(rows[j][fx] - rows[j - 1][fx], rows[j][fy] - rows[j - 1][fy]));
      const Lt = c[c.length - 1], t = UV.snap && Lt > 0.5 ? Lt / Math.max(1, Math.round(Lt / UV.x)) : UV.x;
      return c.map((v) => v / t);
    };
    const uB = along('bx', 'by'), uT = along('tx', 'ty'), uO = along('ox', 'oy');
    // tira a lo largo: A/B = vértices de cada fila, uA/uB = u de cada borde, vA/vB = v; el orden deja las normales afuera
    const strip = (list, A, B, uA, uBv, vA, vB, skip = null) => {
      const base = pos.length / 3;
      rows.forEach((r, j) => { pos.push(...A(r), ...B(r)); uv.push(uA[j], vA(r), uBv[j], vB(r)); });
      for (let q = 0; q < rows.length - 1; q++) {
        if (skip && skip(q)) continue;
        const a0 = base + q * 2, b0 = a0 + 1, a1 = a0 + 2, b1 = a0 + 3;
        if (sg > 0) list.push(a0, a1, b0, b0, a1, b1); else list.push(a0, b0, a1, b0, b1, a1);
      }
    };
    // cara interior: v sobre la cara; con adaptación, la textura termina justo en el borde de arriba
    const faceV = (r) => Math.hypot(r.top - r.zb, Math.hypot(r.tx - r.bx, r.ty - r.by));
    const Lf = rows.reduce((a, r) => a + faceV(r), 0) / rows.length, Nf = Math.max(1, Math.round(Lf / UV.y)), f = UV.fit;
    strip(Pt.face, (r) => [r.bx, r.by, r.zb], (r) => [r.tx, r.ty, r.top], uB, uT, (r) => (1 - f) * (r.zb / UV.y), (r) => (1 - f) * ((r.zb + faceV(r)) / UV.y) + f * Nf);
    strip(Pt.top, (r) => [r.tx, r.ty, r.top], (r) => [r.ox, r.oy, r.top], uT, uO, () => 0, (r) => Math.hypot(r.ox - r.tx, r.oy - r.ty) / UV.y); // tapa
    // cara exterior: se puede ocultar toda o solo donde el suelo la tapa (enterrada)
    if (W.outer !== 'hide') {
      const buried = (r) => r.top - (r.natO ?? r.top) <= 0.12;
      strip(Pt.out, (r) => [r.ox, r.oy, r.top], (r) => [r.ox, r.oy, r.zo], uO, uO, (r) => r.top / UV.y, (r) => r.zo / UV.y, W.outer === 'buried' ? (q) => buried(rows[q]) && buried(rows[q + 1]) : null);
    }
    // pie: franja angosta hacia la pista a la altura de la base (tapa la rendija entre la barrera o el camino y la pared)
    strip(Pt.face, (r) => [r.bx - r.nx * 0.4, r.by - r.ny * 0.4, r.zb], (r) => [r.bx, r.by, r.zb], uB, uB, () => -0.4 / UV.y, () => 0);
    // tapas de los extremos (el perfil de la pared), mirando hacia afuera del tramo
    for (const [r, o] of [[rows[0], rows[1]], [rows[rows.length - 1], rows[rows.length - 2]]]) {
      const base = pos.length / 3, fx = r.ix - o.ix, fy = r.iy - o.iy; // hacia afuera del tramo
      const cw = r.capW ?? capW;
      const Q = [[r.bx, r.by, r.zb], [r.tx, r.ty, r.top], [r.ox, r.oy, r.top], [r.ox, r.oy, r.zo], [r.ix + r.nx * cw, r.iy + r.ny * cw, r.zb]];
      for (const v of Q) { pos.push(...v); uv.push(((v[0] - r.ix) * r.nx + (v[1] - r.iy) * r.ny) / UV.x, v[2] / UV.y); }
      // perfil cerrado: pie de la cara → arriba → tapa → pie de afuera → bajo la base (sirve también si la cara cuelga)
      for (const [a, b2, c] of [[0, 1, 2], [0, 2, 4], [4, 2, 3]]) {
        const A = Q[a], B = Q[b2], C = Q[c];
        const nx = (B[1] - A[1]) * (C[2] - A[2]) - (B[2] - A[2]) * (C[1] - A[1]), ny = (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]);
        if (nx * fx + ny * fy >= 0) Pt.out.push(base + a, base + b2, base + c); else Pt.out.push(base + a, base + c, base + b2);
      }
    }
  }
  // una malla por tramo (exportación; con sus índices por parte) y todas juntas (vista)
  const P = [], U = [], I = [], list = [];
  for (const [k, q] of parts) {
    const all = [...q.face, ...q.top, ...q.out];
    if (!all.length) continue;
    const base = P.length / 3;
    P.push(...q.pos); U.push(...q.uv); for (const v of all) I.push(base + v);
    list.push({ idx: k, positions: new Float32Array(q.pos), uvs: new Float32Array(q.uv), indices: new Uint32Array(all), tris: all.length / 3, sub: { face: new Uint32Array(q.face), top: new Uint32Array(q.top), out: new Uint32Array(q.out) } });
  }
  if (!I.length) return null;
  const stationsN = stations.reduce((a, w) => a + w.rows.length, 0);
  return { positions: new Float32Array(P), uvs: new Float32Array(U), indices: new Uint32Array(I), tris: I.length / 3, extruded: true, parts: list, stations: stationsN };
}

/**
 * Puntos guía del terreno para las paredes lisas: una fila justo afuera de cada pared (bajo la tapa), una justo adentro
 * y una por el centro del fondo, cada ≤ 2,5 m (y unos metros más allá de los extremos del socavado). Así ningún
 * triángulo del terreno cruza de un lado al otro de la zanja ni tapa la rampa de entrada, aunque la densidad sea baja.
 * Devuelve [{x, y, zMax}] (zMax: altura máxima del punto; null = la que diga el terreno).
 */
export function cutGuidePoints(stations, S, capW, layout, step = 2.5, natAt = null, gap = 0.3, cellHint = null) {
  const pts = [];
  const push = (x, y, zMax = null) => pts.push({ x, y, zMax });
  for (const { rows } of stations) {
    let lx = Infinity, ly = Infinity;
    for (let j = 0; j < rows.length; j++) {
      const A = rows[j];
      // en cada estación (si la pista es muy densa, cada ~step m): afuera, pegado a la tapa, y adentro (queda bajo la pista)
      if (j === 0 || j === rows.length - 1 || Math.hypot(A.ix - lx, A.iy - ly) >= step * 0.8) {
        push(A.ox + A.nx * 0.1, A.oy + A.ny * 0.1, A.top - 0.03);
        push(A.ix - A.nx * 0.35, A.iy - A.ny * 0.35);
        lx = A.ix; ly = A.iy;
      }
      if (j === rows.length - 1) break;
      const B = rows[j + 1], L = Math.hypot(B.ix - A.ix, B.iy - A.iy), m = Math.floor(L / step);
      for (let q = 1; q <= m; q++) {
        const t = q / (m + 1);
        const ix = A.ix + (B.ix - A.ix) * t, iy = A.iy + (B.iy - A.iy) * t, ox = A.ox + (B.ox - A.ox) * t, oy = A.oy + (B.oy - A.oy) * t;
        const nx = A.nx + (B.nx - A.nx) * t, ny = A.ny + (B.ny - A.ny) * t;
        push(ox + nx * 0.1, oy + ny * 0.1, A.top + (B.top - A.top) * t - 0.03);
        push(ix - nx * 0.35, iy - ny * 0.35);
      }
    }
  }
  // paredes naturales (son el terreno): una fila bajo el borde de la pista y otra en el pie de la roca
  const isNat = (p) => p && p.cut && p.cut.walls === 'nat';
  const byRoute = new Map();
  for (const p of S) { if (!byRoute.has(p.k)) byRoute.set(p.k, []); byRoute.get(p.k).push(p); }
  const lattice = { n: 0, max: 40000 };
  // grilla de la roca con relieve: pasos según el tamaño de las rocas y «Densidad de las paredes»; solo si los triángulos
  // del terreno en la roca (cellHint(cut)) son más grandes que esos pasos (con terreno denso no hace falta)
  const latticeOf = (cut) => {
    const R = rockOf(cut);
    if (!(R.rough > 0)) return null;
    if (!Number.isFinite(cut.rough) && !Number.isFinite(cut.rockSize) && !cut.rockStyle) return null; // la roca de siempre (sin tocar): igual que antes
    const f = [1.8, 1.4, 1, 0.8, 0.65, 0.55, 0.5][Math.max(0, Math.min(6, Math.round(cut.wallSubdiv ?? 2)))];
    const stA = Math.max(0.6, Math.min(3, R.size * 1.1 * f)), stC = Math.max(0.5, Math.min(2.5, R.size * 0.85 * f));
    if (cellHint && cellHint(cut) <= stC * 1.5) return null;
    return { stA, stC };
  };
  for (const list of byRoute.values()) {
    const n = list.length, ds = list[0].ds || 1, every = Math.max(1, Math.round(step / ds));
    for (let i = 0; i < n; i++) {
      const p = list[i];
      const onEvery = !(i % every && isNat(list[i - 1]) && isNat(list[i + 1]));
      if (!isNat(p)) continue;
      const lt = latticeOf(p.cut), lat = !!lt && i % Math.max(1, Math.round(lt.stA / ds)) === 0;
      if (!onEvery && !lat) continue;
      for (const sg of [1, -1]) {
        const ext = sg > 0 ? p.uL : p.uR, lx = -p.ty * sg, ly = p.tx * sg;
        push(p.x + lx * (ext - 0.3), p.y + ly * (ext - 0.3));
        push(p.x + lx * (ext + 0.4), p.y + ly * (ext + 0.4)); // pie de la roca
        if (!natAt) continue;
        // borde de arriba de la roca (donde la pendiente llega al suelo natural) y, si es alta, una fila al medio: así la
        // roca queda con su forma aunque el terreno tenga triángulos grandes
        const floor = p.z - gap, at = (d) => [p.x + lx * (ext + 0.4 + d), p.y + ly * (ext + 0.4 + d)];
        const slope = Math.tan((cutAngle(p.cut, sg) * Math.PI) / 180); // pendiente media de la roca
        let d = Math.max(0, natAt(...at(0)) - floor) / slope;
        d = Math.max(0, natAt(...at(d)) - floor) / slope;
        if (d < 0.5) continue;
        push(...at(d));
        push(...at(d + 0.3)); // justo afuera del borde: el límite entre roca y pasto queda en una línea limpia
        if (d > 3) push(...at(d / 2));
        // con relieve: una grilla de puntos sobre la roca (según el tamaño de las rocas y la densidad de las paredes), así
        // el relieve se ve aunque el terreno tenga triángulos grandes
        const lt = latticeOf(p.cut);
        if (lt && i % Math.max(1, Math.round(lt.stA / ds)) === 0) for (let dd = lt.stC; dd < d - lt.stC * 0.4; dd += lt.stC) if (lattice.n++ < lattice.max) push(...at(dd));
      }
    }
  }
  // fondo: por el centro de la pista, desde unos metros antes hasta unos metros después de cada socavado
  const isCut = (p) => p && p.cut;
  for (const [k, list] of byRoute) {
    const n = list.length, ds = list[0].ds || 1, reach = Math.ceil(8 / ds), every = Math.max(1, Math.round(step / ds));
    const closed = !!(layout && layout.routes[k] && layout.routes[k].closed);
    const near = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!isCut(list[i])) continue;
      for (let o = -reach; o <= reach; o++) { const j = i + o; if (j >= 0 && j < n) near[j] = 1; else if (closed) near[((j % n) + n) % n] = 1; }
    }
    for (let i = 0; i < n; i++) if (near[i] && (i % every === 0 || !near[(i + n - 1) % n] || !near[(i + 1) % n])) push(list[i].x, list[i].y);
  }
  return pts;
}

/**
 * Recorta el terreno en los tramos socavados: se quita lo que queda bajo la pista (nunca se ve; lo tapan la pista, el
 * camino de tierra, la barrera y las paredes). wallAt(x, y) = {dd (distancia firmada a la línea de corte; > 0 afuera),
 * nat (pared natural), floor (piso de la zanja)} o null lejos de un socavado; wallAtLoose igual, sin la tolerancia a lo
 * largo (para los vértices lejanos de un triángulo que entra en la zanja). Los triángulos que cruzan la línea pierden la
 * parte de adentro; los vértices nuevos del corte toman zAt(x, y) (paredes lisas: el suelo natural, bajo la tapa;
 * naturales: el piso, así la roca arranca bajo el borde de la pista y nunca pasa sobre ella). Agrega pocos vértices.
 */
export function clipTerrainAtCuts(T, wallAt, zAt, wallAtLoose = null) {
  const P0 = T.positions, U0 = T.uvs, C0 = T.colors, B = T.baseIndices || T.indices;
  const nv0 = P0.length / 3;
  const info = new Array(nv0), loose = new Array(nv0);
  const ddOf = (v) => { if (info[v] === undefined) info[v] = wallAt(P0[v * 3], P0[v * 3 + 1]) || null; return info[v]; };
  const ddLoose = (v) => { const w = ddOf(v); if (w) return w; if (loose[v] === undefined) loose[v] = (wallAtLoose && wallAtLoose(P0[v * 3], P0[v * 3 + 1])) || { dd: 1e3 }; return loose[v]; };
  const P = Array.from(P0), U = U0 ? Array.from(U0) : null, C = C0 ? Array.from(C0) : null;
  const edgeV = new Map();
  const cutVertex = (a, b, da, db) => {
    const key = a < b ? a * nv0 + b : b * nv0 + a;
    let v = edgeV.get(key);
    if (v !== undefined) return v;
    const t = da / (da - db);
    const x = P[a * 3] + (P[b * 3] - P[a * 3]) * t, y = P[a * 3 + 1] + (P[b * 3 + 1] - P[a * 3 + 1]) * t;
    v = P.length / 3;
    P.push(x, y, zAt(x, y));
    if (U) U.push(U[a * 2] + (U[b * 2] - U[a * 2]) * t, U[a * 2 + 1] + (U[b * 2 + 1] - U[a * 2 + 1]) * t);
    if (C) for (let k = 0; k < 3; k++) C.push(C[a * 3 + k] + (C[b * 3 + k] - C[a * 3 + k]) * t);
    edgeV.set(key, v);
    return v;
  };
  const out = [];
  let clipped = 0, removed = 0;
  for (let q = 0; q < B.length; q += 3) {
    const vs = [B[q], B[q + 1], B[q + 2]];
    const W0 = vs.map(ddOf);
    if (!W0.some((w) => w && w.dd < 0)) {
      // vértices afuera pero el triángulo cruza por encima de lo que se quita (lecho de un río, de orilla a orilla): fuera
      if (W0.some((w) => w && w.river)) {
        const mx = (P0[vs[0] * 3] + P0[vs[1] * 3] + P0[vs[2] * 3]) / 3, my = (P0[vs[0] * 3 + 1] + P0[vs[1] * 3 + 1] + P0[vs[2] * 3 + 1]) / 3, wc = wallAt(mx, my);
        if (wc && wc.river && wc.dd < -0.3) { removed++; continue; }
      }
      out.push(vs[0], vs[1], vs[2]);
      continue;
    } // nada bajo la pista
    const W = vs.map(ddLoose);
    if (W.every((w) => w.dd <= 0)) { removed++; continue; } // todo bajo la pista: se quita
    // polígono de la parte de afuera (dd >= 0), en el orden original (conserva el sentido de las caras)
    const poly = [];
    for (let k = 0; k < 3; k++) {
      const a = vs[k], b = vs[(k + 1) % 3], da = W[k].dd, db = W[(k + 1) % 3].dd;
      if (da >= 0) poly.push(a);
      if ((da >= 0) !== (db >= 0)) poly.push(cutVertex(a, b, da, db));
    }
    for (let k = 1; k < poly.length - 1; k++) out.push(poly[0], poly[k], poly[k + 1]);
    clipped++;
  }
  const others = T.otherIndices || new Uint32Array(0);
  T.positions = new Float32Array(P);
  if (U) T.uvs = new Float32Array(U);
  if (C) T.colors = new Float32Array(C);
  T.baseIndices = new Uint32Array(out);
  const all = new Uint32Array(out.length + others.length); all.set(out); all.set(others, out.length);
  T.indices = all;
  T.clippedAtWalls = clipped;
  T.removedUnderTrack = removed;
  return T;
}

export function splitParts(mesh, classify, tiles = {}) {
  const P = mesh.positions, I = mesh.indices;
  const base = [], groups = {}, others = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const x = (P[a * 3] + P[b * 3] + P[c * 3]) / 3, y = (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3;
    const key = classify(x, y, a, b, c);
    if (key) { (groups[key] || (groups[key] = [])).push(a, b, c); others.push(a, b, c); } else base.push(a, b, c);
  }
  mesh.baseIndices = new Uint32Array(base);
  mesh.otherIndices = new Uint32Array(others);
  mesh.parts = {};
  for (const [key, list] of Object.entries(groups)) {
    const tile = tiles[key] || tiles[key.split(':')[0]] || 4;
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

function adaptiveMesh(minX, minY, W, H, sp, paint, heightAt, guides = null) {
  // 1) máscara de lo pintado: cada celda guarda el multiplicador de densidad de la última pincelada que la tocó
  //    (cada pincelada lleva su propio multiplicador «f»; las antiguas usan el general sp.paintFactor)
  const mc = Math.max(1, Math.max(W, H) / 600);
  const mw = Math.ceil(W / mc) + 1, mh = Math.ceil(H / mc) + 1;
  const mask = new Float32Array(mw * mh);
  const defF = Math.max(1, sp.paintFactor);
  for (const st of paint) {
    const fv = st.e ? 0 : paintFv(st.f ?? defF);
    const i0 = Math.max(0, Math.floor((st.x - st.r - minX) / mc)), i1 = Math.min(mw - 1, Math.ceil((st.x + st.r - minX) / mc));
    const j0 = Math.max(0, Math.floor((st.y - st.r - minY) / mc)), j1 = Math.min(mh - 1, Math.ceil((st.y + st.r - minY) / mc));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (Math.hypot(minX + i * mc - st.x, minY + j * mc - st.y) <= st.r) mask[j * mw + i] = fv === 1 ? 0 : fv;
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
  const nG = guides ? guides.length : 0; // puntos guía (paredes lisas): fijos, el resto se ajusta al tope
  if (2 * (pts + nG) > maxTris) c *= Math.sqrt((2 * pts) / Math.max(200, maxTris - 2 * nG));
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
  const g0 = P.length / 2; // desde aquí, los puntos guía
  if (nG) for (const g of guides) P.push(clamp(g.x, minX, minX + W), clamp(g.y, minY, minY + H));
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
    let z = heightAt(x, y, rhoV[v] * 1.05 + 0.5);
    if (v >= g0 && guides[v - g0].zMax != null) z = Math.min(z, guides[v - g0].zMax); // afuera de una pared lisa: bajo la tapa
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
    // ni dentro de una zanja con paredes lisas (entre las paredes y sobre su tapa)
    if (ok) g.query(x, y, maxW / 2 + 22, (p) => { // (+20 m: paredes inclinadas hacia afuera)
      if (!ok || !p.cut || p.cut.walls === 'nat') return;
      const dx = x - p.x, dy = y - p.y;
      const u = dx * -p.ty + dy * p.tx;
      if (Math.abs(dx * p.tx + dy * p.ty) > p.ds * (0.75 + Math.abs(u) / 20)) return;
      // inclinada hacia afuera: tampoco sobre la cara (hasta su borde de arriba)
      const sg = u >= 0 ? 1 : -1, k = Math.max(0, cutLean(cutAngle(p.cut, sg)));
      const zg = k && ground && ground.sample ? ground.sample(x, y) : null, zEdge = p.zc + p.sr * sg * ((sg > 0 ? p.uL : p.uR) + 0.05);
      const lean = zg != null && Number.isFinite(zg) ? k * Math.max(0, zg - zEdge) : 0;
      if (Math.abs(u) < (u >= 0 ? p.uL : p.uR) + Math.max(0.5, wallOf(p.cut).width + 0.2) + lean) ok = false;
    });
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
  if (Array.isArray(set.bake)) { // lista fija (editada a mano): mismas posiciones, apoyadas en el suelo actual
    const zf = ground ? null : roadZFallback(layout, elev, sp);
    return set.bake.map((b, i) => {
      const [x, y] = layout.toWorld ? layout.toWorld(b[0], b[1]) : [b[0], b[1]];
      const p = vegPlace(ground, x, y, set.tilt ?? 0, zf ? zf(x, y) : 0);
      return { x, y, z: p.z, up: p.up, yaw: b[2] || 0, s: b[3] ?? 1, pick: b[4] ?? 0, bi: i };
    });
  }
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
  }).map((it, i) => ({ ...it, bi: i }));
}

/** Base ortonormal (A, B) perpendicular a U. */
function basis(U) {
  const ref = Math.abs(U[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let A = [U[1] * ref[2] - U[2] * ref[1], U[2] * ref[0] - U[0] * ref[2], U[0] * ref[1] - U[1] * ref[0]];
  const l = Math.hypot(...A); A = A.map((v) => v / l);
  const B = [U[1] * A[2] - U[2] * A[1], U[2] * A[0] - U[0] * A[2], U[0] * A[1] - U[1] * A[0]];
  return [A, B];
}

/** Altura de la calzada más cercana menos la separación del terreno (apoyo de árboles y adornos sin terreno). */
function roadZFallback(layout, elev, sp) {
  const g = new SpatialGrid(20);
  layout.routes.forEach((r, k) => { const e = elev.routes[k]; for (let i = 0; i < r.n; i += 2) g.insert(r.x[i], r.y[i], { x: r.x[i], y: r.y[i], z: e.z[i] }); });
  return (x, y) => {
    for (const rad of [30, 200, 2000]) {
      let best = null, bd = Infinity;
      g.query(x, y, rad, (q) => { const d = (q.x - x) ** 2 + (q.y - y) ** 2; if (d < bd) { bd = d; best = q; } });
      if (best) return best.z - (sp.terrainGap ?? 0);
    }
    return 0;
  };
}

/**
 * Apoya un árbol o un adorno en (x, y): altura del suelo (terreno o cerro), eje «up» según la inclinación pedida
 * (tilt 0..100 respecto de la normal) y pendiente. Se usa para las listas fijas (editadas a mano) y al moverlos.
 */
export function vegPlace(ground, x, y, tiltPct = 0, zFallback = 0) {
  const tilt = clamp(tiltPct ?? 0, 0, 100) / 100;
  let z = ground ? ground.sample(x, y) : zFallback;
  if (!Number.isFinite(z)) z = zFallback;
  let up = [0, 0, 1], cosA = 1, where = 'terrain';
  if (ground) {
    const n = groundNormal(ground, x, y);
    const ux = n[0] * tilt, uy = n[1] * tilt, uz = 1 - tilt + n[2] * tilt;
    const l = Math.hypot(ux, uy, uz);
    up = [ux / l, uy / l, uz / l];
    cosA = clamp(up[0] * n[0] + up[1] * n[1] + up[2] * n[2], 0.05, 1);
    if (ground.classify) { const c = ground.classify(x, y); if (c) where = c.kind; }
  }
  return { x, y, z, up, slope: Math.sqrt(1 - cosA * cosA) / cosA, where };
}

/** Un árbol apoyado en p (de scatter o vegPlace): se hunde lo necesario para que el borde de la base no flote en pendiente. */
function makeTree(p, h, rad, yaw, ex, ey, bi, mi = bi) {
  const sink = 0.3 + Math.min(0.6 * h, rad * p.slope);
  const base = [p.x - p.up[0] * sink, p.y - p.up[1] * sink, p.z - p.up[2] * sink];
  return { x: p.x, y: p.y, z: p.z, base: base[2], basePos: base, up: p.up, h, r: rad, yaw, ex, ey, where: p.where, bi, mi };
}

/** Vértices del cono de un árbol (8 lados + punta + centro de la base = 10 vértices, 30 números). */
export function treeConeVerts(t, out = new Float32Array(30), o = 0) {
  const seg = 8;
  const [A, B] = basis(t.up);
  const [bx, by, bz] = t.basePos;
  const cy = Math.cos(t.yaw), sy = Math.sin(t.yaw);
  for (let k2 = 0; k2 < seg; k2++) {
    const a = (k2 / seg) * Math.PI * 2;
    const lx = Math.cos(a) * t.r * t.ex, ly = Math.sin(a) * t.r * t.ey; // local, antes del giro
    const c = lx * cy - ly * sy, sn = lx * sy + ly * cy;
    out[o++] = bx + A[0] * c + B[0] * sn; out[o++] = by + A[1] * c + B[1] * sn; out[o++] = bz + A[2] * c + B[2] * sn;
  }
  out[o++] = bx + t.up[0] * t.h; out[o++] = by + t.up[1] * t.h; out[o++] = bz + t.up[2] * t.h;
  out[o++] = bx; out[o++] = by; out[o++] = bz;
  return out;
}

/** Árbol movido a mano a (x, y): nueva posición apoyada en el suelo, con su mismo tamaño y giro. */
export function moveTree(t, ground, x, y, tiltPct, zFallback) {
  return makeTree(vegPlace(ground, x, y, tiltPct, zFallback ?? t.z), t.h, t.r, t.yaw, t.ex, t.ey, t.bi, t.mi);
}

const r3 = (v) => Math.round(v * 1000) / 1000;
/** Lista fija de árboles (para editarlos uno a uno): en coordenadas del mapa y con el tamaño relativo a la escala. */
export function bakeTreeList(layout, trees, treeScale = 1) {
  const k = Math.max(0.01, treeScale);
  return trees.map((t) => { const [lx, ly] = layout.toLayout ? layout.toLayout(t.x, t.y) : [t.x, t.y]; return [r3(lx), r3(ly), r3(t.h / k), r3(t.r / k), r3(t.yaw), r3(t.ex), r3(t.ey), t.mi ?? t.bi ?? 0]; });
}
/** Lista fija de un set de decoración: [[lx, ly, giro, tamaño relativo, elección de modelo], …]. */
export function bakeDecoList(layout, inst) {
  return inst.map((it) => { const [lx, ly] = layout.toLayout ? layout.toLayout(it.x, it.y) : [it.x, it.y]; return [r3(lx), r3(ly), r3(it.yaw || 0), r3(it.s ?? 1), r3(it.pick ?? 0)]; });
}

/**
 * Árboles (conos) a los costados de la pista y, opcionalmente, en laderas y cimas de cerros.
 * Con sp.treeBake (lista fija editada a mano) se usan esas posiciones, apoyadas en el suelo actual.
 */
export function buildTrees(layout, elev, spIn = {}, ground = null) {
  const sp = { ...DEFAULT_SCENE, ...spIn };
  let trees;
  if (Array.isArray(sp.treeBake)) {
    const zf = ground ? null : roadZFallback(layout, elev, sp);
    const k = Math.max(0.01, sp.treeScale);
    trees = sp.treeBake.map((b, i) => {
      const [x, y] = layout.toWorld ? layout.toWorld(b[0], b[1]) : [b[0], b[1]];
      return makeTree(vegPlace(ground, x, y, sp.treeTilt, zf ? zf(x, y) : 0), b[2] * k, b[3] * k, b[4] || 0, b[5] || 1, b[6] || 1, i, b[7] ?? i);
    });
  } else {
    const pts = scatter(layout, elev, sp, ground, {
      seed: sp.treeSeed, density: sp.treeDensity, side: sp.treeSide, offset: sp.treeOffset, spread: sp.treeSpread,
      minSpace: 3.2 * sp.treeScale, clear: 1.5 + 2.6 * sp.treeScale,
      onSlopes: sp.treeOnSlopes, onTops: sp.treeOnTops, hillDensity: sp.treeHillDensity, tilt: sp.treeTilt,
    });
    const rand = rng((sp.treeSeed ^ 0x9e3779b9) >>> 0);
    trees = pts.map((p, i) => {
      const h = 9 * sp.treeScale * (0.75 + 0.5 * rand());
      const rad = h * (0.26 + 0.06 * rand());
      // rotación aleatoria sobre su eje y sección levemente ovalada: cada árbol se ve distinto
      const yaw = rand() * Math.PI * 2, ex = 0.86 + 0.28 * rand(), ey = 0.86 + 0.28 * rand();
      return makeTree(p, h, rad, yaw, ex, ey, i);
    });
  }
  // malla combinada de conos (8 lados + base): 10 vértices y 16 triángulos por árbol
  const seg = 8;
  const pos = new Float32Array(trees.length * (seg + 2) * 3);
  const idx = new Uint32Array(trees.length * seg * 6);
  let q = 0;
  trees.forEach((t, n) => {
    const b = n * (seg + 2);
    treeConeVerts(t, pos, b * 3);
    const apex = b + seg, bottom = b + seg + 1;
    for (let k2 = 0; k2 < seg; k2++) {
      const a = b + k2, c = b + ((k2 + 1) % seg);
      idx[q++] = a; idx[q++] = c; idx[q++] = apex; idx[q++] = c; idx[q++] = a; idx[q++] = bottom; // (A, B, U) es siempre derecha: normales hacia afuera
    }
  });
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
    if (b.type === 'track' || b.type === 'cut') return; // solo los puentes llevan pilares
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


/** Nombre seguro para un objeto exportado (sin espacios ni signos raros). */
export function triggerSafeName(name) {
  return String(name || 'trigger').trim().replace(/[^\w\-áéíóúñÁÉÍÓÚÑ ]/g, '').replace(/\s+/g, '_') || 'trigger';
}

/**
 * Triggers: cubos invisibles de todo el ancho de la pista (calzada + camino de tierra + barrera), alineados con ella.
 * - Túneles (sp.tunnelTriggers): uno en cada boca, «trigger_tunel_NN_entrada» / «_salida» (según el sentido de marcha).
 * - Propios: custom = [{id, name, p:[x, y] en el mundo, depth, height}] en la ruta más cercana.
 * tunnels = [{id, k, e0, e1, name}] (bocas de cada túnel). Devuelve [{name, kind, tunnel, k, s, center:[x,y,z],
 * T, L, U (ejes: a lo largo, lateral, arriba), w, d, h, custom}] con el centro de la base sobre la calzada.
 */
export function buildTriggers(layout, elev, spIn, custom = [], tunnels = []) {
  const sp = { ...DEFAULT_SCENE, ...spIn };
  const out = [];
  if (!layout || !elev) return out;
  const make = (k, sv, d, h, extra) => {
    const r = layout.routes[k], e = elev.routes[k];
    if (!r || !e) return null;
    const F = frameAt(r, e, sv);
    const P = edgeParams(sp, r);
    const bar = (key) => (P.barrierSide === 'both' || P.barrierSide === key ? Math.max(0.05, P.barrierThick ?? 0.25) + 0.15 : 0);
    const wl = F.w / 2 + dirtWidthAt(sp, r, k, sv, 1, P) + bar('left'), wr = F.w / 2 + dirtWidthAt(sp, r, k, sv, -1, P) + bar('right');
    const off = (wl - wr) / 2; // centro del ancho total (el camino de tierra puede ser distinto a cada lado)
    const c = F.at(off, 0);
    return { k, s: sv, center: c, T: [F.tx, F.ty, 0], L: F.L, U: F.U, w: wl + wr, d: Math.max(0.1, d), h: Math.max(0.1, h), ...extra };
  };
  if (sp.tunnelTriggers) {
    for (const t of tunnels || []) {
      const nm = t.name || `tunel_${String(t.id + 1).padStart(2, '0')}`;
      const h = Math.max(sp.triggerHeight ?? 6, 1);
      const a = make(t.k, t.e0, sp.triggerDepth ?? 1, h, { name: `trigger_${nm}_entrada`, kind: 'tunnel_enter', tunnel: nm });
      const b = make(t.k, t.e1, sp.triggerDepth ?? 1, h, { name: `trigger_${nm}_salida`, kind: 'tunnel_exit', tunnel: nm });
      if (a) out.push(a);
      if (b) out.push(b);
    }
  }
  const used = new Set(out.map((q) => q.name));
  for (const c of custom || []) {
    if (!c || !c.p) continue;
    let best = null;
    layout.routes.forEach((r, k) => { const q = nearestOnSamples(r, c.p[0], c.p[1]); if (!best || q.d < best.d) best = { ...q, k }; });
    if (!best) continue;
    let name = `trigger_${triggerSafeName(c.name)}`;
    for (let n = 2; used.has(name); n++) name = `trigger_${triggerSafeName(c.name)}_${n}`;
    used.add(name);
    const tr = make(best.k, best.s, c.depth ?? 2, c.height ?? 6, { name, kind: 'custom', custom: c.id, label: c.name });
    if (tr) out.push(tr);
  }
  return out;
}
