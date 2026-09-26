// Tests del núcleo (sin navegador): node test/run-tests.js
import { SAMPLES } from '../js/samples.js';
import { buildLayout, deriveControlPoints } from '../js/build.js';
import { computeElevation } from '../js/elevation.js';
import { traceImage } from '../js/trace.js';
import { exportBlender, exportMax, exportJSON, exportOBJ, routeSamples, bezierKnots, bezierError } from '../js/export.js';
import { rasterize } from './raster.js';
import { buildTerrain, buildTrees, buildTrackMesh, trackRows, buildDecoInstances, coveredRanges, isCovered, buildHills, buildStartGate, buildGrass, makeGround, suspPillars, pillarBlocked } from '../js/scene.js';
import { edgeSamples } from '../js/export.js';
import { computeItems, defaultGroup, itemAt } from '../js/items.js';
import { nearestOnSamples } from '../js/geometry.js';
import { buildEdgeMeshes } from '../js/edges.js';
import { edgeExtents } from '../js/tunnels.js';
import { buildRivers } from '../js/rivers.js';
import { sculptField } from '../js/scene.js';
import { buildShadows, shadowCasters, sunShadowDir } from '../js/shadows.js';
import { SCULPT_PRESETS, curveLUT, curveEval, normCurve, presetOf } from '../js/sculptcurve.js';

let fails = 0, passes = 0;
const check = (cond, msg) => { if (cond) passes++; else { fails++; console.log('  FALLA:', msg); } };

