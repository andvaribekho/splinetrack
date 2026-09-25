// Modelo de elevación: colinas aleatorias suaves + rampas de cruce + optimización con restricciones.
import { rng, clamp, smoothstep, arcDelta, evalAt, movingAverage, nearestOnSamples } from './geometry.js';
import { solveQP } from './solver.js';

export const DEFAULT_ELEV = {
  hills: 0.35, // slider 0..1
  hillsMax: 12, // m de amplitud con slider = 1
  hillCount: 3, // colinas por vuelta (centro del espectro)
  lambdaMin: 60, // m, longitud de onda mínima
  seed: 1234,
  smooth: 0.5, // 0..1 (más alto = más suave)
  maxGrade: 10, // %
  rCrest: 80, // m radio vertical mínimo en cresta
  rSag: 40, // m radio vertical mínimo en valle
  clearance: 6, // m altura libre bajo puente
  deck: 1, // m espesor de tablero
  crossType: 'mixed', // 'bridge' | 'tunnel' | 'mixed'
  startFlat: 40, // m planos a cada lado de la meta
  flatZones: [], // [[s0, s1], ...] en la ruta principal
  profileZones: [], // perfiles dibujados en la ruta principal: [{s0, s1, pts: [[t 0..1, z], ...]}]
  baseHeight: 0,
  bank: false,
  bankMax: 12, // grados
  designSpeed: 90, // km/h para peralte
};

const SHARE = { bridge: 1, tunnel: 0, mixed: 0.5 };

function coarseGrid(route, dsTarget) {
  const n = route.closed ? Math.max(8, Math.round(route.L / dsTarget)) : Math.max(4, Math.round(route.L / dsTarget) + 1);
  const ds = route.closed ? route.L / n : route.L / (n - 1);
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = i * ds;
  return { n, ds, s };
}

/** Ruido de colinas normalizado a [-1, 1]. */
function hillNoise(s, L, closed, pinned, ep, rand) {
  const n = s.length;
  const out = new Float64Array(n);
  const kMax = Math.max(1, Math.floor((pinned ? 2 * L : L) / Math.max(ep.lambdaMin, 5)));
  const kc = pinned ? Math.max(1, (2 * L * ep.hillCount) / Math.max(ep.lapRef, 1)) : ep.hillCount;
  const sigma = Math.max(0.8, kc * 0.45);
  let any = false;
  for (let k = 1; k <= kMax; k++) {
    const a = Math.exp(-((k - kc) ** 2) / (2 * sigma * sigma)) * (0.6 + 0.8 * rand());
    const ph = rand() * Math.PI * 2;
    if (a < 1e-3) continue;
    any = true;
    for (let i = 0; i < n; i++) {
      if (pinned) out[i] += a * Math.sin((Math.PI * k * s[i]) / L);
      else if (closed) out[i] += a * Math.sin((2 * Math.PI * k * s[i]) / L + ph);
      else out[i] += a * Math.sin((Math.PI * k * s[i]) / L + ph);
    }
  }
  if (!any) return out;
  let mx = 0;
  for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(out[i]));
  if (mx > 0) for (let i = 0; i < n; i++) out[i] /= mx;
  return out;
}

function flatMask(route, s, ep) {
  const n = s.length;
  const m = new Float64Array(n).fill(1);
  const T = 30; // transición
  const zones = [];
  if (ep.startFlat > 0) {
    if (route.closed) zones.push([-ep.startFlat, ep.startFlat]);
    else { zones.push([-1, ep.startFlat]); zones.push([route.L - ep.startFlat, route.L + 1]); }
  }
  for (const z of ep.flatZones || []) zones.push(z);
  for (let i = 0; i < n; i++) {
    let v = 1;
    for (const [a, b] of zones) {
      const mid = (a + b) / 2, half = Math.abs(b - a) / 2;
      const d = route.closed ? Math.abs(arcDelta(route, mid, s[i])) : Math.abs(s[i] - mid);
      v = Math.min(v, smoothstep(half, half + T, d));
    }
    m[i] = v;
  }
  return m;
}

/**
 * Perfiles dibujados (ruta principal): para cada muestra, la altura pedida y el peso (1 dentro del tramo, se desvanece
 * en una transición a cada lado). Devuelve null si no hay perfiles.
 */
