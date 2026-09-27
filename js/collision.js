// Geometría de colisión (invisible) para el motor del juego: el camino de tierra (plano de una cara, como el camino) y
// los costados (paredes en el borde del camino de tierra o, si no hay, de la pista; donde hay barrera, en su cara
// interior). Se extruyen de las mismas secciones que la pista (trackRows) y se abren donde entra o sale un atajo, igual
// que la barrera. El alto de los costados se recorta bajo cualquier calzada que pase por arriba (cruces), con una rampa
// suave. Con grosor 0 los costados son un plano de una cara que mira a la pista; con grosor, un volumen cerrado que crece
// hacia afuera (la cara interior no se mueve).
import { DEFAULT_SCENE, trackRows, trackSamples } from './scene.js';
import { edgeParams, dirtWidthAt } from './tunnels.js';
import { SpatialGrid } from './geometry.js';

/**
 * opts.deck = espesor del tablero de los cruces (m, para el alto libre bajo otra calzada).
 * Devuelve { dirt: [{name, k, positions, indices}], sides: [{name, k, side, positions, indices, plane}], tris, clamped }.
 */
export function buildCollisionMeshes(layout, elev, spIn = {}, opts = {}) {
  const sp = { ...DEFAULT_SCENE, ...spIn };
  const res = { dirt: [], sides: [], tris: 0, clamped: 0 };
  if (!layout || !elev || !sp.collision || (!sp.collDirt && !sp.collSides)) return res;
  const H0 = Math.max(0.2, +sp.collHeight || 3), T = Math.max(0, +sp.collThick || 0), plane = T < 0.01;
  const deck = Math.max(0, opts.deck ?? 1);
  const rowsAll = trackRows(layout, elev, sp);
  const S = trackSamples(layout, elev, sp);
  let maxW = 8;
  for (const p of S) maxW = Math.max(maxW, p.ew);
  const grid = new SpatialGrid(maxW);
  for (const p of S) grid.insert(p.x, p.y, p);
  /** Alto libre sobre (x, y, z) bajo otra calzada (con su camino y barrera) que pase por arriba; Infinity si no hay. */
  const clearAt = (k, sv, x, y, z) => {
    let c = Infinity;
    grid.query(x, y, maxW / 2 + 1, (p) => {
      const r2 = layout.routes[p.k];
      if (p.k === k) { const d = Math.abs(p.s - sv); if (Math.min(d, r2.closed ? r2.L - d : d) < 3 * p.w) return; } // la misma calzada
      const dx = x - p.x, dy = y - p.y;
      if (Math.abs(dx * p.tx + dy * p.ty) > p.ds * 0.75 + 0.3) return;
      const u = dx * -p.ty + dy * p.tx;
      if (u > p.uL + 0.3 || -u > p.uR + 0.3) return;
      const zs = p.zc + p.sr * u;
      if (zs - deck < z + 0.7) return; // al mismo nivel (entrada de un atajo, pendiente) o más abajo: no la tapa
      c = Math.min(c, zs - deck - 0.2 - z);
    });
    return c;
  };
  // mismas aperturas que los bordes: donde el costado se metería en otra calzada al mismo nivel (entradas de atajos)
  const intrudes = (k, sv, x, y, z) => {
    let hit = false;
    grid.query(x, y, maxW / 2 + 1, (p) => {
      if (hit) return;
      const r2 = layout.routes[p.k];
      if (p.k === k) { const d = Math.abs(p.s - sv); if (Math.min(d, r2.closed ? r2.L - d : d) < 3 * p.w) return; }
      const dx = x - p.x, dy = y - p.y;
      if (Math.abs(dx * p.tx + dy * p.ty) > p.ds * 0.75) return;
      if (Math.abs(dx * -p.ty + dy * p.tx) > p.w / 2 + 0.2) return;
      if (Math.abs(p.zc - z) > 2.5) return;
      hit = true;
    });
    return hit;
  };
  layout.routes.forEach((r, k) => {
    const P = edgeParams(sp, r), e = elev.routes[k], n = r.n, Q = rowsAll[k];
    const frames = Q.map((q) => {
      const i = q % n, sv = q === n ? r.L : r.s[i];
      const c = Math.cos(e.roll[i]), sn = Math.sin(e.roll[i]);
      return { i, s: sv, x: r.x[i], y: r.y[i], z: e.z[i], hw: r.w[i] / 2, L: [-r.ty[i] * c, r.tx[i] * c, sn], lx: -r.ty[i], ly: r.tx[i] };
    });
    const at = (F, u) => [F.x + F.L[0] * u, F.y + F.L[1] * u, F.z + F.L[2] * u];
    const dirtPos = [], dirtIdx = [];
    for (const side of [1, -1]) {
      const sideName = side > 0 ? 'izq' : 'der';
      const dAt = frames.map((F) => dirtWidthAt(sp, r, k, F.s, side, P));
      const segOk = (a, b, wOut) => {
        for (const F of [frames[a], frames[b]]) { const p = at(F, side * (F.hw + wOut)); if (intrudes(k, F.s, p[0], p[1], p[2])) return false; }
        const Fm = frames[a], Fn = frames[b];
        const mx = (Fm.x + Fn.x) / 2 + (Fm.lx + Fn.lx) / 2 * side * ((Fm.hw + Fn.hw) / 2 + wOut), my = (Fm.y + Fn.y) / 2 + (Fm.ly + Fn.ly) / 2 * side * ((Fm.hw + Fn.hw) / 2 + wOut);
        return !intrudes(k, (Fm.s + Fn.s) / 2, mx, my, (Fm.z + Fn.z) / 2);
      };
      // camino de tierra: plano con solo sus dos bordes (normal hacia arriba)
      if (sp.collDirt && dAt.some((w) => w > 0)) {
        const base = dirtPos.length / 3;
        frames.forEach((F, a) => { const p0 = at(F, side * F.hw), p1 = at(F, side * (F.hw + dAt[a])); dirtPos.push(...p0, ...p1); });
        for (let a = 0; a < frames.length - 1; a++) {
          if ((dAt[a] <= 0 && dAt[a + 1] <= 0) || !segOk(a, a + 1, (dAt[a] + dAt[a + 1]) / 2)) continue;
          const i0 = base + a * 2, j0 = base + (a + 1) * 2;
          if (side < 0) dirtIdx.push(i0, i0 + 1, j0, i0 + 1, j0 + 1, j0);
          else dirtIdx.push(i0, j0, i0 + 1, i0 + 1, j0, j0 + 1);
        }
      }
      if (!sp.collSides) continue;
      // costados: base en el borde (un poco bajo la superficie), alto recortado bajo lo que pase por arriba
      const B = frames.map((F, a) => { const p = at(F, side * (F.hw + dAt[a] + 0.03)); p[2] -= 0.2; return p; });
      const H = frames.map((F, a) => {
        const b = B[a], ox = F.lx * side * T, oy = F.ly * side * T;
        const c = Math.min(clearAt(k, F.s, b[0], b[1], b[2]), T ? clearAt(k, F.s, b[0] + ox, b[1] + oy, b[2]) : Infinity);
        return Math.min(H0, c);
      });
      // rampa: el alto cambia a lo sumo 0,5 m por metro recorrido (sin escalones al entrar y salir de un cruce)
      for (let pass = 0; pass < 2; pass++) {
        for (let a = 1; a < H.length; a++) H[a] = Math.min(H[a], H[a - 1] + 0.5 * Math.abs(frames[a].s - frames[a - 1].s));
        for (let a = H.length - 2; a >= 0; a--) H[a] = Math.min(H[a], H[a + 1] + 0.5 * Math.abs(frames[a + 1].s - frames[a].s));
      }
      res.clamped += H.filter((h) => h < H0 - 1e-6).length;
      const pos = [], idx = [];
      // por fila: 0 interior abajo, 1 interior arriba, 2 exterior arriba, 3 exterior abajo
      frames.forEach((F, a) => {
        const b = B[a], h = Math.max(0.05, H[a]), ox = F.lx * side * T, oy = F.ly * side * T;
        pos.push(b[0], b[1], b[2], b[0], b[1], b[2] + h, b[0] + ox, b[1] + oy, b[2] + h, b[0] + ox, b[1] + oy, b[2]);
      });
      const on = (a) => H[a] > 0.05 && H[a + 1] > 0.05 && segOk(a, a + 1, (dAt[a] + dAt[a + 1]) / 2 + T);
      const face = (A, Bq, p, q) => { if (side > 0) idx.push(A + p, Bq + p, A + q, A + q, Bq + p, Bq + q); else idx.push(A + p, A + q, Bq + p, A + q, Bq + q, Bq + p); };
      const cap = (A, out) => { // tapa de un extremo del volumen (mirando hacia afuera del tramo: out = -1 al empezar, +1 al terminar)
        const quad = [A, A + 1, A + 2, A + 3];
        if ((side > 0) === (out < 0)) idx.push(quad[0], quad[1], quad[2], quad[0], quad[2], quad[3]);
        else idx.push(quad[0], quad[2], quad[1], quad[0], quad[3], quad[2]);
      };
      for (let a = 0; a < frames.length - 1; a++) {
        if (!on(a)) continue;
        const A = a * 4, Bq = (a + 1) * 4;
        face(A, Bq, 0, 1); // cara interior (mira a la pista)
        if (!plane) {
          face(A, Bq, 1, 2); face(A, Bq, 2, 3); face(A, Bq, 3, 0); // tapa, cara exterior y base: volumen cerrado
          if (a === 0 || !on(a - 1)) cap(A, -1);
          if (a === frames.length - 2 || !on(a + 1)) cap(Bq, 1);
        }
      }
      if (idx.length) {
        res.sides.push({ name: `colision_costados_${r.name}_${sideName}`, k, side, plane, positions: new Float32Array(pos), indices: new Uint32Array(idx) });
        res.tris += idx.length / 3;
      }
    }
    if (dirtIdx.length) {
      res.dirt.push({ name: `colision_camino_tierra_${r.name}`, k, positions: new Float32Array(dirtPos), indices: new Uint32Array(dirtIdx) });
      res.tris += dirtIdx.length / 3;
    }
  });
  return res;
}
