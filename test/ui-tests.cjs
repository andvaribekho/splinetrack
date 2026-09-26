#!/usr/bin/env node
// Pruebas de interfaz (Playwright + Chromium sin ventana). Una sola página para todas las pruebas; en vez de esperas
// fijas se espera a que la app quede quieta (window.__tsg.idle()). Cada prueba verifica (no solo imprime) y el
// resultado final dice cuántas pasaron.
//
//   npm run test:ui                 todas
//   npm run test:ui -- tunel arbol  solo las que contienen alguna de esas palabras en el nombre
//   npm run test:ui -- -j 4         en 4 procesos en paralelo (por defecto: según los núcleos, hasta 4)
//
// Cada prueba deja la app en un estado conocido al empezar (carga el óvalo o una página limpia), así se pueden
// correr solas, en cualquier orden o repartidas entre procesos.
//
// Requiere: npm install (instala playwright) y, la primera vez, npx playwright install chromium.
// No revisa todos los deslizadores (a propósito): prueba el comportamiento de cada función.
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
let URL = '';
const argv = process.argv.slice(2);
let jobs = Math.max(1, Math.min(4, os.cpus().length - 1));
const jIdx = argv.findIndex((a) => a === '-j' || a === '--jobs');
if (jIdx >= 0) { jobs = Math.max(1, parseInt(argv[jIdx + 1], 10) || 1); argv.splice(jIdx, 2); }
const SHARD = process.env.TSG_SHARD ? process.env.TSG_SHARD.split('/').map(Number) : null; // [i, n] (proceso hijo)
const filters = argv.map((s) => s.toLowerCase());
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------------------------------------------
// helpers
let page, errs = [], downloads = [];
const ev = (fn, arg) => page.evaluate(fn, arg);
const idle = () => page.evaluate(() => window.__tsg.idle());
function expect(cond, msg) { if (!cond) throw new Error(msg); }
const approx = (a, b, tol) => Math.abs(a - b) <= tol;
async function sample(name) {
  await page.selectOption('#sampleSelect', name);
  await idle();
}
async function tool(t) { await ev((t) => document.querySelector(`[data-tool=${t}]`).click(), t); await idle(); }
async function freshPage() {
  await page.goto(URL);
  await ev(() => { localStorage.clear(); localStorage.setItem('tsg.autosave', JSON.stringify({ on: false })); }); // sin autoguardado durante las pruebas
  await page.reload();
  await page.waitForFunction(() => window.__tsg && window.__tsg.idle);
  await idle();
}
/** Selecciona puntos de control de la ruta principal (índices). */
const selPts = (idxs) => ev((idxs) => { const t = window.__tsg; t.app.setMultiSel({ key: 'main', idxs }, false); t.editor.draw(); t.profile.draw(); t.preview.updateHandles(); }, idxs);
/** Coordenadas de pantalla de un punto del mundo en el mapa 2D. */
const mapXY = (x, y) => ev(([x, y]) => { const t = window.__tsg, L = t.state.layout, [lx, ly] = L.toLayout(x, y), [sx, sy] = t.editor.toScreen(lx, ly), r = document.getElementById('canvas2d').getBoundingClientRect(); return [sx + r.left, sy + r.top]; }, [x, y]);
/** Arrastra en pantalla (con pasos intermedios). */
async function drag(x0, y0, x1, y1, steps = 3) { await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x1, y1, { steps }); await page.mouse.up(); }
/** Nombres de los objetos de la escena exportada, agrupados por su padre. */
const exportNames = () => ev(async () => {
  const t = window.__tsg, m = await import('/js/export-glb.js');
  const { root } = await m.buildExportScene(t.state.layout, t.state.result, t.state.scene, { deco: { assetById: (id) => t.app.assetById(id), sets: t.state.decoSets, paintFor: (s) => t.app.decoPaintWorld(s) }, triggers: t.app.triggersWorld() }, t.app.terrainPaintWorld ? t.app.terrainPaintWorld() : null, t.app.hillsWorld(), null);
  const out = {};
  root.traverse((o) => { if (o !== root && o.name && o.parent) (out[o.parent.name || '?'] = out[o.parent.name || '?'] || []).push(o.name); });
  return out;
});
/** Página limpia con el óvalo cargado (para pruebas que no dependen de las anteriores). */
async function reset(name = 'oval') { await freshPage(); await sample(name); }
/** Crea un tramo del tipo pedido con los puntos de control dados (herramienta Editar puntos). */
async function makeTramo(type, idxs) {
  await tool('edit');
  await ev((type) => { document.getElementById('tramoType').value = type; }, type);
  await selPts(idxs);
  await ev(() => document.getElementById('btnBridge').click());
  await idle();
  const n = await ev(() => (window.__tsg.state.project.main.bridges || []).length);
  expect(n >= 1, `no se creó el tramo (${await ev(() => document.getElementById('toast') && document.getElementById('toast').textContent)})`);
}
const addHill = (frac = 0.3, extra = {}) => ev(([frac, extra]) => {
  const t = window.__tsg, L = t.state.layout, r = L.routes[0], i = Math.floor(r.n * frac), [x, y] = L.toLayout(r.x[i], r.y[i]);
  t.state.hills = [{ id: 1, name: 'cerro_01', height: 40, hard: true, flat: 1, density: 40, maxTris: 15000, strokes: [{ x, y, r: 45 / L.scale, e: false }], ...extra }];
  t.preview.update(false);
}, [frac, extra]);

// ---------------------------------------------------------------------------------------------------------------
// pruebas
test('carga: versión en el título y en la barra', async () => {
  const [ver, title, bar] = await ev(async () => { const m = await import('/js/version.js'); return [m.VERSION, document.title, document.getElementById('appVersion').textContent]; });
  expect(title.includes(`v${ver}`) && bar === `v${ver}`, `versión ${ver}: título «${title}», barra «${bar}»`);
});

test('ejemplos: óvalo, ocho y trébol se construyen', async () => {
  for (const [n, minCross] of [['figure8', 1], ['trefoil', 3], ['oval', 0]]) {
    await sample(n);
    const [ok, cross] = await ev(() => [!!window.__tsg.state.layout && !!window.__tsg.state.result, window.__tsg.state.result ? window.__tsg.state.result.crossings.length : -1]);
    expect(ok && cross >= minCross, `${n}: layout ${ok}, cruces ${cross}`);
  }
});