const EXPECTED = { oval: 0, figure8: 1, loop: 1, trefoil: 3, shortcut: 0, star: 4 };
for (const [key, s] of Object.entries(SAMPLES)) {
  console.log(`· ${s.name}`);
  const proj = s.build();
  const L = buildLayout(proj, { lapLength: s.lap || 1000 });
  check(L && Math.abs(L.routes[0].L - (s.lap || 1000)) < 2, `${key}: largo de vuelta`);
  check(L.crossings.length === EXPECTED[key], `${key}: cruces ${L.crossings.length} != ${EXPECTED[key]}`);
  for (const hills of [0, 0.5, 1]) {
    for (const crossType of ['mixed', 'bridge', 'tunnel']) {
      const E = computeElevation(L, { hills, crossType, seed: 7 });
      const v = E.validation;
      const req = E.ep.clearance + E.ep.deck;
      check(E.solver.status === 'solved', `${key} h=${hills} ${crossType}: solver ${E.solver.status}`);
      check(v.maxGrade <= E.ep.maxGrade / 100 * 1.06, `${key} h=${hills} ${crossType}: pendiente ${(v.maxGrade * 100).toFixed(2)}%`);
      check(E.crossings.every((c) => c.clearance >= req - 0.25), `${key} h=${hills} ${crossType}: holgura`);
      // continuidad del cierre
      const z = E.routes[0].z;
      check(!L.routes[0].closed || Math.abs(z[0] - z[z.length - 1]) < 0.5, `${key}: cierre continuo`);
      // atajos: extremos pegados a la principal
      L.routes.slice(1).forEach((r, k) => {
        const za = E.routes[k + 1].z;
        const zm0 = z[Math.round(r.forkS / L.routes[0].ds) % L.routes[0].n];
        const zm1 = z[Math.round(r.mergeS / L.routes[0].ds) % L.routes[0].n];
        check(Math.abs(za[0] - zm0) < 0.3 && Math.abs(za[za.length - 1] - zm1) < 0.3, `${key}: atajo unido en altura`);
      });
    }
  }
  if (hillsZeroFlat(L)) passes++; else { fails++; console.log('  FALLA: sin colinas ni cruces debería ser plano'); }
  // trazado por imagen
  const tr = traceImage(rasterize(proj));
  check(tr.main && tr.main.closed, `${key}: trazado cerrado`);
  const LT = buildLayout({ main: tr.main, alts: tr.alts }, { lapLength: s.lap || 1000 });
  check(LT.crossings.length === EXPECTED[key], `${key}: cruces desde imagen ${LT.crossings.length}`);
  check(tr.alts.length === proj.alts.length, `${key}: atajos desde imagen ${tr.alts.length}`);
  // exportación
  const E = computeElevation(L, { hills: 0.5, bank: true });
  const py = exportBlender(L, E), ms = exportMax(L, E), js = exportJSON(L, E, proj, {}), obj = exportOBJ(L, E);
  check(py.includes('CURVAS = {') && py.includes('def main'), `${key}: script Blender`);
  check(ms.includes('addKnot') && (ms.match(/crearSpline "/g) || []).length === L.routes.length * 3, `${key}: script Max`);
  check(JSON.parse(js).routes.length === L.routes.length, `${key}: JSON`);
  check(obj.split('\n').filter((l) => l.startsWith('l ')).length === L.routes.length * 3, `${key}: OBJ`);
  // terreno: nunca por encima de la superficie de la pista (centro y bordes)
  for (const terrainDensity of [35, 75]) {
    const T = buildTerrain(L, E, { terrain: true, terrainDensity, terrainMaxPolys: 150000 });
    let worst = -Infinity;
    L.routes.forEach((r, kk) => {
      const { left, right } = edgeSamples(L, E, kk);
      for (let i = 0; i < r.n; i++) for (const q of [{ x: r.x[i], y: r.y[i], z: E.routes[kk].z[i] }, left[i], right[i]]) worst = Math.max(worst, T.sample(q.x, q.y) - q.z);
    });
    check(worst <= -0.29, `${key}: terreno atraviesa la pista (${worst.toFixed(3)} m)`);
    check(T.tris <= 150000 * 1.02, `${key}: tope de polígonos del terreno`);
    const tr = buildTrees(L, E, { treeDensity: 10 }, T);
    check(tr.count > 10, `${key}: árboles`);
  }
  // terreno adaptativo con zona pintada
  {
    const c0 = { x: L.routes[0].x[0], y: L.routes[0].y[0] };
    const T = buildTerrain(L, E, { terrain: true, terrainDensity: 45, terrainMaxPolys: 60000, paintFactor: 9 }, [{ x: c0.x, y: c0.y, r: 90, e: false }]);
    let worst = -Infinity;
    L.routes.forEach((r, kk) => { const { left, right } = edgeSamples(L, E, kk);
      for (let i = 0; i < r.n; i++) for (const q of [{ x: r.x[i], y: r.y[i], z: E.routes[kk].z[i] }, left[i], right[i]]) worst = Math.max(worst, T.sample(q.x, q.y) - q.z); });
    check(T.adaptive && worst <= -0.29, `${key}: terreno adaptativo atraviesa la pista (${worst.toFixed(3)})`);
    check(T.tris <= 60000 * 1.1, `${key}: tope de polígonos adaptativo (${T.tris})`);
    check(T.cellFine && T.cellFine < T.cell * 0.4, `${key}: celdas finas en lo pintado`);
    // subdivisiones por pincelada: dos zonas con distinto multiplicador
    if (key === 'oval') {
      const c1 = { x: L.routes[0].x[Math.floor(L.routes[0].n / 2)], y: L.routes[0].y[Math.floor(L.routes[0].n / 2)] };
      const cnt = (TT, c) => { let n = 0; const P = TT.positions; for (let v = 0; v < P.length; v += 3) if (Math.hypot(P[v] - c.x, P[v + 1] - c.y) < 50) n++; return n; };
      const T2 = buildTerrain(L, E, { terrain: true, terrainDensity: 45, terrainMaxPolys: 200000 }, [{ x: c0.x, y: c0.y, r: 70, e: false, f: 4 }, { x: c1.x, y: c1.y, r: 70, e: false, f: 25 }]);
      const nA = cnt(T2, c0), nB = cnt(T2, c1);
      check(T2.adaptive && nB > nA * 3, `${key}: cada pincelada con sus subdivisiones (${nA} / ${nB} vértices)`);
    }
  }
  // cerros como mallas propias: fuera de los túneles ni terreno ni cerros quedan sobre la pista; donde cubren la pista, túnel
  {
    const r0 = L.routes[0], i0 = Math.floor(r0.n * 0.3), i1 = Math.floor(r0.n * 0.7);
    const hills = [
      { id: 1, height: 40, hard: false, flat: 0.2, density: 55, maxTris: 30000, strokes: [{ x: r0.x[i0], y: r0.y[i0], r: 45, e: false }] },
      { id: 2, height: 35, hard: true, flat: 1, density: 60, maxTris: 30000, strokes: [{ x: r0.x[i1], y: r0.y[i1], r: 35, e: false }, { x: r0.x[i1] + 20, y: r0.y[i1], r: 25, e: false }] },
    ];
    for (const tunnelOpen of ['none', 'left']) {
      const sp = { terrain: true, terrainDensity: 45, terrainMaxPolys: 80000, tunnelOpen, tunnelType: tunnelOpen === 'none' ? 'artificial' : 'natural', tunnelShape: tunnelOpen === 'none' ? 'circle' : 'rounded' };
      const T = buildTerrain(L, E, sp);
      const HS = buildHills(L, E, sp, T, hills);
      const runs = HS.tunnels;
      const inTun = (kk, s) => runs.some((t) => { if (t.k !== kk) return false; const r = L.routes[kk]; let ss = s;
        if (r.closed) { while (ss < t.e0) ss += r.L; while (ss > t.e1 + r.L) ss -= r.L; } return ss >= t.e0 - 3 && ss <= t.e1 + 3; });
      let worst = -Infinity, worstT = -Infinity;
      L.routes.forEach((r, kk) => { const { left, right } = edgeSamples(L, E, kk);
        for (let i = 0; i < r.n; i++) {
          const pts3 = [{ x: r.x[i], y: r.y[i], z: E.routes[kk].z[i] }, left[i], right[i]];
          for (const q of pts3) worstT = Math.max(worstT, T.sample(q.x, q.y) - q.z);
          if (inTun(kk, r.s[i])) continue;
          for (const q of pts3) worst = Math.max(worst, HS.sample(q.x, q.y) - q.z);
        } });
      check(worstT <= -0.29, `${key}: terreno sobre la pista con cerros (${worstT.toFixed(3)})`);
      check(worst <= -0.29, `${key}: cerros atraviesan la pista fuera de túneles (${worst.toFixed(3)}, ${tunnelOpen})`);
      check(runs.length >= 1, `${key}: túnel detectado bajo cerro (${tunnelOpen})`);
      check(HS.hills.length === 2 && HS.hills.every((h) => h.tris > 50 && h.tris <= 30000 * 1.15), `${key}: mallas de cerros (${HS.hills.map((h) => h.tris).join(', ')})`);
      const g = HS.tunnelGeo[0];
      check(g && g.walls.indices.length && g.ceiling.indices.length && g.portals.length === 2 && g.portals.every((p) => p.geo.indices.length), `${key}: túnel con paredes, techo y bocas`);
    }
    // costado abierto y pilares propios de cada túnel (el general queda cerrado)
    {
      const sp0 = { terrain: true, terrainDensity: 45, terrainMaxPolys: 80000, tunnelOpen: 'none', tunnelPillars: 8 };
      const T = buildTerrain(L, E, sp0);
      const H0 = buildHills(L, E, sp0, T, hills);
      if (H0.tunnels.length) {
        const t0 = H0.tunnels[0];
        const sp1 = { ...sp0, tunnelOverrides: [{ k: t0.k, s: (t0.s0 + t0.s1) / 2, open: 'right', pillars: 3 }] };
        const H1 = buildHills(L, E, sp1, T, hills);
        const g1 = H1.tunnelGeo.find((g) => g.id === t0.id), others = H1.tunnelGeo.filter((g) => g.id !== t0.id);
        check(g1 && g1.openMode === 'right' && g1.custom && g1.pillars.length === 3, `${key}: túnel con costado y pilares propios (${g1 && g1.openMode}, ${g1 && g1.pillars.length})`);
        check(others.every((g) => g.openMode === 'none' && g.pillars.length === 0), `${key}: los demás túneles siguen el valor general`);
        const H2 = buildHills(L, E, { ...sp0, tunnelOpen: 'left', tunnelOverrides: [{ k: t0.k, s: (t0.s0 + t0.s1) / 2, open: 'none' }] }, T, hills);
        const g2 = H2.tunnelGeo.find((g) => g.id === t0.id);
        check(g2 && g2.openMode === 'none' && g2.pillars.length === 0 && H2.tunnelGeo.filter((g) => g.id !== t0.id).every((g) => g.openMode === 'left'), `${key}: un túnel cerrado con el general abierto`);
        if (key === 'oval') { // cavernas: rocas y estalactitas opcionales (general y por túnel)
          const spN = { ...sp0, tunnelType: 'natural' };
          const nRock = (H) => H.tunnelGeo.reduce((acc, g) => acc + g.stalactites.indices.length + g.rocks.indices.length, 0);
          const HN = buildHills(L, E, spN, T, hills), HO = buildHills(L, E, { ...spN, caveRocks: false }, T, hills);
          const HP = buildHills(L, E, { ...spN, caveRocks: false, tunnelOverrides: [{ k: t0.k, s: (t0.s0 + t0.s1) / 2, rocks: true }] }, T, hills);
          const gp = HP.tunnelGeo.find((g) => g.id === t0.id);
          check(nRock(HN) > 0 && nRock(HO) === 0 && gp.stalactites.indices.length + gp.rocks.indices.length > 0, `${key}: cavernas con o sin rocas y estalactitas (${nRock(HN)} / ${nRock(HO)})`);
          // cada casilla por separado, densidades propias y objetos independientes con su pivote
          const ov = (o) => buildHills(L, E, { ...spN, tunnelOverrides: [{ k: t0.k, s: (t0.s0 + t0.s1) / 2, ...o }] }, T, hills).tunnelGeo.find((g) => g.id === t0.id);
          const cnt = (g) => [g.rocks.indices.length / 24, g.stalactites.indices.length / 18];
          const gA = ov({ rocks: true, stal: true }), gR = ov({ rocks: false, stal: true }), gS = ov({ rocks: true, stal: false });
          check(cnt(gA)[0] > 0 && cnt(gA)[1] > 0 && cnt(gR)[0] === 0 && cnt(gR)[1] === cnt(gA)[1] && cnt(gS)[1] === 0 && cnt(gS)[0] === cnt(gA)[0], `${key}: rocas y estalactitas independientes (${cnt(gA)} / ${cnt(gR)} / ${cnt(gS)})`);
          const gD = ov({ rocks: true, stal: true, rockDensity: 100, stalDensity: 10 });
          check(cnt(gD)[0] > cnt(gA)[0] * 1.5 && cnt(gD)[1] < cnt(gA)[1] * 0.4, `${key}: densidad de rocas y de estalactitas (${cnt(gD)} vs ${cnt(gA)})`);
          const g0 = ov({ rocks: true, stal: true, rockDensity: 0 });
          check(cnt(g0)[0] === 0 && cnt(g0)[1] === cnt(gA)[1], `${key}: densidad 0 = sin rocas`);
          check(gA.singleMesh && gA.rockItems.length === cnt(gA)[0], `${key}: single mesh por defecto`);
          // mover una roca y una estalactita en planta: la roca sigue en el piso y la estalactita pegada al techo
          {
            const r0 = gA.rockItems[0], s0 = gA.stalItems[0];
            const pr = gA.caveSnap(r0, r0.x + 3, r0.y - 2), ps = gA.caveSnap(s0, s0.x - 2, s0.y + 3);
            const gM = ov({ rocks: true, stal: true, caveMoves: { r: { [r0.key]: [pr.s, pr.u] }, s: { [s0.key]: [ps.s, ps.u] } } });
            const r1 = gM.rockItems.find((q) => q.key === r0.key), s1 = gM.stalItems.find((q) => q.key === s0.key);
            const same = gM.rockItems.filter((q) => q.key !== r0.key).every((q) => { const o = gA.rockItems.find((w) => w.key === q.key); return o && Math.hypot(o.x - q.x, o.y - q.y) < 1e-9; });
            check(r1 && r1.moved && Math.hypot(r1.x - pr.x, r1.y - pr.y) < 1e-6 && Math.hypot(r1.x - r0.x, r1.y - r0.y) > 1 && same, `${key}: roca movida en planta (${r1 && Math.hypot(r1.x - r0.x, r1.y - r0.y).toFixed(2)} m)`);
            const floorOK = gA.caveSnap(r0, r1.x, r1.y);
            check(Math.abs(r1.z - floorOK.z) < 1e-6 && Math.abs(r1.z - E.routes[0].z[Math.round(r1.s / L.routes[0].ds) % L.routes[0].n]) < 1.5, `${key}: la roca movida queda sobre el piso`);
            check(s1 && s1.moved && Math.hypot(s1.x - s0.x, s1.y - s0.y) > 1 && s1.z - r1.z > 4, `${key}: estalactita movida pegada al techo (z ${s1 && s1.z.toFixed(2)})`);
            const far = gA.caveSnap(r0, r0.x + 500, r0.y + 500);
            check(far.s <= t0.e1 && far.s >= t0.e0, `${key}: no sale del túnel al arrastrar lejos`);
          }
          const gI = ov({ rocks: true, stal: true, singleMesh: false });
          const okR = gI.rockItems.length === cnt(gA)[0] && gI.rockItems.every((it) => { let mn = Infinity; for (let q = 2; q < it.positions.length; q += 3) mn = Math.min(mn, it.positions[q]); return mn < 0.05 && mn > -0.5; });
          const okS = gI.stalItems.length === cnt(gA)[1] && gI.stalItems.every((it) => { let mx = -Infinity, mn = Infinity; for (let q = 2; q < it.positions.length; q += 3) { mx = Math.max(mx, it.positions[q]); mn = Math.min(mn, it.positions[q]); } return Math.abs(mx - 0.3) < 1e-6 && mn < -0.5; });
          check(okR && okS, `${key}: rocas y estalactitas como objetos con pivote en el piso / en la base (${gI.rockItems.length}, ${gI.stalItems.length})`);
        }
      }
    }
    // lado abierto: no queda cerro en el piso entre los pilares; forma, tipo y geometría propios por túnel
    {
      const sp0 = { terrain: true, terrainDensity: 45, terrainMaxPolys: 80000, tunnelOpen: 'left', tunnelPillars: 8 };
      const T = buildTerrain(L, E, sp0);
      const H = buildHills(L, E, sp0, T, hills);
      let bad = 0, checked = 0;
      for (const t of H.tunnels) {
        const r = L.routes[t.k], e = E.routes[t.k];
        for (let sv = t.s0 + 3; sv < t.s1 - 3; sv += 2) {
          const i = Math.round(sv / r.ds) % r.n, lx = -r.ty[i], ly = r.tx[i];
          for (let u = r.w[i] / 2 + 1.5; u < r.w[i] / 2 + 14; u += 1) {
            const x = r.x[i] + lx * u, y = r.y[i] + ly * u;
            checked++;
            if (H.sample(x, y) > T.sample(x, y) + 0.1 && H.sample(x, y) < e.z[i] + 2) bad++; // cerro visible sobre el suelo, a la altura del piso
          }
        }
      }
      check(checked > 0 && bad <= checked * 0.005, `${key}: sin cerro en el piso del lado abierto (${bad}/${checked})`); // (antes: ~5 %)
      if (H.tunnels.length) {
        const t0 = H.tunnels[0];
        const ovs = [{ k: t0.k, s: (t0.s0 + t0.s1) / 2, shape: 'circle', type: 'natural', density: 90, meshMode: 'optimized', adapt: 1 }];
        const H1 = buildHills(L, E, { ...sp0, tunnelShape: 'square', tunnelType: 'artificial', tunnelDensity: 30, tunnelOverrides: ovs }, T, hills);
        const g1 = H1.tunnelGeo.find((g) => g.id === t0.id), g2 = H1.tunnelGeo.find((g) => g.id !== t0.id);
        check(g1 && g1.shape === 'circle' && g1.natural && g1.meshMode === 'optimized' && g1.density === 90, `${key}: túnel con forma, tipo y geometría propios`);
        if (g2) check(g2.shape === 'square' && !g2.natural && g2.meshMode === 'uniform', `${key}: los otros túneles siguen lo general`);
        const H2 = buildHills(L, E, { ...sp0, tunnelOverrides: [{ ...ovs[0], maxTris: 1200 }] }, T, hills);
        const g3 = H2.tunnelGeo.find((g) => g.id === t0.id);
        check(g3 && (g3.walls.indices.length + g3.ceiling.indices.length + g3.walkways.indices.length) / 3 <= 1200 * 1.05, `${key}: tope de triángulos por túnel (${g3 && (g3.walls.indices.length + g3.ceiling.indices.length + g3.walkways.indices.length) / 3})`);
        // medidas propias: ancho, altura libre, marco y cuánto sobresale la boca
        const H3 = buildHills(L, E, { ...sp0, tunnelOverrides: [{ k: t0.k, s: (t0.s0 + t0.s1) / 2, width: 26, height: 12, frame: 2.5, depth: 3 }] }, T, hills);
        const t3 = H3.tunnels.find((t) => t.id === t0.id), g4 = H3.tunnelGeo.find((g) => g.id === t0.id), g0 = H.tunnelGeo.find((g) => g.id === t0.id);
        check(t3 && t3.width === 26 && t3.height === 12 && t3.sp.tunnelHeight === 12 && t3.sp.portalFrame === 2.5, `${key}: túnel con medidas propias`);
        check(g4 && g0 && g4.box && g0.box && g4.box.B > g0.box.B + 3 && g4.box.A > g0.box.A && g4.box.thick === 2.5 && g4.box.depth === 3, `${key}: boca según las medidas del túnel (B ${g0 && g0.box.B.toFixed(1)} → ${g4 && g4.box.B.toFixed(1)})`);
        const zmaxOf = (g) => { let m = -Infinity; const P = g.ceiling.positions; for (let i = 2; i < P.length; i += 3) m = Math.max(m, P[i]); return m; };
        if (g4 && g0) check(zmaxOf(g4) > zmaxOf(g0) + 2, `${key}: techo más alto con altura propia`);
        const g5 = H3.tunnelGeo.find((g) => g.id !== t0.id), g6 = H.tunnelGeo.find((g) => g.id !== t0.id);
        if (g5 && g6) check(Math.abs(g5.box.B - g6.box.B) < 1e-6, `${key}: los otros túneles no cambian`);
      }
    }
    // túnel con camino de tierra y barrera: la pared queda después de la barrera y el piso del túnel empieza tras ella
    {
      const spE = { terrain: true, terrainDensity: 45, terrainMaxPolys: 80000, tunnelWidth: 16, dirtSide: 'both', dirtWidth: 3, barrierSide: 'both', barrierThick: 0.3 };
      const T = buildTerrain(L, E, spE);
      const H = buildHills(L, E, spE, T, hills);
      const g = H.tunnelGeo[0];
      if (g) {
        const t = H.tunnels.find((q) => q.id === g.id), r = L.routes[t.k];
        const i = Math.round(((t.s0 + t.s1) / 2) / r.ds) % r.n, hw = r.w[i] / 2, ext = 3 + 0.3 + 0.15;
        const lat = (x, y) => Math.abs((x - r.x[i]) * -r.ty[i] + (y - r.y[i]) * r.tx[i]);
        const along = (x, y) => Math.abs((x - r.x[i]) * r.tx[i] + (y - r.y[i]) * r.ty[i]);
        let wMin = Infinity, fMin = Infinity;
        const P = g.walls.positions, F = g.walkways.positions;
        const z0 = E.routes[t.k].z[i];
        for (let v = 0; v < P.length / 3; v++) if (along(P[v * 3], P[v * 3 + 1]) < 1.5 && P[v * 3 + 2] - z0 < 1.2) wMin = Math.min(wMin, lat(P[v * 3], P[v * 3 + 1])); // a la altura de la barrera
        for (let v = 0; v < F.length / 3; v++) if (along(F[v * 3], F[v * 3 + 1]) < 1.5) fMin = Math.min(fMin, lat(F[v * 3], F[v * 3 + 1]));
        check(wMin >= hw + ext - 0.05, `${key}: pared del túnel después de la barrera (${wMin.toFixed(2)} ≥ ${(hw + ext).toFixed(2)})`);
        check(Math.abs(fMin - (hw + ext)) < 0.35, `${key}: piso del túnel desde la barrera (${fMin.toFixed(2)} vs ${(hw + ext).toFixed(2)})`);
        const B = buildEdgeMeshes(L, E, spE);
        const bm = B.barriers.find((b) => b.k === t.k);
        let inTun = 0;
        for (let v = 0; v < bm.positions.length / 3; v += 6) if (along(bm.positions[v * 3], bm.positions[v * 3 + 1]) < 1.5 && lat(bm.positions[v * 3], bm.positions[v * 3 + 1]) < hw + 4) inTun++;
        check(inTun > 0, `${key}: la barrera sigue dentro del túnel`);
      }
    }
    // densidad por cerro: bajar el máximo de triángulos reduce la malla
    {
      const sp = { terrain: true, terrainDensity: 30 };
      const T = buildTerrain(L, E, sp);
      const lo = buildHills(L, E, sp, T, [{ ...hills[0], id: 7, maxTris: 1500 }]);
      const hi = buildHills(L, E, sp, T, [{ ...hills[0], id: 7, maxTris: 1500, density: 90 }]);
      check(lo.hills[0].tris <= 1500 * 1.2, `${key}: tope de triángulos por cerro (${lo.hills[0].tris})`);
      check(hi.hills[0].tris >= lo.hills[0].tris * 0.8, `${key}: el tope manda sobre la densidad`);
    }
    // árboles y hierba: solo terreno, laderas, cimas; inclinación según la normal
    {
      const sp = { terrain: true, terrainDensity: 35, treeDensity: 12, treeSpread: 60, grassDensity: 60 };
      const T = buildTerrain(L, E, sp);
      const HS = buildHills(L, E, sp, T, hills);
      const G = makeGround(T, HS);
      const t0 = buildTrees(L, E, sp, G);
      check(t0.count > 10 && t0.trees.every((t) => t.where === 'terrain' && t.up[2] === 1), `${key}: árboles solo en el terreno y rectos`);
      const tTop = buildTrees(L, E, { ...sp, treeOnTops: true, treeHillDensity: 10 }, G);
      check(tTop.trees.some((t) => t.where === 'top') && !tTop.trees.some((t) => t.where === 'slope'), `${key}: árboles en cimas (${tTop.trees.filter((t) => t.where === 'top').length})`);
      const tSl = buildTrees(L, E, { ...sp, treeOnSlopes: true, treeHillDensity: 10, treeTilt: 100 }, G);
      const onSl = tSl.trees.filter((t) => t.where === 'slope');
      check(onSl.length > 3 && !tSl.trees.some((t) => t.where === 'top'), `${key}: árboles en laderas (${onSl.length})`);
      check(onSl.some((t) => t.up[2] < 0.97), `${key}: árboles inclinados según la ladera`);
      const onSlZ = onSl.every((t) => Math.abs(t.z - G.sample(t.x, t.y)) < 1e-6);
      check(onSlZ, `${key}: árboles apoyados en el cerro`);
      const gr = buildGrass(L, E, { ...sp, grassOnSlopes: true, grassOnTops: true }, G);
      const gr0 = buildGrass(L, E, sp, G);
      check(gr.count > gr0.count && gr0.count > 50 && gr.indices.length === gr.count * 12 && gr.uvs.length === gr.count * 16, `${key}: hierba (${gr0.count} / ${gr.count})`);
    }
  }
  // ancho de cada atajo: propio o el de la pista; con «ancho de la pista en la salida y la llegada» hace la transición
  if (L.routes.some((r) => r.kind === 'alt')) {
    for (const ao of [{}, { width: 7 }, { width: 7, inheritWidth: true }]) {
      const projA = { ...proj, alts: proj.alts.map((a) => ({ ...a, ...ao })) };
      const LA = buildLayout(projA, { lapLength: s.lap || 1000 });
      LA.routes.forEach((a) => {
        if (a.kind !== 'alt') return;
        const wantMid = ao.width || LA.routes[0].w[0];
        const wantEnd = ao.inheritWidth ? LA.routes[0].w[0] : wantMid;
        check(Math.abs(a.w[Math.floor(a.n / 2)] - wantMid) < 0.01 && Math.abs(a.w[0] - wantEnd) < 0.01, `${key}: ancho del atajo ${JSON.stringify(ao)}`);
      });
    }
  }
  // atajos desde el eje (por defecto): su calzada queda bajo la principal donde se superponen
  if (L.routes.some((r) => r.kind === 'alt')) {
    for (const gp of [{}, { width7: true }]) {
      const LA = buildLayout(gp.width7 ? { ...proj, alts: proj.alts.map((a) => ({ ...a, width: 7 })) } : proj, { lapLength: s.lap || 1000 });
      const EA = computeElevation(LA, { hills: 0.5, bank: true });
      const m = LA.routes[0], em = EA.routes[0];
      let worst = -Infinity;
      LA.routes.forEach((a, ka) => {
        if (a.kind !== 'alt') return;
        const ea = EA.routes[ka];
        for (let i = 0; i < a.n; i++) {
          if (a.s[i] > 100 && a.L - a.s[i] > 100) continue;
          for (const v of [-a.w[i] / 2, 0, a.w[i] / 2]) {
            const px = a.x[i] - a.ty[i] * v, py = a.y[i] + a.tx[i] * v;
            const nn = nearestOnSamples(m, px, py), jm = Math.min(m.n - 1, nn.i);
            const u = (px - nn.x) * -m.ty[jm] + (py - nn.y) * m.tx[jm];
            if (Math.abs(u) > m.w[jm] / 2) continue;
            worst = Math.max(worst, ea.z[i] + Math.sin(ea.roll[i]) * v - (em.z[jm] + Math.sin(em.roll[jm]) * u));
          }
        }
      });
      check(worst <= 0.02, `${key}: atajo desde el eje queda bajo la principal (${worst.toFixed(3)} m) ${JSON.stringify(gp)}`);
    }
  }
  // elementos de pista: charcos, turbo pads y nitro strips
  {
    const groups = { puddle: [defaultGroup('puddle', 'A', 3)], pad: [defaultGroup('pad', 'A', 3)], strip: [{ ...defaultGroup('strip', 'A', 3), lane: 'outer' }] };
    const I = computeItems(L, E, groups);
    const names = I.flatMap((g) => g.items.map((it) => it.name));
    check(names.includes('puddlesA-1') && names.includes('turbopadA-1') && names.includes('nitrostripA-1'), `${key}: nombres de elementos`);
    const inside = I.every((g) => g.items.every((it) => { const r = L.routes[it.k]; const i = Math.round(((it.s % r.L) + r.L) % r.L / r.ds) % r.n; return Math.abs(it.u) <= r.w[i] / 2; }));
    check(inside, `${key}: elementos dentro de la calzada`);
    const pads = I.find((g) => g.type === 'pad').items;
    const fewer = computeItems(L, E, { pad: [{ ...groups.pad[0], count: 3 }] })[0].items;
    check(fewer.length === Math.min(3, pads.length) && fewer.every((it, q) => it.s === pads[q].s), `${key}: bajar la cantidad conserva las posiciones`);
    const it0 = pads[0];
    const f = it0.basis;
    const dot = f[2][0] * f[0][0] + f[2][1] * f[0][1] + f[2][2] * f[0][2];
    check(Math.abs(dot) < 1e-6 && f[2][2] > 0.8, `${key}: turbo pad paralelo a la calzada`);
    // los grupos sin parámetros propios usan los del primer grupo
    {
      const A = { ...defaultGroup('puddle', 'A', 3), max: 5, count: 4, size: 6 };
      const B = { ...defaultGroup('puddle', 'B', 9), max: 12, count: 12, size: 2 };
      const Ic = computeItems(L, E, { puddle: [A, B] });
      check(Ic[1].items.length === Ic[0].items.length && Ic[1].items[0].footprint.r === 3, `${key}: grupo B usa los parámetros de A`);
      const Id = computeItems(L, E, { puddle: [A, { ...B, custom: true }] });
      check(Id[1].items.length > 4 && Id[1].items[0].footprint.r === 1, `${key}: grupo B con parámetros propios`);
    }
    {
      const Ib = computeItems(L, E, { strip: [groups.strip[0]] }, (q) => q, { border: { h: 0.8 } });
      const st = Ib[0].items[0];
      check(st && st.border && st.border.indices.length === (2 * (st.positions.length / 6 - 1) + 2) * 6 && st.border.uvs.length === st.border.positions.length / 3 * 2, `${key}: borde de nitro strip (paredes sin techo, con UV)`);
      check(st && st.uvs.length === st.positions.length / 3 * 2, `${key}: UV del nitro strip`);
    }
    const hit = itemAt(I, it0.origin[0], it0.origin[1]);
    check(hit && hit.type === 'pad' && hit.idx === 0, `${key}: selección por posición`);
  }
  const tmesh = buildTrackMesh(L, E, { trackTexReps: 50 });
  check(tmesh.uvs.length / 2 === tmesh.positions.length / 3, `${key}: UV de la pista`);
  for (let k = 0; k < L.routes.length; k++) {
    const pts = routeSamples(L, E, k);
    const kn = bezierKnots(pts, L.routes[k].closed, 10, L.routes[k].k);
    check(bezierError(pts, kn, L.routes[k].closed) < 0.25, `${key}: error Bézier ruta ${k}`);
  }
}

// relieve esculpido: parte de la malla del terreno, eleva / hunde lejos de la pista y nunca la tapa
{
  const L = buildLayout(SAMPLES.oval.build(), { lapLength: 1000 });
  const E = computeElevation(L, { hills: 0.5 });
  const r = L.routes[0];
  let cx = 0, cy = 0; for (let i = 0; i < r.n; i++) { cx += r.x[i]; cy += r.y[i]; } cx /= r.n; cy /= r.n;
  const sp = { terrain: true, terrainDensity: 40 };
  const T0 = buildTerrain(L, E, sp);
  // un toque grande que eleva justo sobre un tramo de pista y otro que hunde en el centro
  const i0 = Math.round(r.n * 0.25);
  const sculpt = [{ x: cx, y: cy, r: 50, h: -10 }, { x: r.x[i0], y: r.y[i0], r: 60, h: 25 }, { x: cx + 1, y: cy, r: 40, h: 0 }];
  const T1 = buildTerrain(L, E, sp, { density: null, sculpt });
  check(T1.sculpted && T1.sample(cx, cy) < T0.sample(cx, cy) - 8, `relieve: hunde el centro (${T0.sample(cx, cy).toFixed(1)} -> ${T1.sample(cx, cy).toFixed(1)})`);
  const nx = -r.ty[i0], ny = r.tx[i0], off = r.w[i0] / 2 + 30;
  const fx = r.x[i0] + nx * off, fy = r.y[i0] + ny * off;
  check(T1.sample(fx, fy) > T0.sample(fx, fy) + 5, `relieve: eleva junto a la pista, lejos del borde (${T0.sample(fx, fy).toFixed(1)} -> ${T1.sample(fx, fy).toFixed(1)})`);
  let worst = -Infinity;
  const { left, right } = edgeSamples(L, E, 0);
  for (let i = 0; i < r.n; i++) for (const q of [{ x: r.x[i], y: r.y[i], z: E.routes[0].z[i] }, left[i], right[i]]) worst = Math.max(worst, T1.sample(q.x, q.y) - q.z);
  check(worst <= -0.29, `relieve: el terreno esculpido no tapa la pista (${worst.toFixed(3)})`);
  check(T1.tris > T0.tris, `relieve: lo esculpido recibe más detalle (${T0.tris} -> ${T1.tris})`);
  const T2 = buildTerrain(L, E, { ...sp, sculptDetail: false }, { density: null, sculpt });
  check(T2.tris === T0.tris, 'relieve: sin «más detalle» la malla conserva su densidad');
}

// tipos de terreno: playa (costa hacia el agua) y montaña (acantilado y pared de roca)
{
  const L = buildLayout(SAMPLES.oval.build(), { lapLength: 1000 });
  const E = computeElevation(L, { hills: 0.5 });
  const r = L.routes[0];
  const i0 = Math.round(r.n * 0.3), lx = -r.ty[i0], ly = r.tx[i0], hw = r.w[i0] / 2, z0 = E.routes[0].z[i0];
  const at = (T, u) => T.sample(r.x[i0] + lx * u, r.y[i0] + ly * u);
  const road = (T) => { let w = -Infinity; const { left, right } = edgeSamples(L, E, 0); for (let i = 0; i < r.n; i++) for (const q of [{ x: r.x[i], y: r.y[i], z: E.routes[0].z[i] }, left[i], right[i]]) w = Math.max(w, T.sample(q.x, q.y) - q.z); return w; };
  const beach = buildTerrain(L, E, { terrain: true, terrainDensity: 40, terrainType: 'beach', coastSide: 'right', coastLand: 20, coastBeach: 25, coastHeight: 3 });
  check(beach.waterLevel != null && beach.colors && beach.colors.length === beach.positions.length, `terreno playa: nivel del agua (${beach.waterLevel && beach.waterLevel.toFixed(1)}) y colores`);
  check(at(beach, -(hw + 5)) > beach.waterLevel + 1 && at(beach, -(hw + 120)) < beach.waterLevel - 1, `terreno playa: tierra junto a la pista y agua lejos a la derecha (${at(beach, -(hw + 5)).toFixed(1)} / ${at(beach, -(hw + 120)).toFixed(1)})`);
  check(at(beach, hw + 60) > beach.waterLevel + 1, `terreno playa: bosque a la izquierda (${at(beach, hw + 60).toFixed(1)})`);
  check(road(beach) <= -0.29, `terreno playa: no tapa la pista (${road(beach).toFixed(3)})`);
  const both = buildTerrain(L, E, { terrain: true, terrainDensity: 40, terrainType: 'beach', coastSide: 'both', coastLand: 20, coastBeach: 25 });
  check(at(both, hw + 120) < both.waterLevel - 1 && at(both, -(hw + 120)) < both.waterLevel - 1, 'terreno playa: costa a ambos lados');
  const mt = buildTerrain(L, E, { terrain: true, terrainDensity: 40, terrainType: 'mountain', cliffSide: 'left', coastLand: 15, cliffHeight: 30, wallHeight: 25 });
  check(mt.waterLevel < z0 - 20 && at(mt, hw + 80) < mt.waterLevel, `terreno montaña: acantilado a la izquierda hasta el agua (${at(mt, hw + 80).toFixed(1)}, agua ${mt.waterLevel.toFixed(1)})`);
  check(at(mt, -(hw + 25)) > z0 + 15, `terreno montaña: pared de roca a la derecha (${at(mt, -(hw + 25)).toFixed(1)} sobre ${z0.toFixed(1)})`);
  // corte abrupto: la caída ocurre en pocos metros
  let drop = null;
  for (let u = hw + 2; u < hw + 70; u += 0.5) { const a = at(mt, u), b = at(mt, u + 6); if (a - b > 15) { drop = u; break; } }
  check(drop != null, `terreno montaña: el acantilado cae más de 15 m en 6 m (${drop != null ? (drop - hw).toFixed(1) + ' m desde el borde' : 'no'})`);
  check(road(mt) <= -0.29, `terreno montaña: no tapa la pista (${road(mt).toFixed(3)})`);
  // árboles: nunca en el agua ni en la pared
  const G = makeGround(mt, null);
  const tr = buildTrees(L, E, { terrain: true, terrainType: 'mountain', treeDensity: 20, treeSpread: 60 }, G);
  check(tr.trees.every((t) => t.z > mt.waterLevel + 0.9), `terreno montaña: árboles fuera del agua (${tr.count})`);
  check(tr.trees.every((t, i) => Number.isFinite(t.yaw)) && new Set(tr.trees.map((t) => t.yaw.toFixed(2))).size > tr.count * 0.8, 'árboles con giro aleatorio');
}

// decoración: sets de elementos (junto a la pista o en zonas pintadas), máximo, giro y orientación
{
  const L = buildLayout(SAMPLES.oval.build(), { lapLength: 1000 });
  const E = computeElevation(L, { hills: 0.5 });
  const T = buildTerrain(L, E, { terrain: true, terrainDensity: 35 });
  const G = makeGround(T, null);
  const base = { mode: 'road', side: 'both', density: 10, offset: 4, spread: 25, spacing: 2, size: 1, sizeVar: 0.3, rot: 360, tilt: 0, seed: 3 };
  const a = buildDecoInstances(L, E, {}, G, { ...base, max: 1000 });
  const b = buildDecoInstances(L, E, {}, G, { ...base, max: 25 });
  check(a.length > 50 && b.length === 25, `decoración: cantidad máxima (${a.length} → ${b.length})`);
  check(a.every((it) => it.up[2] === 1) && new Set(a.map((it) => it.yaw.toFixed(2))).size > a.length * 0.8, 'decoración: giro al azar y verticales con orientación 0 %');
  const tilted = buildDecoInstances(L, E, {}, G, { ...base, tilt: 100 });
  check(tilted.length === a.length, 'decoración: la orientación no cambia el reparto');
  let minD = Infinity;
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) minD = Math.min(minD, Math.hypot(a[i].x - a[j].x, a[i].y - a[j].y));
  check(minD >= 2 - 1e-6, `decoración: separación mínima (${minD.toFixed(2)} m)`);
  const r = L.routes[0];
  let cx = 0, cy = 0; for (let i = 0; i < r.n; i++) { cx += r.x[i]; cy += r.y[i]; } cx /= r.n; cy /= r.n;
  const p = buildDecoInstances(L, E, {}, G, { ...base, mode: 'painted', density: 20, max: 5000 }, [{ x: cx, y: cy, r: 30, e: false }, { x: cx, y: cy, r: 10, e: true }]);
  check(p.length > 10 && p.every((it) => { const d = Math.hypot(it.x - cx, it.y - cy); return d <= 30.01 && d >= 9.99; }), `decoración: solo dentro de lo pintado, sin lo borrado (${p.length})`);
  check(p.every((it) => Math.abs(it.z - T.sample(it.x, it.y)) < 1e-6), 'decoración: apoyada en el terreno');
  // rotación fija: 0° = de frente al auto (el -Y local apunta contra la marcha); giro propio por lado
  const fx = buildDecoInstances(L, E, {}, G, { ...base, rotMode: 'fixed', rotLeft: 0, rotRight: 90 });
  let okL = 0, okR = 0, nL = 0, nR = 0;
  for (const it of fx) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < r.n; i++) { const d = (r.x[i] - it.x) ** 2 + (r.y[i] - it.y) ** 2; if (d < bd) { bd = d; bi = i; } }
    const left = (it.x - r.x[bi]) * -r.ty[bi] + (it.y - r.y[bi]) * r.tx[bi] >= 0;
    const fxv = Math.sin(it.yaw), fyv = -Math.cos(it.yaw); // hacia dónde mira el frente
    const dot = fxv * -r.tx[bi] + fyv * -r.ty[bi];
    if (left) { nL++; if (dot > 0.95) okL++; } else { nR++; if (Math.abs(dot) < 0.2) okR++; }
  }
  check(nL > 5 && okL / nL > 0.9 && nR > 5 && okR / nR > 0.9, `decoración: rotación fija por lado (izq ${okL}/${nL} de frente, der ${okR}/${nR} a 90°)`);
}