function profileTargets(route, s, zones) {
  if (!zones || !zones.length) return null;
  const n = s.length;
  const w = new Float64Array(n), z = new Float64Array(n);
  const curve = (Z, t) => {
    const P = Z.pts;
    if (t <= P[0][0]) return P[0][1];
    if (t >= P[P.length - 1][0]) return P[P.length - 1][1];
    let a = 0;
    while (a < P.length - 2 && P[a + 1][0] < t) a++;
    const [t0, z0] = P[a], [t1, z1] = P[a + 1];
    return t1 > t0 ? z0 + ((z1 - z0) * (t - t0)) / (t1 - t0) : z0;
  };
  for (const Z of zones) {
    if (!Z.pts || Z.pts.length < 2 || !(Z.s1 > Z.s0)) continue;
    const len = Z.s1 - Z.s0, T = clamp(len * 0.25, 8, 40); // transición hacia el resto de la pista
    for (let i = 0; i < n; i++) {
      let d = s[i] - Z.s0;
      if (route.closed) { d = ((d % route.L) + route.L) % route.L; if (d > len + T) d -= route.L; }
      if (d < -T || d > len + T) continue;
      const t = clamp(d / len, 0, 1);
      const wi = d < 0 ? smoothstep(0, T, T + d) : d > len ? smoothstep(0, T, T - (d - len)) : 1;
      if (wi > w[i]) { w[i] = wi; z[i] = curve(Z, t); }
    }
  }
  return { w, z };
}

function bumpProfile(d, plateau, ramp) {
  const a = Math.abs(d);
  if (a <= plateau) return 1;
  if (a >= plateau + ramp) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * (a - plateau)) / ramp));
}

/**
 * layout: resultado de buildLayout
 * ep: parámetros de elevación
 * overrides: { [crossingId]: { order: 'auto'|'a'|'b', type: 'auto'|'bridge'|'tunnel'|'mixed' } }
 */