test('barra superior: una sola herramienta activa y Esc vuelve a Navegar', async () => {
  await sample('oval');
  for (const t of ['edit', 'draw', 'paint', 'sculpt', 'hill', 'river', 'tsmooth']) {
    await tool(t);
    const act = await ev(() => [...document.querySelectorAll('#toolbar [data-tool].active, .side-tool[data-tool].active')].map((b) => b.dataset.tool));
    expect(act.length === 1 && act[0] === t, `herramienta ${t}: activas ${act}`);
  }
  await ev(() => document.getElementById('btnHelix').click()); // selección de puntos para las operaciones de forma
  await page.keyboard.press('Escape');
  await idle();
  const st = await ev(() => [window.__tsg.state.tool, document.querySelectorAll('#toolbar .active[data-tool]:not([data-tool=pan]), #btnHelix.active').length]);
  expect(st[0] === 'pan' && st[1] === 0, `Esc: herramienta ${st[0]}, otros activos ${st[1]}`);
});

test('ventanas: Exportar y Ajustes se abren como ventana, Esc solo las cierra', async () => {
  await tool('edit');
  await page.click('#btnExportMenu');
  const vis = await ev(() => { const p = document.getElementById('exportPop'), r = p.getBoundingClientRect(), el = document.elementFromPoint(r.left + r.width / 2, r.top + 60); return [!p.hidden, p.contains(el)]; });
  expect(vis[0] && vis[1], `la ventana Exportar no se ve encima de todo: ${vis}`);
  expect(await ev(() => !!document.getElementById('knotSpacing').closest('#exportPop') && !document.querySelector('section.panel[data-panel=export]')), 'las opciones de exportación no están en la ventana');
  await page.keyboard.press('Escape');
  const s2 = await ev(() => [document.getElementById('exportPop').hidden, window.__tsg.state.tool]);
  expect(s2[0] && s2[1] === 'edit', `Esc: ventana cerrada ${s2[0]}, herramienta ${s2[1]} (debía seguir en edit)`);
  await page.click('#btnSettings');
  expect(await ev(() => !document.getElementById('settingsPop').hidden), 'Ajustes no se abrió');
  await page.click('#btnSettingsClose');
  expect(await ev(() => document.getElementById('settingsPop').hidden), 'Ajustes no se cerró');
});

test('mensajes: error al centro (30 % más grande), informativo abajo', async () => {
  await ev(() => window.__tsg.app.toast('Empieza y termina el trazo sobre la pista para redibujar ese tramo.'));
  const e = await ev(() => { const t = document.getElementById('toast'), r = t.getBoundingClientRect(); return [Math.abs(r.top + r.height / 2 - innerHeight / 2), parseFloat(getComputedStyle(t).fontSize)]; });
  expect(e[0] < 4 && approx(e[1], 15.6, 0.2), `error: a ${e[0].toFixed(1)} px del centro, letra ${e[1]} px`);
  await page.waitForTimeout(3500);
  expect(await ev(() => document.getElementById('toast').hidden), 'el mensaje de error dura más de 3,3 s');
});

test('avisos: «Eliminar avisos» (basurero) oculta los actuales y deja ver los nuevos', async () => {
  await sample('oval');
  await ev(() => { const t = window.__tsg; t.state.result.validation.msgs.push({ level: 'warn', msg: 'Aviso de prueba A' }, { level: 'error', msg: 'Error de prueba B' }); t.refreshPanels(); });
  const b = await ev(() => { const bt = document.querySelector('#validation .vclear'); return [!!bt, !!(bt && bt.querySelector('svg')), document.querySelectorAll('#validation .vmsg').length]; });
  expect(b[0] && b[1] && b[2] >= 2, `botón ${b[0]}, basurero ${b[1]}, avisos ${b[2]}`);
  await page.click('#validation .vclear');
  await ev(() => { const t = window.__tsg; t.state.result.validation.msgs.push({ level: 'warn', msg: 'Aviso nuevo C' }); t.refreshPanels(); });
  const txt = await ev(() => [...document.querySelectorAll('#validation .vmsg')].map((e) => e.textContent).join('|'));
  expect(txt.includes('Aviso nuevo C') && !txt.includes('prueba A') && !txt.includes('prueba B'), `tras eliminar: ${txt}`);
});