// bordes: camino de tierra y barrera, extruidos de las secciones de la pista
{
  const L = buildLayout(SAMPLES.shortcut.build(), { lapLength: 1000 });
  const E = computeElevation(L, { hills: 0.5 });
  const sp = { terrain: true, terrainDensity: 40, dirtSide: 'both', dirtWidth: 3, barrierSide: 'both', barrierHeight: 0.8, altDirtSide: 'both', altDirtWidth: 3, altBarrierSide: 'both', altBarrierHeight: 0.8, trackDensity: 35, trackMeshMode: 'optimized', trackAdapt: 1 };
  const B = buildEdgeMeshes(L, E, sp);
  // los atajos tienen sus propios parámetros
  const BA = buildEdgeMeshes(L, E, { ...sp, altDirtSide: 'none', altBarrierSide: 'left', altBarrierHeight: 1.6 });
  check(BA.dirt.every((d) => !d.alt) && BA.barriers.filter((b) => b.alt).length === 1 && BA.barriers.filter((b) => !b.alt).length === 2, 'bordes: parámetros propios de los atajos');
  const ab = BA.barriers.find((b) => b.alt);
  check(Math.abs((ab.positions[5] - ab.positions[2]) - 1.6) < 1e-3, `bordes: altura propia de la barrera del atajo (${(ab.positions[5] - ab.positions[2]).toFixed(2)})`);
  check(B.dirt.length === 4 && B.barriers.length === 4, `bordes: tierra y barrera a ambos lados de cada ruta (${B.dirt.length}, ${B.barriers.length})`);
  // parámetros propios de cada atajo (route.edges) por encima de los generales de atajos
  {
    const ai = L.routes.findIndex((q) => q.kind === 'alt');
    L.routes[ai].edges = { dirtSide: 'none', barrierSide: 'right', barrierHeight: 2.4 };
    const BR = buildEdgeMeshes(L, E, sp);
    const arB = BR.barriers.filter((b) => b.k === ai), arD = BR.dirt.filter((d) => d.k === ai);
    check(arB.length === 1 && arB[0].side === -1 && arD.length === 0, `bordes: parámetros por atajo (${arB.length} barreras, ${arD.length} caminos)`);
    check(arB.length && Math.abs((arB[0].positions[5] - arB[0].positions[2]) - 2.4) < 1e-3, 'bordes: altura propia de la barrera de un atajo');
    const X = edgeExtents(sp, L.routes[ai]);
    check(X.left === 0 && X.right > 0.2, `bordes: ancho extra por atajo (${X.left}, ${X.right.toFixed(2)})`);
    delete L.routes[ai].edges;
  }
  // hereda las secciones de la pista: mismas filas que la malla de la pista
  const rows = trackRows(L, E, sp);
  const bm = B.barriers.find((b) => b.k === 0 && b.side === 1);
  check(bm.positions.length / 3 === rows[0].length * 6, `bordes: la barrera usa las secciones de la pista (${bm.positions.length / 18} / ${rows[0].length})`);
  // UV a lo largo = s / largo de repetición en cada fila
  const r = L.routes[0];
  let worst = 0;
  rows[0].forEach((q, a) => { const sv = q === r.n ? r.L : r.s[q % r.n]; worst = Math.max(worst, Math.abs(bm.uvs[a * 12] - sv / 4)); });
  check(worst < 1e-3, `bordes: textura de la barrera sigue la distancia (${worst.toExponential(1)})`);
  // la barrera nace donde termina el camino de tierra
  const dm = B.dirt.find((d) => d.k === 0 && d.side === 1);
  const a0 = 10, px = bm.positions[a0 * 18], py = bm.positions[a0 * 18 + 1];
  const per = sp.terrain ? 3 : 2, ox = dm.positions[a0 * per * 3 + 3], oy = dm.positions[a0 * per * 3 + 4];
  check(Math.hypot(px - ox, py - oy) < 0.1, `bordes: la barrera empieza al final del camino de tierra (${Math.hypot(px - ox, py - oy).toFixed(3)} m)`);
  // abierta donde sale / entra el atajo: menos triángulos que una barrera continua del lado del atajo
  const full = (rows[0].length - 1) * 6;
  const counts = B.barriers.filter((b) => b.k === 0).map((b) => b.indices.length / 3);
  check(Math.min(...counts) < full - 12, `bordes: barrera abierta en las salidas del atajo (${counts.join(' / ')} de ${full})`);
  // el terreno queda bajo el camino de tierra
  const T = buildTerrain(L, E, sp);
  let wz = -Infinity;
  for (const d of B.dirt) for (let v = 0; v < d.positions.length / 3; v += per) { const x = d.positions[v * 3], y = d.positions[v * 3 + 1], z = d.positions[v * 3 + 2]; wz = Math.max(wz, T.sample(x, y) - z); }
  check(wz <= -0.25, `bordes: el terreno no tapa el camino de tierra (${wz.toFixed(3)})`);
}

