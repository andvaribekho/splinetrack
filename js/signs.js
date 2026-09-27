// Señalética de curvas (0.80): carteles de curva a la derecha, a la izquierda, rotonda (curva que gira mucho: horquilla o
// rizo) y camino zigzagueante (curvas alternadas seguidas), antes de cada curva de la ruta principal según el sentido de
// marcha. Cada cartel son 2 planos: el poste y el cartel (con su textura por tipo, recortada por la transparencia).
import { clamp, SpatialGrid } from './geometry.js';
import { frameAt } from './tunnels.js';
import { trackSamples } from './scene.js';

export const SIGN_TYPES = ['right', 'left', 'round', 'zigzag'];
export const SIGN_NAMES = { right: 'senal_curva_der', left: 'senal_curva_izq', round: 'senal_rotonda', zigzag: 'senal_zigzag' };
export const SIGN_DEFAULTS = {
  signs: false, signRadius: 60, signMinTurn: 25, signZigGap: 60, signRoundTurn: 180,
  signDist: 40, signCount: 1, signSep: 10, signSide: 'auto', signOffset: 1.5, signHeight: 1.9, signSize: 0.9, signYaw: 0, signOneSided: false,
  signOverrides: [], // [{x, y, type: 'curve' | 'round' | 'zigzag' | 'none'}] en metros (el vértice de la curva)
};
const opt = (sp, k) => (sp && sp[k] != null ? sp[k] : SIGN_DEFAULTS[k]);

/**
 * Curvas de la ruta principal (en el sentido de marcha): tramos donde el radio baja de signRadius y que giran al menos
 * signMinTurn grados. Las alternadas y seguidas (a menos de signZigGap m) forman un zigzag; una sola que gira
 * signRoundTurn grados o más es una rotonda. Devuelve [{i, s0, s1, turn (°), rmin, dir (+1 izq, -1 der), parts, type,
 * auto (el tipo detectado), x, y (vértice), forced}]. type: 'right' | 'left' | 'round' | 'zigzag' | 'none'.
 */