test('perfil: Aplanar, escalar alturas con el marco y deshacer', async () => {
  await reset();
  await tool('edit');
  await selPts([20, 21, 22, 23, 24]);
  expect(await ev(() => window.__tsg.app.flattenSelected()), 'Aplanar falló');
  await idle();
  let z = await ev(() => window.__tsg.app.selHeights().list.map((q) => q.z));
  expect(Math.max(...z) - Math.min(...z) < 0.01, `Aplanar: alturas ${z.map((v) => v.toFixed(2))}`);
  // alturas distintas y escala desde el más bajo con el asa de arriba
  await ev(() => { const zs = window.__tsg.state.project.main.ctrlZ; [0, 1, 2, 1, 0].forEach((v, j) => (zs[20 + j] = v)); window.__tsg.scheduleBuild(); });
  await idle();
  await ev(() => window.__tsg.profile.draw());
  const fr = await ev(() => { const f = window.__tsg.profile.zFrame, r = document.getElementById('canvasProfile').getBoundingClientRect(); return f && [r.left + f.cx, r.top + f.y0]; });
  expect(fr, 'no apareció el marco de la selección en el perfil');
  const z0 = await ev(() => window.__tsg.app.selHeights().list.map((q) => q.z));
  await drag(fr[0], fr[1], fr[0], fr[1] - 25);
  await idle();
  z = await ev(() => window.__tsg.app.selHeights().list.map((q) => q.z));
  expect(approx(Math.min(...z), Math.min(...z0), 0.05) && Math.max(...z) > Math.max(...z0) + 0.3, `escala Z: ${z0.map((v) => v.toFixed(2))} → ${z.map((v) => v.toFixed(2))}`);
  await ev(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Control+z');
  await idle();
  await selPts([20, 21, 22, 23, 24]);
  z = await ev(() => window.__tsg.app.selHeights().list.map((q) => q.z));
  expect(approx(Math.max(...z), Math.max(...z0), 0.05), `deshacer: ${z.map((v) => v.toFixed(2))}`);
});

test('perfil: Suavizar alturas (0–100) con extremos fijos', async () => {
  await reset();
  await tool('edit');
  await selPts([30, 31, 32, 33, 34, 35]);
  await ev(() => { const zs = window.__tsg.state.project.main.ctrlZ; [3, -2, 4, -1, 5, 0].forEach((v, j) => (zs[30 + j] = v)); window.__tsg.scheduleBuild(); });
  await idle();
  const setS = (v) => page.locator('#profSmooth').fill(String(v)); // la barra del perfil (la de verdad, con el mouse/teclado)
  await setS(100);
  const z = await ev(() => window.__tsg.app.selHeights().list.map((q) => q.z));
  const lin = z.every((v, j) => approx(v, 3 - 0.6 * j, 0.35));
  expect(approx(z[0], 3, 0.01) && approx(z[5], 0, 0.01) && lin, `suavizado 100: ${z.map((v) => v.toFixed(2))}`);
  await setS(0);
  const z0 = await ev(() => window.__tsg.app.selHeights().list.map((q) => q.z));
  expect(approx(z0[1], -2, 0.01) && approx(z0[4], 5, 0.01), `volver a 0 recupera las alturas: ${z0.map((v) => v.toFixed(2))}`);
  await selPts([40, 41, 42]);
  expect((await ev(() => document.getElementById('profSmooth').value)) === '0', 'la barra no volvió a 0 al cambiar la selección');
  expect((await ev(() => document.querySelectorAll('[id=smoothZ]').length)) === 1, 'hay ids repetidos (smoothZ)');
});

test('tramos: crear (Pista), tramo ancho desplazado hacia un lado', async () => {
  await reset();
  await makeTramo('track', [5, 6, 7, 8, 9]);
  await ev(() => { const t = window.__tsg, b = t.state.project.main.bridges[0]; b.sameWidth = false; b.w = t.state.geom.width + 10; b.off = 1; b.collapsed = false; t.scheduleBuild(); });
  await idle();
  await ev(() => window.__tsg.refreshBridgeList());
  const r = await ev(() => { const t = window.__tsg, rb = t.state.layout.routes[0].bridges[0], box = document.querySelector('#bridgeList .boBox'); return [rb.w, rb.off, box.classList.contains('disabled'), document.querySelector('#bridgeList .bo').textContent]; });
  expect(r[1] === 1 && !r[2] && /5\.0 m a la derecha/.test(r[3]), `tramo ancho: ${JSON.stringify(r)}`);
});

test('tramos: el tipo Puente (texto nuevo): el terreno no se adapta y lleva pilares', async () => {
  const txt = await ev(() => document.querySelector('#tramoType option[value=bridge]').textContent);
  expect(txt === 'Puente: Terreno no se adapta y se crean pilares', `texto: ${txt}`);
  await reset();
  await ev(() => document.querySelector('#elevMode button[data-mode=direct]').click());
  await idle();
  await makeTramo('bridge', [6, 7, 8, 9, 10]);
  await ev(() => { const t = window.__tsg, zs = t.state.project.main.ctrlZ; for (let i = 6; i <= 10; i++) zs[i] = 9; t.scheduleBuild(); });
  await page.click('#btnGenTerrain');
  await idle();
  const r = await ev(async () => { const t = window.__tsg, m = await import('/js/scene.js'), L = t.state.layout, E = t.state.result, r = L.routes[0], b = r.bridges[0], i = Math.round(((b.s0 + b.s1) / 2) / r.ds) % r.n;
    return [b.type, E.routes[0].z[i], t.preview.terrainData.sample(r.x[i], r.y[i]), m.bridgePillars(L, E, t.preview.terrainData, t.state.scene).length]; });
  expect(r[0] === 'bridge' && r[2] < r[1] - 1.5 && r[3] > 0, `puente: tipo ${r[0]}, tablero ${r[1].toFixed(2)} m, terreno ${r[2].toFixed(2)} m, pilares ${r[3]}`);
});

test('ids únicos en la página', async () => {
  const dup = await ev(() => { const c = {}; document.querySelectorAll('[id]').forEach((e) => { c[e.id] = (c[e.id] || 0) + 1; }); return Object.entries(c).filter(([, n]) => n > 1).map(([k]) => k); });
  expect(!dup.length, `ids repetidos: ${dup}`);
});

test('pinceles: Aumentar/Disminuir subd. solo en Pintar subdivisión; Esculpir con 2 botones', async () => {
  const vis = () => ev(() => ({ sub: !!document.getElementById('paintSubMode').offsetParent, sculpt: !!document.getElementById('sculptBox').offsetParent }));
  for (const [t, sub, sculpt] of [['paint', true, false], ['sculpt', false, true], ['hill', false, false], ['river', false, false]]) {
    await tool(t);
    const v = await vis();
    expect(v.sub === sub && v.sculpt === sculpt, `${t}: ${JSON.stringify(v)}`);
  }
  await tool('sculpt');
  await page.click('#sculptMode button[data-smode=smooth]');
  let s = await ev(() => [window.__tsg.state.scene.sculptMode, [...document.querySelectorAll('#sculptMode button.on')].map((b) => b.dataset.smode).join()]);
  expect(s[0] === 'smooth' && s[1] === 'smooth', `suavizar: ${s}`);
  await page.click('#sculptMode button[data-smode=raise]');
  s = await ev(() => [window.__tsg.state.scene.sculptMode, [...document.querySelectorAll('#sculptMode button.on')].map((b) => b.dataset.smode).join()]);
  expect(s[0] === 'raise' && s[1] === 'raise', `elevar: ${s}`);
  // «Más detalle en lo esculpido» también en la barra del pincel (sincronizada con el panel)
  expect(await ev(() => !!document.getElementById('sculptDetailBar').offsetParent), 'falta «Más detalle en lo esculpido» en la barra');
  await page.click('#sculptDetailBar');
  const det = await ev(() => [window.__tsg.state.scene.sculptDetail, document.getElementById('sculptDetail').checked, document.getElementById('sculptDetailBar').checked]);
  expect(det[0] === false && det[1] === false && det[2] === false, `detalle esculpido: ${det}`);
  await page.click('#sculptDetailBar');
  await page.keyboard.press('Escape');
});

test('terreno: el pincel Esculpir (suavizar) conserva el volumen del relieve', async () => {
  const r = await ev(async () => {
    const m = await import('/js/scene.js');
    const dabs = [{ x: 0, y: 0, r: 20, h: 5 }], F0 = m.sculptField(dabs), F1 = m.sculptField([...dabs, { x: 0, y: 0, r: 25, h: 1, smooth: true }]);
    let v0 = 0, v1 = 0;
    for (let x = -40; x <= 40; x += 1) for (let y = -40; y <= 40; y += 1) { v0 += F0.sample(x, y); v1 += F1.sample(x, y); }
    return [F0.sample(0, 0), F1.sample(0, 0), v1 / v0];
  });
  expect(r[1] < r[0] && approx(r[2], 1, 0.05), `cima ${r[0].toFixed(2)} → ${r[1].toFixed(2)}, volumen ×${r[2].toFixed(3)}`);
});

test('cerros y túneles: túnel detectado; Quitar cerro deja solo el túnel con cáscara', async () => {
  await reset();
  await page.click('#btnGenTerrain');
  await idle();
  await addHill(0.3);
  await idle();
  await ev(() => window.__tsg.app.selectTunnel(0));
  const a = await ev(() => [window.__tsg.preview.hillMeshes.length, (window.__tsg.state.tunnelInfo || []).length]);
  expect(a[0] === 1 && a[1] >= 1, `cerros ${a[0]}, túneles ${a[1]}`);
  await page.check('#tunnelList .tun-card.sel .tsNoHill');
  await idle();
  const b = await ev(() => [window.__tsg.preview.hillMeshes.length, (window.__tsg.state.tunnelInfo || []).length, window.__tsg.state.tunnelInfo[0].noHill]);
  expect(b[0] === 0 && b[1] === a[1] && b[2], `sin cerro: cerros ${b[0]}, túneles ${b[1]}, noHill ${b[2]}`);
  const names = Object.values(await exportNames()).flat();
  expect(names.includes('tunel_01_cascara') && !names.some((n) => /^cerro_\d+$/.test(n)), `exportación: ${names.filter((n) => /tunel_01|cerro/.test(n))}`);
  await ev(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Control+z');
  await idle();
  expect((await ev(() => window.__tsg.preview.hillMeshes.length)) === 1, 'deshacer no devolvió el cerro');
});

test('cavernas: rocas sueltas sin single mesh, se mueven sobre el piso', async () => {
  await reset();
  await page.click('#btnGenTerrain');
  await idle();
  await addHill(0.3);
  await idle();
  await ev(() => { const t = window.__tsg; const ti = t.state.tunnelInfo[0]; t.state.scene.tunnelOverrides = [{ k: ti.k, s: +ti.sMid.toFixed(2), type: 'natural', caveSize: 0.8, singleMesh: false }]; t.preview.update(false); });
  await idle();
  await ev(() => window.__tsg.app.selectTunnel(0));
  const n = await ev(() => window.__tsg.app.caveItemsSel().length);
  expect(n > 0, `rocas y estalactitas sueltas: ${n}`);
  const r = await ev(() => {
    const t = window.__tsg, it = t.app.caveItemsSel().find((q) => q.kind === 'r');
    if (!it) return null;
    const x0 = it.x, y0 = it.y;
    t.app.selectCave({ tid: 0, kind: 'r', key: it.key });
    const P = t.app.moveCaveLive(t.state.selCave, x0 + 1.5, y0 + 1);
    t.app.commitCaveMove(t.state.selCave, P);
    return [P.x - x0, P.y - y0, JSON.stringify(t.state.scene.tunnelOverrides[0].caveMoves)];
  });
  expect(r && Math.hypot(r[0], r[1]) > 0.3 && r[2].includes('"r"'), `mover roca: ${JSON.stringify(r)}`);
  await idle();
  await page.keyboard.press('Escape');
});

test('árboles: el botón solo genera árboles; single mesh, editar, borrar, deshacer y exportar', async () => {
  await reset();
  await page.click('#btnGenTerrain');
  await idle();
  await page.click('#btnGenTrees');
  await idle();
  let s = await ev(() => [window.__tsg.state.scene.trees, window.__tsg.state.decoSets.length, document.getElementById('treeSingle').checked, document.getElementById('btnGenTrees').textContent]);
  expect(s[0] && s[1] === 0 && s[2] && s[3] === 'Generar árboles y decoración', `generar: ${s}`);
  let ex = await exportNames();
  expect((ex.arboles || []).length === 1 && ex.arboles[0] === 'arboles_malla', `exporta una malla: ${(ex.arboles || []).slice(0, 3)}`);
  await page.uncheck('#treeSingle');
  await idle();
  s = await ev(() => [window.__tsg.state.scene.treeBake.length, window.__tsg.app.vegEditItems().length]);
  expect(s[0] > 10 && s[1] === s[0], `lista fija ${s[0]}, marcadores ${s[1]}`);
  // arrastrar un árbol en el mapa: queda apoyado en el suelo
  await tool('pan');
  const it = await ev(() => { const q = window.__tsg.app.vegEditItems()[5]; return { i: q.i, x: q.x, y: q.y }; });
  const [sx, sy] = await mapXY(it.x, it.y);
  await drag(sx, sy, sx + 18, sy + 9);
  await idle();
  const m = await ev((i) => { const t = window.__tsg, tr = t.preview.treeData[i], G = t.preview.groundCache; return [tr.x, tr.y, tr.z - G.sample(tr.x, tr.y), JSON.stringify(t.state.selVeg)]; }, it.i);
  expect(Math.hypot(m[0] - it.x, m[1] - it.y) > 2 && Math.abs(m[2]) < 1e-3 && m[3].includes('"tree"'), `arrastre 2D: ${JSON.stringify(m)}`);
  // 3D: gizmo (mover en vivo + guardar)
  const g = await ev(() => { const t = window.__tsg, v = t.state.selVeg, tr = t.preview.treeData[v.i], x0 = tr.x; const P = t.app.moveVegLive(v, tr.x + 4, tr.y + 3); t.app.commitVegMove(v, P); return t.preview.treeData[v.i].x - x0; });
  expect(approx(g, 4, 0.01), `gizmo 3D: dx ${g}`);
  const nb = await ev(() => window.__tsg.state.scene.treeBake.length);
  await ev(() => document.activeElement && document.activeElement.blur());
  await page.mouse.move(700, 450);
  await page.keyboard.press('Delete');
  await idle();
  expect((await ev(() => window.__tsg.state.scene.treeBake.length)) === nb - 1, 'Supr no borró el árbol');
  await page.keyboard.press('Control+z');
  await idle();
  expect((await ev(() => window.__tsg.state.scene.treeBake.length)) === nb, 'deshacer no devolvió el árbol');
  ex = await exportNames();
  expect((ex.arboles || []).length === nb && ex.arboles[0] === 'arbol_0001', `exporta un objeto por árbol: ${(ex.arboles || []).length} / ${nb}`);
  await page.check('#treeSingle');
  await idle();
  s = await ev(() => [window.__tsg.state.scene.treeBake.length, window.__tsg.app.vegEditItems().length, !document.getElementById('btnTreeReset').hidden]);
  expect(s[0] === nb && s[1] === 0 && s[2], `volver a single mesh conserva lo editado: ${s}`);
  await page.click('#btnTreeReset');
  await idle();
  expect((await ev(() => window.__tsg.state.scene.treeBake)) === null, 'Restablecer no volvió a la distribución automática');
});

test('decoración: set con single mesh, editar un elemento en 3D y exportar', async () => {
  await reset();
  await page.click('#btnGenTerrain');
  await idle();
  await ev(() => document.getElementById('btnDecoNew').click());
  await idle();
  const c0 = '#decoList .deco-card:nth-child(1)';
  let ex = await exportNames();
  expect((ex.set_1 || []).length === 1 && ex.set_1[0] === 'set_1_malla', `set con single mesh: ${ex.set_1}`);
  await page.uncheck(`${c0} .dsingle`);
  await idle();
  const n = await ev(() => { const s = window.__tsg.state.decoSets[0]; return [s.bake.length, (window.__tsg.preview.decoItemsBySet[s.id] || []).length]; });
  expect(n[0] > 5 && n[0] === n[1], `lista fija del set: ${n}`);
  // clic en 3D sobre un cubo (a través de los árboles)
  await ev(() => { const t = window.__tsg, pv = t.preview, s = t.state.decoSets[0], it = pv.decoItemsBySet[s.id][8]; pv.controls.target.set(it.x, it.y, it.z); pv.camera.position.set(it.x + 10, it.y - 20, it.z + 14); pv.controls.update(); pv.needsFrame = true; t.app.selectVeg(null); });
  await tool('pan');
  const sc = await ev(() => { const t = window.__tsg, pv = t.preview, s = t.state.decoSets[0], it = pv.decoItemsBySet[s.id][8]; const v = pv.camera.position.clone().set(it.x, it.y, pv.vegZ(it.x, it.y, it.z) + 0.5).project(pv.camera); const r = pv.renderer.domElement.getBoundingClientRect(); return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; });
  await page.mouse.click(sc[0], sc[1]);
  const sel = await ev(() => window.__tsg.state.selVeg);
  expect(sel && sel.kind === 'deco' && sel.i === 8, `clic 3D: ${JSON.stringify(sel)}`);
  await page.click(`${c0} .ddel`);
  await idle();
  expect((await ev(() => window.__tsg.state.decoSets[0].bake.length)) === n[0] - 1, 'no se borró el elemento');
  ex = await exportNames();
  expect((ex.set_1 || []).length === n[0] - 1 && ex.set_1[0] === 'set_1_0001', `set sin single mesh: ${(ex.set_1 || []).length}`);
});

test('bordes: camino de tierra con ancho a cada lado; en un tramo, como la pista o propio', async () => {
  await reset();
  await ev(() => { const el = document.getElementById('dirtSide'); el.value = 'both'; el.dispatchEvent(new Event('change')); });
  await page.locator('#dirtWidthLNum').fill('2'); await page.locator('#dirtWidthLNum').dispatchEvent('change');
  await page.locator('#dirtWidthRNum').fill('5'); await page.locator('#dirtWidthRNum').dispatchEvent('change');
  await idle();
  const w = await ev(async () => { const t = window.__tsg, m = await import('/js/tunnels.js'), r = t.state.layout.routes[0]; return [m.dirtWidthAt(t.state.scene, r, 0, 10, 1), m.dirtWidthAt(t.state.scene, r, 0, 10, -1)]; });
  expect(w[0] === 2 && w[1] === 5, `anchos izq./der.: ${w}`);
  await makeTramo('track', [5, 6, 7, 8, 9]);
  await ev(() => { const t = window.__tsg; t.state.project.main.bridges[0].collapsed = false; t.refreshBridgeList(); });
  const sel = await ev(() => { const s2 = document.querySelector('#bridgeList .bdw'); return s2 && s2.value; });
  expect(sel === 'inherit', `el tramo empieza «Como la pista»: ${sel}`);
  await ev(() => { const s2 = document.querySelector('#bridgeList .bdw'); s2.value = 'own'; s2.dispatchEvent(new Event('change')); });
  await ev(() => { const i = document.querySelector('#bridgeList .bdwL'); i.value = '7'; i.dispatchEvent(new Event('change')); });
  await idle();
  const tw = await ev(async () => { const t = window.__tsg, m = await import('/js/tunnels.js'), r = t.state.layout.routes[0], b = r.bridges[0]; return [m.dirtWidthAt(t.state.scene, r, 0, (b.s0 + b.s1) / 2, 1), m.dirtWidthAt(t.state.scene, r, 0, (b.s0 + b.s1) / 2, -1)]; });
  expect(tw[0] === 7 && tw[1] === 5, `anchos propios del tramo: ${tw}`);
});

test('faldones: en «Geometría de la pista», con alto configurable', async () => {
  const where = await ev(() => document.getElementById('skirts').closest('section').dataset.panel);
  expect(where === 'trackmesh', `los faldones están en «${where}»`);
  await page.click('#btnGenTerrain');
  await idle();
  await page.locator('#skirtHeightNum').fill('4'); await page.locator('#skirtHeightNum').dispatchEvent('change');
  await idle();
  expect((await ev(() => window.__tsg.state.scene.skirtHeight)) === 4, 'no se guardó el alto del faldón');
});

test('triggers: bocas de túneles y triggers propios (ubicar, renombrar, exportar)', async () => {
  await reset();
  await page.click('#btnGenTerrain');
  await idle();
  await addHill(0.3);
  await idle();
  let names = Object.values(await exportNames()).flat();
  expect(names.includes('trigger_tunel_01_entrada') && names.includes('trigger_tunel_01_salida'), `triggers del túnel: ${names.filter((n) => n.startsWith('trigger'))}`);
  // nuevo trigger: botón y clic en la pista
  await ev(() => document.getElementById('btnTriggerNew').click());
  const pt = await ev(() => { const r = window.__tsg.state.layout.routes[0], i = Math.floor(r.n * 0.8); return [r.x[i], r.y[i]]; });
  const [sx, sy] = await mapXY(pt[0], pt[1]);
  await page.mouse.click(sx, sy);
  await idle();
  const n = await ev(() => [window.__tsg.state.triggers.length, window.__tsg.state.selTrigger != null]);
  expect(n[0] === 1 && n[1], `trigger propio creado: ${n}`);
  await ev(() => { const i = document.querySelector('#triggerList .tgn'); i.value = 'Zona oscura'; i.dispatchEvent(new Event('change')); });
  // arrastrarlo a lo largo de la pista
  const p0 = await ev(() => window.__tsg.state.triggers[0].p.slice());
  await drag(sx, sy, sx + 30, sy + 4);
  const p1 = await ev(() => window.__tsg.state.triggers[0].p.slice());
  expect(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) > 3, `arrastrar el trigger: ${p0} → ${p1}`);
  names = Object.values(await exportNames()).flat();
  expect(names.includes('trigger_Zona_oscura'), `exporta el trigger propio: ${names.filter((n2) => n2.startsWith('trigger'))}`);
  const ud = await ev(async () => { const t = window.__tsg, m = await import('/js/export-glb.js'); const { root } = await m.buildExportScene(t.state.layout, t.state.result, t.state.scene, { triggers: t.app.triggersWorld() }, null, t.app.hillsWorld(), null); let o = null; root.traverse((q) => { if (q.name === 'trigger_Zona_oscura') o = q; }); return o && [o.userData.trigger, o.material.opacity, o.material.name]; });
  expect(ud && ud[0] === 'custom' && ud[1] === 0 && ud[2] === 'trigger', `trigger invisible con extras: ${ud}`);
  await page.keyboard.press('Delete');
  await idle();
  expect((await ev(() => window.__tsg.state.triggers.length)) === 0, 'Supr no quitó el trigger');
  await page.keyboard.press('Control+z');
  await idle();
  expect((await ev(() => window.__tsg.state.triggers.length)) === 1, 'deshacer no devolvió el trigger');
});

test('transiciones: subdividir y mover las divisiones sobre la textura', async () => {
  await reset();
  await makeTramo('track', [5, 6, 7, 8, 9]);
  await ev(() => { const t = window.__tsg, b = t.state.project.main.bridges[0]; b.sameWidth = false; b.w = t.state.geom.width + 10; t.scheduleBuild(); });
  await idle();
  const tris = () => ev(() => window.__tsg.preview.trackGroup.children.reduce((a, m) => a + (m.geometry && m.geometry.index ? m.geometry.index.count / 3 : 0), 0));
  const t1 = await tris();
  await page.uncheck('#transSubdiv');
  await idle();
  const t0 = await tris();
  expect(t1 > t0, `subdividir agrega triángulos (${t0} → ${t1})`);
  await page.check('#transSubdiv');
  await ev(() => document.getElementById('transDivBar').scrollIntoView());
  const marks = await ev(() => document.querySelectorAll('#transDivBar .tdiv-mark').length);
  expect(marks === 4, `4 divisiones por defecto: ${marks}`);
  // arrastrar la primera marca
  const r = await ev(() => { const m = document.querySelector('#transDivBar .tdiv-mark'), b = m.getBoundingClientRect(), bar = document.getElementById('transDivBar').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2, bar.width]; });
  await drag(r[0], r[1], r[0] + r[2] * 0.1, r[1]);
  await idle();
  const d0 = await ev(() => window.__tsg.state.scene.transDivs[0]);
  expect(d0 > 0.12 && d0 < 0.22, `división movida: ${d0}`);
  await page.click('#btnTransDivAdd');
  expect((await ev(() => window.__tsg.state.scene.transDivs.length)) === 5, 'no se agregó la división');
  await page.click('#btnTransDivDel');
  await page.click('#btnTransDivReset');
  const def = await ev(() => window.__tsg.state.scene.transDivs.join());
  expect(def === '0.07,0.47,0.53,0.93', `por defecto: ${def}`);
});

