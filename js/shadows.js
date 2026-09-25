// Planos de sombra: un plano con textura (sombra falsa) bajo cada árbol o elemento de decoración que proyecta sombra.
// El plano se amolda al terreno, a los cerros y a la calzada con la menor subdivisión que alcance (hasta un máximo).
// Posición: centrado en el pivote del objeto, o proyectado según la posición del sol (se desplaza y se estira en la
// dirección contraria al sol y su base queda en el pie del objeto).
import { SpatialGrid, clamp } from './geometry.js';
import { edgeExtents } from './tunnels.js';

export const SHADOW_DEFAULTS = {
  shadows: false, // generar planos de sombra
  treeShadow: false, // los árboles proyectan sombra (los sets de decoración tienen su propia casilla)
  shadowSize: 1, // tamaño del plano respecto de la huella del objeto
  shadowMaxTris: 2, // máximo de triángulos por plano (2 = un solo cuadro)
  shadowTol: 0.05, // m: cuánto puede separarse el plano de la superficie antes de subdividir
  shadowMode: 'center', // 'center' (en el pivote del objeto) | 'sun' (proyectada según el sol)
  sunX: -0.45, sunY: 0.55, // posición del sol en planta (-1..1; +Y = norte / arriba del mapa)
  sunElev: 45, // altura del sol (grados sobre el horizonte)
  shadowMaxLen: 3, // largo máximo de la sombra proyectada (veces la altura del objeto)
  shadowOpacity: 0.2, // opacidad del centro de la textura por defecto
  shadowSoft: 0.6, // difuminado del borde de la textura por defecto (0..1)
  shadowLift: 0.04, // m sobre la superficie (evita el parpadeo)
  sunLight: true, // la luz de la vista 3D sigue al sol
};

/** Dirección de la sombra (unitaria, en planta) y largo por metro de altura; null si el sol está casi encima. */
export function sunShadowDir(sp) {
  const x = sp.sunX ?? SHADOW_DEFAULTS.sunX, y = sp.sunY ?? SHADOW_DEFAULTS.sunY;
  const l = Math.hypot(x, y);
  const el = clamp(sp.sunElev ?? 45, 5, 90) * (Math.PI / 180);
  const perM = Math.cos(el) / Math.max(Math.sin(el), 1e-3);
  if (l < 0.02 || perM < 0.01) return null;
  return { dx: -x / l, dy: -y / l, perM };
}

/** Dirección hacia el sol (unitaria, 3D) para la luz de la vista previa. */
export function sunVector(sp) {
  const x = sp.sunX ?? SHADOW_DEFAULTS.sunX, y = sp.sunY ?? SHADOW_DEFAULTS.sunY;
  const l = Math.hypot(x, y) || 1;
  const el = clamp(sp.sunElev ?? 45, 5, 90) * (Math.PI / 180);
  return [(x / l) * Math.cos(el), (y / l) * Math.cos(el), Math.sin(el)];
}

/**
 * Objetos que proyectan sombra: [{x, y, r, h}] (r = radio de la huella, h = altura). trees = buildTrees().trees;
 * decoRes = decoSetItems(); assetOf(id) = asset con size [x, y, z].
 */
export function shadowCasters(sp, trees, decoRes, assetOf) {
  const out = [];
  if (sp.treeShadow && trees) for (const t of trees) out.push({ x: t.x, y: t.y, r: t.r * Math.max(t.ex || 1, t.ey || 1), h: t.h });
  for (const { set, items } of decoRes || []) {
    if (!set.shadow) continue;
    for (const it of items) {
      const A = assetOf ? assetOf(it.asset) : null;
      const sz = A && A.size ? A.size : [1, 1, 1], sc = it.scale || 1;
      out.push({ x: it.x, y: it.y, r: Math.max(0.1, (Math.max(sz[0], sz[1]) / 2) * sc), h: Math.max(0.1, sz[2] * sc) });
    }
  }
  return out;
}