// cerro sobre cerro: el de encima se apoya en el de abajo y su base no lo atraviesa
{
  const L = buildLayout(SAMPLES.oval.build(), { lapLength: 1000 });
  const E = computeElevation(L, { hills: 0.5 });
  const r = L.routes[0];
  let cx = 0, cy = 0; for (let i = 0; i < r.n; i++) { cx += r.x[i]; cy += r.y[i]; } cx /= r.n; cy /= r.n;
  const sp = { terrain: true, terrainDensity: 40 };
  const T = buildTerrain(L, E, sp);
  const A = { id: 1, height: 20, hard: false, flat: 0.6, density: 60, maxTris: 30000, strokes: [{ x: cx, y: cy, r: 60, e: false }] };
  const B = { id: 2, height: 12, hard: true, flat: 1, density: 60, maxTris: 30000, onTop: true, strokes: [{ x: cx + 10, y: cy, r: 18, e: false }] };
  const H1 = buildHills(L, E, sp, T, [A]);
  const H2 = buildHills(L, E, sp, T, [A, B]);
  const zA = H1.sample(cx + 10, cy), zAB = H2.sample(cx + 10, cy);
  check(zAB > zA + 9, `cerro encima: se suma a la altura del de abajo (${zA.toFixed(1)} → ${zAB.toFixed(1)})`);
  const hb = H2.hills.find((h) => h.id === 2), ha = H2.hills.find((h) => h.id === 1);
  const sampA = (x, y) => H1.sample(x, y);
  let below = 0, n = 0;
  for (let t = 0; t < hb.indices.length; t += 3) {
    let zc = 0, xc = 0, yc = 0;
    for (let k = 0; k < 3; k++) { const v = hb.indices[t + k]; xc += hb.positions[v * 3]; yc += hb.positions[v * 3 + 1]; zc += hb.positions[v * 3 + 2]; }
    xc /= 3; yc /= 3; zc /= 3; n++;
    if (zc < sampA(xc, yc) - 0.6) below++;
  }
  check(n > 0 && below / n < 0.02, `cerro encima: su base no atraviesa el cerro de abajo (${below}/${n} triángulos bajo él)`);
  check(ha.tris > 0, 'cerro encima: el de abajo sigue entero');
}