test('auto 3D: se carga, se escala al tamaño del auto por defecto y se ajusta', async () => {
  await reset();
  await page.click('#btnGame');
  await page.waitForFunction(() => window.__tsg.preview.game.active);
  await page.setInputFiles('#fileCar', path.join(ROOT, 'test', 'assets', 'auto_prueba.glb'));
  await page.waitForFunction(() => !!window.__tsg.preview.game.customCar, null, { timeout: 15000 });
  const fit = await ev(async () => { const THREE = await import('three'); const g = window.__tsg.preview.game; g.car.updateMatrixWorld(true); const q = g.car.quaternion.clone(), p = g.car.position.clone(); g.car.quaternion.identity(); g.car.position.set(0, 0, 0); g.car.updateMatrixWorld(true); const b = new THREE.Box3().setFromObject(g.customCar), d = g.defaultBox(); g.car.quaternion.copy(q); g.car.position.copy(p); const s1 = b.getSize(new THREE.Vector3()), s2 = d.getSize(new THREE.Vector3()); return [s1.x, s1.y, s1.z, s2.x, s2.y, s2.z, b.min.z]; });
  const inBox = fit[0] <= fit[3] + 1e-3 && fit[1] <= fit[4] + 1e-3 && fit[2] <= fit[5] + 1e-3;
  const touches = Math.abs(fit[0] - fit[3]) < 1e-3 || Math.abs(fit[1] - fit[4]) < 1e-3 || Math.abs(fit[2] - fit[5]) < 1e-3;
  expect(inBox && touches && Math.abs(fit[6]) < 1e-3, `escala automática: ${fit.map((v) => v.toFixed(2))}`);
  if (await ev(() => document.getElementById('carAdjBox').hidden)) await page.click('#btnCarAdj'); // se abre sola al cargar
  await page.locator('#carDz').fill('0.5');
  await page.locator('#carSz').fill('2');
  const adj = await ev(() => { const g = window.__tsg.preview.game; return [g.customCar.position.z, window.__tsg.state.game.carAdj.sz, g.car.userData.body.visible]; });
  expect(Math.abs(adj[0] - 0.5) < 1e-6 && adj[1] === 2 && adj[2] === false, `ajuste: ${adj}`);
  const saved = await ev(() => { const d = window.__tsg.projectData(); return [!!d.carModel && d.carModel.name, d.game.carAdj.dz]; });
  expect(saved[0] === 'auto_prueba.glb' && saved[1] === 0.5, `se guarda con el proyecto: ${saved}`);
  await page.click('#btnCarRemove');
  expect(await ev(() => !window.__tsg.preview.game.customCar && window.__tsg.preview.game.car.userData.body.visible), 'no volvió al auto por defecto');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.__tsg.preview.game.active);
});

