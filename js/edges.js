// Bordes de la pista: camino de tierra y barrera de contención. Se extruyen de las mismas secciones que la malla de
// la pista (trackRows), así heredan su densidad y su optimización; la coordenada UV a lo largo sigue la distancia
// recorrida, por lo que la textura se ve igual con más o menos secciones.
import { DEFAULT_SCENE, trackRows } from './scene.js';
import { edgeParams } from './tunnels.js';
import { SpatialGrid } from './geometry.js';

const has = (v, side) => v === 'both' || v === side;

/** ¿La posición s de la ruta cae en alguno de los tramos [{k, e0, e1}] (túneles)? */
function inRanges(r, k, sv, ranges) {
  for (const t of ranges) {
    if (t.k !== k) continue;
    let ss = sv;
    if (r.closed) { while (ss < t.e0) ss += r.L; while (ss > t.e1 + r.L) ss -= r.L; }
    if (ss >= t.e0 && ss <= t.e1) return true;
  }
  return false;
}
function inBridge(r, sv) {
  if (!r.bridges) return false;
  for (const b of r.bridges) { const d = r.closed ? (((sv - b.s0) % r.L) + r.L) % r.L : sv - b.s0; if (d >= -1e-6 && d <= b.s1 - b.s0 + 1e-6) return true; }
  return false;
}

/**
 * Mallas de los bordes. opts.skip = tramos de túnel [{k, e0, e1}] (sin bordes dentro de los túneles).
 * Devuelve { dirt: [{name, k, side, positions, uvs, indices}], barriers: [...], dirtTris, barrierTris }.
 * side: +1 izquierda (según el sentido de marcha), -1 derecha.
 */