export function computeElevation(layout, epIn = {}, overrides = {}, pinsIn = []) {
  const ep = { ...DEFAULT_ELEV, ...epIn };
  const routes = layout.routes;
  const main = routes[0];
  ep.lapRef = main.L;
  const g = ep.maxGrade / 100;
  const Hreq = ep.clearance + ep.deck;
  const rand = rng(ep.seed);
  const dsE = clamp(main.L / 450, 1.5, 6);

  // --- rejillas gruesas y ruido
  const grids = routes.map((r) => coarseGrid(r, dsE));
  const amp = ep.hills * ep.hillsMax;
  const noise = routes.map((r, k) => hillNoise(grids[k].s, r.L, r.closed, r.kind === 'alt', ep, rand));
  const mask = routes.map((r, k) => (k === 0 ? flatMask(r, grids[k].s, ep) : new Float64Array(grids[k].n).fill(1)));
  const prof = profileTargets(main, grids[0].s, ep.profileZones);

  // --- cruces: pares en rejilla gruesa y orientación
  const crossings = layout.crossings.map((c) => {
    const A = routes[c.ra], B = routes[c.rb];
    const gA = grids[c.ra], gB = grids[c.rb];
    const set = new Set();
    const pairs = [];
    for (const [i, j] of c.pairs) {
      const ci = clampIdx(Math.round(A.s[i] / gA.ds), gA.n, A.closed);
      const cj = clampIdx(Math.round(B.s[j] / gB.ds), gB.n, B.closed);
      const key = ci + ':' + cj;
      if (set.has(key)) continue;
      set.add(key);
      pairs.push([ci, cj]);
    }
    const ov = overrides[c.id] || {};
    const type = ov.type && ov.type !== 'auto' ? ov.type : ep.crossType;
    // separación propia del cruce (altura del puente: de calzada a calzada) o la general
    const hreq = ov.sep > 0 ? ov.sep : Hreq;
    return { ...c, cpairs: pairs, type, order: ov.order || 'auto', hreq, sepOwn: ov.sep > 0 };
  });
  // alturas editadas a mano cerca de un cruce: conviven con la separación del cruce (que siempre se cumple). Solo
  // ayudan a decidir qué pasada va arriba cuando el orden es automático (la que quedó más alta al editar)
  {
    const dist = (k, s0, sv) => { const r = routes[k]; return Math.abs(r.closed ? arcDelta(r, sv, s0) : sv - s0); };
    for (const c of crossings) {
      const R = (c.window || 15) * 1.3 + 5;
      const nearest = (k, s0) => { let best = null, bd = R; for (const p of pinsIn || []) { if (p.route !== k || !isFinite(p.z)) continue; const d = dist(k, s0, p.s); if (d < bd) { bd = d; best = p; } } return best; };
      const pa = nearest(c.ra, c.sa), pb = c.ra === c.rb && Math.abs(c.sa - c.sb) < 1e-6 ? null : nearest(c.rb, c.sb);
      c.pinned = !!(pa || pb);
      c.pinZa = pa ? pa.z : null;
      c.pinZb = pb ? pb.z : null;
    }
  }

  const baseZ = (k) => {
    const z = new Float64Array(grids[k].n);
    for (let i = 0; i < z.length; i++) z[i] = ep.baseHeight + amp * noise[k][i] * mask[k][i];
    return z;
  };
  const zN = routes.map((_, k) => baseZ(k));
  // peralte de la principal (solo depende de la curvatura): los atajos salen desde el borde, a la altura del borde
  const mainRoll = bankRoll(main, ep);
  const rollAtMain = (sv) => { const i = Math.round((((sv % main.L) + main.L) % main.L) / main.ds) % main.n; return mainRoll[i]; };
  // atajo desde el eje: arranca 6 cm bajo la principal (no la corta); desde el borde: a la altura del borde
  const SINK = 0.06;
  const edgeDelta = (r, end) => {
    const u = (end === 'fork' ? r.forkU : r.mergeU) || 0;
    return Math.sin(rollAtMain(end === 'fork' ? r.forkS : r.mergeS)) * u - (Math.abs(u) < 1e-6 ? SINK : 0);
  };
  // peralte de cada atajo (con el de la principal en los extremos): se conoce antes de resolver las alturas
  const altRoll = routes.map((r) => {
    if (r.kind !== 'alt' || !ep.bank) return null;
    const ro = bankRoll(r, ep);
    const Lb = Math.min(40, r.L / 3);
    const rf = rollAtMain(r.forkS), rm = rollAtMain(r.mergeS);
    for (let i = 0; i < r.n; i++) {
      const bf = smoothstep(0, Lb, r.s[i]), bm = smoothstep(0, Lb, r.L - r.s[i]);
      ro[i] = ro[i] * Math.min(bf, bm) + (r.s[i] < r.L / 2 ? rf * (1 - bf) : rm * (1 - bm));
    }
    return ro;
  });
  // rutas alternativas: línea base entre la altura de la principal en bifurcación y unión
  const altBaseline = (zMain) => routes.map((r, k) => {
    if (r.kind !== 'alt') return null;
    const zf = sampleCoarse(zMain, grids[0], main, r.forkS) + edgeDelta(r, 'fork');
    const zm = sampleCoarse(zMain, grids[0], main, r.mergeS) + edgeDelta(r, 'merge');
    const b = new Float64Array(grids[k].n);
    for (let i = 0; i < b.length; i++) { const t = grids[k].s[i] / r.L; b[i] = zf + (zm - zf) * t; }
    return b;
  });

  chooseOrientation(crossings, routes, grids, zN, Hreq, g);

  // --- rampas de cruce iterativas
  const hUp = new Float64Array(crossings.length), hDn = new Float64Array(crossings.length);
  // alturas fijadas a mano: [{route, s, z}]
  const inProfile = (sv) => (ep.profileZones || []).some((Z) => { let d = sv - Z.s0; if (main.closed) d = ((d % main.L) + main.L) % main.L; return d >= 0 && d <= Z.s1 - Z.s0; });
  // dentro de un perfil dibujado manda el perfil: se ignoran las alturas fijadas en los puntos de ese tramo
  const pinsBy = routes.map((_, k) => (pinsIn || []).filter((p) => p.route === k && isFinite(p.z) && isFinite(p.s) && !(k === 0 && inProfile(p.s))));
  const composeZ = () => {
    const z = zN.map((a) => Float64Array.from(a));
    // bumps
    crossings.forEach((c, ci) => {
      const upR = c.up === 'a' ? c.ra : c.rb, dnR = c.up === 'a' ? c.rb : c.ra;
      const upS = c.up === 'a' ? c.sa : c.sb, dnS = c.up === 'a' ? c.sb : c.sa;
      addBump(z[upR], routes[upR], grids[upR], upS, hUp[ci], c.window, g);
      addBump(z[dnR], routes[dnR], grids[dnR], dnS, -hDn[ci], c.window, g);
    });
    applyPins(z[0], routes[0], grids[0], pinsBy[0], g);
    if (prof) for (let i = 0; i < z[0].length; i++) if (prof.w[i] > 0) z[0][i] = z[0][i] * (1 - prof.w[i]) + prof.z[i] * prof.w[i];
    const base = altBaseline(z[0]);
    routes.forEach((r, k) => {
      if (!base[k]) return;
      for (let i = 0; i < z[k].length; i++) z[k][i] += base[k][i];
      applyPins(z[k], r, grids[k], pinsBy[k], g);
    });
    return z;
  };
  let zObj = composeZ();
  for (let iter = 0; iter < 10; iter++) {
    let worst = 0;
    crossings.forEach((c, ci) => {
      const d = c.hreq * 1.08 - minSep(c, zObj);
      if (d > 0.01) {
        const sh = SHARE[c.type] ?? 0.5;
        hUp[ci] += d * sh;
        hDn[ci] += d * (1 - sh);
        worst = Math.max(worst, d);
      }
    });
    zObj = composeZ();
    if (worst < 0.01) break;
  }

  // --- QP
  const offs = [];
  let N = 0;
  grids.forEach((gr) => { offs.push(N); N += gr.n; });
  const blocks = grids.map((gr, k) => ({ offset: offs[k], n: gr.n }));
  const lambdaC = 5 + 75 * clamp(ep.smooth, 0, 1);
  const lam = Math.pow(lambdaC / (2 * Math.PI), 4);
  const objRows = [];
  const cons = [];
  const diag = new Float64Array(N);
  const q = new Float64Array(N);
  const x0 = new Float64Array(N);
  routes.forEach((r, k) => {
    const gr = grids[k], o = offs[k], n = gr.n, ds = gr.ds;
    const idx = (i) => o + (r.closed ? ((i % n) + n) % n : i);
    for (let i = 0; i < n; i++) {
      const muI = 1 + (k === 0 ? 30 * (1 - mask[0][i]) + (prof ? 400 * prof.w[i] : 0) : 0);
      diag[o + i] = 2 * muI;
      q[o + i] = -2 * muI * zObj[k][i];
      x0[o + i] = zObj[k][i];
    }
    const w = (2 * lam) / Math.pow(ds, 4);
    const c2 = [1, -2, 1];
    const i0 = r.closed ? 0 : 1, i1 = r.closed ? n : n - 1;
    for (let i = i0; i < i1; i++) {
      const id3 = [idx(i - 1), idx(i), idx(i + 1)];
      objRows.push({ idx: id3, coef: c2, w });
      cons.push({ idx: id3, coef: c2, l: -(ds * ds) / (ep.rCrest * 1.08), u: (ds * ds) / (ep.rSag * 1.08) });
    }
    const j1 = r.closed ? n : n - 1;
    for (let i = 0; i < j1; i++) cons.push({ idx: [idx(i), idx(i + 1)], coef: [-1, 1], l: -g * ds * 0.98, u: g * ds * 0.98 });
    if (r.kind === 'alt') {
      // continuidad de altura y pendiente con la principal en ambos extremos
      const gm = grids[0];
      const tie = (sMain, iAlt, iAlt2, sign, delta) => {
        const f = interpIdx(sMain, gm, main);
        cons.push({ idx: [o + iAlt, offs[0] + f.i, offs[0] + f.j], coef: [1, -(1 - f.t), -f.t], l: delta, u: delta });
        // pendiente: (z_alt[i2]-z_alt[i])/ds_alt*sign = (z_main[j]-z_main[i])/ds_main
        cons.push({
          idx: [o + iAlt2, o + iAlt, offs[0] + f.j, offs[0] + f.i],
          coef: [sign / ds, -sign / ds, -1 / gm.ds, 1 / gm.ds], l: 0, u: 0,
        });
      };
      tie(r.forkS, 0, 1, 1, edgeDelta(r, 'fork'));
      tie(r.mergeS, n - 1, n - 2, -1, edgeDelta(r, 'merge'));
      // donde el atajo todavía está sobre la calzada principal, su superficie queda por debajo (no la corta)
      const win = Math.round(160 / main.ds);
      for (let i = 1; i < n - 1; i++) {
        const sv = gr.s[i];
        if (sv > 150 && r.L - sv > 150) continue;
        const e = evalAt(r, sv);
        const sRef = sv < r.L / 2 ? r.forkS : r.mergeS;
        const i0 = Math.round(sRef / main.ds);
        let bj = -1, bd = Infinity;
        for (let d = -win; d <= win; d++) {
          const j = main.closed ? (((i0 + d) % main.n) + main.n) % main.n : i0 + d;
          if (j < 0 || j >= main.n) continue;
          const dd = (main.x[j] - e.x) ** 2 + (main.y[j] - e.y) ** 2;
          if (dd < bd) { bd = dd; bj = j; }
        }
        if (bj < 0) continue;
        const uc = (e.x - main.x[bj]) * -main.ty[bj] + (e.y - main.y[bj]) * main.tx[bj];
        const wa = e.w || r.w[0];
        if (Math.abs(uc) >= main.w[bj] / 2 + wa / 2 - 0.1) continue; // ya no se superponen
        const rm = mainRoll[bj], ra = altRoll[k] ? altRoll[k][Math.min(r.n - 1, e.i)] : 0;
        const f = interpIdx(main.s[bj], gm, main);
        const ub = Math.sin(rm) * uc - Math.abs(Math.sin(ra) - Math.sin(rm)) * wa / 2 - SINK;
        cons.push({ idx: [o + i, offs[0] + f.i, offs[0] + f.j], coef: [1, -(1 - f.t), -f.t], l: null, u: ub });
      }
    }
  });
  crossings.forEach((c) => {
    const upR = c.up === 'a' ? c.ra : c.rb, dnR = c.up === 'a' ? c.rb : c.ra;
    const step = Math.max(1, Math.floor(c.cpairs.length / 12));
    c.cpairs.forEach(([i, j], t) => {
      if (t % step !== 0 && t !== c.cpairs.length - 1) return;
      const iu = c.up === 'a' ? i : j, id = c.up === 'a' ? j : i;
      cons.push({ idx: [offs[upR] + iu, offs[dnR] + id], coef: [1, -1], l: c.hreq, u: null }); // siempre: también con alturas editadas cerca
    });
  });

  const Wp = 4000;
  routes.forEach((r, k) => {
    for (const p of pinsBy[k]) {
      const f = interpIdx(p.s, grids[k], r);
      const o = offs[k];
      objRows.push({ idx: [o + f.i, o + f.j], coef: [1 - f.t, f.t], w: 2 * Wp });
      q[o + f.i] += -2 * Wp * p.z * (1 - f.t);
      q[o + f.j] += -2 * Wp * p.z * f.t;
      if (p.local) {
        // anclas en los puntos vecinos: el resto de la pista no se mueve
        for (const sa of [p.s - p.rl, p.s + p.rr]) {
          const sv = r.closed ? ((sa % r.L) + r.L) % r.L : clamp(sa, 0, r.L);
          if (pinsBy[k].some((o2) => Math.abs((r.closed ? arcDelta(r, o2.s, sv) : sv - o2.s)) < 1)) continue;
          const fa = interpIdx(sv, grids[k], r);
          const za = sampleCoarse(zObj[k], grids[k], r, sv);
          objRows.push({ idx: [o + fa.i, o + fa.j], coef: [1 - fa.t, fa.t], w: 2 * Wp });
          q[o + fa.i] += -2 * Wp * za * (1 - fa.t);
          q[o + fa.j] += -2 * Wp * za * fa.t;
        }
      }
    }
  });
  const sol = solveQP({ n: N, blocks, objRows, diag, q, cons, x0 });

  // --- a muestras finas
  const out = routes.map((r, k) => {
    const zc = sol.x.subarray(offs[k], offs[k] + grids[k].n);
    const z = new Float64Array(r.n);
    for (let i = 0; i < r.n; i++) z[i] = cubicSample(zc, grids[k], r, r.s[i]);
    return { z, zCoarse: Float64Array.from(zc), sCoarse: grids[k].s, dsCoarse: grids[k].ds };
  });

  // --- peralte
  out.forEach((o, k) => {
    const r = routes[k];
    // en los extremos de un atajo el peralte es el de la principal (el borde del atajo empalma con el de la pista)
    if (ep.bank) o.roll = k === 0 ? mainRoll : r.kind === 'alt' ? altRoll[k] : bankRoll(r, ep);
    else o.roll = new Float64Array(r.n);
  });

  // los atajos nunca asoman por encima de la pista principal donde se superponen (salida y llegada)
  routes.forEach((r, k) => { if (r.kind === 'alt') sinkAltUnderMain(main, out[0], r, out[k]); });

  const validation = validate(layout, out, crossings, ep, sol, Hreq);
  // perfiles dibujados: aviso si la pendiente máxima, un radio vertical o un cruce no dejan seguir la forma
  for (const Z of ep.profileZones || []) {
    if (!Z.pts || Z.pts.length < 2) continue;
    const pt = profileTargets(main, main.s, [Z]);
    let worst = 0, ws = Z.s0;
    for (let i = 0; i < main.n; i++) if (pt.w[i] >= 1) { const d = Math.abs(out[0].z[i] - pt.z[i]); if (d > worst) { worst = d; ws = main.s[i]; } }
    if (worst > 0.5) validation.msgs.push({ level: 'warn', route: 0, s: ws, msg: `El perfil dibujado (s≈${Z.s0.toFixed(0)}–${Z.s1.toFixed(0)} m) se sigue con hasta ${worst.toFixed(1)} m de diferencia: lo limita la pendiente máxima, un radio vertical o un cruce.` });
  }
  const pinsOut = [];
  routes.forEach((r, k) => {
    for (const p of pinsBy[k]) {
      const i = Math.min(r.n - 1, Math.max(0, Math.round(p.s / r.ds))) % r.n;
      const got = out[k].z[i];
      pinsOut.push({ ...p, got });
      if (Math.abs(got - p.z) > 0.35) {
        validation.msgs.push({ level: 'warn', route: k, s: p.s, msg: `Altura fijada en ${r.name} (s≈${p.s.toFixed(0)} m) pedida ${p.z.toFixed(1)} m, lograda ${got.toFixed(1)} m: la limita la pendiente máxima, un radio vertical o un cruce.` });
      }
    }
  });
  return {
    routes: out,
    crossings: crossings.map((c) => ({
      id: c.id, ra: c.ra, rb: c.rb, sa: c.sa, sb: c.sb, x: c.x, y: c.y, up: c.up, type: c.type,
      order: c.order, autoUp: c.autoUp, clearance: c.clearance, hreq: c.hreq, sepOwn: c.sepOwn, pinned: c.pinned,
    })),
    validation,
    pins: pinsOut,
    solver: sol && { status: sol.status, iter: sol.iter, ms: sol.ms, rank: sol.rank },
    ep,
  };
}