test('pincel Suavizar pista: suaviza los puntos bajo el pincel sin Editar puntos', async () => {
  await reset();
  await tool('edit'); // crea los puntos de control
  // un tramo de puntos seguidos bien a la vista en el mapa, con zigzag
  const i0 = await ev(() => {
    const t = window.__tsg, c = t.state.project.main.ctrl, r = document.getElementById('canvas2d').getBoundingClientRect();
    const ok = (i) => { const [x, y] = t.editor.toScreen(c[i][0], c[i][1]); return x > 80 && y > 80 && x < r.width - 80 && y < r.height - 80; };
    for (let i = 2; i < c.length - 9; i++) { let all = true; for (let j = i; j <= i + 6; j++) if (!ok(j)) all = false; if (all) return i; }
    return 10;
  });
  const before = await ev((i0) => { const t = window.__tsg, c = t.state.project.main.ctrl, L = t.state.layout; for (let i = i0; i <= i0 + 6; i++) { const d = (i % 2 ? 1 : -1) * 3 / L.scale; c[i][0] += d; c[i][1] += d; } t.scheduleBuild(); return c.map((q) => q.slice(0, 2)); }, i0);
  await idle();
  await tool('tsmooth');
  const vis = await ev(() => [!!document.getElementById('tsmoothBox').offsetParent, !!document.getElementById('paintSubMode').offsetParent]);
  expect(vis[0] && !vis[1], `barra del pincel: ${vis}`);
  const rough = (c) => { let s2 = 0; for (let i = i0 + 1; i <= i0 + 5; i++) s2 += Math.hypot(c[i - 1][0] + c[i + 1][0] - 2 * c[i][0], c[i - 1][1] + c[i + 1][1] - 2 * c[i][1]); return s2; };
  const sc = await ev((i0) => { const t = window.__tsg, c = t.state.project.main.ctrl, r = document.getElementById('canvas2d').getBoundingClientRect(); return [i0 + 1, i0 + 5].map((i) => { const [x, y] = t.editor.toScreen(c[i][0], c[i][1]); return [x + r.left, y + r.top]; }); }, i0);
  await page.locator('#tsmoothStrength').fill('1');
  await drag(sc[0][0], sc[0][1], sc[1][0], sc[1][1], 8);
  await drag(sc[1][0], sc[1][1], sc[0][0], sc[0][1], 8);
  await idle();
  const after = await ev(() => window.__tsg.state.project.main.ctrl.map((q) => q.slice(0, 2)));
  const farI = (i0 + 30) % after.length;
  const far = Math.hypot(after[farI][0] - before[farI][0], after[farI][1] - before[farI][1]);
  expect(rough(after) < rough(before) * 0.6 && far < 1e-9, `suavizado: ${rough(before).toFixed(2)} → ${rough(after).toFixed(2)}, punto lejano movido ${far}`);
  await ev(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Control+z');
  await idle();
  const und = await ev(() => window.__tsg.state.project.main.ctrl.map((q) => q.slice(0, 2)));
  expect(rough(und) > rough(after), 'deshacer no devolvió el trazo');
  await page.keyboard.press('Escape');
});

test('nombre del proyecto y guardado automático en disco (carpeta, archivos por proyecto)', async () => {
  await reset();
  await page.locator('#projectName').fill('Prueba Auto');
  await page.locator('#projectName').press('Enter');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnSave')]);
  expect(dl.suggestedFilename() === 'Prueba_Auto.tsg.json', `guardar usa el nombre: ${dl.suggestedFilename()}`);
  const dir = path.join(os.tmpdir(), `tsg-auto-${process.pid}`);
  await ev((dir) => { const c = window.__tsg.asCfg(); c.dir = dir; c.keep = 2; }, dir);
  for (let k = 0; k < 3; k++) {
    await ev((k) => { const t = window.__tsg; t.state.project.main.pts[3][0] += 1 + k; }, k);
    const ok = await ev(() => window.__tsg.autosaveNow(false));
    expect(ok, `autoguardado ${k + 1} falló: ${await ev(() => document.getElementById('asInfo').textContent)}`);
    await page.waitForTimeout(1100); // nombres con la hora (segundos)
  }
  expect(!(await ev(() => window.__tsg.autosaveNow(false))), 'sin cambios no debe guardar otra copia');
  const fs = require('fs');
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('Prueba_Auto_auto_'));
  expect(files.length === 2, `se conservan 2 archivos: ${files}`);
  const d = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  expect(d.format === 'track-spline-generator' && d.projectName === 'Prueba Auto', 'el autoguardado no es un proyecto válido');
  // abrir autoguardado: la ventana de abrir lista las copias
  await ev(() => window.__tsg.openAutosaves());
  await page.waitForSelector('.open-dialog .od-card');
  const cards = await ev(() => document.querySelectorAll('.open-dialog .od-card').length);
  expect(cards === 2, `ventana con los autoguardados: ${cards}`);
  await page.keyboard.press('Escape');
  // seguridad: sin el encabezado de la app, el servidor no escribe
  const code = (await fetch(new (require('url').URL)('/api/autosave/save?name=x', page.url()), { method: 'POST', body: '{}' })).status;
  expect(code === 403, `pedido sin encabezado: ${code}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('guardar y abrir: el proyecto conserva tramos, cerros y listas fijas', async () => {
  await reset();
  await makeTramo('track', [5, 6, 7, 8, 9]);
  await addHill(0.6);
  await ev(() => document.getElementById('btnDecoNew').click());
  await idle();
  await ev(() => { window.__tsg.state.triggers = [{ id: 'tgx', name: 'uno', p: [100, 100], depth: 2, height: 6 }]; });
  await ev(() => { const t = window.__tsg; t.state.scene.treeSingle = false; t.state.scene.treeBake = [[10, 10, 9, 2.5, 0, 1, 1, 0]]; t.state.decoSets[0].single = false; t.state.decoSets[0].bake = [[5, 5, 0, 1, 0.5]]; });
  const back = await ev(async () => {
    const t = window.__tsg, d = JSON.parse(JSON.stringify(t.projectData()));
    await t.openProject(d);
    await t.idle();
    return [d.format, t.state.scene.treeBake && t.state.scene.treeBake.length, t.state.decoSets.length, t.state.decoSets[0] && Array.isArray(t.state.decoSets[0].bake), (t.state.project.main.bridges || []).length, t.state.hills.length, t.state.triggers.length];
  });
  expect(back[0] === 'track-spline-generator' && back[1] === 1 && back[2] === 1 && back[3] && back[4] === 1 && back[5] === 1 && back[6] === 1, `ida y vuelta: ${back}`);
});

test('exportar y guardar: Blender, 3ds Max, JSON, OBJ y el proyecto descargan su archivo', async () => {
  await reset();
  downloads = [];
  await page.click('#btnExportMenu');
  for (const id of ['btnExportBlender', 'btnExportMax', 'btnExportJSON', 'btnExportOBJ', 'btnSave']) {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), ev((id) => document.getElementById(id).click(), id)]);
    downloads.push(dl.suggestedFilename());
  }
  expect(downloads.some((n) => n.endsWith('.py')) && downloads.some((n) => n.endsWith('.ms')) && downloads.some((n) => n.endsWith('.json')) && downloads.some((n) => n.endsWith('.obj')) && downloads.includes('pista.tsg.json'), `descargas: ${downloads}`);
});

test('cámara de juego: entra, muestra el auto en el perfil y sale con Esc', async () => {
  await sample('oval');
  await page.click('#btnGame');
  await page.waitForFunction(() => window.__tsg.preview.game && window.__tsg.preview.game.active);
  const on = await ev(() => [window.__tsg.preview.game.active, window.__tsg.profile.gameS != null || !!window.__tsg.profile.hitCar]);
  expect(on[0], 'no entró a la cámara de juego');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.__tsg.preview.game.active);
});

// ---------------------------------------------------------------------------------------------------------------
/** Corre las pruebas elegidas en un navegador propio (un proceso). Devuelve {pass, fails, total}. */
async function runTests(run, port) {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  URL = `http://localhost:${port}/`;
  await freshPage();
  let pass = 0;
  const fails = [];
  for (const t of run) {
    const e0 = errs.length, ts = Date.now();
    try {
      await t.fn();
      if (errs.length > e0) throw new Error('errores en la página: ' + errs.slice(e0).join(' | '));
      pass++;
      console.log(`  ✓ ${t.name} (${((Date.now() - ts) / 1000).toFixed(1)} s)`);
    } catch (err) {
      const shot = path.join(os.tmpdir(), `tsg-ui-${process.pid}-${fails.length + 1}.png`);
      try { await page.screenshot({ path: shot }); } catch { /* sin captura */ }
      fails.push(t.name);
      console.log(`  ✗ ${t.name}\n      ${err.message.split('\n')[0]}\n      captura: ${shot}`);
      try { await page.keyboard.press('Escape'); } catch { /* seguir */ }
    }
  }
  await browser.close();
  return { pass, fails };
}

function startServer() {
  const port = 5190 + Math.floor(Math.random() * 60);
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, PORT: String(port), NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res, rej) => {
    server.stdout.on('data', (d) => { if (/corriendo/.test(String(d))) res({ server, port }); });
    server.on('exit', (c) => rej(new Error('el servidor terminó: ' + c)));
    setTimeout(() => rej(new Error('el servidor no respondió')), 8000);
  });
}