// cima plana al 100 %: meseta horizontal aunque se apoye en la ladera de otro cerro; subdivisión pintada en un cerro;
// ríos socavados en el terreno y cascadas en un cerro
{
  const L = buildLayout(SAMPLES.oval.build(), { lapLength: 1000 });
  const E = computeElevation(L, { hills: 0.5 });
  const r = L.routes[0];
  let cx = 0, cy = 0; for (let i = 0; i < r.n; i++) { cx += r.x[i]; cy += r.y[i]; } cx /= r.n; cy /= r.n;
  const sp = { terrain: true, terrainDensity: 40 };
  const T = buildTerrain(L, E, sp);
  const A = { id: 1, height: 24, hard: false, flat: 0, density: 60, maxTris: 60000, strokes: [{ x: cx, y: cy, r: 60, e: false }] };
  const B = { id: 2, height: 8, hard: false, flat: 1, density: 70, maxTris: 60000, onTop: true, strokes: [{ x: cx + 30, y: cy, r: 22, e: false }] };
  const H = buildHills(L, E, sp, T, [A, B]);
  const zs = [];
  for (let a = 0; a < 12; a++) for (const rr of [0, 3, 6]) { const z = H.hillSample(2, cx + 30 + Math.cos(a) * rr, cy + Math.sin(a) * rr); if (Number.isFinite(z)) zs.push(z); }
  const span = Math.max(...zs) - Math.min(...zs);
  check(zs.length > 20 && span < 0.25, `cima plana: meseta horizontal sobre otro cerro (desnivel ${span.toFixed(2)} m)`);
  // subdivisión pintada sobre el cerro
  const A2 = { ...A, subdiv: [{ x: cx, y: cy, r: 25, e: false, f: 16 }] };
  const Hsub = buildHills(L, E, sp, T, [A2]), Hno = buildHills(L, E, sp, T, [A]);
  const hs = Hsub.hills[0], hn = Hno.hills[0];
  check(hs.subdivided && hs.tris > hn.tris * 1.3, `subdivisión en un cerro (${hn.tris} → ${hs.tris} triángulos)`);
  check(Math.abs(Hsub.sample(cx + 40, cy) - Hno.sample(cx + 40, cy)) < 0.6, 'subdivisión en un cerro: misma forma');
  // río socavado en el terreno
  const rv = { id: 1, kind: 'river', mode: 'carved', depth: 3, walls: 'rock', wallSubdiv: 2, strokes: [{ x: cx - 40, y: cy - 20, r: 6, e: false }, { x: cx - 30, y: cy - 20, r: 6, e: false }, { x: cx - 20, y: cy - 20, r: 6, e: false }] };
  const TR = buildTerrain(L, E, sp, { density: null, sculpt: null, rivers: [rv] });
  const d0 = T.sample(cx - 30, cy - 20) - TR.sample(cx - 30, cy - 20);
  check(d0 > 2.4 && d0 < 3.6, `río socavado: hunde el terreno (${d0.toFixed(2)} m)`);
  check(Math.abs(T.sample(cx - 30, cy + 20) - TR.sample(cx - 30, cy + 20)) < 0.3, 'río socavado: fuera del cauce no cambia');
  check(TR.wall && TR.wall.tris > 20 && TR.baseIndices.length + TR.wall.indices.length === TR.indices.length, `río socavado: lecho y paredes aparte (${TR.wall && TR.wall.tris} triángulos)`);
  check(!T.wall, 'sin ríos socavados no hay malla de cauces');
  const RW = buildRivers(TR, null, [rv]);
  check(RW.length === 1 && RW[0].tris > 10 && RW[0].name === 'rio_01', `río: malla de agua (${RW.length && RW[0].tris} triángulos)`);
  if (RW.length) {
    let zmin = Infinity, zmax = -Infinity;
    const P = RW[0].positions;
    for (let v = 0; v < P.length; v += 3) if (Math.hypot(P[v] - (cx - 30), P[v + 1] - (cy - 20)) < 3) { const zb = TR.sample(P[v], P[v + 1]); zmin = Math.min(zmin, P[v + 2] - zb); zmax = Math.max(zmax, P[v + 2] - T.sample(P[v], P[v + 1])); }
    check(zmin > 0.5 && zmax < 0, `río: el agua queda dentro del cauce (sobre el lecho ${zmin.toFixed(2)}, bajo el borde ${zmax.toFixed(2)})`);
  }
  const rvS = { ...rv, id: 2, mode: 'surface' };
  const TS = buildTerrain(L, E, sp, { rivers: [rvS] });
  check(Math.abs(T.sample(cx - 30, cy - 20) - TS.sample(cx - 30, cy - 20)) < 0.3, 'río posado: no hunde el terreno');
  const G = makeGround(TR, null);
  check(G.inWater && G.inWater(cx - 30, cy - 20) && !G.inWater(cx - 30, cy + 20), 'río: la vegetación lo evita');
  // cascada socavada sobre el cerro
  const fall = { id: 3, kind: 'fall', hill: 1, mode: 'carved', depth: 2.5, walls: 'smooth', wallSubdiv: 2, strokes: [{ x: cx + 20, y: cy + 5, r: 5, e: false }, { x: cx + 30, y: cy + 5, r: 5, e: false }] };
  const HF = buildHills(L, E, sp, T, [{ ...A, falls: [fall] }]);
  const dh = Hno.hillSample(1, cx + 30, cy + 5) - HF.hillSample(1, cx + 30, cy + 5);
  check(dh > 1.8 && dh < 3.2, `cascada socavada: hunde el cerro (${dh.toFixed(2)} m)`);
  check(HF.hills[0].subdivided, 'cascada socavada: paredes con más geometría');
  check(HF.hills[0].wall && HF.hills[0].wall.tris > 10, 'cascada socavada: cauce con material propio');
  const FW = buildRivers(T, HF, [fall]);
  check(FW.length === 1 && FW[0].kind === 'fall' && FW[0].name === 'cascada_01', 'cascada: malla de agua propia');
}

// perfil dibujado en un tramo: la elevación sigue la forma dibujada, y fuera del tramo casi no cambia
{
  const L = buildLayout(SAMPLES.oval.build(), { lapLength: 1000 });
  const E0 = computeElevation(L, { hills: 0.5 });
  const r = L.routes[0];
  const s0 = 300, s1 = 520;
  const zAt = (E, sv) => E.routes[0].z[Math.round(sv / r.ds) % r.n];
  const zb = zAt(E0, s0);
  const pts = [];
  for (let k = 0; k <= 40; k++) { const t = k / 40; pts.push([t, zb + 6 * Math.sin(Math.PI * t) - 2 * t]); }
  const E1 = computeElevation(L, { hills: 0.5, profileZones: [{ s0, s1, pts }] });
  let worst = 0;
  for (let k = 2; k <= 38; k++) { const t = k / 40; worst = Math.max(worst, Math.abs(zAt(E1, s0 + t * (s1 - s0)) - (zb + 6 * Math.sin(Math.PI * t) - 2 * t))); }
  check(worst < 0.5, `perfil dibujado: la elevación sigue la forma (error máx. ${worst.toFixed(2)} m)`);
  const far = Math.abs(zAt(E1, 850) - zAt(E0, 850));
  check(far < 1.5, `perfil dibujado: lejos del tramo casi no cambia (${far.toFixed(2)} m)`);
  // un pin (altura fijada) dentro del tramo no le gana al perfil
  const E2 = computeElevation(L, { hills: 0.5, profileZones: [{ s0, s1, pts }] }, {}, [{ route: 0, s: 410, z: zb + 30 }]);
  check(Math.abs(zAt(E2, 410) - zAt(E1, 410)) < 0.3, 'perfil dibujado: manda sobre las alturas fijadas del tramo');
}

// tramo suspendido: el terreno no se adapta, pilares hasta el suelo, bordes y material propios; barrera de grosor 0
{
  const L = buildLayout(SAMPLES.oval.build(), { lapLength: 1000 });
  const r = L.routes[0];
  const s0 = 300, s1 = 520, zb0 = 0;
  const pts = [[0, 0], [0.25, 10], [0.75, 10], [1, 0]].map(([t, dz]) => [t, dz]);
  const E0 = computeElevation(L, { hills: 0.3 });
  const zS = E0.routes[0].z[Math.round(s0 / r.ds)];
  const E = computeElevation(L, { hills: 0.3, profileZones: [{ s0, s1, pts: pts.map(([t, dz]) => [t, zS + dz]) }] });
  const susp = [{ k: 0, s0, s1, pillars: 5, dirt: true, barrier: true }];
  const sp = { terrain: true, terrainDensity: 45, barrierSide: 'none', dirtSide: 'none' };
  const TA = buildTerrain(L, E, sp), TS = buildTerrain(L, E, { ...sp, suspRanges: susp });
  const i = Math.round(410 / r.ds), x = r.x[i], y = r.y[i], zt = E.routes[0].z[i];
  const gA = zt - TA.sample(x, y), gS = zt - TS.sample(x, y);
  check(gA < 1 && gS > 5, `tramo suspendido: el terreno no sube a la pista (bajo la pista ${gA.toFixed(2)} → ${gS.toFixed(2)} m)`);
  const PL = suspPillars(L, E, { suspRanges: susp }, makeGround(TS, null));
  check(PL.length >= 3 && PL.every((p) => p.zTop > p.zBot + 0.6), `tramo suspendido: pilares hasta el suelo (${PL.length})`);
  const TM = buildTrackMesh(L, E, { ...sp, suspRanges: susp });
  check(TM.suspParts.length === 1 && TM.suspParts[0].name === 'ruta_principal_suspendido' && TM.groups[4].count > 0, 'tramo suspendido: objeto y grupo de material propios');
  const B = buildEdgeMeshes(L, E, { ...sp, suspRanges: susp });
  check(B.barriers.length === 2 && B.barriers.every((b) => b.susp) && B.dirt.length === 2 && B.dirt.every((d) => d.susp), `tramo suspendido: barreras y camino propios aunque la pista no los tenga (${B.barriers.length}, ${B.dirt.length})`);
  const B2 = buildEdgeMeshes(L, E, { ...sp, barrierSide: 'both', suspRanges: [{ ...susp[0], barrier: false, dirt: false }] });
  const nS = B2.barriers.filter((b) => b.susp).length;
  check(B2.barriers.length === 2 && nS === 0, 'tramo suspendido sin barreras: la barrera de la pista se corta ahí');
  // barrera de grosor 0: una sola cara, con la normal hacia la calzada
  const BP = buildEdgeMeshes(L, E, { barrierSide: 'both', barrierThick: 0 });
  let okN = BP.barriers.length === 2;
  for (const m of BP.barriers) {
    okN = okN && m.plane && m.indices.length / 6 === m.segs.length;
    const P = m.positions, I = m.indices, a = I[0], b = I[1], c = I[2];
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz;
    const q = m.segs[0] * 6, fr = m.segs[0];
    // la calzada está hacia el eje: vector del vértice al eje más cercano
    const n0 = nearestOnSamples(r, P[q * 3], P[q * 3 + 1]);
    const dx = r.x[n0.i] - P[q * 3], dy = r.y[n0.i] - P[q * 3 + 1];
    okN = okN && nx * dx + ny * dy > 0;
  }
  check(okN, 'barrera de grosor 0: plano de una cara mirando a la calzada');
}

// sección socavada: la pista baja y abre una zanja con paredes (el resto del terreno no se deforma)
{
  const L = buildLayout(SAMPLES.oval.build(), { lapLength: 1000 });
  const r = L.routes[0];
  const s0 = 300, s1 = 520;
  const E0 = computeElevation(L, { hills: 0.3 });
  const zS = E0.routes[0].z[Math.round(s0 / r.ds)];
  const E = computeElevation(L, { hills: 0.3, profileZones: [{ s0, s1, pts: [[0, zS], [0.3, zS - 8], [0.7, zS - 8], [1, zS]] }] });
  const sp = { terrain: true, terrainDensity: 50, terrainMaxPolys: 150000 };
  const i = Math.round(410 / r.ds), x = r.x[i], y = r.y[i], zt = E.routes[0].z[i];
  const lx = -r.ty[i], ly = r.tx[i], hw = r.w[i] / 2;
  const TN = buildTerrain(L, E, sp); // sin sección socavada: el terreno baja con la pista
  const TA = buildTerrain(L, E, { ...sp, cutRanges: [{ k: 0, s0, s1, walls: 'art', wallSubdiv: 3 }] });
  const TR = buildTerrain(L, E, { ...sp, cutRanges: [{ k: 0, s0, s1, walls: 'nat', wallSubdiv: 3 }] });
  const at = (T, u) => T.sample(x + lx * u, y + ly * u);
  const g = TA.ctx.groundAt(x + lx * (hw + 15), y + ly * (hw + 15));
  check(Math.abs(at(TA, 0) - (zt - 0.35)) < 1.2, `sección socavada: piso de la zanja bajo la pista (${(at(TA, 0) - zt).toFixed(2)} m)`);
  check(at(TA, hw + 6) > zt + 4 && at(TN, hw + 6) < zt + 3, `sección socavada: el terreno junto a la zanja no baja (${(at(TN, hw + 6) - zt).toFixed(1)} → ${(at(TA, hw + 6) - zt).toFixed(1)} m)`);
  check(TA.cutWalls && TA.cutWalls.art && TA.cutWalls.art.tris > 20 && !TA.cutWalls.nat, `sección socavada: paredes artificiales aparte (${TA.cutWalls && TA.cutWalls.art && TA.cutWalls.art.tris})`);
  check(TR.cutWalls && TR.cutWalls.nat && TR.cutWalls.nat.tris > 20, 'sección socavada: paredes naturales (roca) aparte');
  check(Number.isFinite(g) && g > zt + 4, `sección socavada: nivel natural del suelo sobre la pista (${(g - zt).toFixed(1)} m)`);
}