/** Desplaza el perfil para que pase por las alturas fijadas, con influencia local suave (RBF de Wendland). */
function applyPins(z, route, gr, pinsAll, g) {
  if (!pinsAll || !pinsAll.length) return;
  const pins = pinsAll.filter((p) => !p.local);
  const locals = pinsAll.filter((p) => p.local);
  if (pins.length) applyGlobalPins(z, route, gr, pins, g);
  // Pines locales: solo afectan el tramo entre los puntos de control vecinos.
  const phi = (r) => (r >= 1 ? 0 : Math.pow(1 - r, 4) * (4 * r + 1));
  for (const p of locals) {
    const d = p.z - sampleCoarse(z, gr, route, p.s);
    if (Math.abs(d) < 1e-6) continue;
    for (let i = 0; i < z.length; i++) {
      const ds = route.closed ? arcDelta(route, p.s, gr.s[i]) : gr.s[i] - p.s;
      const R = ds < 0 ? p.rl : p.rr;
      z[i] += d * phi(Math.abs(ds) / Math.max(R, 1));
    }
  }
}

function applyGlobalPins(z, route, gr, pins, g) {
  const m = pins.length;
  const d = pins.map((p) => p.z - sampleCoarse(z, gr, route, p.s));
  const maxD = Math.max(...d.map(Math.abs));
  const R = clamp(Math.max(maxD / (0.45 * g), 60), 60, route.closed ? route.L / 2 : Math.max(route.L, 60));
  const dist = (a, b) => Math.abs(route.closed ? arcDelta(route, a, b) : b - a);
  const phi = (r) => (r >= 1 ? 0 : Math.pow(1 - r, 4) * (4 * r + 1));
  // sistema Φ w = d
  const A = [];
  for (let i = 0; i < m; i++) {
    A.push([]);
    for (let j = 0; j < m; j++) A[i].push(phi(dist(pins[i].s, pins[j].s) / R) + (i === j ? 1e-6 : 0));
    A[i].push(d[i]);
  }
  for (let c = 0; c < m; c++) {
    let piv = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    const v = A[c][c] || 1e-12;
    for (let r = 0; r < m; r++) {
      if (r === c) continue;
      const f = A[r][c] / v;
      if (!f) continue;
      for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k];
    }
  }
  const w = A.map((row, i) => row[m] / (row[i] || 1e-12));
  for (let i = 0; i < z.length; i++) {
    let off = 0;
    for (let j = 0; j < m; j++) off += w[j] * phi(dist(pins[j].s, gr.s[i]) / R);
    z[i] += off;
  }
}