export function detectCurves(layout, sp = {}) {
  const r = layout && layout.routes[0];
  if (!r || r.n < 8) return [];
  const n = r.n, ds = r.ds, closed = r.closed;
  const at = (i) => (closed ? ((i % n) + n) % n : clamp(i, 0, n - 1));
  // curvatura suavizada (≈ 6 m): sin el ruido de las muestras
  const w = Math.max(1, Math.round(3 / ds)), ks = new Float64Array(n);
  for (let i = 0; i < n; i++) { let a = 0, c = 0; for (let d = -w; d <= w; d++) { const j = i + d; if (!closed && (j < 0 || j >= n)) continue; a += r.k[at(j)]; c++; } ks[i] = a / c; }
  const kth = 1 / Math.max(1, opt(sp, 'signRadius'));
  const sg = (i) => (Math.abs(ks[i]) >= kth ? Math.sign(ks[i]) : 0);
  // tramos seguidos del mismo signo (en un circuito cerrado se empieza en una recta para no partir una curva en dos)
  let start = 0;
  if (closed) { start = -1; for (let i = 0; i < n; i++) if (!sg(i)) { start = i; break; } if (start < 0) start = 0; }
  const runs = [];
  let cur = null;
  const gapMax = Math.max(1, Math.round(3 / ds)); // huecos de hasta 3 m no cortan la curva
  for (let q = 0; q < n; q++) {
    const i = closed ? (start + q) % n : q, v = sg(i);
    if (v && cur && cur.dir === v && q - cur.qLast <= gapMax) { cur.qLast = q; cur.turn += ks[i] * ds; cur.kmax = Math.max(cur.kmax, Math.abs(ks[i])); continue; }
    if (v) { cur = { dir: v, q0: q, qLast: q, turn: ks[i] * ds, kmax: Math.abs(ks[i]) }; runs.push(cur); }
  }
  const sOf = (q) => r.s[closed ? (start + q) % n : q] + (closed && start + q >= n ? r.L : 0);
  const minTurn = (opt(sp, 'signMinTurn') * Math.PI) / 180;
  const C = runs.filter((c) => Math.abs(c.turn) >= minTurn).map((c) => ({ s0: sOf(c.q0), s1: sOf(c.qLast), turn: (Math.abs(c.turn) * 180) / Math.PI, rmin: 1 / c.kmax, dir: c.dir }));
  // grupos: curvas alternadas a menos de signZigGap m = zigzag
  const G = [];
  const zg = Math.max(0, opt(sp, 'signZigGap'));
  for (const c of C) {
    const g = G[G.length - 1], last = g && g.parts[g.parts.length - 1];
    if (last && last.dir !== c.dir && c.s0 - last.s1 <= zg) { g.parts.push(c); g.s1 = c.s1; continue; }
    G.push({ s0: c.s0, s1: c.s1, parts: [c] });
  }
  // circuito cerrado: la última y la primera pueden ir seguidas
  if (closed && G.length > 1) {
    const a = G[G.length - 1], b = G[0], la = a.parts[a.parts.length - 1], fb = b.parts[0];
    if (la.dir !== fb.dir && fb.s0 + r.L - la.s1 <= zg) { a.parts.push(...b.parts.map((p) => ({ ...p, s0: p.s0 + r.L, s1: p.s1 + r.L }))); a.s1 = b.s1 + r.L; G.shift(); }
  }
  const roundT = opt(sp, 'signRoundTurn');
  const ov = opt(sp, 'signOverrides') || [];
  return G.map((g, i) => {
    const p0 = g.parts[0], turn = g.parts.reduce((a, p) => a + p.turn, 0), rmin = Math.min(...g.parts.map((p) => p.rmin));
    const auto = g.parts.length > 1 ? 'zigzag' : p0.turn >= roundT ? 'round' : p0.dir > 0 ? 'left' : 'right';
    const mid = frameAt(r, { z: new Float32Array(n), roll: new Float32Array(n) }, (p0.s0 + p0.s1) / 2);
    // tipo elegido a mano (guardado por la posición del vértice: sirve aunque cambie el sentido o se edite la pista)
    let forced = null, bd = Infinity;
    for (const o of ov) { const d = Math.hypot(o.x - mid.x, o.y - mid.y); if (d < Math.max(15, (p0.s1 - p0.s0) / 2) && d < bd) { bd = d; forced = o.type; } }
    const dirType = p0.dir > 0 ? 'left' : 'right';
    const type = !forced ? auto : forced === 'curve' ? dirType : forced;
    return { i, s0: g.s0, s1: g.s1, turn, rmin, dir: p0.dir, parts: g.parts.length, type, auto, x: mid.x, y: mid.y, forced };
  });
}

/**
 * Carteles de las curvas: antes de la entrada de cada una (signDist m, signCount carteles cada signSep m), al costado
 * (signSide: auto = por fuera de la curva, left, right, both), más allá del camino de tierra y la barrera (signOffset m),
 * mirando al auto que llega (más signYaw grados). No van sobre otra calzada, en un túnel, en un puente ni en el agua.
 * tunnels = [{k, s0, s1}]. Devuelve {curves, signs: [{type, x, y, z, nx, ny, curve, side, s}]}.
 */