// pilares: nunca sobre otra calzada, su camino de tierra o un atajo
{
  const L = buildLayout(SAMPLES.figure8.build(), { lapLength: 1000 });
  const E = computeElevation(L, { hills: 0.3 });
  const c = E.crossings[0];
  const upS = c.up === 'a' ? c.sa : c.sb, dnS = c.up === 'a' ? c.sb : c.sa;
  const r = L.routes[0];
  const sp = { dirtSide: 'both', dirtWidth: 3, suspRanges: [{ k: 0, s0: upS - 40, s1: upS + 40, pillars: 9 }] };
  const PL = suspPillars(L, E, sp, null);
  let bad = 0;
  for (const p of PL) {
    const n = nearestOnSamples(r, p.x, p.y);
    const dS = Math.abs(r.s[n.i] - dnS);
    if (Math.min(dS, r.L - dS) < 60 && n.d < r.w[n.i] / 2 + 3 + p.size * 0.5) bad++;
  }
  check(PL.length >= 5 && bad === 0, `pilares: ninguno sobre la pista de abajo ni su camino de tierra (${PL.length} pilares, ${bad} mal puestos)`);
  const i = Math.round(dnS / r.ds) % r.n;
  check(pillarBlocked(L, E, sp, r.x[i], r.y[i], 1.5, E.routes[0].z[Math.round(upS / r.ds) % r.n], 0, upS), 'pilares: detecta una calzada debajo');
}

// tramos cubiertos (bajo cruces y en túneles): material propio, cortes exactos
{
  const L = buildLayout(SAMPLES.figure8.build(), { lapLength: 1000 });
  const E = computeElevation(L, { hills: 0.5 });
  const cov = coveredRanges(L, E, [{ k: 0, s0: 100, s1: 160 }]);
  check(cov.length === 1 + E.crossings.length, `cubiertos: túnel + ${E.crossings.length} cruce(s)`);
  const TM = buildTrackMesh(L, E, { coveredRanges: cov, trackDensity: 30, trackMeshMode: 'optimized', trackAdapt: 1 });
  check(TM.groups.length >= 4 && TM.groups[2].count > 0 && TM.coveredParts.length === 1 && TM.coveredParts[0].name === 'ruta_principal_cubierto', `cubiertos: grupo y objeto propios (${TM.groups.map((g) => g.count).join('/')})`);
  const r = L.routes[0], cp = TM.coveredParts[0];
  let inside = 0, total = 0;
  const ez = E.routes[0].z;
  for (let v = 0; v < cp.positions.length / 3; v++) {
    // muestra más cercana a la misma altura (en el cruce, la otra rama pasa justo encima)
    const x = cp.positions[v * 3], y = cp.positions[v * 3 + 1], z = cp.positions[v * 3 + 2];
    let bi = 0, bd = Infinity;
    for (let i = 0; i < r.n; i++) { if (Math.abs(ez[i] - z) > 3) continue; const d = (r.x[i] - x) ** 2 + (r.y[i] - y) ** 2; if (d < bd) { bd = d; bi = i; } }
    total++; if (isCovered(L, 0, r.s[bi], cov.map((c) => ({ ...c, s0: c.s0 - 1.5, s1: c.s1 + 1.5 })))) inside++;
  }
  check(inside === total, `cubiertos: la malla cubierta queda dentro de sus tramos (${inside}/${total})`);
}

// densidad del trazado de la pista: uniforme / optimizado, tope de triángulos y UV continuo
{
  const L = buildLayout(SAMPLES.shortcut.build(), { lapLength: 1000 });
  const E = computeElevation(L, { hills: 0.5 });
  const full = buildTrackMesh(L, E, {});
  check(full.rows[0] === L.routes[0].n + 1, `densidad pista: 100 % usa todas las muestras (${full.rows[0]})`);
  const uni = trackRows(L, E, { trackDensity: 40 });
  const opt0 = trackRows(L, E, { trackDensity: 40, trackMeshMode: 'optimized', trackAdapt: 0 });
  const opt1 = trackRows(L, E, { trackDensity: 40, trackMeshMode: 'optimized', trackAdapt: 1 });
  const r = L.routes[0];
  // separación promedio en tramos rectos (|k| bajo) y curvos (|k| alto)
  const ez = E.routes[0].z, zpp = (m) => Math.abs(ez[(m + 1) % r.n] - 2 * ez[m] + ez[(m - 1 + r.n) % r.n]) / (r.ds * r.ds);
  const gaps = (q) => { let st = [], cu = []; for (let j = 1; j < q.length; j++) { const m = Math.round((q[j] + q[j - 1]) / 2) % r.n, g = (q[j] - q[j - 1]) * r.ds; if (Math.abs(r.k[m]) < 0.002 && zpp(m) < 0.001) st.push(g); else if (Math.abs(r.k[m]) > 0.02) cu.push(g); }
    const av = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length); return [av(st), av(cu)]; };
  const [us, uc] = gaps(uni[0]), [s0, c0] = gaps(opt0[0]), [s1, c1] = gaps(opt1[0]);
  check(Math.abs(us / uc - 1) < 0.25, `densidad pista: uniforme parejo (recta ${us.toFixed(1)} m, curva ${uc.toFixed(1)} m)`);
  check(s0 / c0 > 1.15 && s0 / c0 < 2.5, `densidad pista: optimizado mínimo, curvas algo más densas (×${(s0 / c0).toFixed(2)})`);
  check(s1 / c1 > 5, `densidad pista: optimizado máximo, rectas mucho menos densas (×${(s1 / c1).toFixed(2)})`);
  check(opt1[0].length <= uni[0].length + 2, `densidad pista: optimizado no supera al uniforme (${opt1[0].length} / ${uni[0].length})`);
  const capped = buildTrackMesh(L, E, { trackMaxTris: 3000 });
  check(capped.indices.length / 3 <= 3000, `densidad pista: tope de triángulos (${capped.indices.length / 3})`);
  // UV: la coordenada a lo largo es proporcional a la distancia recorrida en cada sección
  const tm = buildTrackMesh(L, E, { trackDensity: 30, trackMeshMode: 'optimized', trackAdapt: 1, skirts: false, trackTexReps: 100, trackDivs: 1 });
  const p0 = tm.parts[0], reps = 100 / r.L;
  let worstUV = 0;
  for (let v = 1; v < p0.positions.length / 3; v += 3) { // columna central
    const x = p0.positions[v * 3], y = p0.positions[v * 3 + 1];
    const nn = nearestOnSamples(r, x, y);
    const sv = nn.s, along = p0.uvs[v * 2 + 1];
    const d = Math.abs(along - sv * reps);
    worstUV = Math.max(worstUV, Math.min(d, Math.abs(d - r.L * reps)));
  }
  check(worstUV < 1e-3, `densidad pista: UV a lo largo sigue la distancia (${worstUV.toExponential(1)})`);
}

// puentes: tramo entre dos puntos de control con ancho propio
{
  const proj = SAMPLES.oval.build();
  const L0 = buildLayout(proj, { lapLength: 1000 });
  proj.main.ctrl = deriveControlPoints(proj.main.pts, true, 30 / L0.scale, 3);
  const c = proj.main.ctrl;
  proj.main.bridges = [{ a: c[5].slice(), b: c[7].slice(), w: 24 }];
  const LB = buildLayout(proj, { lapLength: 1000 });
  const r = LB.routes[0], b = r.bridges[0];
  check(b && b.s1 - b.s0 > 20, `puente: tramo detectado (${b ? (b.s1 - b.s0).toFixed(0) : 0} m)`);
  const mid = Math.round(((b.s0 + b.s1) / 2) / r.ds) % r.n;
  const far = (mid + Math.round(r.n / 2)) % r.n;
  check(Math.abs(r.w[mid] - 24) < 0.01 && Math.abs(r.w[far] - 14) < 0.01, `puente: ancho propio (${r.w[mid].toFixed(1)} / ${r.w[far].toFixed(1)})`);
  const EB = computeElevation(LB, { hills: 0.5 });
  const T = buildTerrain(LB, EB, { terrain: true, terrainDensity: 40 });
  let worst = -Infinity;
  const { left, right } = edgeSamples(LB, EB, 0);
  for (let i = 0; i < r.n; i++) for (const q of [{ x: r.x[i], y: r.y[i], z: EB.routes[0].z[i] }, left[i], right[i]]) worst = Math.max(worst, T.sample(q.x, q.y) - q.z);
  check(worst <= -0.29, `puente: el terreno no atraviesa el puente (${worst.toFixed(3)})`);
  // tablero aparte (textura propia) en la malla
  const TM = buildTrackMesh(LB, EB, {});
  check(TM.bridgeParts.length === 1 && TM.bridgeParts[0].name === 'puente_01' && TM.bridgeParts[0].indices.length > 0, 'puente: tablero como malla propia');
  check(TM.trackCount > 0 && TM.trackCount < TM.indices.length, 'puente: índices de pista y de tablero separados');
  const tpart = TM.parts[0];
  check(tpart.indices.every((i) => i < tpart.positions.length / 3) && TM.bridgeParts[0].indices.every((i) => i < TM.bridgeParts[0].positions.length / 3), 'puente: mallas compactadas válidas');
  // con la pista optimizada y poca densidad el tablero sigue exacto (secciones obligatorias en sus bordes)
  const TO = buildTrackMesh(LB, EB, { trackDensity: 10, trackMeshMode: 'optimized', trackAdapt: 1 });
  const bp = TO.bridgeParts[0];
  let zmin = Infinity, zmax = -Infinity;
  if (bp) for (let v = 0; v < bp.positions.length / 3; v++) { const nn = nearestOnSamples(r, bp.positions[v * 3], bp.positions[v * 3 + 1]); zmin = Math.min(zmin, nn.s); zmax = Math.max(zmax, nn.s); }
  check(bp && Math.abs(zmin - b.s0) < 0.6 && Math.abs(zmax - b.s1) < 0.6, `puente: tablero exacto con pista optimizada (${zmin.toFixed(1)}–${zmax.toFixed(1)} vs ${b.s0.toFixed(1)}–${b.s1.toFixed(1)})`);
}

// tramo seleccionado convertido en puente: sigue la forma original; con punto intermedio puede ser el tramo largo
{
  const proj = SAMPLES.oval.build();
  const L0 = buildLayout(proj, { lapLength: 1000 });
  proj.main.ctrl = deriveControlPoints(proj.main.pts, true, 30 / L0.scale, 3);
  const c = proj.main.ctrl, n = c.length;
  const LN = buildLayout(proj, { lapLength: 1000 });
  const ia = 4, ib = Math.floor(n * 0.75);
  proj.main.bridges = [{ a: c[ia].slice(0, 2), b: c[ib].slice(0, 2), mid: c[Math.floor((ia + ib) / 2)].slice(0, 2), w: 20 }];
  const LL = buildLayout(proj, { lapLength: 1000 });
  proj.main.bridges = [{ a: c[ib].slice(0, 2), b: c[ia].slice(0, 2), mid: c[(ib + Math.floor((n - ib + ia) / 2)) % n].slice(0, 2), w: 20 }];
  const LW = buildLayout(proj, { lapLength: 1000 });
  const bl = LL.routes[0].bridges[0], bw = LW.routes[0].bridges[0];
  const Lm = LN.routes[0].L;
  check(bl && bw && Math.abs((bl.s1 - bl.s0) + (bw.s1 - bw.s0) - Lm) < 8 && bl.s1 - bl.s0 > Lm * 0.55, `puente de tramo: el sentido lo da el punto intermedio (${bl && (bl.s1 - bl.s0).toFixed(0)} + ${bw && (bw.s1 - bw.s0).toFixed(0)} de ${Lm.toFixed(0)} m)`);
  // la forma del eje no cambia (solo el ancho)
  const r0 = LN.routes[0], r1 = LL.routes[0];
  let dev = 0;
  for (let i = 0; i < r1.n; i += 5) { const q = nearestOnSamples(r0, r1.x[i], r1.y[i]); dev = Math.max(dev, q.d); }
  const midI = Math.round(((bl.s0 + bl.s1) / 2) / r1.ds) % r1.n;
  check(dev < 0.05 && Math.abs(r1.w[midI] - 20) < 0.01, `puente de tramo: misma forma (desvío ${dev.toFixed(3)} m) y ancho propio`);
}