export function buildEdgeMeshes(layout, elev, spIn = {}, opts = {}) {
  const sp = { ...DEFAULT_SCENE, ...spIn };
  const res = { dirt: [], barriers: [], dirtTris: 0, barrierTris: 0 };
  // parámetros propios de la pista y de los atajos
  const PM = edgeParams(sp, false), PA = edgeParams(sp, true);
  const wants = (P) => ({ dirt: P.dirtSide !== 'none' && P.dirtWidth > 0, bar: P.barrierSide !== 'none' && P.barrierHeight > 0 });
  const WM = wants(PM), WA = wants(PA);
  if (!layout || !elev || (!WM.dirt && !WM.bar && !WA.dirt && !WA.bar)) return res;
  const skip = opts.skip || [];
  const rowsAll = trackRows(layout, elev, sp);
  const skirt = sp.skirts && sp.terrain ? sp.terrainGap + 0.8 : 0;
  // muestras de todas las rutas, para abrir los bordes donde se meterían en otra calzada (salidas de atajos)
  let maxW = 8;
  for (const r of layout.routes) for (let i = 0; i < r.n; i++) maxW = Math.max(maxW, r.w[i]);
  const grid = new SpatialGrid(maxW);
  layout.routes.forEach((r, k) => { for (let i = 0; i < r.n; i++) grid.insert(r.x[i], r.y[i], { k, i }); });
  const intrudes = (k, sv, x, y, z) => {
    let hit = false;
    grid.query(x, y, maxW / 2 + 1, (q) => {
      if (hit) return;
      const r2 = layout.routes[q.k];
      if (q.k === k) { // la misma ruta: solo cuenta si es otro tramo (lejos en s)
        const d = Math.abs(r2.s[q.i] - sv);
        if (Math.min(d, r2.closed ? r2.L - d : d) < 3 * r2.w[q.i]) return;
      }
      const dx = x - r2.x[q.i], dy = y - r2.y[q.i];
      const a = Math.abs(dx * r2.tx[q.i] + dy * r2.ty[q.i]);
      if (a > r2.ds * 0.75) return;
      const u = Math.abs(dx * -r2.ty[q.i] + dy * r2.tx[q.i]);
      if (u > r2.w[q.i] / 2 + 0.2) return;
      if (Math.abs(elev.routes[q.k].z[q.i] - z) > 2.5) return; // otro nivel (cruce): no estorba
      hit = true;
    });
    return hit;
  };
  layout.routes.forEach((r, k) => {
    const isAlt = r.kind === 'alt';
    const P = isAlt ? PA : PM, Wt = isAlt ? WA : WM;
    const wantDirt = Wt.dirt, wantBar = Wt.bar;
    if (!wantDirt && !wantBar) return;
    const dw = Math.max(0, P.dirtWidth), bh = P.barrierHeight, bt = Math.max(0.05, P.barrierThick);
    const dTile = Math.max(0.5, P.dirtTile || 4), bTile = Math.max(0.5, P.barrierTile || 4);
    const e = elev.routes[k];
    const n = r.n;
    const Q = rowsAll[k];
    // marco de cada fila
    const frames = Q.map((q) => {
      const i = q % n, sv = q === n ? r.L : r.s[i];
      const lx = -r.ty[i], ly = r.tx[i];
      const c = Math.cos(e.roll[i]), sn = Math.sin(e.roll[i]);
      return { i, s: sv, x: r.x[i], y: r.y[i], z: e.z[i], hw: r.w[i] / 2, L: [lx * c, ly * c, sn], lx, ly };
    });
    const at = (F, u, v = 0) => [F.x + F.L[0] * u, F.y + F.L[1] * u, F.z + F.L[2] * u + v];
    const tunnelAt = frames.map((F) => inRanges(r, k, F.s, skip));
    for (const side of [1, -1]) {
      const sideName = side > 0 ? 'izq' : 'der';
      const dirtOn = wantDirt && has(P.dirtSide, side > 0 ? 'left' : 'right');
      const barOn = wantBar && has(P.barrierSide, side > 0 ? 'left' : 'right');
      if (!dirtOn && !barOn) continue;
      // tramo a tramo: ¿se dibuja?
      const segOk = (a, b, wOut) => {
        if (tunnelAt[a] || tunnelAt[b]) return false;
        for (const F of [frames[a], frames[b]]) {
          const p = at(F, side * (F.hw + wOut));
          if (intrudes(k, F.s, p[0], p[1], p[2])) return false;
        }
        const Fm = frames[a], Fn = frames[b];
        const mx = (Fm.x + Fn.x) / 2 + (Fm.lx + Fn.lx) / 2 * side * ((Fm.hw + Fn.hw) / 2 + wOut), my = (Fm.y + Fn.y) / 2 + (Fm.ly + Fn.ly) / 2 * side * ((Fm.hw + Fn.hw) / 2 + wOut);
        return !intrudes(k, (Fm.s + Fn.s) / 2, mx, my, (Fm.z + Fn.z) / 2);
      };
      // ancho del camino de tierra en cada fila (0 sobre los tableros de puente)
      const dAt = frames.map((F) => (dirtOn && !inBridge(r, F.s) ? dw : 0));
      if (dirtOn) {
        const pos = [], uv = [], idx = [];
        frames.forEach((F, a) => {
          const w = dAt[a];
          const p0 = at(F, side * F.hw), p1 = at(F, side * (F.hw + w));
          const v = F.s / dTile;
          pos.push(p0[0], p0[1], p0[2] + 0.005, p1[0], p1[1], p1[2] + 0.005);
          uv.push(0, v, 1, v);
          if (skirt) { pos.push(p1[0] + F.lx * side * 0.2, p1[1] + F.ly * side * 0.2, p1[2] - skirt); uv.push(1.05, v); }
        });
        const per = skirt ? 3 : 2;
        const segs = [];
        for (let a = 0; a < frames.length - 1; a++) {
          if (dAt[a] <= 0 || dAt[a + 1] <= 0 || !segOk(a, a + 1, (dAt[a] + dAt[a + 1]) / 2)) continue;
          segs.push(a);
          const i0 = a * per, j0 = (a + 1) * per;
          // normales hacia arriba
          if (side < 0) idx.push(i0, i0 + 1, j0, i0 + 1, j0 + 1, j0);
          else idx.push(i0, j0, i0 + 1, i0 + 1, j0, j0 + 1);
          if (skirt) { // faldón hacia afuera, hasta el terreno
            if (side < 0) idx.push(i0 + 1, i0 + 2, j0 + 1, i0 + 2, j0 + 2, j0 + 1);
            else idx.push(i0 + 1, j0 + 1, i0 + 2, i0 + 2, j0 + 1, j0 + 2);
          }
        }
        if (idx.length) {
          res.dirt.push({ name: `camino_tierra_${r.name}_${sideName}`, k, side, alt: isAlt, positions: new Float32Array(pos), uvs: new Float32Array(uv), indices: idx, segs, per });
          res.dirtTris += idx.length / 3;
        }
      }
      if (barOn) {
        // barrera: cara interior, tapa y cara exterior; nace donde termina la calzada o el camino de tierra
        const pos = [], uv = [], idx = [];
        const vTop = bt / Math.max(0.1, bh + bt * 2) ; // la tapa ocupa una franja fina de la textura
        frames.forEach((F, a) => {
          const off = F.hw + dAt[a] + 0.03;
          const b0 = at(F, side * off);
          const ox = F.lx * side * bt, oy = F.ly * side * bt; // grosor horizontal hacia afuera
          const u = F.s / bTile;
          const zb = b0[2], zt = b0[2] + bh;
          // 0,1: cara interior (abajo, arriba) · 2,3: tapa (interior, exterior) · 4,5: cara exterior (arriba, abajo)
          pos.push(b0[0], b0[1], zb, b0[0], b0[1], zt,
            b0[0], b0[1], zt, b0[0] + ox, b0[1] + oy, zt,
            b0[0] + ox, b0[1] + oy, zt, b0[0] + ox, b0[1] + oy, zb - skirt);
          uv.push(u, 0, u, 1, u, 1, u, 1 - vTop, u, 1, u, -skirt / Math.max(0.1, bh));
        });
        const segs = [];
        for (let a = 0; a < frames.length - 1; a++) {
          const wOut = (dAt[a] + dAt[a + 1]) / 2 + bt;
          if (!segOk(a, a + 1, wOut)) continue;
          segs.push(a);
          const A = a * 6, B = (a + 1) * 6;
          const face = (p, q) => { // p, q: índices (dentro de la fila) de los dos vértices de la cara
            if (side > 0) idx.push(A + p, B + p, A + q, A + q, B + p, B + q);
            else idx.push(A + p, A + q, B + p, A + q, B + q, B + p);
          };
          face(0, 1); face(2, 3); face(4, 5);
        }
        if (idx.length) {
          res.barriers.push({ name: `barrera_${r.name}_${sideName}`, k, side, alt: isAlt, positions: new Float32Array(pos), uvs: new Float32Array(uv), indices: idx, segs, per: 6, s: frames.map((F) => F.s) });
          res.barrierTris += idx.length / 3;
        }
      }
    }
  });
  return res;
}