function clampIdx(i, n, closed) {
  return closed ? ((i % n) + n) % n : clamp(i, 0, n - 1);
}

function interpIdx(s, gr, route) {
  let f = s / gr.ds;
  if (route.closed) {
    f = ((f % gr.n) + gr.n) % gr.n;
    const i = Math.floor(f);
    return { i, j: (i + 1) % gr.n, t: f - i };
  }
  f = clamp(f, 0, gr.n - 1 - 1e-9);
  const i = Math.floor(f);
  return { i, j: i + 1, t: f - i };
}

function sampleCoarse(z, gr, route, s) {
  const f = interpIdx(s, gr, route);
  return z[f.i] * (1 - f.t) + z[f.j] * f.t;
}

function cubicSample(z, gr, route, s) {
  const n = gr.n;
  let f = s / gr.ds;
  if (route.closed) f = ((f % n) + n) % n; else f = clamp(f, 0, n - 1);
  const i = Math.floor(f);
  const t = f - i;
  const get = (k) => (route.closed ? z[((k % n) + n) % n] : z[clamp(k, 0, n - 1)]);
  const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
  // Catmull-Rom uniforme
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
}

function addBump(z, route, gr, s0, h, window, g) {
  if (Math.abs(h) < 1e-6) return;
  const ramp = Math.max((Math.PI * Math.abs(h)) / (2 * 0.8 * g), 20);
  const plateau = (window || 10) * 1.1;
  for (let i = 0; i < gr.n; i++) {
    const d = route.closed ? arcDelta(route, s0, gr.s[i]) : gr.s[i] - s0;
    z[i] += h * bumpProfile(d, plateau, ramp);
  }
}