// puentes desplazados hacia un borde: el borde del puente sigue el borde de la pista
{
  const proj = SAMPLES.oval.build();
  const L0 = buildLayout(proj, { lapLength: 1000 });
  proj.main.ctrl = deriveControlPoints(proj.main.pts, true, 30 / L0.scale, 3);
  const c = proj.main.ctrl;
  const base = JSON.parse(JSON.stringify(proj));
  base.main.bridges = [{ a: c[5].slice(), b: c[8].slice(), w: 6 }];
  const LC = buildLayout(base, { lapLength: 1000, width: 14 });
  for (const side of [-1, 1]) {
    const pj = JSON.parse(JSON.stringify(base));
    pj.main.bridges[0].off = side;
    const LO = buildLayout(pj, { lapLength: 1000, width: 14 });
    const r = LO.routes[0], b = r.bridges[0], rc = LC.routes[0], bc = rc.bridges[0];
    check(b && Math.abs(b.off - side) < 1e-9 && Math.abs((b.s1 - b.s0) - (bc.s1 - bc.s0)) < 3, `puente desplazado ${side}: tramo conservado (${(b.s1 - b.s0).toFixed(1)} vs ${(bc.s1 - bc.s0).toFixed(1)} m)`);
    // en el centro del puente: el borde del lado elegido coincide con el borde de la pista original
    const mid = Math.round(((b.s0 + b.s1) / 2) / r.ds) % r.n;
    const nc = nearestOnSamples(rc, r.x[mid], r.y[mid]);
    const i = nc.i;
    // borde de la pista centrada (ancho 14 fuera del puente → usar 7 m del eje original sin puente)
    const lx = -rc.ty[i], ly = rc.tx[i];
    const sgn = side < 0 ? 1 : -1; // izquierda = +normal
    const shift = (r.x[mid] - rc.x[i]) * lx + (r.y[mid] - rc.y[i]) * ly;
    check(Math.abs(shift - sgn * 4) < 0.35, `puente desplazado ${side}: eje movido ${shift.toFixed(2)} m (esperado ${sgn * 4})`);
    check(Math.abs(r.w[mid] - 6) < 0.05, `puente desplazado ${side}: ancho ${r.w[mid].toFixed(2)}`);
    // muestreo uniforme tras el desplazamiento
    let dmax = 0, dmin = Infinity;
    for (let k = 0; k < r.n; k++) { const j = (k + 1) % r.n, d = Math.hypot(r.x[j] - r.x[k], r.y[j] - r.y[k]); dmax = Math.max(dmax, d); dmin = Math.min(dmin, d); }
    check(dmax / dmin < 1.05, `puente desplazado ${side}: muestreo uniforme (${dmin.toFixed(3)}–${dmax.toFixed(3)})`);
  }
}

// ---- divisiones a lo ancho de la pista: 0 por defecto, misma forma con menos triángulos ----
{
  const L = buildLayout(SAMPLES.oval.build(), { lapLength: 1000 });
  const E = computeElevation(L, { hills: 0.5, bank: true });
  const m0 = buildTrackMesh(L, E, { skirts: false }), m1 = buildTrackMesh(L, E, { skirts: false, trackDivs: 1 }), m3 = buildTrackMesh(L, E, { skirts: false, trackDivs: 3 });
  check(m1.indices.length === 2 * m0.indices.length && m3.indices.length === 4 * m0.indices.length, `divisiones a lo ancho: triángulos ${m0.indices.length / 3} / ${m1.indices.length / 3} / ${m3.indices.length / 3}`);
  // la columna del centro (trackDivs 1) cae justo en la recta entre los bordes
  const P = m1.parts[0].positions;
  let dev = 0;
  for (let v = 0; v + 2 < P.length / 3; v += 3) for (let c = 0; c < 3; c++) dev = Math.max(dev, Math.abs(P[(v + 1) * 3 + c] - (P[v * 3 + c] + P[(v + 2) * 3 + c]) / 2));
  check(dev < 1e-4, `divisiones a lo ancho: 0 divisiones no cambia la forma (desvío ${dev.toExponential(1)})`);
}

// ---- planos de sombra ----
{
  const L = buildLayout(SAMPLES.oval.build(), { lapLength: 1000 });
  const E = computeElevation(L, { hills: 0.6, bank: true });
  const r0 = L.routes[0], ih = Math.floor(r0.n * 0.5);
  const hills = [{ id: 1, height: 30, hard: false, flat: 0, density: 50, maxTris: 20000, strokes: [{ x: r0.x[ih] + 60 * -r0.ty[ih], y: r0.y[ih] + 60 * r0.tx[ih], r: 40, e: false }] }];
  const sp = { terrain: true, terrainDensity: 35, treeDensity: 10, treeSpread: 60, treeOnSlopes: true, treeHillDensity: 8 };
  const T = buildTerrain(L, E, sp);
  const HS = buildHills(L, E, sp, T, hills);
  const G = makeGround(T, HS);
  const TR = buildTrees(L, E, sp, G);
  check(shadowCasters({ ...sp, treeShadow: false }, TR.trees, [], null).length === 0, 'sombras: sin la casilla los árboles no proyectan');
  const cas = shadowCasters({ ...sp, treeShadow: true }, TR.trees, [{ set: { shadow: true }, items: [{ x: r0.x[5], y: r0.y[5], asset: 'cube:#fff', scale: 2 }] }, { set: { shadow: false }, items: [{ x: 0, y: 0, asset: 'x', scale: 1 }] }], () => ({ size: [1, 1, 1] }));
  check(cas.length === TR.count + 1, `sombras: árboles + el set marcado (${cas.length})`);
  const c2 = buildShadows(L, E, { ...sp, shadowMaxTris: 2 }, G, cas, { baseAt: (x, y) => T.sample(x, y) });
  check(c2.tris === cas.length * 2 && c2.count === cas.length, `sombras: 2 triángulos por plano (${c2.tris})`);
  const c32 = buildShadows(L, E, { ...sp, shadowMaxTris: 32, shadowTol: 0.03 }, G, cas, { baseAt: (x, y) => T.sample(x, y) });
  const hs = Object.keys(c32.hist).map(Number);
  check(c32.tris > c2.tris && c32.tris < cas.length * 32 && hs.includes(2) && Math.max(...hs) <= 32, `sombras: subdivisión adaptativa (${JSON.stringify(c32.hist)})`);
  check(c32.kinds.some((k) => k === 1), 'sombras: vértices sobre el cerro marcados');
  // se amolda a la superficie: vértices sobre el suelo o la calzada, a la altura de despegue
  let worst = 0;
  const P = c32.positions;
  for (let v = 0; v < P.length / 3; v++) { const z = P[v * 3 + 2] - 0.04, g = G.sample(P[v * 3], P[v * 3 + 1]); if (z < g - 0.01) worst = Math.max(worst, g - z); }
  check(worst < 0.02, `sombras: ningún vértice bajo el suelo (${worst.toFixed(3)} m)`);
  // la sombra del cubo junto a la pista sube a la calzada
  const one = buildShadows(L, E, sp, G, [{ x: r0.x[5], y: r0.y[5], r: 1, h: 2 }]);
  const zRoad = E.routes[0].z[5];
  check(Math.abs(one.positions[2] - 0.04 - zRoad) < 0.4 && one.positions[2] - 0.04 > G.sample(one.positions[0], one.positions[1]) - 0.01, `sombras: sube a la calzada (${(one.positions[2] - 0.04).toFixed(2)} vs pista ${zRoad.toFixed(2)})`);
  // sol: la sombra se corre al lado contrario del sol y se alarga con el sol bajo
  const c = [{ x: 0, y: 0, r: 2, h: 10 }];
  const spS = { shadowMode: 'sun', sunX: 1, sunY: 0, sunElev: 45 };
  const s45 = buildShadows(null, null, spS, null, c), s20 = buildShadows(null, null, { ...spS, sunElev: 20 }, null, c);
  const xs = (m) => { const X = []; for (let v = 0; v < m.positions.length / 3; v++) X.push(m.positions[v * 3]); return [Math.min(...X), Math.max(...X)]; };
  const [a0, a1] = xs(s45), [b0, b1] = xs(s20);
  check(Math.abs(a0 - -12) < 0.01 && Math.abs(a1 - 2) < 0.01, `sombras: con sol al este se estira al oeste desde el pie (${a0.toFixed(2)}..${a1.toFixed(2)})`);
  check(b1 - b0 > a1 - a0 && Math.abs(b1 - 2) < 0.01, `sombras: sol bajo = sombra más larga (${(a1 - a0).toFixed(1)} → ${(b1 - b0).toFixed(1)} m)`);
  check(sunShadowDir({ sunX: 0, sunY: 0, sunElev: 45 }) === null, 'sombras: sol encima = centrada');
}

// ---- cavernas: rocas y estalactitas por separado ----
{
  const L = buildLayout(SAMPLES.oval.build(), { lapLength: 1000 });
  const E = computeElevation(L, { hills: 0 });
  const r0 = L.routes[0], i0 = Math.floor(r0.n * 0.3);
  const hills = [{ id: 1, height: 45, hard: true, flat: 1, density: 50, maxTris: 30000, strokes: [{ x: r0.x[i0], y: r0.y[i0], r: 50, e: false }] }];
  const base = { terrain: true, terrainDensity: 30, tunnelType: 'natural', caveSize: 1 };
  const T = buildTerrain(L, E, base);
  const cnt = (sp) => { const H = buildHills(L, E, { ...base, ...sp }, T, hills); const t = H.tunnelGeo[0]; return t ? [t.rocks.indices.length, t.stalactites.indices.length] : null; };
  const both = cnt({}), noR = cnt({ caveRocks: false, caveStalactites: true }), noS = cnt({ caveStalactites: false }), old = cnt({ caveRocks: false });
  check(both && both[0] > 0 && both[1] > 0, `caverna con rocas y estalactitas (${both})`);
  check(noR && noR[0] === 0 && noR[1] > 0, `caverna sin rocas, con estalactitas (${noR})`);
  check(noS && noS[0] > 0 && noS[1] === 0, `caverna con rocas, sin estalactitas (${noS})`);
  check(old && old[0] === 0 && old[1] === 0, `proyecto anterior (un solo valor apagado): sin ambas (${old})`);
}

// ---- modo directo de elevación: la curva pasa exactamente por las alturas fijadas ----
{
  const L = buildLayout(SAMPLES.oval.build(), { lapLength: 1000 });
  const r = L.routes[0];
  const pins = [[50, 2], [200, 10], [320, 10], [450, 4], [700, -3], [900, 1]].map(([sv, z]) => ({ route: 0, s: sv, z, local: false }));
  const E = computeElevation(L, { mode: 'direct', hills: 1 }, {}, pins);
  const zAt = (sv) => { const u = sv / r.ds, i = Math.floor(u), t = u - i; return E.routes[0].z[i % r.n] * (1 - t) + E.routes[0].z[(i + 1) % r.n] * t; };
  const worst = Math.max(...pins.map((p) => Math.abs(zAt(p.s) - p.z)));
  check(worst < 0.02, `modo directo: pasa por los puntos (${worst.toFixed(3)} m)`);
  let flat = 0, over = 0;
  for (let i = 0; i < r.n; i++) { const sv = r.s[i], z = E.routes[0].z[i]; if (sv >= 200 && sv <= 320) flat = Math.max(flat, Math.abs(z - 10)); over = Math.max(over, z - 10, -3 - z); }
  check(flat < 1e-6 && over < 1e-6, `modo directo: plano entre alturas iguales y sin pasarse de largo (${flat.toExponential(1)}, ${over.toFixed(3)})`);
  const z0 = E.routes[0].z[0], zl = E.routes[0].z[r.n - 1];
  check(Math.abs(z0 - zl) < 0.2, `modo directo: continuo en la meta (${z0.toFixed(2)} / ${zl.toFixed(2)})`);
  check(E.pins.length === pins.length && E.pins.every((p) => Math.abs(p.got - p.z) < 0.05) && !E.validation.msgs.some((m) => /Altura fijada/.test(m.msg)), 'modo directo: sin avisos de alturas no logradas');
  // sin alturas: plano (nada automático)
  const E0 = computeElevation(L, { mode: 'direct', hills: 1 }, {}, []);
  check(Math.max(...E0.routes[0].z) - Math.min(...E0.routes[0].z) < 1e-9, 'modo directo: sin puntos fijados la pista es plana');
  // cruce sin altura suficiente: se avisa (no se corrige solo)
  const L8 = buildLayout(SAMPLES.figure8.build(), { lapLength: 1000 });
  const E8 = computeElevation(L8, { mode: 'direct' }, {}, []);
  check(L8.crossings.length > 0 && E8.validation.msgs.some((m) => /Corregir cruces/.test(m.msg)), 'modo directo: cruce sin separación se avisa');
  const c = L8.crossings[0], hi = 8;
  const E8b = computeElevation(L8, { mode: 'direct' }, {}, [{ route: 0, s: c.sa, z: hi }, { route: 0, s: c.sb, z: 0 }]);
  check(!E8b.validation.msgs.some((m) => /Cruce 1/.test(m.msg)) && E8b.crossings[0].clearance > 6.9, `modo directo: con alturas en el cruce queda separado (${E8b.crossings[0].clearance.toFixed(2)} m)`);
  // atajo: empalma con la principal
  const LS = buildLayout(SAMPLES.shortcut.build(), { lapLength: 1000 });
  const ES = computeElevation(LS, { mode: 'direct' }, {}, [{ route: 0, s: 100, z: 5 }, { route: 0, s: 600, z: 15 }]);
  const a = LS.routes[1], za = ES.routes[1].z;
  const zm = (sv) => { const m = LS.routes[0], u = (((sv % m.L) + m.L) % m.L) / m.ds, i = Math.floor(u); return ES.routes[0].z[i % m.n]; };
  check(Math.abs(za[0] - zm(a.forkS)) < 0.3 && Math.abs(za[a.n - 1] - zm(a.mergeS)) < 0.3, `modo directo: el atajo empalma con la principal (${(za[0] - zm(a.forkS)).toFixed(2)}, ${(za[a.n - 1] - zm(a.mergeS)).toFixed(2)})`);
}