async function main() {
  const t0 = Date.now();
  const selected = tests.filter((t) => !filters.length || filters.some((f) => t.name.toLowerCase().includes(f)));
  if (SHARD) { // proceso hijo: su parte de las pruebas, con el servidor del padre
    const [i, n] = SHARD;
    const { fails } = await runTests(selected.filter((_, k) => k % n === i), parseInt(process.env.TSG_PORT, 10));
    process.exit(fails.length ? 1 : 0);
  }
  const { server, port } = await startServer();
  let pass = 0, failed = 0;
  const n = Math.min(jobs, selected.length);
  if (n <= 1) {
    const r = await runTests(selected, port);
    pass = r.pass; failed = r.fails.length;
  } else {
    // n procesos, cada uno con su navegador; las pruebas se reparten en orden alterno (las lentas quedan parejas)
    const codes = await Promise.all(Array.from({ length: n }, (_, i) => new Promise((res) => {
      const ch = spawn(process.execPath, [__filename, ...argv], { env: { ...process.env, TSG_SHARD: `${i}/${n}`, TSG_PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
      ch.stdout.on('data', (d) => { const txt = String(d); process.stdout.write(txt); pass += (txt.match(/^ {2}✓/gm) || []).length; failed += (txt.match(/^ {2}✗/gm) || []).length; });
      ch.on('exit', res);
    })));
    if (codes.some((c) => c !== 0 && c !== 1)) failed = Math.max(failed, 1);
  }
  server.kill();
  console.log(`\n${pass} de ${selected.length} pruebas de interfaz correctas${failed ? ` · ${failed} con fallas` : ''} · ${n} proceso(s) · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  process.exit(failed || pass !== selected.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