function minSep(c, z) {
  const upR = c.up === 'a' ? c.ra : c.rb, dnR = c.up === 'a' ? c.rb : c.ra;
  let m = Infinity;
  for (const [i, j] of c.cpairs) {
    const iu = c.up === 'a' ? i : j, id = c.up === 'a' ? j : i;
    m = Math.min(m, z[upR][iu] - z[dnR][id]);
  }
  return m;
}

function chooseOrientation(crossings, routes, grids, zN, Hreq, g) {
  const k = crossings.length;
  if (!k) return;
  const reach = (Math.PI * Hreq) / (2 * 0.8 * g) * 2 + 60;
  const demand = (c, up) => {
    const [ci, cj] = c.cpairs[Math.floor(c.cpairs.length / 2)];
    // con alturas editadas cerca, cuentan esas alturas (la pasada editada más alta tiende a ir arriba)
    const za = c.pinZa ?? zN[c.ra][ci], zb = c.pinZb ?? zN[c.rb][cj];
    const deficit = up === 'a' ? c.hreq - (za - zb) : c.hreq - (zb - za);
    return {
      cost: Math.max(0, deficit),
      marks: [
        { r: c.ra, s: c.sa, sign: up === 'a' ? 1 : -1 },
        { r: c.rb, s: c.sb, sign: up === 'a' ? -1 : 1 },
      ],
    };
  };
  const options = crossings.map((c) => {
    if (c.order === 'a' || c.order === 'b') return [c.order];
    return ['a', 'b'];
  });
  const evalChoice = (choice) => {
    let cost = 0;
    const marks = [];
    choice.forEach((up, idx) => {
      const d = demand(crossings[idx], up);
      cost += d.cost;
      marks.push(...d.marks);
    });
    for (let a = 0; a < marks.length; a++) for (let b = a + 1; b < marks.length; b++) {
      const A = marks[a], B = marks[b];
      if (A.r !== B.r || A.sign === B.sign) continue;
      const d = Math.abs(arcDelta(routes[A.r], A.s, B.s));
      if (d < reach) cost += Hreq * 2 * (1 - d / reach);
    }
    return cost;
  };
  let best = null, bestCost = Infinity;
  if (k <= 12) {
    const total = options.reduce((p, o) => p * o.length, 1);
    for (let c = 0; c < total; c++) {
      let v = c;
      const choice = options.map((o) => { const x = o[v % o.length]; v = Math.floor(v / o.length); return x; });
      const cost = evalChoice(choice);
      if (cost < bestCost - 1e-9) { bestCost = cost; best = choice; }
    }
  } else {
    best = options.map((o) => o[0]);
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < k; i++) {
        if (options[i].length < 2) continue;
        const alt = best.slice();
        alt[i] = best[i] === 'a' ? 'b' : 'a';
        const c = evalChoice(alt);
        if (c < evalChoice(best) - 1e-9) { best = alt; improved = true; }
      }
    }
  }
  crossings.forEach((c, i) => { c.up = best[i]; c.autoUp = c.order === 'auto'; });
}