export function placeSigns(layout, elev, sp = {}, ground = null, tunnels = []) {
  const curves = detectCurves(layout, sp);
  const out = { curves, signs: [] };
  if (!curves.length) return out;
  const r = layout.routes[0], e = elev.routes[0], S = trackSamples(layout, elev, sp);
  let maxW = 8;
  for (const p of S) maxW = Math.max(maxW, p.ew);
  const grid = new SpatialGrid(maxW);
  for (const p of S) grid.insert(p.x, p.y, p);
  const main = S.filter((p) => p.k === 0);
  const wrap = (s) => (r.closed ? ((s % r.L) + r.L) % r.L : s);
  const inTunnel = (s) => (tunnels || []).some((t) => t && t.k === 0 && (() => { const d = r.closed ? (((s - t.s0) % r.L) + r.L) % r.L : s - t.s0; return d >= -2 && d <= t.s1 - t.s0 + 2; })());
  const dist = Math.max(0, opt(sp, 'signDist')), cnt = clamp(Math.round(opt(sp, 'signCount')), 1, 20), sep = Math.max(0.5, opt(sp, 'signSep'));
  const side0 = opt(sp, 'signSide'), off = Math.max(0, opt(sp, 'signOffset')), yaw = (opt(sp, 'signYaw') * Math.PI) / 180;
  const placed = [];
  for (const c of curves) {
    if (c.type === 'none') continue;
    // lado: por fuera de la curva (el conductor lo tiene de frente al llegar); el zigzag, por fuera de la primera
    const sides = side0 === 'both' ? [1, -1] : side0 === 'left' ? [1] : side0 === 'right' ? [-1] : [-c.dir];
    for (let j = 0; j < cnt; j++) {
      const s = c.s0 - dist - j * sep;
      if (!r.closed && (s < 0 || s > r.L)) continue;
      const ss = wrap(s);
      if (inTunnel(ss)) continue;
      const F = frameAt(r, e, ss), p = main[Math.min(main.length - 1, Math.round(ss / r.ds) % r.n)];
      if (!p || p.bridge || (p.susp && !p.cut)) continue; // en un puente o un tramo suspendido quedaría flotando
      for (const sd of sides) {
        const u = (sd > 0 ? p.uL : p.uR) + off, lx = -F.ty * sd, ly = F.tx * sd;
        const x = F.x + lx * u, y = F.y + ly * u;
        // ni sobre otra calzada (o su camino de tierra y barrera), ni en otra parte de esta pista
        let ok = true;
        grid.query(x, y, maxW / 2 + 1, (q) => {
          if (!ok) return;
          const dx = x - q.x, dy = y - q.y, al = dx * q.tx + dy * q.ty, lat = -dx * q.ty + dy * q.tx;
          if (Math.abs(al) <= q.ds * 0.75 && lat <= q.uL + 0.3 && lat >= -q.uR - 0.3) ok = false;
        });
        if (!ok) continue;
        if (ground && ground.inWater && ground.inWater(x, y)) continue;
        if (placed.some((q) => Math.hypot(q.x - x, q.y - y) < 2)) continue;
        const zg = ground ? ground.sample(x, y) : F.z - 0.2;
        if (!Number.isFinite(zg) || (ground && ground.waterLevel != null && zg < ground.waterLevel + 0.3)) continue;
        // mirando al auto que llega: hacia la pista unos metros antes
        const T = frameAt(r, e, wrap(s - 25));
        let nx = T.x - x, ny = T.y - y;
        const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
        if (yaw) { const cs = Math.cos(yaw), sn = Math.sin(yaw); [nx, ny] = [nx * cs - ny * sn, nx * sn + ny * cs]; }
        const sg = { type: c.type, x, y, z: zg, nx, ny, curve: c.i, side: sd > 0 ? 'left' : 'right', s: ss };
        placed.push(sg);
        out.signs.push(sg);
      }
    }
  }
  return out;
}

/**
 * Mallas de los carteles, por tipo: cartel (un plano cuadrado de signSize, centrado a signHeight sobre el suelo) y poste
 * (un plano de 0,1 m de ancho desde 0,2 m bajo el suelo hasta el centro del cartel). UV del cartel: (0,0)–(1,1), u hacia
 * la derecha de quien lo mira de frente. Salvo «One sided» (signOneSided), cada plano lleva una copia 1 cm más atrás con
 * las caras (y las normales) hacia atrás y la u invertida: por detrás se ve la misma imagen, legible (8 triángulos por
 * cartel; 4 con One sided). Materiales de una cara. Devuelve {right: {sign, post, count, vps}, …, tris}.
 */