/** Altura de la calzada (con peralte y bordes) en (x, y), o -Infinity fuera de toda pista. */
function roadSampler(layout, elev, sp) {
  const S = [];
  let maxE = 4;
  layout.routes.forEach((r, k) => {
    const X = edgeExtents(sp, r);
    const e = elev.routes[k];
    for (let i = 0; i < r.n; i++) {
      const uL = r.w[i] / 2 + X.left, uR = r.w[i] / 2 + X.right;
      maxE = Math.max(maxE, uL, uR, r.ds);
      S.push({ x: r.x[i], y: r.y[i], z: e.z[i], sr: Math.sin(e.roll[i]), tx: r.tx[i], ty: r.ty[i], hw: r.w[i] / 2, uL, uR, ds: r.ds });
    }
  });
  const g = new SpatialGrid(Math.max(8, maxE));
  for (const p of S) g.insert(p.x, p.y, p);
  return (x, y) => {
    let best = -Infinity;
    g.query(x, y, maxE + 1, (p) => {
      const dx = x - p.x, dy = y - p.y;
      if (Math.abs(dx * p.tx + dy * p.ty) > p.ds * 0.6) return;
      const u = dx * -p.ty + dy * p.tx;
      if (u > p.uL || u < -p.uR) return;
      const z = p.z + p.sr * clamp(u, -p.hw, p.hw);
      if (z > best) best = z;
    });
    return best;
  };
}

/** Grillas candidatas (nu × nv celdas, 2·nu·nv triángulos) hasta maxTris, de menos a más triángulos. */
function candidates(maxTris, aspect) {
  const out = [];
  const maxCells = Math.max(1, Math.floor(maxTris / 2));
  for (let nu = 1; nu <= 8; nu++) for (let nv = 1; nv <= 8; nv++) if (nu * nv <= maxCells) out.push([nu, nv]);
  // a igual cantidad de triángulos, primero la que divide el lado largo
  out.sort((a, b) => a[0] * a[1] - b[0] * b[1] || Math.abs(a[0] / a[1] - aspect) - Math.abs(b[0] / b[1] - aspect));
  return out;
}

/** z interpolada en la grilla (triángulos (a, b, d) y (b, c, d) de cada celda) en (u, v) ∈ [0, 1]². */
function gridZ(Z, nu, nv, u, v) {
  const fu = Math.min(nu - 1e-9, u * nu), fv = Math.min(nv - 1e-9, v * nv);
  const i = Math.floor(fu), j = Math.floor(fv), a = fu - i, b = fv - j;
  const at = (ii, jj) => Z[jj * (nu + 1) + ii];
  if (a + b <= 1) return at(i, j) + (at(i + 1, j) - at(i, j)) * a + (at(i, j + 1) - at(i, j)) * b;
  const zc = at(i + 1, j + 1);
  return zc + (at(i, j + 1) - zc) * (1 - a) + (at(i + 1, j) - zc) * (1 - b);
}

/**
 * Malla unida de todos los planos de sombra. casters = shadowCasters(). ground = makeGround(); opts.baseAt(x, y) =
 * altura del terreno sin cerros (para saber qué vértices van sobre un cerro: kinds = 1).
 * Devuelve {positions, uvs, indices, kinds, count, tris, hist} (hist = cuántos planos con cada cantidad de triángulos).
 */