function validate(layout, out, crossings, ep, sol, Hreq) {
  const msgs = [];
  const routes = layout.routes;
  const g = ep.maxGrade / 100;
  let maxGrade = 0, minRc = Infinity, minRs = Infinity, zMin = Infinity, zMax = -Infinity;
  routes.forEach((r, k) => {
    const z = out[k].z;
    const h = Math.max(1, Math.round(out[k].dsCoarse / r.ds));
    const grade = new Float64Array(r.n);
    let badG = null, badR = null;
    for (let i = 0; i < r.n; i++) {
      zMin = Math.min(zMin, z[i]); zMax = Math.max(zMax, z[i]);
      const a = r.closed ? (i - h + r.n) % r.n : Math.max(0, i - h);
      const b = r.closed ? (i + h) % r.n : Math.min(r.n - 1, i + h);
      const span = (r.closed ? 2 * h : b - a) * r.ds;
      if (span <= 0) continue;
      const gr = (z[b] - z[a]) / span;
      grade[i] = gr;
      if (Math.abs(gr) > maxGrade) maxGrade = Math.abs(gr);
      if (Math.abs(gr) > g * 1.05 && !badG) badG = r.s[i];
      if (r.closed || (i - h >= 0 && i + h < r.n)) {
        const d2 = (z[b] - 2 * z[i] + z[a]) / ((h * r.ds) ** 2);
        if (d2 < 0) { const R = -1 / d2; if (R < minRc) minRc = R; if (R < ep.rCrest * 0.9 && badR === null) badR = r.s[i]; }
        else if (d2 > 0) { const R = 1 / d2; if (R < minRs) minRs = R; if (R < ep.rSag * 0.9 && badR === null) badR = r.s[i]; }
      }
    }
    out[k].grade = grade;
    if (badG !== null) msgs.push({ level: 'error', route: k, s: badG, msg: `Pendiente sobre el máximo en ${r.name} (s≈${badG.toFixed(0)} m).` });
    if (badR !== null) msgs.push({ level: 'warn', route: k, s: badR, msg: `Radio vertical bajo el mínimo en ${r.name} (s≈${badR.toFixed(0)} m).` });
  });
  // holgura en cruces (sobre muestras finas)
  const lc = layout.crossings;
  crossings.forEach((c, ci) => {
    const src = lc[ci];
    const upR = c.up === 'a' ? c.ra : c.rb, dnR = c.up === 'a' ? c.rb : c.ra;
    let m = Infinity;
    for (const [i, j] of src.pairs) {
      const iu = c.up === 'a' ? i : j, id = c.up === 'a' ? j : i;
      m = Math.min(m, out[upR].z[iu] - out[dnR].z[id]);
    }
    c.clearance = m;
    if (m < c.hreq - 0.25) {
      msgs.push({ level: 'error', route: c.ra, s: c.sa, msg: `Cruce ${ci + 1}: separación ${m.toFixed(1)} m < ${c.hreq.toFixed(1)} m requeridos. Sube la pendiente máxima, baja la separación del cruce o aleja los cruces.` });
    }
  });
  for (const o of layout.overlaps) {
    let mn = Infinity, mx = -Infinity;
    for (const [i, j] of o.pairs) {
      const dz = Math.abs(out[o.ra].z[i] - out[o.rb].z[j]);
      mn = Math.min(mn, dz); mx = Math.max(mx, dz);
    }
    if (mn < Hreq) msgs.push({ level: 'warn', route: o.ra, s: o.sa0, msg: `Tramos superpuestos (${routes[o.ra].name} s≈${o.sa0.toFixed(0)} m): diferencia de altura ${mn.toFixed(1)}–${mx.toFixed(1)} m. Separa el trazado o agrega un muro.` });
  }
  if (sol && sol.status !== 'solved') {
    msgs.push({ level: 'warn', msg: `El optimizador no convergió del todo (${sol.iter} iteraciones). Puede que las restricciones sean imposibles: revisa pendiente máxima, holgura y radios.` });
  }
  return { msgs, maxGrade, minRc, minRs, zMin, zMax };
}