export function buildSigns(layout, elev, sp = {}, ground = null, tunnels = []) {
  const P = placeSigns(layout, elev, sp, ground, tunnels);
  const H = Math.max(0.3, opt(sp, 'signHeight')), Sz = Math.max(0.1, opt(sp, 'signSize')), pw = 0.1;
  const res = { curves: P.curves, signs: P.signs, byType: {}, tris: 0 };
  for (const t of SIGN_TYPES) {
    const L = P.signs.filter((q) => q.type === t);
    if (!L.length) continue;
    const two = !opt(sp, 'signOneSided');
    // f = cuánto va delante del punto (el cartel 2 cm delante del poste, sin parpadeo); la copia trasera, 1 cm atrás
    const plane = (list, corners, f) => {
      const pos = [], uv = [], idx = [];
      for (const q of list) {
        const [rx, ry] = [-q.ny, q.nx]; // derecha de quien mira el frente
        const put = (off, flipU) => { const b = pos.length / 3; for (const [a, h, u, v] of corners) { pos.push(q.x + rx * a + q.nx * off, q.y + ry * a + q.ny * off, q.z + h); uv.push(flipU ? 1 - u : u, v); } return b; };
        const b = put(f, false);
        idx.push(b, b + 1, b + 2, b, b + 2, b + 3); // de frente (normal hacia n): antihorario visto desde afuera
        if (two) { const k = put(f - 0.01, true); idx.push(k, k + 2, k + 1, k, k + 3, k + 2); } // por detrás: al revés
      }
      return { positions: new Float32Array(pos), uvs: new Float32Array(uv), indices: new Uint32Array(idx) };
    };
    const sign = plane(L, [[-Sz / 2, H - Sz / 2, 0, 0], [Sz / 2, H - Sz / 2, 1, 0], [Sz / 2, H + Sz / 2, 1, 1], [-Sz / 2, H + Sz / 2, 0, 1]], 0.02);
    const post = plane(L, [[-pw / 2, -0.2, 0, 0], [pw / 2, -0.2, 1, 0], [pw / 2, H, 1, 1], [-pw / 2, H, 0, 1]], 0);
    const vps = two ? 8 : 4; // vértices por cartel en cada malla
    res.byType[t] = { sign, post, count: L.length, vps };
    res.tris += L.length * (two ? 8 : 4);
  }
  return res;
}

/** Texturas de fábrica (dibujos propios): rombo amarillo con borde negro y el símbolo de cada tipo; fondo transparente. */
export function makeSignCanvas(type) {
  const N = 256, cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d');
  if (type === 'post') {
    cv.width = 32; cv.height = 256;
    const gr = g.createLinearGradient(0, 0, 32, 0);
    gr.addColorStop(0, '#6d7179'); gr.addColorStop(0.5, '#b9bdc4'); gr.addColorStop(1, '#6d7179');
    g.fillStyle = gr; g.fillRect(0, 0, 32, 256);
    return cv;
  }
  const c = N / 2, R = N * 0.47;
  const diamond = (rr) => { g.beginPath(); g.moveTo(c, c - rr); g.lineTo(c + rr, c); g.lineTo(c, c + rr); g.lineTo(c - rr, c); g.closePath(); };
  g.fillStyle = '#111'; diamond(R); g.fill();
  g.fillStyle = '#f5c518'; diamond(R - 12); g.fill();
  g.strokeStyle = '#111'; g.fillStyle = '#111'; g.lineWidth = 16; g.lineCap = 'round'; g.lineJoin = 'round';
  const head = (x, y, a, s = 26) => { g.beginPath(); g.moveTo(x + Math.cos(a) * s, y + Math.sin(a) * s); g.lineTo(x + Math.cos(a + 2.4) * s, y + Math.sin(a + 2.4) * s); g.lineTo(x + Math.cos(a - 2.4) * s, y + Math.sin(a - 2.4) * s); g.closePath(); g.fill(); };
  if (type === 'right' || type === 'left') {
    const m = type === 'left' ? -1 : 1;
    g.save(); g.translate(c, c); g.scale(m, 1); g.translate(-c, -c);
    g.beginPath(); g.moveTo(c - 18, c + 62); g.lineTo(c - 18, c + 5); g.quadraticCurveTo(c - 18, c - 30, c + 20, c - 30); g.stroke();
    head(c + 32, c - 30, 0);
    g.restore();
  } else if (type === 'zigzag') {
    g.beginPath(); g.moveTo(c - 8, c + 68); g.lineTo(c - 8, c + 40); g.bezierCurveTo(c - 8, c + 15, c + 26, c + 22, c + 26, c - 2); g.bezierCurveTo(c + 26, c - 26, c - 22, c - 20, c - 22, c - 42); g.stroke();
    head(c - 22, c - 52, -Math.PI / 2);
  } else { // rotonda: tres flechas en círculo
    const rr = 42;
    for (let q = 0; q < 3; q++) {
      const a0 = q * (2 * Math.PI / 3) - Math.PI / 2 + 0.35, a1 = a0 + 1.35;
      g.beginPath(); g.arc(c, c, rr, a0, a1); g.stroke();
      head(c + Math.cos(a1 + 0.12) * rr, c + Math.sin(a1 + 0.12) * rr, a1 + Math.PI / 2 + 0.2, 20);
    }
  }
  return cv;
}