export function buildShadows(layout, elev, spIn, ground, casters, opts = {}) {
  const sp = { ...SHADOW_DEFAULTS, ...spIn };
  const empty = { positions: new Float32Array(0), uvs: new Float32Array(0), indices: new Uint32Array(0), kinds: new Uint8Array(0), count: 0, tris: 0, hist: {} };
  if (!casters || !casters.length) return empty;
  const road = layout && elev ? roadSampler(layout, elev, sp) : () => -Infinity;
  const gz = (x, y) => (ground ? ground.sample(x, y) : 0);
  const surf = (x, y) => { const a = gz(x, y), b = road(x, y); return b > a - 0.3 ? Math.max(a, b) : a; }; // la calzada manda si está encima (o casi) del suelo
  const baseAt = opts.baseAt || null;
  const sun = sp.shadowMode === 'sun' ? sunShadowDir(sp) : null;
  const maxTris = Math.max(2, Math.round(sp.shadowMaxTris || 2));
  const tol = Math.max(0.005, sp.shadowTol ?? 0.05);
  const lift = sp.shadowLift ?? 0.04;
  const size = Math.max(0.05, sp.shadowSize ?? 1);
  const P = [], UV = [], I = [], K = [];
  const hist = {};
  for (const c of casters) {
    const R = c.r * size;
    let cx = c.x, cy = c.y, ux = 1, uy = 0, len = 2 * R;
    if (sun) {
      // sombra proyectada: desde el pie del objeto hacia el lado contrario del sol, con su largo según la altura del sol
      const Ls = Math.min(c.h * sun.perM, c.h * Math.max(0.2, sp.shadowMaxLen ?? 3));
      ux = sun.dx; uy = sun.dy;
      len = Ls + 2 * R;
      cx = c.x + ux * (Ls / 2); cy = c.y + uy * (Ls / 2);
    }
    const vx = -uy, vy = ux, wid = 2 * R;
    const X0 = cx - ux * (len / 2) - vx * (wid / 2), Y0 = cy - uy * (len / 2) - vy * (wid / 2);
    const at = (u, v) => [X0 + ux * len * u + vx * wid * v, Y0 + uy * len * u + vy * wid * v];
    // la grilla más simple que sigue la superficie dentro de la tolerancia
    const cand = candidates(maxTris, len / wid);
    let pick = cand[0], Zpick = null;
    const cache = new Map();
    const S = (u, v) => { const k = `${u.toFixed(5)},${v.toFixed(5)}`; let z = cache.get(k); if (z === undefined) { const [x, y] = at(u, v); z = surf(x, y); cache.set(k, z); } return z; };
    const gridOf = (nu, nv) => { const Z = new Float64Array((nu + 1) * (nv + 1)); for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) Z[j * (nu + 1) + i] = S(i / nu, j / nv); return Z; };
    if (cand.length > 1) {
      const maxN = Math.max(...cand.map((q) => Math.max(q[0], q[1])));
      const nt = Math.min(17, 2 * maxN + 1);
      let bestErr = Infinity, best = null, bestZ = null;
      for (const [nu, nv] of cand) {
        const Z = gridOf(nu, nv);
        let err = 0;
        for (let j = 0; j < nt && err <= tol; j++) for (let i = 0; i < nt; i++) {
          const u = i / (nt - 1), v = j / (nt - 1);
          const d = Math.abs(S(u, v) - gridZ(Z, nu, nv, u, v));
          if (d > err) { err = d; if (err > tol) break; }
        }
        if (err <= tol) { best = [nu, nv]; bestZ = Z; break; }
        if (err < bestErr) { bestErr = err; best = [nu, nv]; bestZ = Z; }
      }
      pick = best; Zpick = bestZ;
    }
    const [nu, nv] = pick;
    const Z = Zpick || gridOf(nu, nv);
    const base = P.length / 3;
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const u = i / nu, v = j / nv;
      const [x, y] = at(u, v);
      const z = Z[j * (nu + 1) + i];
      P.push(x, y, z + lift);
      UV.push(u, v);
      // sobre un cerro (no sobre la calzada ni el terreno): la vista 3D lo apoya en el terreno exagerado sin estirarlo
      K.push(baseAt && z > baseAt(x, y) + 0.02 && road(x, y) < z - 0.05 ? 1 : 0);
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = base + j * (nu + 1) + i, b = a + 1, d = a + nu + 1, e = d + 1;
      I.push(a, b, d, b, e, d); // normal hacia arriba
    }
    const t = 2 * nu * nv;
    hist[t] = (hist[t] || 0) + 1;
  }
  return { positions: new Float32Array(P), uvs: new Float32Array(UV), indices: new Uint32Array(I), kinds: new Uint8Array(K), count: casters.length, tris: I.length / 3, hist };
}

/** Textura por defecto: círculo negro (opacidad en el centro) con el borde difuminado. */
export function makeShadowCanvas(opacity = 0.2, soft = 0.6, size = 128) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const r = size / 2, inner = Math.max(0, Math.min(0.98, 1 - soft)) * r;
  const grad = g.createRadialGradient(r, r, inner, r, r, r * 0.98);
  grad.addColorStop(0, `rgba(0,0,0,${opacity})`);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return cv;
}