/** Peralte por curvatura (suavizado); ceros si el peralte está desactivado. */
function bankRoll(r, ep) {
  const roll = new Float64Array(r.n);
  if (!ep.bank) return roll;
  const v = ep.designSpeed / 3.6;
  const mx = (ep.bankMax * Math.PI) / 180;
  for (let i = 0; i < r.n; i++) roll[i] = -clamp(Math.atan((v * v * r.k[i]) / 9.81), -mx, mx);
  const sm = movingAverage(roll, Math.max(1, Math.round(15 / r.ds)), r.closed);
  return movingAverage(sm, Math.max(1, Math.round(15 / r.ds)), r.closed);
}

/**
 * Baja el atajo lo justo (+6 cm) donde su calzada queda sobre la de la principal, para que no la "corte":
 * se revisan el eje y los dos bordes del atajo contra la superficie de la principal (con peralte).
 */
function sinkAltUnderMain(main, em, r, ea) {
  const lower = new Float64Array(r.n);
  // búsqueda del punto más cercano de la principal solo cerca de la bifurcación / unión (no en otros tramos que pasen cerca)
  const near = (px, py, sRef) => {
    const win = Math.round(160 / main.ds), i0 = Math.round(sRef / main.ds);
    let best = null, bd = Infinity;
    for (let d = -win; d <= win; d++) {
      const j = main.closed ? (((i0 + d) % main.n) + main.n) % main.n : i0 + d;
      if (j < 0 || j >= main.n) continue;
      const dd = (main.x[j] - px) ** 2 + (main.y[j] - py) ** 2;
      if (dd < bd) { bd = dd; best = j; }
    }
    return best;
  };
  const check = (i, sRef) => {
    const lx = -r.ty[i], ly = r.tx[i];
    const wa = r.w[i];
    let hit = false;
    for (const v of [-wa / 2, 0, wa / 2]) {
      const px = r.x[i] + lx * v, py = r.y[i] + ly * v;
      const jm = near(px, py, sRef);
      if (jm === null) continue;
      const u = (px - main.x[jm]) * -main.ty[jm] + (py - main.y[jm]) * main.tx[jm];
      const a = Math.abs((px - main.x[jm]) * main.tx[jm] + (py - main.y[jm]) * main.ty[jm]);
      if (a > main.ds * 1.5 || Math.abs(u) > main.w[jm] / 2 - 0.1) continue; // estrictamente dentro de la calzada principal
      hit = true;
      const zm = em.z[jm] + Math.sin(em.roll[jm]) * u;
      const za = ea.z[i] + Math.sin(ea.roll[i]) * v;
      lower[i] = Math.max(lower[i], za - zm + 0.06);
    }
    return hit;
  };
  // solo cerca de los extremos: se avanza mientras el atajo siga sobre la principal
  const reach = main.w[0] + Math.max(...r.w) + 2;
  for (let i = 0; i < r.n && r.s[i] < 120; i++) { const hit = check(i, r.forkS); if (!hit && r.s[i] > reach) break; }
  for (let i = r.n - 1; i >= 0 && r.L - r.s[i] < 120; i--) { const hit = check(i, r.mergeS); if (!hit && r.L - r.s[i] > reach) break; }
  // ensanchar y suavizar para que el ajuste no deje escalones
  const win = Math.max(2, Math.round(4 / r.ds));
  const dil = new Float64Array(r.n);
  for (let i = 0; i < r.n; i++) { let m = 0; for (let d = -win; d <= win; d++) { const j = i + d; if (j >= 0 && j < r.n) m = Math.max(m, lower[j]); } dil[i] = m; }
  const sm = movingAverage(dil, win, false);
  for (let i = 0; i < r.n; i++) { const d = Math.max(sm[i], lower[i], 0); if (d > 0) ea.z[i] -= d; }
}