// ---- terreno elevado: el terreno queda con el suelo guardado al marcar el tramo ----
{
  const L = buildLayout(SAMPLES.oval.build(), { lapLength: 1000 });
  const r = L.routes[0];
  const E0 = computeElevation(L, { hills: 0.5 }, {}, []);
  const s0 = 300, s1 = 460, N = 40;
  const zAt = (E, sv) => E.routes[0].z[Math.round(sv / r.ds) % r.n];
  const ground = Array.from({ length: N + 1 }, (_, i) => [i / N, +zAt(E0, s0 + (s1 - s0) * i / N).toFixed(3)]);
  const zone = { k: 0, s0, s1, pillars: 4, barrier: true };
  // sube el medio 12 m; los extremos anclados al suelo guardado
  const pins = [{ route: 0, s: 380, z: zAt(E0, 380) + 6 }, { route: 0, s: s0, z: ground[0][1], anchor: true }, { route: 0, s: s1, z: ground[N][1], anchor: true }];
  const E1 = computeElevation(L, { hills: 0.5 }, {}, pins);
  check(!E1.pins.some((p) => p.anchor), 'terreno elevado: las anclas no se muestran como puntos');
  check(Math.abs(zAt(E1, s0) - ground[0][1]) < 0.5 && Math.abs(zAt(E1, s1) - ground[N][1]) < 0.5, `terreno elevado: la subida queda dentro del tramo (${(zAt(E1, s0) - ground[0][1]).toFixed(2)}, ${(zAt(E1, s1) - ground[N][1]).toFixed(2)})`);
  const base = { terrain: true, terrainDensity: 40 };
  const Tref = buildTerrain(L, E1, { ...base, suspRanges: [{ ...zone, ground }] });
  const Told = buildTerrain(L, E1, { ...base, suspRanges: [zone] });
  const i = Math.round(380 / r.ds) % r.n, lx = -r.ty[i], ly = r.tx[i];
  const off = r.w[i] / 2 + 3;
  const gRef = Tref.sample(r.x[i] + lx * off, r.y[i] + ly * off), gOld = Told.sample(r.x[i] + lx * off, r.y[i] + ly * off);
  const want = zAt(E0, 380) - 0.3;
  check(Math.abs(gRef - want) < 1.2, `terreno elevado: el terreno queda donde estaba (${gRef.toFixed(2)} vs ${want.toFixed(2)})`);
  check(zAt(E1, 380) - gRef > 5, `terreno elevado: solo sube la pista (${(zAt(E1, 380) - gRef).toFixed(1)} m sobre el suelo)`);
  const G = makeGround(Tref, null);
  const pl = suspPillars(L, E1, { ...base, suspRanges: [{ ...zone, ground }] }, G);
  check(pl.length > 0 && pl.every((q) => Math.abs(q.zBot - G.sample(q.x, q.y)) < 0.6), `terreno elevado: pilares del suelo a la pista (${pl.length})`);
  void gOld;
}

// ---- atajos con puntos de control: pasan por todos sus puntos y empalman tangentes ----
{
  const proj = SAMPLES.shortcut.build();
  let L = buildLayout(proj, { lapLength: 1000 });
  proj.main.ctrl = deriveControlPoints(proj.main.pts, true, 20 / L.scale, 4); proj.main.scale = L.scale;
  proj.alts.forEach((a) => { a.ctrl = deriveControlPoints(a.pts, false, 20 / L.scale, 4); a.ctrlZ = a.ctrl.map(() => null); });
  L = buildLayout(proj, { lapLength: 1000 });
  const main = L.routes[0], alt = L.routes.find((r) => r.kind === 'alt');
  const cw = proj.alts[0].ctrl.map((q) => L.toWorld(q[0], q[1]));
  const devs = cw.slice(1, -1).map((q) => nearestOnSamples(alt, q[0], q[1]).d);
  check(Math.max(...devs) < 0.05, `atajo pasa por sus puntos (máx ${Math.max(...devs).toFixed(3)} m, ${devs.length} puntos)`);
  const i0 = Math.round(alt.forkS / main.ds) % main.n, i1 = Math.round(alt.mergeS / main.ds) % main.n;
  const d0 = alt.tx[0] * main.tx[i0] + alt.ty[0] * main.ty[i0], d1 = alt.tx[alt.n - 1] * main.tx[i1] + alt.ty[alt.n - 1] * main.ty[i1];
  check(d0 > 0.99 && d1 > 0.99, `atajo sale y entra tangente a la principal (${d0.toFixed(4)}, ${d1.toFixed(4)})`);
  const e0 = nearestOnSamples(main, cw[0][0], cw[0][1]);
  check(Math.abs(e0.s - alt.forkS) < 1, `la salida es donde está el primer punto (${e0.s.toFixed(1)} vs ${alt.forkS.toFixed(1)})`);
  // suavidad del empalme: tangente más larga = curva más abierta cerca de la salida
  proj.alts[0].joinSmooth = 2;
  const L2 = buildLayout(proj, { lapLength: 1000 }), a2 = L2.routes.find((r) => r.kind === 'alt');
  const devs2 = cw.slice(1, -1).map((q) => nearestOnSamples(a2, q[0], q[1]).d);
  check(Math.max(...devs2) < 0.05 && Math.abs(a2.L - alt.L) > 0.1, `suavidad del empalme cambia la curva sin dejar los puntos (${alt.L.toFixed(1)} → ${a2.L.toFixed(1)} m)`);
  // forma antigua (empalme automático): ignora los puntos cercanos a la principal
  proj.alts[0].legacyJoin = true; delete proj.alts[0].joinSmooth;
  const L3 = buildLayout(proj, { lapLength: 1000 }), a3 = L3.routes.find((r) => r.kind === 'alt');
  check(nearestOnSamples(a3, cw[1][0], cw[1][1]).d > 1, 'empalme antiguo: sigue disponible');
  // sin puntos de control: misma forma que al crearlos (no salta al entrar a Editar puntos)
  const proj4 = SAMPLES.shortcut.build();
  const L4a = buildLayout(proj4, { lapLength: 1000 });
  const a4a = L4a.routes.find((r) => r.kind === 'alt');
  proj4.alts.forEach((a) => { a.ctrl = deriveControlPoints(a.pts, false, Math.max(14, 1000 / 50) / L4a.scale, 3); });
  const a4b = buildLayout(proj4, { lapLength: 1000 }).routes.find((r) => r.kind === 'alt');
  check(Math.abs(a4a.L - a4b.L) < 0.5, `atajo sin puntos de control = con puntos derivados (${a4a.L.toFixed(1)} / ${a4b.L.toFixed(1)} m)`);
}

// ---- aplanado estricto entre puntos seguidos con la misma altura fijada ----
{
  const L = buildLayout(SAMPLES.oval.build(), { lapLength: 1000 });
  const pins = [300, 340, 380, 420].map((sv) => ({ route: 0, s: sv, z: 6, local: false }));
  const E = computeElevation(L, { hills: 1, seed: 3, pinFlats: [{ route: 0, s0: 300, s1: 340, z: 6 }, { route: 0, s0: 340, s1: 380, z: 6 }, { route: 0, s0: 380, s1: 420, z: 6 }] }, {}, pins);
  const r = L.routes[0], z = E.routes[0].z;
  let mn = Infinity, mx = -Infinity, gmax = 0;
  for (let i = 0; i < r.n; i++) {
    if (r.s[i] >= 300 && r.s[i] <= 420) { mn = Math.min(mn, z[i]); mx = Math.max(mx, z[i]); }
    const j = (i + 1) % r.n; gmax = Math.max(gmax, Math.abs(z[j] - z[i]) / r.ds);
  }
  check(mx - mn < 0.02 && Math.abs(mn - 6) < 0.02, `tramo aplanado estricto: z ${mn.toFixed(3)}–${mx.toFixed(3)}`);
  check(gmax * 100 <= 10.6, `tramo aplanado: la pendiente fuera sigue en el máximo (${(gmax * 100).toFixed(2)} %)`);
  const E2 = computeElevation(L, { hills: 1, seed: 3 }, {}, pins);
  let m2 = Infinity, x2 = -Infinity;
  for (let i = 0; i < r.n; i++) if (r.s[i] >= 300 && r.s[i] <= 420) { m2 = Math.min(m2, E2.routes[0].z[i]); x2 = Math.max(x2, E2.routes[0].z[i]); }
  check(x2 - m2 > 0.05, `sin tramo plano los pines solo fijan los puntos (${(x2 - m2).toFixed(2)} m de variación)`);
}

// ---- curva del pincel de relieve ----
{
  const ev = curveEval(SCULPT_PRESETS.bell.pts);
  let err = 0;
  for (let k = 0; k <= 20; k++) { const t = k / 20; err = Math.max(err, Math.abs(ev(t) - (1 - t * t) ** 2)); }
  check(err < 0.03, `curva campana ≈ (1-t²)² (error ${err.toFixed(3)})`);
  for (const [k, p] of Object.entries(SCULPT_PRESETS)) {
    const lut = curveLUT(p.pts);
    let mono = true;
    for (let i = 1; i < lut.length; i++) if (lut[i] > lut[i - 1] + 1e-6) mono = false;
    check(mono && Math.abs(lut[0] - 1) < 1e-6 && lut[lut.length - 1] === 0, `preset ${k}: monótono de 1 a 0`);
    check(presetOf(p.pts) === k, `preset ${k} reconocido`);
  }
  const n = normCurve([[0.5, 0.4], [0.02, 1.2], [1, 0.3], [0.501, 0.2]]);
  check(n[0][0] === 0 && n[n.length - 1][0] === 1 && n.every((q) => q[1] >= 0 && q[1] <= 1) && n.length === 3, `normCurve limpia la curva ${JSON.stringify(n)}`);
  // meseta dura: cima plana (a media distancia del centro casi toda la altura); campana: ya bajó
  const mk = (pts) => sculptField([{ x: 0, y: 0, r: 20, h: 5, lut: pts ? curveLUT(pts) : undefined }]);
  const Fm = mk(SCULPT_PRESETS.mesa.pts), Fb = mk(SCULPT_PRESETS.bell.pts), F0 = mk(null), Fg = mk(SCULPT_PRESETS.gentle.pts);
  check(Math.abs(Fm.sample(0, 0) - 5) < 0.05 && Fm.sample(12, 0) > 4.9 && Fm.sample(15, 0) > 4.8, `meseta: plana hasta cerca del borde (${Fm.sample(12, 0).toFixed(2)}, ${Fm.sample(15, 0).toFixed(2)})`);
  check(Fb.sample(12, 0) < 2.2 && Math.abs(Fb.sample(10, 0) - F0.sample(10, 0)) < 0.15, `campana ≈ caída anterior (${Fb.sample(10, 0).toFixed(2)} vs ${F0.sample(10, 0).toFixed(2)})`);
  const maxSlope = (pts) => { const l = curveLUT(pts); let m = 0; for (let i = 1; i < l.length; i++) m = Math.max(m, (l[i - 1] - l[i]) * (l.length - 1)); return m; };
  check(maxSlope(SCULPT_PRESETS.gentle.pts) < maxSlope(SCULPT_PRESETS.bell.pts) * 0.9 && maxSlope(SCULPT_PRESETS.mesa.pts) > 3 * maxSlope(SCULPT_PRESETS.bell.pts),
    `pendientes máx.: suave ${maxSlope(SCULPT_PRESETS.gentle.pts).toFixed(2)} < campana ${maxSlope(SCULPT_PRESETS.bell.pts).toFixed(2)} < meseta ${maxSlope(SCULPT_PRESETS.mesa.pts).toFixed(2)}`);
  const Fs = sculptField([{ x: 0, y: 0, r: 20, h: -3, lut: curveLUT(SCULPT_PRESETS.mesa.pts) }]);
  check(Math.abs(Fs.sample(10, 0) + 3) < 0.05, 'meseta hundida: fondo plano');
}

function hillsZeroFlat(L) {
  if (L.crossings.length) return true;
  const E = computeElevation(L, { hills: 0 });
  return E.validation.zMax - E.validation.zMin < 0.08; // los atajos pueden quedar unos cm bajo la principal donde se superponen
}

console.log(`\n${passes} correctas, ${fails} fallas`);
process.exit(fails ? 1 : 0);
