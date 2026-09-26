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
  if (!layout || !elev) return res;
  const wants = (P) => ({ dirt: P.dirtSide !== 'none' && P.dirtWidth > 0, bar: P.barrierSide !== 'none' && P.barrierHeight > 0 });
  const PR = layout.routes.map((r) => edgeParams(sp, r)); // cada atajo con sus propios parámetros
  const WR = PR.map(wants);
  if (!WR.some((w) => w.dirt || w.bar) && !(sp.suspRanges || []).some((z) => z.dirt || z.barrier)) return res;
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
  // tramos suspendidos: cada uno decide si lleva camino de tierra y barrera (con texturas propias)
  const susp = sp.suspRanges || [];
  const suspAt = (r, k, sv) => {
    for (const z of susp) {
      if (z.k !== k) continue;
      let d = sv - z.s0;
      if (r.closed) d = ((d % r.L) + r.L) % r.L;
      if (d >= -1e-6 && d <= z.s1 - z.s0 + 1e-6) return z;
    }
    return null;
  };
  layout.routes.forEach((r, k) => {
    const isAlt = r.kind === 'alt';
    const P = PR[k], Wt = WR[k];
    const hasSusp = susp.some((z) => z.k === k && (z.dirt || z.barrier));
    if (!Wt.dirt && !Wt.bar && !hasSusp) return;
    const dw = Math.max(0, P.dirtWidth || 3), bh = P.barrierHeight > 0 ? P.barrierHeight : 0.8;
    const bt = Math.max(0, P.barrierThick ?? 0.25), plane = bt < 0.01; // grosor 0: plano de una cara (mira a la calzada)
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
    const suspF = frames.map((F) => suspAt(r, k, F.s));
    for (const side of [1, -1]) {
      const sideName = side > 0 ? 'izq' : 'der';
      const sideKey = side > 0 ? 'left' : 'right';
      // ¿hay camino de tierra / barrera en cada fila? En un tramo suspendido lo decide el tramo (si la ruta no los
      // tiene de ese lado, van a ambos lados con las medidas de la ruta)
      const routeDirt = Wt.dirt && has(P.dirtSide, sideKey), routeBar = Wt.bar && has(P.barrierSide, sideKey);
      const onFor = (z, want, routeHas, routeSide) => (z ? !!want && (routeHas || routeSide === 'none' || !routeSide) : routeHas);
      const dOn = frames.map((F, a) => onFor(suspF[a], suspF[a] && suspF[a].dirt, routeDirt, P.dirtSide));
      const bOn = frames.map((F, a) => onFor(suspF[a], suspF[a] && suspF[a].barrier, routeBar, P.barrierSide));
      if (!dOn.some(Boolean) && !bOn.some(Boolean)) continue;
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
      // un tramo es «suspendido» si su punto medio cae en un tramo suspendido (texturas propias)
      const segSusp = (a) => !!suspAt(r, k, (frames[a].s + frames[a + 1].s) / 2);
      // ancho del camino de tierra en cada fila (0 sobre los tableros de puente)
      const dAt = frames.map((F, a) => (dOn[a] && !inBridge(r, F.s) ? dw : 0));
      if (dAt.some((w) => w > 0)) {
        const pos = [], uv = [], idxN = [], idxS = [];
        frames.forEach((F, a) => {
          const w = dAt[a];
          const p0 = at(F, side * F.hw), p1 = at(F, side * (F.hw + w));
          const v = F.s / dTile;
          pos.push(p0[0], p0[1], p0[2] + 0.005, p1[0], p1[1], p1[2] + 0.005);
          uv.push(0, v, 1, v);
          if (skirt) { pos.push(p1[0] + F.lx * side * 0.2, p1[1] + F.ly * side * 0.2, p1[2] - skirt); uv.push(1.05, v); }
        });
        const per = skirt ? 3 : 2;
        const segs = [], segsS = [];
        for (let a = 0; a < frames.length - 1; a++) {
          if (dAt[a] <= 0 || dAt[a + 1] <= 0 || !segOk(a, a + 1, (dAt[a] + dAt[a + 1]) / 2)) continue;
          const sus = segSusp(a), idx = sus ? idxS : idxN;
          (sus ? segsS : segs).push(a);
          const i0 = a * per, j0 = (a + 1) * per;
          // normales hacia arriba
          if (side < 0) idx.push(i0, i0 + 1, j0, i0 + 1, j0 + 1, j0);
          else idx.push(i0, j0, i0 + 1, i0 + 1, j0, j0 + 1);
          if (skirt && !sus) { // faldón hacia afuera, hasta el terreno (no en los tramos suspendidos)
            if (side < 0) idx.push(i0 + 1, i0 + 2, j0 + 1, i0 + 2, j0 + 2, j0 + 1);
            else idx.push(i0 + 1, j0 + 1, i0 + 2, i0 + 2, j0 + 1, j0 + 2);
          }
        }
        const P32 = new Float32Array(pos), U32 = new Float32Array(uv);
        if (idxN.length) { res.dirt.push({ name: `camino_tierra_${r.name}_${sideName}`, k, side, alt: isAlt, positions: P32, uvs: U32, indices: idxN, segs, per }); res.dirtTris += idxN.length / 3; }
        if (idxS.length) { res.dirt.push({ name: `camino_tierra_${r.name}_suspendido_${sideName}`, k, side, alt: isAlt, susp: true, positions: P32, uvs: U32, indices: idxS, segs: segsS, per }); res.dirtTris += idxS.length / 3; }
      }
      if (bOn.some(Boolean)) {
        // barrera: cara interior, tapa y cara exterior; nace donde termina la calzada o el camino de tierra.
        // Con grosor 0 es solo la cara interior (plano de una cara, con la normal hacia la calzada).
        const pos = [], uv = [], idxN = [], idxS = [];
        const vTop = bt / Math.max(0.1, bh + bt * 2); // la tapa ocupa una franja fina de la textura
        frames.forEach((F, a) => {
          const off = F.hw + dAt[a] + 0.03;
          const b0 = at(F, side * off);
          const ox = F.lx * side * bt, oy = F.ly * side * bt; // grosor horizontal hacia afuera
          const u = F.s / bTile;
          const zb = b0[2], zt = b0[2] + bh;
          const sk = suspF[a] ? 0 : skirt;
          // 0,1: cara interior (abajo, arriba) · 2,3: tapa (interior, exterior) · 4,5: cara exterior (arriba, abajo)
          pos.push(b0[0], b0[1], zb, b0[0], b0[1], zt,
            b0[0], b0[1], zt, b0[0] + ox, b0[1] + oy, zt,
            b0[0] + ox, b0[1] + oy, zt, b0[0] + ox, b0[1] + oy, zb - sk);
          uv.push(u, 0, u, 1, u, 1, u, 1 - vTop, u, 1, u, -sk / Math.max(0.1, bh));
        });
        const segs = [], segsS = [];
        for (let a = 0; a < frames.length - 1; a++) {
          if (!bOn[a] || !bOn[a + 1]) continue;
          const wOut = (dAt[a] + dAt[a + 1]) / 2 + bt;
          if (!segOk(a, a + 1, wOut)) continue;
          const sus = segSusp(a), idx = sus ? idxS : idxN;
          (sus ? segsS : segs).push(a);
          const A = a * 6, B = (a + 1) * 6;
          const face = (p, q) => { // p, q: índices (dentro de la fila) de los dos vértices de la cara
            if (side > 0) idx.push(A + p, B + p, A + q, A + q, B + p, B + q);
            else idx.push(A + p, A + q, B + p, A + q, B + q, B + p);
          };
          face(0, 1);
          if (!plane) { face(2, 3); face(4, 5); }
        }
        const P32 = new Float32Array(pos), U32 = new Float32Array(uv), sArr = frames.map((F) => F.s);
        if (idxN.length) { res.barriers.push({ name: `barrera_${r.name}_${sideName}`, k, side, alt: isAlt, plane, positions: P32, uvs: U32, indices: idxN, segs, per: 6, s: sArr }); res.barrierTris += idxN.length / 3; }
        if (idxS.length) { res.barriers.push({ name: `barrera_${r.name}_suspendido_${sideName}`, k, side, alt: isAlt, plane, susp: true, positions: P32, uvs: U32, indices: idxS, segs: segsS, per: 6, s: sArr }); res.barrierTris += idxS.length / 3; }
      }
    }
  });
  return res;
}
