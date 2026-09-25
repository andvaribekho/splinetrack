// Controlador principal de la interfaz.
import { buildLayout, DEFAULT_GEOM, deriveControlPoints, respaceControlPoints } from './build.js';
import { computeElevation, DEFAULT_ELEV } from './elevation.js';
import { exportBlender, exportMax, exportJSON, exportOBJ, DEFAULT_EXPORT, routeSamples, bezierKnots, bezierError, edgeSamples } from './export.js';
import { nearestOnSamples, evalAt, resampleUniform } from './geometry.js';
import { SAMPLES, rasterizeLayout } from './samples.js';
import { Editor2D } from './editor2d.js';
import { ProfileView } from './profile.js';
import { Preview3D } from './preview3d.js';
import { initPanels } from './panels.js';
import { initSplitters } from './splitters.js';
import { initHotkeys } from './hotkeys.js';
import { DEFAULT_SCENE, terrainCell } from './scene.js';
import { makeTrackThumbnail } from './thumbnail.js';
import { parseReference, footprint } from './refmodel.js';
import { loadAsset, builtinAsset } from './assets.js';
import { defaultDecoSet } from './deco.js';
import { makeGrassCanvas, makePadCanvas, makeGlowCanvas, makeAsphaltCanvas, makeBridgeCanvas, makeBarrierCanvas, makeSandCanvas } from './gatetex.js';
import { GameCam, makeDefaultSky } from './gamecam.js';
import { tunnelResolution, edgeParams } from './tunnels.js';
import { initButtonIcons } from './icons.js';
import { computeItems, defaultGroup, nextGroupId, itemAt, projectToTrack, groupName, itemName, ITEM_TYPES, SHARED_KEYS, effectiveGroup } from './items.js';

const $ = (id) => document.getElementById(id);

const state = {
  project: { main: null, alts: [], start: null, reverse: false },
  geom: { ...DEFAULT_GEOM },
  closed: true,
  elev: { ...DEFAULT_ELEV },
  exp: { ...DEFAULT_EXPORT },
  trace: { threshold: null, invert: 'auto' },
  overrides: [], // [{lx, ly, upDir:[dx,dy]|null, type}]
  flatZones: [], // [[ [x,y], [x,y] ], ...] en coordenadas de lienzo
  profileZones: [], // perfiles dibujados en la ruta principal: [{a:[x,y], b:[x,y], pts:[[t, z], ...]}] (extremos en coords del lienzo)
  profileSel: null, // tramo elegido para dibujar un perfil: {a, b} (coords del lienzo)
  suspZones: [], // tramos suspendidos de la ruta principal: [{a:[x,y], b:[x,y], pillars, dirt, barrier}] (coords del lienzo)
  suspTex: null, suspBarrierTex: null, suspDirtTex: null, // texturas propias de los tramos suspendidos (null = las de la pista)
  image: null, // {canvas, w, h}
  imageOpacity: 0.5,
  tool: 'pan',
  layout: null,
  result: null,
  hover: null,
  showRaw: false,
  drawSmooth: 4, // suavizado del dibujo a mano (0..10)
  pinLocal: true, // al fijar una altura, mover solo ese punto
  selSet: null, // selección múltiple {key, idxs:Set}
  arc: null, // sesión de curva de radio fijo
  arcPreview: null,
  scene: { ...DEFAULT_SCENE }, // terreno, árboles, texturas
  densityPaint: [], // zonas pintadas para densidad del terreno [{x,y,r,e}] en coords del lienzo
  assets: [], // biblioteca de decoración: modelos cargados {id, name, parts, tris, buffer…}
  decoSets: [], // sets de elementos decorativos
  selDeco: null, // id del set seleccionado
  ref3d: null, // modelo de referencia 3D {name, inner, meshes, fp, pos, rotZ, scale, ...} (no se exporta)
  terrainSculpt: [], // relieve esculpido en el terreno [{x,y,r,h}] (x, y, r en coords del lienzo; h en m, + eleva, - hunde)
  hills: [], // cerros independientes [{id,name,height,hard,flat,density,maxTris,strokes:[{x,y,r,e}]}] (toques en coords del lienzo)
  selHill: null, // id del cerro seleccionado
  rivers: [], // ríos y cascadas [{id,kind:'river'|'fall',hill,mode,depth,walls,wallSubdiv,strokes:[{x,y,r,e}]}] (coords del lienzo)
  selRiver: null,
  selTunnel: null, // id del túnel seleccionado
  selAlt: null, // índice del atajo seleccionado
  selCross: null, // id del cruce seleccionado
  selBridge: null, // índice del puente seleccionado
  items: { puddle: [], pad: [], strip: [] }, // grupos de elementos de pista
  selItem: null, // {type, gid, idx}
  itemPaintTarget: null, // {type, gid} al pintar zonas de un grupo
  paintErase: false,
  game: { speed: 120, mode: 'third', camDist: 8.5, camHeight: 2.9, camTilt: 0, fov: 62 }, // cámara: distancia y altura (tercera persona), inclinación (°) y FOV
  skyTex: null, skyCustom: false,
  trackTex: null, // canvas de la textura de la pista
  barrierTex: null, // canvas de la textura de la barrera (null = rojo y blanco por defecto)
  altTexs: {}, // texturas propias de cada atajo, por su uid: {track, barrier, dirt} (null = las de la pista)
  coveredTex: null, // textura de los tramos cubiertos: túneles y bajo cruces (null = la de la pista un 20 % más oscura)
  dirtTex: null, // canvas de la textura del camino de tierra (null = arena por defecto)
  riverWallTex: null, fallWallTex: null, // texturas de las paredes socavadas de ríos y cascadas (null = roca por defecto)
  edgeMeshes: null, // última malla de bordes (para el mapa 2D y los clics)
  bridgeTex: null, // canvas de la textura de los puentes (null = café por defecto)
  grassTex: null, // canvas de la textura de hierba (null = por defecto)
  itemTex: { puddle: null, pad: null, strip: null, border: null }, // texturas de los elementos de pista
  terrainTex: null, // canvas de la textura del terreno
  ref: null, // imagen de referencia {canvas,w,h,x,y,scale,opacity,visible}
  sel: null, // punto de control seleccionado {key, idx}
};

const undoStack = [];
function snapshot() {
  const ref = state.ref ? { x: state.ref.x, y: state.ref.y, scale: state.ref.scale, opacity: state.ref.opacity } : null;
  return JSON.stringify({ project: state.project, flatZones: state.flatZones, profileZones: state.profileZones, suspZones: state.suspZones, overrides: state.overrides, ref, refCanvas: !!state.ref, densityPaint: state.densityPaint, terrainSculpt: state.terrainSculpt, decoSets: state.decoSets, hills: state.hills, selHill: state.selHill, rivers: state.rivers, items: state.items });
}
function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 60) undoStack.shift();
  $('btnUndo').disabled = false;
}
function undo() {
  const s = undoStack.pop();
  if (!s) return;
  const o = JSON.parse(s);
  state.project = o.project;
  state.flatZones = o.flatZones;
  if (o.profileZones) state.profileZones = o.profileZones;
  if (o.suspZones) state.suspZones = o.suspZones;
  state.overrides = o.overrides;
  if (o.ref && state.ref) Object.assign(state.ref, o.ref);
  if (o.items) { state.items = o.items; if (typeof itemsChanged === 'function') { renderItemsPanel(); itemsChanged(); } }
  if (o.hills) { state.hills = o.hills; state.selHill = state.hills.some((h) => h.id === o.selHill) ? o.selHill : null; if (typeof refreshHillPanel === 'function') refreshHillPanel(); }
  if (o.rivers) { state.rivers = o.rivers; if (!state.rivers.some((rv) => rv.id === state.selRiver)) state.selRiver = null; if (typeof renderRiverPanel === 'function') renderRiverPanel(); }
  if (o.decoSets) { state.decoSets = o.decoSets; if (typeof renderDecoPanel === 'function') { renderDecoPanel(); decoChanged(); } }
  if (o.terrainSculpt) { state.terrainSculpt = o.terrainSculpt; if (typeof refreshSculptInfo === 'function') refreshSculptInfo(); }
  if (o.densityPaint) { const changed = JSON.stringify(o.densityPaint) !== JSON.stringify(state.densityPaint); state.densityPaint = o.densityPaint; if (changed && typeof refreshPaintInfo === 'function') refreshPaintInfo(); }
  state.selSet = null; endArc();
  if (typeof syncRefControls === 'function') syncRefControls();
  $('btnUndo').disabled = undoStack.length === 0;
  scheduleBuild();
}

// ---------- cerros ----------
function hillName(id) { return `cerro_${String(id).padStart(2, '0')}`; }
function newHill() {
  const sc = state.scene;
  const id = state.hills.reduce((m, h) => Math.max(m, h.id), 0) + 1;
  return { id, name: hillName(id), height: sc.hillHeight, hard: !!sc.hillHard, flat: sc.hillFlat, density: sc.hillDensity, maxTris: sc.hillMaxTris, strokes: [] };
}
function hillContainsL(h, p) {
  let inside = false;
  for (const q of h.strokes) if ((p[0] - q.x) ** 2 + (p[1] - q.y) ** 2 <= q.r * q.r) inside = !q.e;
  return inside;
}
// ---------- ríos y cascadas ----------
function newRiver(kind, hill = null) {
  const sc = state.scene;
  const id = state.rivers.reduce((m, rv) => Math.max(m, rv.id), 0) + 1;
  return { id, kind, hill, mode: sc.riverMode, depth: sc.riverDepth, walls: sc.riverWalls, wallSubdiv: sc.riverWallSubdiv, strokes: [] };
}
const riverContainsL = hillContainsL; // misma regla: el último toque que cubre el punto manda
function riverIsEmpty(rv) { return !rv.strokes.some((q) => !q.e && riverContainsL(rv, [q.x, q.y])); }
function riverLabel(rv) {
  const same = state.rivers.filter((q) => q.kind === rv.kind);
  const n = same.indexOf(rv) + 1;
  return rv.name || `${rv.kind === 'fall' ? 'cascada' : 'rio'}_${String(n).padStart(2, '0')}`;
}
function riversChanged() { renderRiverPanel(); editor.draw(); preview.update(false); }
function selectRiver(id, expand = true) {
  state.selRiver = id;
  const rv = id != null ? state.rivers.find((q) => q.id === id) : null;
  if (rv && expand) rv.collapsed = false; // al elegirlo (en el mapa o en 3D) se despliega su tarjeta
  renderRiverPanel();
  editor.draw();
  if (preview.setRiverSelection) preview.setRiverSelection(id);
  if (id != null) setTimeout(() => { try { focusPanel('rivers', document.querySelector(`#riverList .item[data-id="${id}"]`)); } catch { /* iniciando */ } }, 0);
}
function renderRiverPanel() {
  const el = document.getElementById('riverList');
  if (!el || draggingIn(el)) return;
  el.innerHTML = '';
  const cnt = document.getElementById('riverCount');
  if (cnt) cnt.textContent = state.rivers.length;
  for (const rv of state.rivers) {
    const div = document.createElement('div');
    div.className = 'item river-card' + (rv.id === state.selRiver ? ' sel' : '') + (rv.collapsed ? ' collapsed' : '');
    div.dataset.id = rv.id;
    const hill = rv.kind === 'fall' ? state.hills.find((h) => h.id === rv.hill) : null;
    div.innerHTML = `
      <div class="head"><span><button class="x rtoggle" title="Mostrar u ocultar sus parámetros">${rv.collapsed ? '▸' : '▾'}</button> <strong>${riverLabel(rv)}</strong> <span class="muted small">${rv.kind === 'fall' ? `cascada en ${hill ? hill.name || hillName(hill.id) : 'un cerro'}` : 'río'}</span></span><button class="x del" title="Eliminar">✕</button></div>
      <div class="rbody">
      <div class="field"><label>Geometría</label><select class="rmode"><option value="surface"${rv.mode === 'surface' ? ' selected' : ''}>Posada sobre la superficie</option><option value="carved"${rv.mode === 'carved' ? ' selected' : ''}>Socavada</option></select></div>
      <div class="rcarved${rv.mode === 'carved' ? '' : ' disabled'}">
        <div class="field"><label>Profundidad <span class="val"><input type="number" class="rdepthN" min="0.1" step="0.1" style="width:58px" value="${rv.depth}"> m</span></label><input type="range" class="rdepth" min="0.2" max="20" step="0.1" value="${Math.min(20, rv.depth)}"></div>
        <div class="field"><label>Paredes</label><select class="rwalls"><option value="smooth"${rv.walls !== 'rock' ? ' selected' : ''}>Suaves</option><option value="rock"${rv.walls === 'rock' ? ' selected' : ''}>De roca</option></select></div>
        <div class="field"><label>Densidad de las paredes <span class="val rsubV">${rv.wallSubdiv} (×${subdivFactor(rv.wallSubdiv)} pol.)</span></label><input type="range" class="rsub" min="0" max="6" step="1" value="${rv.wallSubdiv}"></div>
      </div>
      </div>`;
    div.querySelector('.rtoggle').addEventListener('click', () => { rv.collapsed = !rv.collapsed; div.classList.toggle('collapsed', rv.collapsed); div.querySelector('.rtoggle').textContent = rv.collapsed ? '▸' : '▾'; });
    let editing = false;
    const set = (k, v, done = true) => {
      if (!editing) { pushUndo(); editing = true; }
      rv[k] = v;
      if (done) editing = false;
      div.querySelector('.rcarved').classList.toggle('disabled', rv.mode !== 'carved');
      div.querySelector('.rsubV').textContent = `${rv.wallSubdiv} (×${subdivFactor(rv.wallSubdiv)} pol.)`;
      editor.draw(); preview.update(false);
    };
    div.querySelector('button.del').addEventListener('click', () => { pushUndo(); state.rivers = state.rivers.filter((q) => q !== rv); if (state.selRiver === rv.id) state.selRiver = null; riversChanged(); });
    div.querySelector('.rmode').addEventListener('change', (e) => set('mode', e.target.value));
    div.querySelector('.rwalls').addEventListener('change', (e) => set('walls', e.target.value));
    div.querySelector('.rdepth').addEventListener('input', (e) => { div.querySelector('.rdepthN').value = e.target.value; set('depth', parseFloat(e.target.value), false); });
    div.querySelector('.rdepth').addEventListener('change', () => { editing = false; });
    div.querySelector('.rdepthN').addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (v > 0) set('depth', v); });
    div.querySelector('.rsub').addEventListener('input', (e) => set('wallSubdiv', Math.round(parseFloat(e.target.value)), false));
    div.querySelector('.rsub').addEventListener('change', () => { editing = false; });
    div.addEventListener('click', (e) => { if (e.target.closest('input,button,select,label')) return; selectRiver(state.selRiver === rv.id ? null : rv.id, false); });
    el.appendChild(div);
  }
  const info = document.getElementById('riverInfo');
  if (info) info.textContent = state.rivers.length ? '' : 'Activa «Ríos y cascadas» en la barra y pinta sobre el terreno. Con un cerro seleccionado, lo que pintes sobre él es una cascada.';
}
function hillIsEmpty(h) {
  // vacío si todos los centros de sus toques quedaron borrados
  return !h.strokes.some((q) => !q.e && hillContainsL(h, [q.x, q.y]));
}
/** Subdivisiones extra del pincel → multiplicador de polígonos por m² (cada lado se divide n + 1 veces). */
function subdivFactor(n) { const k = Math.max(0, Math.round(n ?? 1)); return (k + 1) * (k + 1); }
/** Clave del radio del pincel de cada herramienta. */
function brushKey(t) { return t === 'hill' ? 'hillBrush' : t === 'sculpt' ? 'sculptBrush' : t === 'river' ? 'riverBrush' : 'paintBrush'; }
const PAINT_TOOLS = ['paint', 'hill', 'itemPaint', 'sculpt', 'river'];
function hillAt(p) {
  const sel = state.hills.find((h) => h.id === state.selHill);
  if (sel && hillContainsL(sel, p)) return sel;
  for (let i = state.hills.length - 1; i >= 0; i--) if (hillContainsL(state.hills[i], p)) return state.hills[i];
  return null;
}
function refreshTunnelInfo() {
  const el = $('tunnelInfo');
  if (!el) return;
  const tl = state.tunnelInfo || [];
  if (!state.hills.length) { el.textContent = 'Pinta cerros con «Pintar cerros» (en el mapa o en la vista 3D). Si un cerro cubre la pista, se crea un túnel.'; return; }
  if (!tl.length) { el.textContent = 'Ningún cerro cubre la pista lo suficiente para un túnel (debe superar la altura libre + techo); donde la cruza, la pista pasa en trinchera.'; return; }
  el.innerHTML = `${tl.length} túnel(es): ${tl.map((t) => `<span class="tun-link${t.id === state.selTunnel ? ' on' : ''}" data-id="${t.id}">${t.name}</span> ${t.len.toFixed(0)} m (${t.tris.toLocaleString('es')} tri.)`).join(' · ')}. Haz clic en un túnel (aquí o en 3D) para seleccionarlo. Cada túnel exporta paredes, techo, veredas y dos bocas por separado.`;
  el.querySelectorAll('.tun-link').forEach((a) => a.addEventListener('click', () => { const id = +a.dataset.id; selectTunnel(state.selTunnel === id ? null : id); }));
  refreshTunnelSel();
}
/** Tarjeta del túnel seleccionado: costado abierto y pilares propios (si no, usa los valores generales). */
function refreshTunnelSel() {
  const box = $('tunnelSelBox');
  if (!box || draggingIn(box)) return;
  const t = (state.tunnelInfo || []).find((q) => q.id === state.selTunnel);
  box.hidden = !t;
  if (!t) { box.innerHTML = ''; return; }
  const sc = state.scene;
  const ov = (sc.tunnelOverrides || [])[t.key] || null;
  const own = (k) => ov && ov[k] !== undefined && ov[k] !== null && ov[k] !== '';
  const genOpen = { none: 'cerrado', left: 'abierto a la izquierda', right: 'abierto a la derecha' }[sc.tunnelOpen] || 'cerrado';
  const shapes = { rounded: 'Cuadrado con esquinas redondeadas', square: 'Cuadrado', circle: 'Círculo', oval: 'Ovalado' };
  const types = { artificial: 'Artificial (sección regular)', natural: 'Natural (caverna)' };
  const opt = (map, gen) => `<option value="">Como el general (${(map[gen] || gen).toLowerCase()})</option>` + Object.entries(map).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  const mode = t.meshMode || 'uniform';
  box.innerHTML = `<div class="head"><strong>${t.name}</strong><span class="meta">${t.len.toFixed(0)} m · ${t.tris.toLocaleString('es')} tri. · ${t.sections || '?'} secciones × ${t.profilePts || '?'} puntos</span></div>
    <div class="field"><label>Forma</label><select class="tsShape">${opt(shapes, sc.tunnelShape)}</select></div>
    <div class="field"><label>Tipo</label><select class="tsType">${opt(types, sc.tunnelType)}</select></div>
    <div class="field"><label>Costado abierto</label>
      <select class="tsOpen"><option value="">Como el general (${genOpen})</option><option value="none">Cerrado</option><option value="left">Abierto a la izquierda (con pilares)</option><option value="right">Abierto a la derecha (con pilares)</option></select></div>
    <label class="check small tsRocksBox${t.type === 'natural' ? '' : ' disabled'}"><input type="checkbox" class="tsRocks"${t.rocks !== false ? ' checked' : ''}> Rocas y estalactitas${own('rocks') ? '' : ' (como el general)'}</label>
    <div class="field tsPilBox${t.openMode === 'none' ? ' disabled' : ''}"><label><input type="checkbox" class="tsPilOwn"${own('pillars') ? ' checked' : ''}> Pilares propios <span class="val"><input type="number" class="tsPilN" min="0" max="200" step="1" style="width:56px" value="${t.pillarCount}"></span></label>
      <input type="range" class="tsPil" min="0" max="40" step="1" value="${Math.min(40, t.pillarCount)}"${own('pillars') ? '' : ' disabled'}></div>
    <h4 class="mini">Geometría ${own('density') || own('meshMode') || own('maxTris') || own('adapt') ? '(propia)' : '(la general)'}</h4>
    <div class="seg tsMode"><button data-mode="uniform" class="${mode === 'uniform' ? 'on' : ''}">Uniforme</button><button data-mode="optimized" class="${mode === 'optimized' ? 'on' : ''}">Optimizado</button></div>
    <div class="field"><label>Densidad de polígonos <span class="val"><input type="number" class="tsDenN" min="1" max="100" step="1" style="width:52px" value="${t.density}"> %</span></label><input type="range" class="tsDen" min="1" max="100" step="1" value="${t.density}"></div>
    <div class="field"><label>Máximo de triángulos <span class="val"><input type="number" class="tsMaxN" min="100" step="500" style="width:80px" value="${t.maxTris}"></span></label><input type="range" class="tsMax" min="500" max="150000" step="500" value="${Math.min(150000, t.maxTris)}"></div>
    <div class="field tsAdaptBox"${mode === 'optimized' ? '' : ' hidden'}><label>Optimización <span class="val">${Math.round((t.adapt ?? 0.5) * 100)} %</span></label><input type="range" class="tsAdapt" min="0" max="1" step="0.01" value="${t.adapt ?? 0.5}">
      <div class="range-ends"><span>mínimo</span><span>máximo</span></div></div>
    <div class="row gap"><button class="tsReset"${ov ? '' : ' disabled'} title="Vuelve a usar los valores generales en este túnel">Usar valores generales</button></div>`;
  box.querySelector('.tsOpen').value = own('open') ? ov.open : '';
  box.querySelector('.tsShape').value = own('shape') ? ov.shape : '';
  box.querySelector('.tsType').value = own('type') ? ov.type : '';
  const setOv = (patch) => {
    const list = (sc.tunnelOverrides || []).slice();
    const cur = (t.key >= 0 && list[t.key]) ? { ...list[t.key] } : { k: t.k, s: +t.sMid.toFixed(2) };
    Object.assign(cur, patch);
    for (const k of Object.keys(cur)) if (k !== 'k' && k !== 's' && (cur[k] === undefined || cur[k] === null || cur[k] === '' || (typeof cur[k] === 'number' && !Number.isFinite(cur[k])))) delete cur[k];
    const empty = Object.keys(cur).every((k) => k === 'k' || k === 's');
    if (t.key >= 0 && list[t.key]) { if (empty) list.splice(t.key, 1); else list[t.key] = cur; }
    else if (!empty) { list.push(cur); t.key = list.length - 1; }
    sc.tunnelOverrides = list;
    sceneChanged();
  };
  box.querySelector('.tsOpen').addEventListener('change', (e) => setOv({ open: e.target.value || undefined }));
  box.querySelector('.tsRocks').addEventListener('change', (e) => setOv({ rocks: e.target.checked === (sc.caveRocks !== false) ? undefined : e.target.checked }));
  box.querySelector('.tsShape').addEventListener('change', (e) => setOv({ shape: e.target.value || undefined }));
  box.querySelector('.tsType').addEventListener('change', (e) => setOv({ type: e.target.value || undefined }));
  const pilSet = (v) => { v = Math.max(0, Math.min(200, Math.round(v))); box.querySelector('.tsPilN').value = v; box.querySelector('.tsPil').value = Math.min(40, v); setOv({ pillars: v }); };
  box.querySelector('.tsPilOwn').addEventListener('change', (e) => { if (e.target.checked) pilSet(t.pillarCount); else setOv({ pillars: undefined }); });
  box.querySelector('.tsPil').addEventListener('input', (e) => pilSet(parseFloat(e.target.value)));
  box.querySelector('.tsPilN').addEventListener('change', (e) => { box.querySelector('.tsPilOwn').checked = true; box.querySelector('.tsPil').disabled = false; pilSet(parseFloat(e.target.value)); });
  box.querySelectorAll('.tsMode button').forEach((b) => b.addEventListener('click', () => setOv({ meshMode: b.dataset.mode })));
  const den = (v) => { v = Math.round(Math.max(1, Math.min(100, v))); if (Number.isFinite(v)) setOv({ density: v }); };
  box.querySelector('.tsDen').addEventListener('input', (e) => den(parseFloat(e.target.value)));
  box.querySelector('.tsDenN').addEventListener('change', (e) => den(parseFloat(e.target.value)));
  const mx = (v) => { v = Math.round(Math.max(100, v)); if (Number.isFinite(v)) setOv({ maxTris: v }); };
  box.querySelector('.tsMax').addEventListener('input', (e) => mx(parseFloat(e.target.value)));
  box.querySelector('.tsMaxN').addEventListener('change', (e) => mx(parseFloat(e.target.value)));
  box.querySelector('.tsAdapt').addEventListener('input', (e) => setOv({ adapt: Math.max(0, Math.min(1, parseFloat(e.target.value))) }));
  box.querySelector('.tsReset').addEventListener('click', () => { const list = (sc.tunnelOverrides || []).slice(); if (t.key >= 0) list.splice(t.key, 1); sc.tunnelOverrides = list; sceneChanged(); });
}
function clearAllSelections() {
  if (state.selDeco != null) { state.selDeco = null; if (typeof renderDecoPanel === 'function') renderDecoPanel(); }
  if (state.ref3d && state.ref3d.sel) selectRef3d(false);
  if (state.selAlt != null) selectAlt(null);
  if (state.selBridge != null) selectBridge(null);
  if (state.selCross != null) { state.selCross = null; refreshPanels(); }
  state.sel = null;
  state.selSet = null;
  endArc();
  if (state.selItem) selectItem(null);
  if (state.selHill != null || state.selTunnel != null) selectHill(null);
  state.selTunnel = null;
  refreshArcBox();
  if (typeof editor !== 'undefined') { editor.draw(); profile.draw(); preview.updateHandles(); preview.setHillSelection(null); }
}
function deleteSelectedHill() {
  if (state.selHill == null) return;
  pushUndo();
  state.hills = state.hills.filter((h) => h.id !== state.selHill);
  state.selHill = null;
  refreshHillPanel();
  editor.draw();
  sceneChanged();
}
function selectTunnel(id) {
  state.selTunnel = id;
  if (id != null) setTimeout(() => { try { focusPanel('hills', $('tunnelSelBox').hidden ? $('tunnelInfo') : $('tunnelSelBox')); } catch { /* iniciando */ } }, 0);
  if (id != null) { state.selHill = null; if (state.selItem) { state.selItem = null; preview.buildItems(); preview.updateHandles(); refreshItemsInfo(); } }
  if (typeof refreshHillPanel === 'function') refreshHillPanel();
  if (typeof refreshTunnelInfo === 'function') refreshTunnelInfo();
  if (typeof editor !== 'undefined') { editor.draw(); preview.setHillSelection(state.selHill); }
}
/** Selecciona un atajo (índice en project.alts): lo resalta y lleva el panel a sus parámetros. */
function selectAlt(i) {
  state.selAlt = i;
  if (i != null) {
    state.selHill = null; state.selTunnel = null;
    if (state.selItem) { state.selItem = null; if (typeof preview !== 'undefined') preview.buildItems(); refreshItemsInfo(); }
    if (typeof refreshHillPanel === 'function') refreshHillPanel();
    if (typeof preview !== 'undefined') preview.setHillSelection(null);
  }
  refreshPanels();
  if (typeof editor !== 'undefined') { editor.draw(); preview.update(false, true); }
  if (i != null) setTimeout(() => { try { focusPanel('alts', document.querySelector(`#altList .item[data-alt="${i}"]`)); } catch { /* iniciando */ } }, 0);
}
/** Miniatura (dataURL de 64 px) de un lienzo, guardada en el propio lienzo. */
function thumbURL(cv) {
  if (!cv) return '';
  if (cv.__thumb && cv.__thumbW === cv.width && cv.__thumbH === cv.height) return cv.__thumb;
  const t = document.createElement('canvas');
  const k = 64 / Math.max(cv.width, cv.height);
  t.width = Math.max(1, Math.round(cv.width * k)); t.height = Math.max(1, Math.round(cv.height * k));
  t.getContext('2d').drawImage(cv, 0, 0, t.width, t.height);
  cv.__thumb = t.toDataURL('image/png'); cv.__thumbW = cv.width; cv.__thumbH = cv.height;
  return cv.__thumb;
}
/** Carga una textura propia para un atajo (kind: 'track' | 'barrier' | 'dirt'). */
function pickAltTexture(a, kind) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.addEventListener('change', async () => {
    const f = inp.files[0];
    if (!f) return;
    try {
      const bmp = await createImageBitmap(f);
      const k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(bmp.width * k)); cv.height = Math.max(1, Math.round(bmp.height * k));
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      app.setAltTexture(a, kind, cv);
    } catch (err) { toast('No se pudo leer la textura: ' + err.message); }
  });
  inp.click();
}
/** Puente (índice en project.main.bridges) bajo un punto del lienzo, o null. */
function bridgeAt(p, tolLayout = 0) {
  const L = state.layout;
  if (!L) return null;
  const r = L.routes[0];
  if (!r || !r.bridges || !r.bridges.length) return null;
  const [x, y] = L.toWorld(p[0], p[1]);
  const n = nearestOnSamples(r, x, y);
  const w = (r.w && r.w[Math.min(r.n - 1, n.i)]) || state.geom.width;
  if (n.d - w / 2 > tolLayout * L.scale) return null;
  const sv = r.s[Math.min(r.n - 1, n.i)];
  for (const b of r.bridges) {
    const d = r.closed ? (((sv - b.s0) % r.L) + r.L) % r.L : sv - b.s0;
    if (d >= 0 && d <= b.s1 - b.s0) return b.idx;
  }
  return null;
}
/** {kind: 'barrier' | 'dirt', k (ruta)} o null según lo que haya bajo el punto del lienzo. */
function edgeAt(p, tolLayout = 0) {
  const L = state.layout, EM = state.edgeMeshes;
  if (!L || !EM) return null;
  const [x, y] = L.toWorld(p[0], p[1]);
  const tol = tolLayout * L.scale;
  const segDist = (ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy; const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0; return Math.hypot(x - ax - dx * t, y - ay - dy * t); };
  for (const m of EM.barriers) {
    const P = m.positions;
    for (const a of m.segs) {
      const v = a * 6, w = (a + 1) * 6;
      const ax = (P[v * 3] + P[v * 3 + 9]) / 2, ay = (P[v * 3 + 1] + P[v * 3 + 10]) / 2, bx = (P[w * 3] + P[w * 3 + 9]) / 2, by = (P[w * 3 + 1] + P[w * 3 + 10]) / 2;
      if (segDist(ax, ay, bx, by) < Math.max(0.1, edgeParams(state.scene, L.routes[m.k]).barrierThick ?? 0.25) / 2 + tol) return { kind: 'barrier', k: m.k };
    }
  }
  const inTri = (A, B, C) => { const d = (P1, P2) => (x - P2[0]) * (P1[1] - P2[1]) - (P1[0] - P2[0]) * (y - P2[1]); const d1 = d(A, B), d2 = d(B, C), d3 = d(C, A); return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)); };
  for (const m of EM.dirt) {
    const P = m.positions, per = m.per || 2, V = (v) => [P[v * 3], P[v * 3 + 1]];
    for (const a of m.segs) {
      const A = V(a * per), B = V(a * per + 1), C = V((a + 1) * per + 1), D = V((a + 1) * per);
      if (inTri(A, B, C) || inTri(A, C, D)) return { kind: 'dirt', k: m.k };
    }
  }
  return null;
}
/** ¿El punto del lienzo está sobre la calzada de la pista principal? */
function onMainRoad(p, tolLayout = 0) {
  const L = state.layout;
  if (!L) return false;
  const [x, y] = L.toWorld(p[0], p[1]);
  const r = L.routes.find((q) => q.kind !== 'alt');
  if (!r) return false;
  const n = nearestOnSamples(r, x, y);
  const w = (r.w && r.w[Math.min(r.n - 1, n.i)]) || state.geom.width;
  return n.d - w / 2 < tolLayout * L.scale;
}
/** Atajo bajo un punto del lienzo (índice en project.alts) o null. */
function altAt(p, tolLayout) {
  const L = state.layout;
  if (!L) return null;
  const [x, y] = L.toWorld(p[0], p[1]);
  let best = null, bd = Infinity;
  for (const r of L.routes) {
    if (r.kind !== 'alt') continue;
    const n = nearestOnSamples(r, x, y);
    const w = r.w[Math.min(r.n - 1, n.i)] || state.geom.width;
    const d = n.d - w / 2;
    if (d < tolLayout * L.scale && d < bd) { bd = d; best = r.altIndex; }
  }
  return best;
}
function selectHill(id, redraw = true) {
  state.selHill = id;
  state.selTunnel = null;
  if (typeof preview !== 'undefined' && preview.refreshPaintOverlay && state.tool === 'hill') preview.refreshPaintOverlay();
  if (id != null && state.selAlt != null) { state.selAlt = null; refreshPanels(); preview.update(false, true); }
  if (id != null) setTimeout(() => { try { focusPanel('hills', $('hillSelBox')); } catch { /* iniciando */ } }, 0);
  if (state.selItem && typeof preview !== 'undefined') { state.selItem = null; preview.buildItems(); preview.updateHandles(); refreshItemsInfo(); }
  if (typeof refreshTunnelInfo === 'function') refreshTunnelInfo();
  if (typeof refreshHillPanel === 'function') refreshHillPanel();
  if (redraw && typeof editor !== 'undefined') { editor.draw(); preview.setHillSelection(id); }
}
/** Convierte los toques sueltos del formato anterior (hillPaint) en cerros: un cerro por grupo de toques que se tocan. */
function migrateHillPaint(list) {
  const adds = list.filter((q) => !q.e);
  const parent = adds.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < adds.length; i++) for (let j = i + 1; j < adds.length; j++) {
    if (Math.hypot(adds[i].x - adds[j].x, adds[i].y - adds[j].y) < adds[i].r + adds[j].r) parent[find(i)] = find(j);
  }
  const groups = new Map();
  adds.forEach((q, i) => { const g = find(i); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(q); });
  const hills = [];
  const sc = state.scene;
  for (const qs of groups.values()) {
    const id = hills.length + 1;
    const hard = qs.filter((q) => q.hard).length > qs.length / 2;
    const strokes = [];
    for (const q of list) {
      if (!q.e && !qs.includes(q)) continue;
      strokes.push({ x: q.x, y: q.y, r: q.r, e: !!q.e });
    }
    hills.push({ id, name: hillName(id), height: Math.max(...qs.map((q) => q.h || sc.hillHeight)), hard, flat: hard ? 1 : 0, density: sc.hillDensity, maxTris: sc.hillMaxTris, strokes });
  }
  return hills;
}

// ---------- elementos de pista (charcos, turbo pads, nitro strips) ----------
const ITEM_COLORS = { puddle: '#3a8fe8', pad: '#ffd21f', strip: '#22c55e' };
const ITEM_LABEL = { puddle: 'charcos', pad: 'turbo pads', strip: 'nitro strips' };
let itemsVersion = 0, itemsMemo = null;
function itemGroup(ref) {
  if (!ref) return null;
  if (ref.type === 'deco') return state.decoSets.find((d) => d.id === ref.id) || null; // zonas pintadas de un set de decoración
  return (state.items[ref.type] || []).find((g) => g.gid === ref.gid) || null;
}
function itemInstances() {
  const L = state.layout, E = state.result;
  if (!L || !E) return [];
  const sc = state.scene;
  const bkey = sc.stripBorder ? sc.stripBorderHeight : 0;
  if (itemsMemo && itemsMemo.L === L && itemsMemo.E === E && itemsMemo.v === itemsVersion && itemsMemo.b === bkey) return itemsMemo.inst;
  const toW = (strokes) => strokes.map((q) => { const [x, y] = L.toWorld(q.x, q.y); return { x, y, r: q.r * L.scale, e: q.e }; });
  const inst = computeItems(L, E, state.items, toW, { border: sc.stripBorder ? { h: sc.stripBorderHeight } : null });
  itemsMemo = { L, E, v: itemsVersion, b: bkey, inst };
  return inst;
}
function findItemInst(ref) {
  if (!ref) return null;
  for (const g of itemInstances()) if (g.type === ref.type && g.gid === ref.gid) return g.items.find((it) => it.idx === ref.idx) || null;
  return null;
}
/** Recalcula los elementos y refresca vistas (quick = durante un arrastre: sin tocar el panel). */
function itemsChanged(quick = false) {
  itemsVersion++;
  if (state.selItem && !findItemInst(state.selItem)) state.selItem = null;
  if (typeof preview !== 'undefined') preview.buildItems();
  if (typeof editor !== 'undefined') editor.draw();
  if (!quick) refreshItemsInfo();
}
function selectItem(ref) {
  const changedGroup = !ref || !state.selItem || ref.type !== state.selItem.type || ref.gid !== state.selItem.gid;
  state.selItem = ref;
  if (changedGroup && typeof renderItemsPanel === 'function' && document.querySelector('.igroup')) renderItemsPanel();
  if (ref) setTimeout(() => { try { focusPanel('items', document.querySelector(`.igroup[data-type="${ref.type}"][data-gid="${ref.gid}"]`)); } catch { /* iniciando */ } }, 0);
  if (ref) { state.selHill = null; state.selTunnel = null; if (typeof refreshHillPanel === 'function') refreshHillPanel(); if (typeof refreshTunnelInfo === 'function') refreshTunnelInfo(); }
  if (typeof preview !== 'undefined') { preview.setHillSelection(state.selHill); preview.buildItems(); preview.updateHandles(); }
  if (typeof editor !== 'undefined') editor.draw();
  refreshItemsInfo();
}

// ---------- API usada por las vistas ----------
const app = {
  state,
  contentBounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    if (state.image) { add(0, 0); add(state.image.w, state.image.h); }
    if (state.project.main) for (const p of state.project.main.pts) add(p[0], p[1]);
    for (const a of state.project.alts) for (const p of a.pts) add(p[0], p[1]);
    if (!isFinite(x0)) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  },
  nearestMainS(p, maxDist) {
    const L = state.layout;
    if (!L) return null;
    const [X, Y] = L.toWorld(p[0], p[1]);
    const r = nearestOnSamples(L.routes[0], X, Y);
    if (r.d / L.scale > maxDist) return null;
    return r.s;
  },
  flatZonesS() {
    const L = state.layout;
    if (!L) return [];
    return state.flatZones.map(([a, b]) => {
      const s0 = app.nearestMainS(a, Infinity), s1 = app.nearestMainS(b, Infinity);
      return [Math.min(s0, s1), Math.max(s0, s1)];
    }).filter(([a, b]) => b - a > 1);
  },
  setHover(s, src) {
    state.hover = s;
    requestRender({ hover: true, src });
  },
  commitStroke(kind, pts, zoom = 1) {
    if (kind === 'extend') {
      if (!state.project.main) kind = 'draw';
      else { extendMain(pts, 28 / zoom); return; }
    }
    pushUndo();
    if (kind === 'draw') {
      state.project.main = { pts, closed: state.closed };
      state.project.start = null;
      state.overrides = [];
    } else {
      if (!state.project.main) { toast('Primero dibuja o traza la ruta principal.'); undoStack.pop(); return; }
      state.project.alts.push({ pts, keep: true });
    }
    scheduleBuild();
  },
  setStart(p) {
    if (!state.project.main) return;
    pushUndo();
    state.project.start = p;
    scheduleBuild();
  },
  /** Perfiles dibujados en s de la ruta principal: [{s0, s1, pts}] (t crece en el sentido de marcha). */
  profileZonesS() {
    const L = state.layout;
    if (!L) return [];
    return state.profileZones.map((Z, idx) => {
      const s0 = app.nearestMainS(Z.a, Infinity), s1 = app.nearestMainS(Z.b, Infinity);
      if (s0 === null || s1 === null) return null;
      const flip = s1 < s0;
      return { idx, s0: Math.min(s0, s1), s1: Math.max(s0, s1), pts: flip ? Z.pts.map(([t, z]) => [1 - t, z]).reverse() : Z.pts };
    }).filter((Z) => Z && Z.s1 - Z.s0 > 2);
  },
  /** Tramos suspendidos en s de la ruta principal: [{k: 0, s0, s1, pillars, dirt, barrier, idx}]. */
  suspZonesS() {
    const L = state.layout;
    if (!L) return [];
    return state.suspZones.map((Z, idx) => {
      const s0 = app.nearestMainS(Z.a, Infinity), s1 = app.nearestMainS(Z.b, Infinity);
      if (s0 === null || s1 === null) return null;
      return { k: 0, idx, s0: Math.min(s0, s1), s1: Math.max(s0, s1), pillars: Z.pillars ?? 3, dirt: !!Z.dirt, barrier: !!Z.barrier };
    }).filter((Z) => Z && Z.s1 - Z.s0 > 2);
  },
  addSuspZone(a, b) {
    if (!state.layout) return;
    const s0 = app.nearestMainS(a, Infinity), s1 = app.nearestMainS(b, Infinity);
    if (s0 === null || s1 === null || Math.abs(s1 - s0) < 5) return;
    pushUndo();
    const lo = Math.min(s0, s1), hi = Math.max(s0, s1);
    const cur = app.suspZonesS();
    state.suspZones = state.suspZones.filter((Z, i) => { const c = cur.find((q) => q.idx === i); return !c || c.s1 < lo || c.s0 > hi; }); // reemplaza los que se superponen
    state.suspZones.push({ a: app.mainLayoutAt(lo), b: app.mainLayoutAt(hi), pillars: Math.max(1, Math.round((hi - lo) / 25)), dirt: false, barrier: true });
    scheduleElev();
    toast(`Tramo suspendido entre s=${lo.toFixed(0)} y ${hi.toFixed(0)} m: súbelo con el perfil (o las alturas de sus puntos).`);
  },
  /** Tramo elegido para el perfil, en s: [s0, s1] o null. */
  profileSelS() {
    const P = state.profileSel;
    if (!P || !state.layout) return null;
    const s0 = app.nearestMainS(P.a, Infinity), s1 = app.nearestMainS(P.b, Infinity);
    if (s0 === null || s1 === null || Math.abs(s1 - s0) < 3) return null;
    return [Math.min(s0, s1), Math.max(s0, s1)];
  },
  /** Punto del lienzo sobre la ruta principal en la posición s. */
  mainLayoutAt(sv) {
    const L = state.layout, r = L.routes[0];
    const i = Math.min(r.n - 1, Math.max(0, Math.round(sv / r.ds))) % r.n;
    return L.toLayout(r.x[i], r.y[i]).map((v) => +v.toFixed(3));
  },
  setProfileSel(a, b) {
    if (!state.layout) return;
    if (!a || !b) { state.profileSel = null; editor.draw(); profile.draw(); return; }
    state.profileSel = { a, b };
    if (!app.profileSelS()) state.profileSel = null;
    editor.draw(); profile.draw();
  },
  setProfileSelS(s0, s1) { if (!state.layout) return; this.setProfileSel(this.mainLayoutAt(Math.min(s0, s1)), this.mainLayoutAt(Math.max(s0, s1))); },
  /**
   * Aplica un perfil dibujado en el gráfico: pts = [[s, z], ...] tal como se dibujaron. El tramo es el elegido (el trazo
   * se recorta a él) o, si no hay, el que cubre el trazo. Reemplaza los perfiles que se superponen.
   */
  applyDrawnProfile(raw) {
    const L = state.layout;
    if (!L || !raw || raw.length < 2) return false;
    const Lm = L.routes[0].L;
    const P = raw.map(([sv, z]) => [Math.max(0, Math.min(Lm, sv)), z]).sort((u, v) => u[0] - v[0]);
    let a = P[0][0], b = P[P.length - 1][0];
    const sel = app.profileSelS();
    if (sel) { a = Math.max(a, sel[0]); b = Math.min(b, sel[1]); }
    if (b - a < 5) { toast(sel ? 'Dibuja el perfil dentro del tramo elegido (resaltado).' : 'Dibuja el perfil a lo largo de al menos unos metros de pista.'); return false; }
    const zAt = (sv) => {
      if (sv <= P[0][0]) return P[0][1];
      if (sv >= P[P.length - 1][0]) return P[P.length - 1][1];
      let k = 0;
      while (k < P.length - 2 && P[k + 1][0] < sv) k++;
      const [s0, z0] = P[k], [s1, z1] = P[k + 1];
      return s1 > s0 ? z0 + ((z1 - z0) * (sv - s0)) / (s1 - s0) : z0;
    };
    const N = Math.max(8, Math.min(200, Math.round((b - a) / 2)));
    let zs = [];
    for (let k = 0; k <= N; k++) zs.push(zAt(a + ((b - a) * k) / N));
    for (let pass = 0; pass < 2; pass++) zs = zs.map((z, k) => (k === 0 || k === N ? z : (zs[k - 1] + 2 * z + zs[k + 1]) / 4)); // suaviza el trazo a mano
    const pts = zs.map((z, k) => [+(k / N).toFixed(4), +z.toFixed(3)]);
    pushUndo();
    const cur = app.profileZonesS();
    state.profileZones = state.profileZones.filter((Z, i) => { const c = cur.find((q) => q.idx === i); return !c || c.s1 < a || c.s0 > b; });
    state.profileZones.push({ a: app.mainLayoutAt(a), b: app.mainLayoutAt(b), pts });
    scheduleElev();
    toast(`Perfil aplicado entre s=${a.toFixed(0)} y ${b.toFixed(0)} m.`);
    return true;
  },
  /** Deja los puntos de control seleccionados a la elevación promedio que tenían. */
  flattenSelected() {
    const st = state;
    const sel = st.selSet && st.selSet.idxs.size ? { key: st.selSet.key, idxs: st.selSet.idxs } : st.sel ? { key: st.sel.key, idxs: new Set([st.sel.idx]) } : null;
    if (!sel) { toast('Selecciona puntos (Editar puntos: Shift + clic o caja) para aplanarlos.'); return false; }
    const list = app.ctrlPoints().filter((q) => q.key === sel.key && sel.idxs.has(q.idx));
    if (list.length < 2) { toast('Selecciona al menos dos puntos para aplanarlos.'); return false; }
    const avg = list.reduce((acc, q) => acc + q.z, 0) / list.length;
    const za = zArray(sel.key);
    if (!za) return false;
    pushUndo();
    for (const q of list) za[q.idx] = makePin(avg);
    // una sola vez: los puntos quedan con esa altura, pero se pueden volver a editar (no se fuerza nada)
    scheduleElev();
    toast(`${list.length} puntos a ${avg.toFixed(2)} m (su altura promedio). Puedes seguir editándolos.`);
    return true;
  },
  addFlatZone(a, b) {
    if (!state.layout) return;
    const s0 = app.nearestMainS(a, Infinity), s1 = app.nearestMainS(b, Infinity);
    if (s0 === null || Math.abs(s1 - s0) < 5) return;
    pushUndo();
    state.flatZones.push([a, b]);
    scheduleElev();
  },
  // ---- edición de puntos de control ----
  ctrlRoutes() {
    const out = [];
    const p = state.project;
    if (p.main && p.main.ctrl) out.push({ key: 'main', pts: p.main.ctrl, zs: zArray('main'), closed: p.main.closed !== false });
    p.alts.forEach((a, i) => { if (a.ctrl && a.keep !== false) out.push({ key: i, pts: a.ctrl, zs: zArray(i), closed: false }); });
    return out;
  },
  selectCtrl(sel) {
    state.sel = sel;
    if (state.selSet) { state.selSet = null; endArc(); refreshArcBox(); }
    editor.draw(); profile.draw(); preview.updateHandles();
  },
  beginCtrlDrag(key, idx) { pushUndo(); state.sel = { key, idx }; },
  moveCtrl(key, idx, p) {
    const arr = ctrlArray(key);
    if (!arr || !arr[idx]) return;
    arr[idx] = [p[0], p[1], ...arr[idx].slice(2)];
    scheduleBuild();
  },
  endCtrlDrag() { refreshPanels(); },
  insertCtrl(p, tol, onlyKey = undefined, pinZ = null) {
    let best = null;
    for (const r of app.ctrlRoutes()) {
      if (onlyKey !== undefined && r.key !== onlyKey) continue;
      const n = r.pts.length;
      const segs = r.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const a = r.pts[i], b = r.pts[(i + 1) % n];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
        const d = Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
        if (!best || d < best.d) best = { d, key: r.key, i, a, b };
      }
    }
    // tolerancia generosa: el spline puede alejarse del polígono de control
    if (!best || best.d > tol * 4) { toast('Haz doble clic sobre la pista para agregar un punto.'); return; }
    pushUndo();
    const arr = ctrlArray(best.key);
    const pt = [p[0], p[1]];
    if (best.a.length > 2 && best.b.length > 2) pt.push((best.a[2] + best.b[2]) / 2);
    arr.splice(best.i + 1, 0, pt);
    zArray(best.key).splice(best.i + 1, 0, pinZ);
    state.sel = { key: best.key, idx: best.i + 1 };
    scheduleBuild();
  },
  /** Borra varios puntos de una vez (con «Abrir»: si son seguidos en un circuito, queda abierto en ese hueco). */
  deleteCtrlMany(key, idxs) {
    const arr = ctrlArray(key);
    if (!arr || !idxs.length) return;
    if (idxs.length === 1) { this.deleteCtrl(key, idxs[0]); return; }
    const m0 = state.project.main;
    const closed = key === 'main' ? m0.closed !== false : false;
    const remain = arr.length - idxs.length;
    const openIt = key === 'main' && closed && state.openOnDelete;
    const minR = closed && !openIt ? 3 : 2;
    if (remain < minR) { toast(`Deben quedar al menos ${minR} puntos.`); return; }
    const za = zArray(key);
    const set = new Set(idxs);
    pushUndo();
    if (openIt) {
      const run = contiguousRun('main');
      if (run && run.length === set.size) {
        const n = arr.length, first = run[0], last = run[run.length - 1];
        const order = [];
        for (let i = (last + 1) % n; i !== first; i = (i + 1) % n) order.push(i);
        m0.ctrl = order.map((i) => arr[i]);
        m0.ctrlZ = order.map((i) => za[i]);
        m0.closed = false; state.closed = false;
        if ($('closed')) $('closed').checked = false;
        state.sel = null; state.selSet = null; endArc(); refreshArcBox();
        scheduleBuild();
        toast(`${set.size} puntos borrados: el circuito queda abierto en ese hueco.`);
        return;
      }
    }
    const keep = arr.map((_, i) => i).filter((i) => !set.has(i));
    const newArr = keep.map((i) => arr[i]), newZ = keep.map((i) => za[i]);
    arr.length = 0; arr.push(...newArr);
    za.length = 0; za.push(...newZ);
    state.sel = null; state.selSet = null; endArc(); refreshArcBox();
    scheduleBuild();
    toast(`${set.size} puntos borrados.`);
  },
  deleteCtrl(key, idx) {
    const arr = ctrlArray(key);
    if (!arr) return;
    const m0 = state.project.main;
    if (key === 'main' && state.openOnDelete && m0.closed !== false) {
      // «Abrir»: el circuito queda abierto donde estaba el punto (en vez de cerrarse con un punto menos)
      if (arr.length < 4) { toast('La ruta necesita al menos 3 puntos para quedar abierta.'); return; }
      pushUndo();
      const za = zArray('main');
      m0.ctrl = arr.slice(idx + 1).concat(arr.slice(0, idx));
      m0.ctrlZ = za.slice(idx + 1).concat(za.slice(0, idx));
      m0.closed = false;
      state.closed = false;
      if ($('closed')) $('closed').checked = false;
      state.sel = null; state.selSet = null;
      scheduleBuild();
      toast('Circuito abierto en ese punto. Selecciona los dos extremos (Shift) para unirlos con un puente.');
      return;
    }
    const min = key === 'main' ? (state.project.main.closed !== false ? 4 : 3) : 3;
    if (arr.length <= min) { toast(`La ruta necesita al menos ${min} puntos.`); return; }
    pushUndo();
    arr.splice(idx, 1);
    zArray(key).splice(idx, 1);
    state.sel = null;
    scheduleBuild();
  },
  enterEditAt(p, tolLayout) {
    if (!state.project.main) return;
    setTool('edit');
    let best = null, bd = tolLayout;
    for (const r of app.ctrlRoutes()) r.pts.forEach((q, idx) => { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; best = { key: r.key, idx }; } });
    app.selectCtrl(best);
  },
  /** Entra a «Editar puntos» y selecciona el punto de control más cercano a la posición s de la ruta k. */
  enterEditAtS(k, s) {
    const L = state.layout;
    if (!L || !L.routes[k]) return;
    const e = evalAt(L.routes[k], s);
    const [lx, ly] = L.toLayout(e.x, e.y);
    this.enterEditAt([lx, ly], 1e9);
  },
  /** Igual, desde un punto del mundo (vista 3D). */
  enterEditAtWorld(x, y) {
    const L = state.layout;
    if (!L) return;
    const [lx, ly] = L.toLayout(x, y);
    this.enterEditAt([lx, ly], 60 / L.scale);
  },
  /** Quita de la selección los puntos indicados (Alt + caja). */
  subtractMultiSel(best) {
    if (!best || !best.idxs.length) return;
    endArc();
    if (state.selSet && state.selSet.key === best.key) { best.idxs.forEach((i) => state.selSet.idxs.delete(i)); if (!state.selSet.idxs.size) state.selSet = null; }
    if (state.sel && state.sel.key === best.key && best.idxs.includes(state.sel.idx)) state.sel = null;
    refreshArcBox();
    editor.draw(); profile.draw(); preview.updateHandles();
  },
  boxSelect(x0, y0, x1, y1, additive) {
    const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)], [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
    let best = null;
    for (const r of app.ctrlRoutes()) {
      const idxs = [];
      r.pts.forEach((q, i) => { if (q[0] >= ax && q[0] <= bx && q[1] >= ay && q[1] <= by) idxs.push(i); });
      if (idxs.length && (!best || idxs.length > best.idxs.length)) best = { key: r.key, idxs };
    }
    if (additive === 'sub') app.subtractMultiSel(best); else app.setMultiSel(best, additive);
  },
  /** best: {key, idxs:[...]} | null. Si hay puntos de varias rutas se usa la ruta con más puntos. */
  setMultiSel(best, additive) {
    endArc();
    if (!best || !best.idxs.length) { if (!additive) state.selSet = null; }
    else if (additive && state.selSet && state.selSet.key === best.key) best.idxs.forEach((i) => state.selSet.idxs.add(i));
    else state.selSet = { key: best.key, idxs: new Set(best.idxs) };
    state.sel = null;
    refreshArcBox();
    editor.draw(); profile.draw(); preview.updateHandles();
  },
  pickBest(list) {
    // list: [{key, idx}] -> {key, idxs} de la ruta con más puntos
    const by = new Map();
    for (const q of list) { if (!by.has(q.key)) by.set(q.key, []); by.get(q.key).push(q.idx); }
    let best = null;
    for (const [key, idxs] of by) if (!best || idxs.length > best.idxs.length) best = { key, idxs };
    return best;
  },
  isMultiSelected(key, idx) { const m = state.selSet; return !!(m && m.key === key && m.idxs.has(idx) && m.idxs.size > 1); },
  beginGroupDrag() {
    const m = state.selSet;
    if (!m) return false;
    pushUndo();
    endArc();
    const arr = ctrlArray(m.key);
    const pts = app.ctrlPoints();
    const items = [...m.idxs].map((idx) => {
      const cp = pts.find((q) => q.key === m.key && q.idx === idx);
      return { idx, x: arr[idx][0], y: arr[idx][1], z: cp ? (cp.pin !== null ? cp.pin : cp.z) : 0 };
    });
    state.groupDrag = { key: m.key, items };
    return true;
  },
  applyGroupDelta(dx, dy, dz) {
    const g = state.groupDrag;
    if (!g) return;
    const arr = ctrlArray(g.key), za = zArray(g.key);
    const moveXY = Math.abs(dx) + Math.abs(dy) > 1e-9;
    for (const it of g.items) {
      if (moveXY) arr[it.idx] = [it.x + dx, it.y + dy, ...arr[it.idx].slice(2)];
      if (dz !== null && dz !== undefined) za[it.idx] = makePin(it.z + dz);
    }
    if (moveXY) scheduleBuild(); else scheduleElev();
  },
  endGroupDrag() { state.groupDrag = null; refreshPanels(); },
  toggleMultiSel(hit) {
    endArc();
    // Ctrl/Shift + clic sobre el único punto seleccionado: se deselecciona
    if (!state.selSet && state.sel && state.sel.key === hit.key && state.sel.idx === hit.idx) {
      state.sel = null; refreshArcBox(); editor.draw(); profile.draw(); preview.updateHandles(); return;
    }
    if (!state.selSet || state.selSet.key !== hit.key) {
      state.selSet = { key: hit.key, idxs: new Set() };
      if (state.sel && state.sel.key === hit.key && state.sel.idx !== hit.idx) state.selSet.idxs.add(state.sel.idx); // el punto ya seleccionado se suma
    }
    const S = state.selSet.idxs;
    if (S.has(hit.idx)) S.delete(hit.idx); else S.add(hit.idx);
    if (!S.size) state.selSet = null;
    state.sel = null;
    refreshArcBox();
    editor.draw();
  },
  clearMultiSel() { endArc(); state.selSet = null; refreshArcBox(); editor.draw(); },
  // ---- pintura: densidad del terreno y cerros ----
  /** Empieza una sesión de pincel. Cerros: si empieza sobre un cerro lo extiende (y lo selecciona); si no, crea uno nuevo. */
  beginPaint(kind, ses = null, p = null, hitHill = null) {
    state.paintSes = ses;
    if (ses) { ses.from = kind === 'sculpt' ? state.terrainSculpt.length : 0; ses.strokes = []; }
    if (kind === 'river' && ses) {
      // río sobre el terreno o, con un cerro seleccionado y pintando sobre él, cascada de ese cerro; si el trazo empieza
      // sobre un río (o cascada) del mismo tipo, lo extiende (así se bifurca si el trazo se abre)
      pushUndo(); ses.pushed = true;
      if (ses.erase) return;
      const selH = state.selHill != null ? state.hills.find((h) => h.id === state.selHill) : null;
      const onHill = !!(selH && ((p && hillContainsL(selH, p)) || hitHill === selH.id));
      const kindR = onHill ? 'fall' : 'river';
      const ex = p ? [...state.rivers].reverse().find((rv) => rv.kind === kindR && (kindR !== 'fall' || rv.hill === selH.id) && riverContainsL(rv, p)) : null;
      let rv = ex;
      if (!rv) { rv = newRiver(kindR, onHill ? selH.id : null); state.rivers.push(rv); }
      ses.target = rv.id;
      state.selRiver = rv.id;
      return;
    }
    if (kind === 'paint' && ses) ses.hillSub = state.selHill; // con un cerro seleccionado se subdivide el cerro
    if (kind !== 'hill' || !ses) { pushUndo(); if (kind === 'itemPaint') { const g = itemGroup(state.itemPaintTarget); if (g && g.mode !== 'painted') { g.mode = 'painted'; if (state.itemPaintTarget.type === 'deco') renderDecoPanel(); else renderItemsPanel(); } } return; }
    // el cerro bajo el pincel: por su huella pintada y, si no, por la malla que tocó el rayo (vista 3D)
    const hit = (p ? hillAt(p) : null) || (hitHill != null ? state.hills.find((h) => h.id === hitHill) : null);
    if (ses.erase) { pushUndo(); ses.pushed = true; if (ses.shift && hit) ses.eraseOnly = hit.id; return; } // Shift: solo el cerro original
    if (hit) {
      // sobre un cerro: un clic lo selecciona; al arrastrar, sin Shift se pinta un cerro nuevo encima (se apoya en los
      // de abajo) y con Shift se agranda el cerro original
      ses.target = hit.id; ses.pending = true; ses.start = p; ses.stackNew = !ses.shift;
      selectHill(hit.id);
    } else {
      pushUndo(); ses.pushed = true;
      const h = newHill();
      state.hills.push(h);
      ses.target = h.id;
      selectHill(h.id, false);
    }
  },
  /** Agrega un toque de pincel (sesión = {kind, erase, last, target}); p en coordenadas del lienzo. */
  addStroke(ses, p) {
    const L = state.layout;
    if (!L) return;
    const sc = state.scene;
    const rm = sc[brushKey(ses.kind)];
    if (ses.kind === 'sculpt') {
      // relieve: clic derecho (o Alt) eleva, clic izquierdo hunde
      const rr = rm / L.scale;
      if (ses.last && Math.hypot(p[0] - ses.last[0], p[1] - ses.last[1]) < rr * 0.3) return;
      ses.last = p;
      state.terrainSculpt.push({ x: +p[0].toFixed(2), y: +p[1].toFixed(2), r: +rr.toFixed(3), h: +((ses.erase ? 1 : -1) * sc.sculptStrength).toFixed(3) });
      return;
    }
    if (ses.kind === 'itemPaint') {
      const g = itemGroup(state.itemPaintTarget);
      if (!g) return;
      const rr = rm / L.scale;
      if (ses.last && Math.hypot(p[0] - ses.last[0], p[1] - ses.last[1]) < rr * 0.3) return;
      ses.last = p;
      g.paint.push({ x: +p[0].toFixed(2), y: +p[1].toFixed(2), r: +rr.toFixed(2), e: !!ses.erase });
      return;
    }
    const r = rm / L.scale;
    if (ses.kind === 'river') {
      if (ses.last && Math.hypot(p[0] - ses.last[0], p[1] - ses.last[1]) < r * 0.3) return;
      ses.last = p;
      const q = { x: +p[0].toFixed(2), y: +p[1].toFixed(2), r: +r.toFixed(2), e: !!ses.erase };
      if (ses.erase) { for (const rv of state.rivers) if (rv.strokes.some((st) => !st.e && Math.hypot(st.x - q.x, st.y - q.y) < st.r + q.r)) rv.strokes.push({ ...q }); if (ses.strokes) ses.strokes.push(q); }
      else { const rv = state.rivers.find((x) => x.id === ses.target); if (rv) rv.strokes.push(q); }
      return;
    }
    if (ses.pending) {
      if (!ses.start || Math.hypot(p[0] - ses.start[0], p[1] - ses.start[1]) < r * 0.3) return;
      ses.pending = false;
      if (!ses.pushed) { pushUndo(); ses.pushed = true; }
      if (ses.kind === 'hill' && ses.stackNew) { // cerro nuevo encima del que estaba bajo el pincel
        const h = newHill();
        h.onTop = true;
        state.hills.push(h);
        ses.target = h.id;
        selectHill(h.id, false);
      }
      const s0 = ses.start;
      ses.start = null;
      this.addStroke(ses, s0);
    }
    if (ses.last && Math.hypot(p[0] - ses.last[0], p[1] - ses.last[1]) < r * 0.3) return;
    ses.last = p;
    const q = { x: +p[0].toFixed(2), y: +p[1].toFixed(2), r: +r.toFixed(2), e: !!ses.erase };
    if (ses.kind === 'hill') {
      if (ses.erase) {
        if (ses.strokes) ses.strokes.push(q);
        // el borrador afecta a todos los cerros que toca
        for (const h of state.hills) if ((ses.eraseOnly == null || h.id === ses.eraseOnly) && h.strokes.some((st) => !st.e && Math.hypot(st.x - q.x, st.y - q.y) < st.r + q.r)) h.strokes.push({ ...q });
      } else {
        const h = state.hills.find((hh) => hh.id === ses.target);
        if (h) h.strokes.push(q);
      }
    } else {
      const dq = { ...q, f: q.e ? undefined : subdivFactor(state.scene.paintSubdiv) };
      const hs = ses.hillSub != null ? state.hills.find((h) => h.id === ses.hillSub) : null;
      if (hs) (hs.subdiv || (hs.subdiv = [])).push(dq); // subdivisión del cerro seleccionado
      else state.densityPaint.push(dq);
    }
  },
  endPaint(kind, ses) {
    state.paintSes = null;
    setTimeout(() => preview.refreshPaintOverlay(), 0);
    if (kind === 'itemPaint') { if (state.itemPaintTarget && state.itemPaintTarget.type === 'deco') decoChanged(); else itemsChanged(); return; }
    if (kind === 'sculpt') refreshSculptInfo();
    if (kind === 'river') {
      state.rivers = state.rivers.filter((rv) => rv.strokes.some((q) => !q.e) && !riverIsEmpty(rv));
      if (state.selRiver != null && !state.rivers.some((rv) => rv.id === state.selRiver)) state.selRiver = null;
      riversChanged();
      return;
    }
    if (kind === 'hill') {
      // quita los cerros que quedaron vacíos
      const before = state.hills.length;
      state.hills = state.hills.filter((h) => h.strokes.some((st) => !st.e) && !hillIsEmpty(h));
      if (state.selHill != null && !state.hills.some((h) => h.id === state.selHill)) state.selHill = null;
      refreshHillPanel();
      if (ses && ses.pending && before === state.hills.length) { editor.draw(); preview.setHillSelection(state.selHill); return; }
    }
    refreshPaintInfo();
    preview.update(false);
  },
  onPaintProgress() { editor.draw(); preview.refreshPaintOverlay(); },
  /**
   * Toques de pincel que la vista 3D ilumina mientras se pinta, en metros: densidad → todas las zonas pintadas; cerro →
   * el cerro que se está pintando (o el seleccionado); relieve → los toques de esta pasada; elementos → su pintura.
   */
  paintOverlayStrokes() {
    const L = state.layout;
    if (!L) return null;
    const W = (list, extra = {}) => (list || []).map((q) => { const [x, y] = L.toWorld(q.x, q.y); return { x, y, r: q.r * L.scale, e: !!q.e, ...extra }; });
    const t = state.tool, ses = state.paintSes;
    if (t === 'paint' && state.selHill != null) { const h = state.hills.find((q) => q.id === state.selHill); return { color: 0xe040fb, strokes: h ? W(h.subdiv || []) : [] }; }
    if (t === 'river') return { color: 0x3fa7ff, strokes: state.rivers.flatMap((rv) => W(rv.strokes)) };
    if (t === 'paint') {
      const top = Math.max(4, ...state.densityPaint.map((q) => q.f || state.scene.paintFactor || 4));
      return { color: 0xe040fb, strokes: state.densityPaint.map((q) => { const [x, y] = L.toWorld(q.x, q.y); return { x, y, r: q.r * L.scale, e: !!q.e, a: q.e ? 1 : 0.45 + 0.55 * Math.min(1, (q.f || state.scene.paintFactor || 4) / top) }; }) };
    }
    if (t === 'hill') {
      const id = ses && ses.kind === 'hill' ? (ses.eraseOnly ?? ses.target ?? null) : state.selHill;
      const h = id != null ? state.hills.find((hh) => hh.id === id) : null;
      if (ses && ses.kind === 'hill' && ses.erase && ses.eraseOnly == null) return { color: 0xff6a4a, strokes: W(ses.strokes || [], { e: false }) };
      return { color: 0xe0a050, strokes: h ? W(h.strokes) : [] };
    }
    if (t === 'sculpt') return { color: 0x7ec8ff, strokes: ses && ses.kind === 'sculpt' ? W(state.terrainSculpt.slice(ses.from || 0)) : [] };
    if (t === 'itemPaint') { const g = itemGroup(state.itemPaintTarget); return { color: this.itemPaintColor(), strokes: g ? W(g.paint) : [] }; }
    return null;
  },
  /** Relieve esculpido en metros. */
  sculptWorld() {
    const L = state.layout;
    if (!L || !state.terrainSculpt.length) return null;
    return state.terrainSculpt.map((q) => { const [x, y] = L.toWorld(q.x, q.y); return { x, y, r: q.r * L.scale, h: q.h }; });
  },
  /** Todo lo que el terreno recibe del pincel: zonas de densidad y relieve esculpido. */
  terrainPaintWorld() { const rv = this.riversWorld(); return { density: this.paintWorld(), sculpt: this.sculptWorld(), rivers: rv ? rv.filter((q) => q.kind !== 'fall') : null }; },
  /** Ríos y cascadas en metros (los toques pasan a coordenadas del mundo). */
  riversWorld() {
    const L = state.layout;
    if (!L || !state.rivers.length) return null;
    return state.rivers.map((rv) => ({ ...rv, name: riverLabel(rv), strokes: rv.strokes.map((q) => { const [x, y] = L.toWorld(q.x, q.y); return { x, y, r: q.r * L.scale, e: q.e }; }) }));
  },
  paintWorld() {
    const L = state.layout;
    if (!L || !state.densityPaint.length) return null;
    return state.densityPaint.map((q) => { const [x, y] = L.toWorld(q.x, q.y); return { x, y, r: q.r * L.scale, e: q.e, f: q.f }; });
  },
  hillsWorld() {
    const L = state.layout;
    if (!L || !state.hills.length) return null;
    const rw = this.riversWorld();
    return state.hills.map((h) => ({
      id: h.id, name: h.name, height: h.height, hard: !!h.hard, onTop: !!h.onTop, flat: h.flat, density: h.density, maxTris: h.maxTris,
      strokes: h.strokes.map((q) => { const [x, y] = L.toWorld(q.x, q.y); return { x, y, r: q.r * L.scale, e: q.e }; }),
      subdiv: (h.subdiv || []).map((q) => { const [x, y] = L.toWorld(q.x, q.y); return { x, y, r: q.r * L.scale, e: q.e, f: q.f }; }),
      falls: (rw || []).filter((rv) => rv.kind === 'fall' && rv.hill === h.id),
    }));
  },
  hillAt(p) { return hillAt(p); },
  // ---- elementos de pista ----
  itemInstances() { return itemInstances(); },
  itemAtLayout(p, tolPx) { const L = state.layout; if (!L) return null; const [x, y] = L.toWorld(p[0], p[1]); return itemAt(itemInstances(), x, y, tolPx * L.scale); },
  selectItem(ref) { selectItem(ref); },
  itemPaintColor() { const t = state.itemPaintTarget; if (t && t.type === 'deco') { const d = itemGroup(t); return d ? d.color : '#e040fb'; } return t ? ITEM_COLORS[t.type] : '#e040fb'; },
  // ---- decoración ----
  assetById(id) { if (!id) return null; return builtinAsset(id) || state.assets.find((a) => a.id === id) || null; },
  decoPaintWorld(set) { const L = state.layout; if (!L || !set.paint || !set.paint.length) return null; return set.paint.map((q) => { const [x, y] = L.toWorld(q.x, q.y); return { x, y, r: q.r * L.scale, e: q.e }; }); },
  selectDecoSet(id) { selectDecoSet(id); },
  /** Altura de un cerro desde el gizmo 3D (al soltar). */
  setHillHeight(id, hgt) {
    const h = state.hills.find((q) => q.id === id);
    if (!h) return;
    pushUndo();
    h.height = Math.round(hgt * 10) / 10;
    refreshHillPanel();
    editor.draw();
    sceneChanged();
    toast(`${h.name || 'Cerro'}: altura ${h.height} m.`);
  },
  onHillHeightPreview(id, hgt) { const el = $('hillHeight'); if (el && state.selHill === id) { el.value = Math.min(+el.max || 150, hgt); const v = $('hillHeightVal'); if (v) v.textContent = `${hgt.toFixed(1)} m`; } },
  onDecoInfo(counts) { state.decoCounts = counts; refreshDecoCounts(); },
  itemPaintStrokes() { const g = itemGroup(state.itemPaintTarget); return g ? g.paint : []; },
  beginItemDrag(ref) { pushUndo(); selectItem(ref); const it = findItemInst(ref); state.itemDrag = it ? { ref, start: it.origin.slice(0, 2) } : null; },
  /** Mueve el elemento arrastrado: dxW, dyW = desplazamiento en metros desde el inicio del arrastre. */
  dragItemBy(dxW, dyW) {
    const d = state.itemDrag, L = state.layout;
    if (!d || !L) return;
    const pr = projectToTrack(L, d.start[0] + dxW, d.start[1] + dyW);
    if (!pr) return;
    const g = itemGroup(d.ref);
    if (!g) return;
    g.moves = g.moves || {};
    g.moves[d.ref.idx] = { k: pr.k, s: +pr.s.toFixed(3), u: +pr.u.toFixed(3) };
    itemsChanged(true);
  },
  dragItemToLayout(p0, p1) { const L = state.layout; if (!L) return; const a = L.toWorld(p0[0], p0[1]), b = L.toWorld(p1[0], p1[1]); this.dragItemBy(b[0] - a[0], b[1] - a[1]); },
  endItemDrag() { state.itemDrag = null; itemsChanged(); },
  bridgeAtLayout(p, tol = 0) { return bridgeAt(p, tol); },
  // ---- modelo de referencia 3D ----
  selectRef3d(on) { selectRef3d(on); },
  onRef3dMove(pos, rotDeg) { const R = state.ref3d; if (!R) return; R.pos = pos.map((v) => +v.toFixed(3)); R.rotZ = +rotDeg.toFixed(2); syncRef3dControls(); editor.draw(); },
  onRef3dMoveEnd() { syncRef3dControls(); editor.draw(); },
  moveRef3dLayout(p0, p1) {
    const R = state.ref3d, L = state.layout;
    if (!R || !L) return;
    const a = L.toWorld(p0[0], p0[1]), b = L.toWorld(p1[0], p1[1]);
    R.pos = [+(R.pos[0] + b[0] - a[0]).toFixed(3), +(R.pos[1] + b[1] - a[1]).toFixed(3), R.pos[2]];
    preview.updateReference(); syncRef3dControls(); editor.draw();
  },
  endRef3dMove() { syncRef3dControls(); },
  bridgeAtWorld(x, y) { const L = state.layout; if (!L) return null; return bridgeAt(L.toLayout(x, y), 0.5 / L.scale); },
  beginBridgeDrag(i) {
    if (state.selBridge !== i) selectBridge(i);
    const b = state.project.main.bridges && state.project.main.bridges[i];
    if (!b) return;
    state.bridgeDrag = { i, pushed: false };
  },
  dragBridgeLayout(p0, p1) {
    const d = state.bridgeDrag, L = state.layout;
    if (!d || !L) return;
    const b = state.project.main.bridges[d.i], rb = L.routes[0].bridges && L.routes[0].bridges.find((q) => q.idx === d.i);
    if (!b || !rb) return;
    const r = L.routes[0];
    const maxOff = (state.geom.width - b.w) / 2;
    if (maxOff < 0.05) { if (!d.warned) { d.warned = true; toast('El puente es tan ancho como la pista: no hay espacio para desplazarlo.'); } return; }
    const j = ((Math.round((rb.s0 + rb.s1) / 2 / r.ds) % r.n) + r.n) % r.n;
    const a = L.toWorld(p0[0], p0[1]), c = L.toWorld(p1[0], p1[1]);
    const lat = (c[0] - a[0]) * -r.ty[j] + (c[1] - a[1]) * r.tx[j]; // hacia la izquierda de la marcha
    if (!lat) return;
    if (!d.pushed) { pushUndo(); d.pushed = true; }
    d.acc = (d.acc ?? (+b.off || 0)) - lat / maxOff;
    b.off = Math.max(-1, Math.min(1, d.acc));
    if (Math.abs(b.off) < 0.02) b.off = 0; // imán al centro
    scheduleBuild();
  },
  endBridgeDrag() { state.bridgeDrag = null; refreshBridgeList(); },
  selectHillAt(p, tol = 0) {
    if (state.ref3d && state.ref3d.sel) selectRef3d(false);
    const ai = altAt(p, tol);
    if (ai != null) { selectAlt(ai); return; }
    if (state.selAlt != null) selectAlt(null);
    const bi = bridgeAt(p, tol);
    if (bi != null) { selectBridge(bi); return; }
    if (state.selBridge != null) selectBridge(null);
    if (onMainRoad(p, 0)) { selectHill(null); focusPanel('tracktex'); return; } // clic en la pista: su textura
    const eh = edgeAt(p, tol);
    if (eh) { // barrera o camino de tierra: los de la pista en «Bordes», los de un atajo en su tarjeta
      selectHill(null);
      const r = state.layout.routes[eh.k];
      if (r && r.kind === 'alt') app.focusAltEdge(r.altIndex, eh.kind); else focusPanel('edges', $(eh.kind + 'Head'));
      return;
    }
    if (onMainRoad(p, tol)) { selectHill(null); focusPanel('tracktex'); return; }
    const rv = [...state.rivers].reverse().find((q) => riverContainsL(q, p)); // río o cascada: su tarjeta
    if (rv) { selectHill(null); selectRiver(rv.id); return; }
    if (state.selRiver != null) selectRiver(null);
    const h = hillAt(p); selectHill(h ? h.id : null);
  },
  selectAlt(i) { selectAlt(i); },
  selectRiver(id) { selectRiver(id); },
  selectBridge(i) { selectBridge(i); },
  focusPanel(id, sub) { focusPanel(id, sub); },
  trackTexCanvas() { return state.trackTex || defaultTrackCanvas(); },
  bridgeTexCanvas() { return state.bridgeTex || defaultBridgeCanvas(); },
  /** Textura propia de un atajo (ruta, objeto de project.alts o uid) o null. kind: 'track' | 'barrier' | 'dirt'. */
  altOwnTex(r, kind) { const uid = r && typeof r === 'object' ? r.uid : r; const t = uid ? state.altTexs[uid] : null; return (t && t[kind]) || null; },
  // r: la ruta (o el atajo): los atajos usan su textura propia o, si no tienen, la de la pista
  barrierTexCanvas(r = null, susp = false) { return (susp && state.suspBarrierTex) || (r && typeof r === 'object' && this.altOwnTex(r, 'barrier')) || state.barrierTex || defaultBarrierCanvas(); },
  dirtTexCanvas(r = null, susp = false) { return (susp && state.suspDirtTex) || (r && typeof r === 'object' && this.altOwnTex(r, 'dirt')) || state.dirtTex || defaultDirtCanvas(); },
  /** Textura propia de los tramos suspendidos (null = la de la pista). */
  suspTexCanvas() { return state.suspTex || null; },
  altTexCanvas(r = null) { return (r && this.altOwnTex(r, 'track')) || state.trackTex || defaultTrackCanvas(); },
  /** Asigna (o quita, con null) una textura propia a un atajo (objeto de project.alts o índice). */
  setAltTexture(a, kind, cv) {
    if (typeof a === 'number') a = state.project.alts[a];
    if (!a) return;
    if (!a.uid) a.uid = `al${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const t = state.altTexs[a.uid] || (state.altTexs[a.uid] = { track: null, barrier: null, dirt: null });
    t[kind] = cv;
    refreshPanels();
    editor.draw();
    sceneChanged();
  },
  /** Bordes izquierdo y derecho de una ruta (para iluminarla en 2D). */
  edgeSamplesFor(r) { const L = state.layout, E = state.result; if (!L || !E) return { left: null, right: null }; const k = L.routes.indexOf(r); return k < 0 || !E.routes[k] ? { left: null, right: null } : edgeSamples(L, E, k); },
  /** Texturas propias de un atajo para exportar (null = material compartido con la pista). */
  altTexturesFor(r) { return { track: this.altOwnTex(r, 'track'), barrier: this.altOwnTex(r, 'barrier'), dirt: this.altOwnTex(r, 'dirt') }; },
  /** Clic en la barrera o el camino de tierra de un atajo: lo selecciona y abre esa parte de su tarjeta. */
  focusAltEdge(i, kind) {
    const a = state.project.alts[i];
    if (!a) return;
    a.collapsed = false;
    selectAlt(i);
    setTimeout(() => { try { const card = document.querySelector(`#altList .item[data-alt="${i}"]`); focusPanel('alts', card && card.querySelector(kind === 'barrier' ? '.abarH' : kind === 'dirt' ? '.adirtH' : '.atexH')); } catch { /* iniciando */ } }, 20);
  },
  wallTexCanvas(kind) { return (kind === 'fall' ? state.fallWallTex : state.riverWallTex) || null; },
  coveredTexCanvas() { return state.coveredTex || darkenedCanvas(state.trackTex || defaultTrackCanvas(), 0.2); },
  onEdgesInfo(B) {
    state.edgeMeshes = B;
    const el = $('edgesInfo');
    if (el) el.textContent = B.dirt.length || B.barriers.length ? `${B.dirt.length ? `Camino de tierra: ${B.dirtTris.toLocaleString('es')} triángulos` : ''}${B.dirt.length && B.barriers.length ? ' · ' : ''}${B.barriers.length ? `barreras: ${B.barrierTris.toLocaleString('es')} triángulos` : ''}. Clic en una barrera o en el camino (vista 3D o mapa) trae esta sección. Se exportan en «bordes».` : 'Sin bordes.';
  },
  altAtWorld(x, y) { const L = state.layout; if (!L) return null; const [lx, ly] = L.toLayout(x, y); return altAt([lx, ly], 0.5 / L.scale); },
  onGameMove(s) { if (preview.game && preview.game.dragging) return; editor.gameS = s; editor.draw(); },
  // arrastrar el auto de la cámara de juego en el mapa
  beginCarDrag() { if (preview.game) preview.game.dragging = true; },
  moveCarTo(sv) {
    const g = preview.game;
    if (!g || !g.active) return;
    g.s = sv;
    g.snapCamera = true; // la cámara salta con el auto
    editor.gameS = sv; editor.draw();
    app.setHover(sv, 'map');
  },
  endCarDrag() { if (preview.game) preview.game.dragging = false; },
  selectHill(id) { selectHill(id); },
  selectTunnel(id) { selectTunnel(id); },
  // ---- imagen de referencia ----
  refBeginDrag() { pushUndoRef(); },
  refMove(dx, dy) { if (!state.ref) return; state.ref.x += dx; state.ref.y += dy; editor.draw(); },
  refScaleTo(scale) { if (!state.ref) return; state.ref.scale = Math.max(0.01, scale); syncRefControls(); editor.draw(); },
  // ---- alturas por punto (perfil y 3D) ----
  beginPinDrag(key, idx) { pushUndo(); state.sel = { key, idx }; },
  setPin(key, idx, z) {
    const za = zArray(key);
    if (!za || idx >= za.length) return;
    za[idx] = makePin(z);
    scheduleElev();
  },
  unpin(key, idx) {
    const za = zArray(key);
    if (!za || za[idx] === null || za[idx] === undefined) return;
    pushUndo();
    za[idx] = null;
    scheduleElev();
  },
  insertCtrlAtS(k, s, z) {
    const L = state.layout;
    const r = L.routes[k];
    const e = evalAt(r, s);
    const key = k === 0 ? 'main' : r.altIndex;
    app.insertCtrl(L.toLayout(e.x, e.y), Infinity, key, +z.toFixed(3));
  },
  moveCtrl3D(key, idx, X, Y, z) {
    const L = state.layout;
    const arr = ctrlArray(key);
    if (!L || !arr || !arr[idx]) return;
    const [lx, ly] = L.toLayout(X, Y);
    arr[idx] = [lx, ly, ...arr[idx].slice(2)];
    if (z !== null && z !== undefined) zArray(key)[idx] = makePin(z);
    scheduleBuild();
  },
  /** Puntos de control con posición 3D, s y altura (para el perfil y la vista 3D). */
  ctrlPoints() {
    const L = state.layout, E = state.result;
    if (!L || !E || !state.ctrlS) return [];
    const out = [];
    L.routes.forEach((r, k) => {
      const key = k === 0 ? 'main' : r.altIndex;
      const arr = ctrlArray(key);
      const sArr = state.ctrlS[k];
      if (!arr || !sArr) return;
      const za = zArray(key);
      arr.forEach((p, idx) => {
        const s = sArr[idx];
        const i = Math.min(r.n - 1, Math.max(0, Math.round(s / r.ds))) % r.n;
        const pinned = za[idx] !== null && za[idx] !== undefined;
        const [X, Y] = L.toWorld(p[0], p[1]);
        out.push({ key, idx, k, s, X, Y, z: E.routes[k].z[i], pin: pinned ? pinVal(za[idx]) : null, local: pinned && pinLocal(za[idx]) });
      });
    });
    return out;
  },
  selectCrossing(id) {
    state.selCross = id;
    refreshPanels();
    editor.draw();
    const E = state.result;
    const idx = E ? E.crossings.findIndex((q) => q.id === id) : -1;
    setTimeout(() => { try { focusPanel('cross', document.querySelector(`#crossList .item[data-cross="${id}"]`)); } catch { /* iniciando */ } }, 0);
    if (idx >= 0) { const c = E.crossings[idx]; if (c.ra === 0) this.setHover(c.sa, 'list'); }
  },
  toggleCrossing(id) {
    const E = state.result;
    const c = E && E.crossings.find((q) => q.id === id);
    if (!c) return;
    setCrossingOverride(id, { order: c.up === 'a' ? 'b' : 'a' });
  },
};

// ---------- curva de radio fijo (selección múltiple) ----------
function contiguousRun(key) {
  const sel = state.selSet;
  const arr = ctrlArray(key);
  if (!sel || !arr) return null;
  const n = arr.length;
  const closed = key === 'main' ? state.project.main.closed !== false : false;
  const inSel = (i) => sel.idxs.has(i);
  // corridas contiguas (con vuelta en rutas cerradas); se toma la más larga
  let best = null;
  const visited = new Set();
  for (const i0 of [...sel.idxs].sort((a, b) => a - b)) {
    if (visited.has(i0)) continue;
    let a = i0;
    if (closed) { let g = 0; while (inSel((a - 1 + n) % n) && g++ < n) a = (a - 1 + n) % n; }
    else while (a > 0 && inSel(a - 1)) a--;
    const run = [];
    let i = a, g = 0;
    while (inSel(i) && g++ < n) { run.push(i); visited.add(i); i = closed ? (i + 1) % n : i + 1; if (!closed && i >= n) break; }
    if (!best || run.length > best.length) best = run;
  }
  return best;
}
/** ¿Un tramo superpuesto está apilado (una pasada sobre otra) con altura libre suficiente en todo su largo? */
function stackedOK(L, E, o) {
  const ra = L.routes[o.ra], rb = L.routes[o.rb];
  if (!ra || !rb || !E.routes[o.ra] || !E.routes[o.rb]) return false;
  const need = Math.max(2.5, (state.elev.clearance || 6) * 0.8);
  const n = Math.max(4, Math.ceil((o.sa1 - o.sa0) / 3));
  for (let q = 0; q <= n; q++) {
    const sv = o.sa0 + ((o.sa1 - o.sa0) * q) / n;
    const i = Math.min(ra.n - 1, Math.max(0, Math.round(sv / ra.ds))) % ra.n;
    const near = nearestOnSamples(rb, ra.x[i], ra.y[i]);
    if (near.d > (ra.w[i] + rb.w[near.i]) / 2 + 1) continue;
    if (Math.abs(E.routes[o.ra].z[i] - E.routes[o.rb].z[near.i]) < need) return false;
  }
  return true;
}

// ---------- helix ----------
/**
 * Plan de un helix (espiral) sobre los puntos seleccionados: desde el primer punto la pista da «turns» giros
 * alrededor de un centro al costado, con el radio pasando de «r0» a «r1», y sube (o baja) «pitch» metros por giro;
 * después sigue hacia el último punto seleccionado (con uno solo, el siguiente). El resto de los puntos no se mueve.
 */
function helixPlan(turns, r0, r1, pitch, dirMode = 'up', sideMode = 'auto') {
  const L = state.layout, E = state.result;
  if (!L || !E) return { error: 'Primero crea o carga una pista.' };
  const sel = state.selSet && state.selSet.idxs.size ? state.selSet : state.sel ? { key: state.sel.key, idxs: new Set([state.sel.idx]) } : null;
  if (!sel) return { error: 'Selecciona uno o más puntos seguidos (Editar puntos) donde irá el helix.' };
  const key = sel.key, arr = ctrlArray(key);
  if (!arr) return { error: 'Esa ruta no tiene puntos editables.' };
  const n = arr.length;
  const closed = key === 'main' ? state.project.main.closed !== false : false;
  let run = sel.idxs.size > 1 ? (state.selSet ? contiguousRun(key) : null) : [[...sel.idxs][0]];
  if (!run || (sel.idxs.size > 1 && run.length !== sel.idxs.size)) return { error: 'Los puntos del helix deben ser seguidos.' };
  if (run.length === 1) {
    const i = run[0];
    if (closed) run = [i, (i + 1) % n];
    else if (i < n - 1) run = [i, i + 1];
    else return { error: 'El helix necesita un punto después del seleccionado.' };
  }
  const i0 = run[0], i1 = run[run.length - 1];
  const k = key === 'main' ? 0 : L.routes.findIndex((r) => r.kind === 'alt' && r.altIndex === key);
  const r = L.routes[k];
  if (!r) return { error: 'No se encontró la ruta.' };
  const cp = app.ctrlPoints().filter((q) => q.key === key);
  const q0 = cp.find((c) => c.idx === i0);
  const [ax, ay] = L.toWorld(arr[i0][0], arr[i0][1]);
  // dirección de la pista en el primer punto
  const si = q0 ? Math.min(r.n - 1, Math.max(0, Math.round(q0.s / r.ds))) % r.n : nearestOnSamples(r, ax, ay).i;
  const tx = r.tx[si], ty = r.ty[si];
  const N = Math.max(1, Math.min(10, Math.round(turns)));
  const w = (r.w && r.w[0]) || state.geom.width;
  const R0 = Math.max(w * 0.9, r0), R1 = Math.max(w * 0.9, r1 > 0 ? r1 : r0);
  let side = sideMode === 'left' ? 1 : sideMode === 'right' ? -1 : 0;
  if (!side) {
    const r0r = L.routes[0];
    let cx = 0, cy = 0; for (let i = 0; i < r0r.n; i++) { cx += r0r.x[i]; cy += r0r.y[i]; } cx /= r0r.n; cy /= r0r.n;
    side = (ax - cx) * -ty + (ay - cy) * tx >= 0 ? 1 : -1; // hacia afuera del circuito
  }
  const nx = -ty * side, ny = tx * side; // normal hacia el centro del helix
  const Cx = ax + nx * R0, Cy = ay + ny * R0;
  const T = 2 * Math.PI * N;
  const Rof = (ph) => R0 + ((R1 - R0) * ph) / T;
  const Pof = (ph) => { // posición: parte en el primer punto (vector centro→punto = −n) y gira hacia el lado elegido
    const c = Math.cos(side * ph), s = Math.sin(side * ph);
    const ex = -nx * c + ny * s, ey = -ny * c - nx * s; // −n rotado side·ph (sentido antihorario si side = +1)
    const R = Rof(ph);
    return [Cx + ex * R, Cy + ey * R];
  };
  const dir = dirMode === 'down' ? -1 : 1;
  const z0 = q0 ? q0.z : 0;
  // largo y pendiente
  let len = 0, prev = Pof(0);
  const K = Math.max(16, Math.round(16 * N * Math.max(1, Math.max(R0, R1) / 30)));
  const pts = [], zs = [];
  for (let j = 1; j <= K; j++) {
    const ph = (T * j) / K;
    const p = Pof(ph);
    len += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    prev = p;
    // el último punto (con el mismo radio) cae sobre el primero, más arriba: la pista vuelve a pasar por ahí
    const [lx, ly] = L.toLayout(p[0], p[1]);
    pts.push([+lx.toFixed(3), +ly.toFixed(3)]);
    zs.push(+(z0 + (dir * pitch * ph) / (2 * Math.PI)).toFixed(3));
  }
  const grade = (pitch * N) / len;
  // giros apilados: si el radio cambia más que el ancho por giro, ya no quedan uno sobre otro (espiral plana)
  const stacked = Math.abs(R1 - R0) / N < w * 1.1;
  const clearOK = !stacked || pitch >= (state.elev.clearance || 6) + (state.elev.deck || 1) - 0.01;
  return { key, run, i0, i1, pts, zs, z0, zEnd: z0 + dir * pitch * N, R0, R1, N, len, grade, side, stacked, clearOK };
}
function addHelix(turns, r0, r1, pitch, dirMode, sideMode) {
  const P = helixPlan(turns, r0, r1, pitch, dirMode, sideMode);
  if (P.error) { toast(P.error); return false; }
  const arr = ctrlArray(P.key), za = zArray(P.key);
  pushUndo();
  const inner = new Set(P.run.slice(1, -1));
  const nA = [], nZ = [], newSel = [];
  for (let i = 0; i < arr.length; i++) {
    if (inner.has(i)) continue;
    nA.push(arr[i]);
    // el primer punto queda a su altura y el último a la altura de salida del helix (el resto de la pista se adapta)
    // alturas fijadas con influencia amplia: la subida (y la bajada después) se reparte en la pista vecina
    nZ.push(i === P.i0 ? +P.z0.toFixed(3) : za[i]);
    if (i === P.i0) P.pts.forEach((q, j) => { nA.push(q); nZ.push(P.zs[j]); newSel.push(nA.length - 1); });
  }
  arr.length = 0; arr.push(...nA);
  za.length = 0; za.push(...nZ);
  state.sel = null; state.selSet = { key: P.key, idxs: new Set(newSel) }; endArc(); refreshArcBox();
  scheduleBuild();
  toast(`Helix de ${P.N} giro${P.N > 1 ? 's' : ''} (radio ${P.R0.toFixed(0)}${Math.abs(P.R1 - P.R0) > 0.5 ? `→${P.R1.toFixed(0)}` : ''} m, ${P.zEnd >= P.z0 ? 'sube' : 'baja'} ${Math.abs(P.zEnd - P.z0).toFixed(1)} m, +${P.len.toFixed(0)} m de pista).`);
  return true;
}
function helixInputs() {
  const r = parseFloat($('helixRadius').value) || 30;
  const diff = $('helixDiff').checked;
  return [parseFloat($('helixTurns').value) || 1, diff ? parseFloat($('helixR0').value) || r : r, diff ? parseFloat($('helixR1').value) || r : r, parseFloat($('helixPitch').value) || 7, $('helixDir').value, $('helixSide').value];
}
function refreshHelixInfo() {
  const el = document.getElementById('helixInfo');
  if (!el) return;
  const P = helixPlan(...helixInputs());
  const warnG = !P.error && P.grade * 100 > state.elev.maxGrade;
  el.textContent = P.error ? P.error : `+${P.len.toFixed(0)} m · ${P.zEnd >= P.z0 ? 'sube' : 'baja'} ${Math.abs(P.zEnd - P.z0).toFixed(1)} m · pendiente ≈ ${(P.grade * 100).toFixed(1)} %${warnG ? ' (sube la pendiente máxima)' : ''}${!P.clearOK ? ' · giros apilados con poca separación (menos que la altura libre + tablero)' : ''}${!P.stacked ? ' · espiral plana (los giros no quedan uno sobre otro)' : ''}`;
  el.classList.toggle('warn', !P.error && (warnG || !P.clearOK));
  $('btnHelixAdd').disabled = !!P.error;
}

// ---------- rizos ----------
/**
 * Plan de un rizo sobre los puntos seleccionados: la pista describe «turns» vueltas (trocoide) entre el primer y el
 * último punto seleccionado (con uno solo, entre ese y el siguiente) y se cruza a sí misma en cada vuelta; la pasada
 * de arriba queda «sep» metros sobre la de abajo (separación propia de cada cruce: la elevación la resuelve el
 * optimizador, con rampas suaves). El resto de los puntos no se mueve (la vuelta se alarga).
 * Devuelve {key, run, pts (lienzo), crosses [{lx, ly, upDir}], R, grade, len, D} o {error}.
 */
function loopPlan(turns, sep, sideMode = 'auto', radius = 0) {
  const L = state.layout, E = state.result;
  if (!L || !E) return { error: 'Primero crea o carga una pista.' };
  const sel = state.selSet && state.selSet.idxs.size ? state.selSet : state.sel ? { key: state.sel.key, idxs: new Set([state.sel.idx]) } : null;
  if (!sel) return { error: 'Selecciona uno o más puntos seguidos (Editar puntos) donde irá el rizo.' };
  const key = sel.key, arr = ctrlArray(key);
  if (!arr) return { error: 'Esa ruta no tiene puntos editables.' };
  const n = arr.length;
  const closed = key === 'main' ? state.project.main.closed !== false : false;
  let run = sel.idxs.size > 1 ? (state.selSet ? contiguousRun(key) : null) : [[...sel.idxs][0]];
  if (!run || (sel.idxs.size > 1 && run.length !== sel.idxs.size)) return { error: 'Los puntos del rizo deben ser seguidos.' };
  if (run.length === 1) {
    const i = run[0];
    if (closed) run = [i, (i + 1) % n];
    else if (i < n - 1) run = [i, i + 1];
    else run = [i - 1, i];
  }
  const i0 = run[0], i1 = run[run.length - 1];
  const k = key === 'main' ? 0 : L.routes.findIndex((r) => r.kind === 'alt' && r.altIndex === key);
  const r = L.routes[k];
  if (!r) return { error: 'No se encontró la ruta.' };
  const cp = app.ctrlPoints().filter((q) => q.key === key);
  const zOf = (idx) => { const q = cp.find((c) => c.idx === idx); return q ? q.z : 0; };
  const [ax, ay] = L.toWorld(arr[i0][0], arr[i0][1]), [bx, by] = L.toWorld(arr[i1][0], arr[i1][1]);
  const D = Math.hypot(bx - ax, by - ay);
  if (D < 2) return { error: 'Los puntos están demasiado juntos para un rizo.' };
  const N = Math.max(1, Math.min(8, Math.round(turns)));
  const ux = (bx - ax) / D, uy = (by - ay) / D;
  // lado: hacia afuera del circuito (o el elegido)
  let side = sideMode === 'left' ? 1 : sideMode === 'right' ? -1 : 0;
  if (!side) {
    const r0 = L.routes[0];
    let cx = 0, cy = 0; for (let i = 0; i < r0.n; i++) { cx += r0.x[i]; cy += r0.y[i]; } cx /= r0.n; cy /= r0.n;
    const mx = (ax + bx) / 2 - cx, my = (ay + by) / 2 - cy;
    side = mx * -uy + my * ux >= 0 ? 1 : -1;
  }
  const vx = -uy * side, vy = ux * side;
  // trocoide: x = aθ + R sen θ, y = R (1 − cos θ); se cruza cuando R > a. Con R ≈ 1,57 a el cruce cae a media vuelta.
  const w = (r.w && r.w[0]) || state.geom.width;
  const a = D / (2 * Math.PI * N);
  const Rauto = Math.max(1.57 * a, 1.6 * w, 8);
  // radio pedido (0 = automático); para que la pista se cruce tiene que ser mayor que a (avance por radián)
  const Rmin = a * 1.08 + 0.5;
  const Rwant = radius > 0 ? radius : Rauto;
  const R = Math.max(Rwant, Rmin);
  const clampedR = radius > 0 && radius < Rmin;
  const tight = R < w * 1.2; // más cerrado que el ancho de la pista: la calzada se pisa en la curva
  // parámetro del cruce: sen ψ / ψ = a / R (pasadas en θ = π − ψ y θ = π + ψ de cada vuelta)
  let lo = 1e-6, hi = Math.PI - 1e-6;
  for (let it = 0; it < 60; it++) { const m = (lo + hi) / 2; if (Math.sin(m) / m > a / R) lo = m; else hi = m; }
  const psi = (lo + hi) / 2;
  const T = 2 * Math.PI * N;
  const speed = (th) => Math.hypot(a + R * Math.cos(th), R * Math.sin(th));
  const arcLen = (t0, t1) => { let s = 0; const m = 64; for (let j = 0; j < m; j++) s += speed(t0 + ((j + 0.5) / m) * (t1 - t0)) * (t1 - t0) / m; return s; };
  // entre las dos pasadas de un cruce la pista recorre la vuelta: ahí se gana la separación (las vueltas alternan
  // cuál pasada va arriba, así entre una vuelta y la siguiente no hay que bajar)
  const grade = sep / arcLen(Math.PI - psi, Math.PI + psi);
  // las vueltas alternan de lado (izquierda, derecha, …): así dos vueltas seguidas nunca se pisan
  const sgn = (th) => (Math.floor(th / (2 * Math.PI) + 1e-9) % 2 === 0 ? 1 : -1);
  const P = (th) => { const lx = a * th + R * Math.sin(th), ly = sgn(Math.min(th, T - 1e-9)) * R * (1 - Math.cos(th)); return [ax + ux * lx + vx * ly, ay + uy * lx + vy * ly]; };
  const Tn = (th) => { const tx = a + R * Math.cos(th), ty = sgn(th) * R * Math.sin(th); return [ux * tx + vx * ty, uy * tx + vy * ty]; };
  // con 3 o más vueltas, las del mismo lado necesitan espacio entre ellas
  const needD = N >= 3 ? (N * (2 * R + w + 4)) / 2 : 0;
  const crosses = [];
  for (let q = 0; q < N; q++) {
    const ta = 2 * Math.PI * q + Math.PI - psi, tb = 2 * Math.PI * q + Math.PI + psi;
    const [X, Y] = P(ta);
    const [lx, ly] = L.toLayout(X, Y);
    const up = Tn(q % 2 === 0 ? tb : ta); // pasada que va arriba (dirección en el lienzo: Y invertida)
    const l = Math.hypot(up[0], up[1]) || 1;
    crosses.push({ lx: +lx.toFixed(3), ly: +ly.toFixed(3), upDir: [up[0] / l, -up[1] / l] });
  }
  const K = 14 * N; // puntos de control por vuelta
  const pts = [];
  for (let j = 1; j < K; j++) {
    const [X, Y] = P((T * j) / K);
    const [px, py] = L.toLayout(X, Y);
    pts.push([+px.toFixed(3), +py.toFixed(3)]);
  }
  return { key, run, i0, i1, pts, crosses, R, Rauto, Rmin, clampedR, tight, grade, len: arcLen(0, T), D, N, side, overlap: D < needD, needD };
}
function addLoop(turns, sep, sideMode, radius = 0) {
  const P = loopPlan(turns, sep, sideMode, radius);
  if (P.error) { toast(P.error); return false; }
  const arr = ctrlArray(P.key), za = zArray(P.key);
  pushUndo();
  const inner = new Set(P.run.slice(1, -1)); // los puntos entre el primero y el último quedan reemplazados por el rizo
  const nA = [], nZ = [];
  let newSel = [];
  for (let i = 0; i < arr.length; i++) {
    if (inner.has(i)) continue;
    nA.push(arr[i]);
    nZ.push(za[i]);
    if (i === P.i0) P.pts.forEach((q) => { nA.push(q); nZ.push(null); newSel.push(nA.length - 1); }); // alturas automáticas
  }
  arr.length = 0; arr.push(...nA);
  za.length = 0; za.push(...nZ);
  // separación propia de cada cruce del rizo (y qué pasada va arriba)
  for (const c of P.crosses) state.overrides.push({ lx: c.lx, ly: c.ly, upDir: c.upDir, type: 'auto', sep: +sep });
  state.sel = null; state.selSet = { key: P.key, idxs: new Set(newSel) }; endArc(); refreshArcBox();
  scheduleBuild();
  toast(`Rizo de ${P.N} vuelta${P.N > 1 ? 's' : ''} (radio ${P.R.toFixed(0)} m, +${P.len.toFixed(0)} m de pista, ${sep} m de separación en ${P.N > 1 ? 'cada cruce' : 'el cruce'}).`);
  return true;
}
function refreshLoopInfo() {
  const el = document.getElementById('loopInfo');
  if (!el) return;
  const P = loopPlan(parseFloat($('loopTurns').value) || 1, parseFloat($('loopSep').value) || 7, $('loopSide').value, parseFloat($('loopRadius').value) || 0);
  if (!P.error && !(parseFloat($('loopRadius').value) > 0)) $('loopRadius').placeholder = `auto ${P.Rauto.toFixed(0)}`;
  el.textContent = P.error ? P.error : `radio ${P.R.toFixed(1)} m${P.clampedR ? ` (mínimo para que se cruce: ${P.Rmin.toFixed(1)} m)` : ''}${P.tight ? ' (muy cerrado para el ancho de la pista)' : ''} · +${P.len.toFixed(0)} m · pendiente ≈ ${(P.grade * 100).toFixed(1)} %${P.grade * 100 > state.elev.maxGrade ? ' (sube la pendiente máxima)' : ''}${P.overlap ? ` · las vueltas se pisan: elige puntos que abarquen ≥ ${P.needD.toFixed(0)} m` : ''}`;
  el.classList.toggle('warn', !P.error && (P.grade * 100 > state.elev.maxGrade || P.overlap || P.clampedR || P.tight));
  $('btnLoopAdd').disabled = !!P.error;
}

function fitRadiusMeters(key, run) {
  const arr = ctrlArray(key), L = state.layout;
  if (!run || run.length < 3 || !L) return null;
  const A = arr[run[0]], M = arr[run[Math.floor(run.length / 2)]], B = arr[run[run.length - 1]];
  const a = Math.hypot(B[0] - M[0], B[1] - M[1]), b = Math.hypot(A[0] - M[0], A[1] - M[1]), c = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const area2 = Math.abs((M[0] - A[0]) * (B[1] - A[1]) - (M[1] - A[1]) * (B[0] - A[0]));
  if (area2 < 1e-9) return 500;
  return ((a * b * c) / (2 * area2)) * L.scale;
}
function endArc() { state.arc = null; state.arcPreview = null; }
/** ¿La selección son los dos extremos de la ruta principal abierta? */
function openEndsSelected() {
  const sel = state.selSet, m = state.project.main;
  if (!sel || sel.key !== 'main' || !m || m.closed !== false || !m.ctrl) return false;
  const n = m.ctrl.length;
  return sel.idxs.size === 2 && sel.idxs.has(0) && sel.idxs.has(n - 1);
}
function refreshBridgeBox() {
  const bc = $('bridgeControls');
  if (!bc) return;
  const ok = state.tool === 'edit' && openEndsSelected();
  bc.classList.toggle('disabled', !ok);
  bc.querySelectorAll('input,button').forEach((el) => (el.disabled = !ok));
  if ($('btnTbBridge')) $('btnTbBridge').classList.toggle('ready', !!ok);
  if (!$('bridgeWidthNum').value) { $('bridgeWidthNum').value = state.geom.width; $('bridgeWidth').value = Math.min(40, state.geom.width); }
  $('bridgeInfo').textContent = ok
    ? 'Une los dos extremos con un puente que cierra el circuito, con su propio ancho. Si queda en altura, lleva pilares.'
    : 'Abre el circuito borrando un punto con «Abrir» activado (barra de «Editar puntos») y selecciona los dos extremos con Shift para crear un puente.';
}
function createBridge(w) {
  const m = state.project.main;
  if (!openEndsSelected()) { toast('Selecciona con Shift los dos extremos abiertos de la ruta principal.'); return; }
  pushUndo();
  const n = m.ctrl.length;
  m.bridges = m.bridges || [];
  m.bridges.push({ a: m.ctrl[n - 1].slice(0, 2), b: m.ctrl[0].slice(0, 2), w: Math.max(2, w || state.geom.width) });
  m.closed = true;
  state.closed = true;
  if ($('closed')) $('closed').checked = true;
  state.selSet = null; state.sel = null;
  endArc();
  refreshArcBox();
  scheduleBuild();
  toast(`Puente creado (${w.toFixed(1)} m de ancho): el circuito vuelve a estar cerrado.`);
}
/** Selecciona un puente (se ilumina en el mapa y en 3D). */
function selectBridge(i) {
  state.selBridge = i;
  if (i != null) {
    if (state.selAlt != null) { state.selAlt = null; refreshPanels(); }
    if (state.selHill != null || state.selTunnel != null) selectHill(null, false);
    if (state.selItem) selectItem(null);
  }
  refreshBridgeList();
  if (i != null) setTimeout(() => { try { focusPanel('ctrl', document.querySelector(`#bridgeList .item[data-i="${i}"]`)); } catch { /* iniciando */ } }, 0);
  editor.draw();
  preview.update(false, true);
  if (i != null) {
    const L = state.layout, b = L && L.routes[0].bridges && L.routes[0].bridges.find((q) => q.idx === i);
    if (b) app.setHover((b.s0 + b.s1) / 2, 'list');
  }
}
function refreshBridgeList() {
  const el = $('bridgeList');
  if (!el || draggingIn(el)) return;
  const m = state.project.main;
  const bl = (m && m.bridges) || [];
  const L = state.layout;
  const infoArr = L && L.routes[0] ? L.routes[0].bridges || [] : [];
  el.innerHTML = bl.length ? '' : '<div class="meta">Sin puentes. Se crean uniendo los dos extremos de la ruta abierta.</div>';
  bl.forEach((b, i) => {
    const d = document.createElement('div');
    d.className = 'item' + (state.selBridge === i ? ' sel' : '');
    d.dataset.i = i;
    const inf = infoArr.find((q) => q.idx === i);
    d.innerHTML = `<div class="head"><strong>Puente ${i + 1}</strong><button class="x" title="Quitar el puente (el tramo vuelve al ancho de la pista)">✕</button></div>
      <div class="meta">${inf ? `${(inf.s1 - inf.s0).toFixed(0)} m · s ${inf.s0.toFixed(0)}–${inf.s1.toFixed(0)} m` : ''}</div>
      <div class="field"><label>Ancho <span class="val"><input type="number" class="bw" min="2" max="80" step="0.5" style="width:60px" value="${b.w}"> m</span></label><input type="range" class="bwR" min="3" max="40" step="0.5" value="${Math.min(40, b.w)}"></div>
      <div class="field boBox"><label>Desplazamiento lateral <span class="val bo"></span></label><input type="range" class="boR" min="-1" max="1" step="0.01" value="${+b.off || 0}">
        <div class="row gap bo-btns"><button data-o="-1" title="Alinear el puente con el borde izquierdo de la pista">⇤ Izquierda</button><button data-o="0" title="Puente centrado en el eje de la pista">Centro</button><button data-o="1" title="Alinear el puente con el borde derecho de la pista">Derecha ⇥</button></div></div>`;
    let editing = false;
    const setW = (v, done) => { if (!(v > 0)) return; if (!editing) { pushUndo(); editing = true; } b.w = Math.min(80, Math.max(2, v)); d.querySelector('.bw').value = b.w; d.querySelector('.bwR').value = Math.min(40, b.w); scheduleBuild(); if (done) editing = false; };
    d.querySelector('.bwR').addEventListener('input', (e) => setW(parseFloat(e.target.value), false));
    d.querySelector('.bwR').addEventListener('change', (e) => setW(parseFloat(e.target.value), true));
    d.querySelector('.bw').addEventListener('change', (e) => setW(parseFloat(e.target.value), true));
    const offLabel = () => {
      const maxOff = Math.max(0, (state.geom.width - b.w) / 2), o = +b.off || 0;
      d.querySelector('.bo').textContent = maxOff < 0.05 ? 'sin espacio (ancho = pista)' : Math.abs(o) < 0.005 ? 'centrado' : `${(Math.abs(o) * maxOff).toFixed(1)} m a la ${o < 0 ? 'izquierda' : 'derecha'}${Math.abs(o) > 0.995 ? ' (borde)' : ''}`;
      d.querySelector('.boBox').classList.toggle('disabled', maxOff < 0.05);
    };
    offLabel();
    let offEditing = false;
    const setOff = (v, done) => { if (!isFinite(v)) return; if (!offEditing) { pushUndo(); offEditing = true; } b.off = Math.max(-1, Math.min(1, v)); if (Math.abs(b.off) < 0.02) b.off = 0; d.querySelector('.boR').value = b.off; offLabel(); scheduleBuild(); if (done) offEditing = false; };
    d.querySelector('.boR').addEventListener('input', (e) => setOff(parseFloat(e.target.value), false));
    d.querySelector('.boR').addEventListener('change', (e) => setOff(parseFloat(e.target.value), true));
    d.querySelectorAll('.bo-btns button').forEach((bt) => bt.addEventListener('click', () => setOff(parseFloat(bt.dataset.o), true)));
    d.querySelector('button.x').addEventListener('click', () => { pushUndo(); m.bridges.splice(i, 1); state.selBridge = null; scheduleBuild(); });
    d.addEventListener('click', (e) => { if (e.target.closest('input,button')) return; selectBridge(state.selBridge === i ? null : i); });
    el.appendChild(d);
  });
}
function refreshForkBox() {
  refreshBridgeBox();
  const fc = $('forkControls');
  if (!fc) return;
  const sel = state.selSet;
  const ok = state.tool === 'edit' && sel && sel.key === 'main' && sel.idxs.size >= 2;
  const run = sel ? contiguousRun(sel.key) : null;
  if ($('btnTbFork')) $('btnTbFork').classList.toggle('ready', !!ok);
  if ($('btnTbRadius')) $('btnTbRadius').classList.toggle('ready', !!(state.tool === 'edit' && run && run.length >= 3));
  fc.classList.toggle('disabled', !ok);
  fc.querySelectorAll('input,button,select').forEach((el) => (el.disabled = !ok));
  $('forkInfo').textContent = ok
    ? 'Crea una ruta alternativa que sale en el primer punto seleccionado y vuelve a la pista en el último. Después puedes editar sus puntos.'
    : 'Selecciona 2 o más puntos de la ruta principal con Shift (en «Editar puntos»): la bifurcación sale en el primero y vuelve en el último.';
}
/**
 * Bifurca la pista entre el primer y el último punto seleccionado.
 * side = +1 izquierda, -1 derecha (la ruta principal no cambia) o 0 = por el centro: la nueva ruta sale hacia la izquierda
 * y la ruta principal se abre hacia la derecha, cada una la mitad de la separación.
 */
function forkSelection(side, sepM) {
  const L = state.layout, sel = state.selSet, p = state.project;
  if (!L || !sel || sel.key !== 'main' || sel.idxs.size < 2 || !p.main.ctrl) return;
  const arr = p.main.ctrl, r = L.routes[0], n = arr.length;
  const closed = p.main.closed !== false;
  const run = contiguousRun('main');
  let a, b;
  if (run && run.length === sel.idxs.size) { a = run[0]; b = run[run.length - 1]; }
  else { const srt = [...sel.idxs].sort((x, y) => x - y); a = srt[0]; b = srt[srt.length - 1]; }
  const fwd = closed ? (b - a + n) % n : b - a;
  if (fwd < 1) return;
  const sOf = (i) => { const w = L.toWorld(arr[i][0], arr[i][1]); return nearestOnSamples(r, w[0], w[1]).s; };
  const wrap = (v) => (r.closed ? ((v % r.L) + r.L) % r.L : v);
  let s0 = sOf(a), s1 = sOf(b), swapped = false;
  let len = r.closed ? wrap(s1 - s0) : s1 - s0;
  // el tramo de carrera debe pasar por los puntos intermedios (y respetar el sentido de carrera)
  if (r.closed) {
    let flip;
    if (fwd >= 2) { const sm = sOf((a + Math.floor(fwd / 2)) % n); flip = wrap(sm - s0) > len; }
    else flip = len > r.L / 2;
    if (flip) { [s0, s1] = [s1, s0]; len = wrap(s1 - s0); swapped = true; }
  } else if (len < 0) { [s0, s1] = [s1, s0]; len = -len; swapped = true; }
  const wTrack = state.geom.width;
  if (len < wTrack * 4) { toast('El tramo seleccionado es muy corto para una bifurcación: elige puntos más separados.'); return; }
  const center = side === 0;
  const sep = Math.max(sepM, wTrack * 2.2);
  const N = Math.max(5, Math.ceil(len / Math.max(state.geom.detail, 12)));
  const ss = (x0, x1, x) => { const t = Math.min(1, Math.max(0, (x - x0) / (x1 - x0))); return t * t * (3 - 2 * t); };
  // curvatura media alrededor de s: hacia el interior de una curva la separación no puede superar ~0,6 R
  const kAt = (sv) => {
    const win = Math.max(1, Math.round(20 / r.ds));
    const i0 = evalAt(r, wrap(sv)).i;
    let acc = 0, cnt = 0;
    for (let d = -win; d <= win; d++) {
      const j = r.closed ? (i0 + d + r.n) % r.n : Math.min(r.n - 1, Math.max(0, i0 + d));
      acc += r.k[j]; cnt++;
    }
    return acc / cnt;
  };
  // perfil de separación para una dirección (sgn = +1 izquierda, -1 derecha)
  const profile = (sgn, amount) => {
    const d = [];
    for (let k = 0; k <= N; k++) {
      const t = k / N;
      let v = amount * ss(0, 0.3, t) * ss(0, 0.3, 1 - t);
      const kk = kAt(s0 + t * len);
      if (sgn * kk > 0) v = Math.min(v, 0.6 / Math.abs(kk));
      d.push(v);
    }
    for (let pass = 0; pass < 2; pass++) { const dd = d.slice(); for (let k = 1; k < N; k++) d[k] = (dd[k - 1] + 2 * dd[k] + dd[k + 1]) / 4; }
    return d;
  };
  const frames = [];
  for (let k = 0; k <= N; k++) frames.push(evalAt(r, wrap(s0 + (k / N) * len)));
  const offsetPts = (d, sgn) => frames.map((e, k) => {
    const lx = -r.ty[e.i], ly = r.tx[e.i];
    const [x, y] = L.toLayout(e.x + lx * d[k] * sgn, e.y + ly * d[k] * sgn);
    return [+x.toFixed(3), +y.toFixed(3)];
  });
  const altSide = center ? 1 : side;
  const dAlt = profile(altSide, center ? sep / 2 : sep);
  const dMain = center ? profile(-1, sep / 2) : null;
  const maxAlt = Math.max(...dAlt), maxMain = dMain ? Math.max(...dMain) : 0;
  const total = maxAlt + maxMain;
  if (total < wTrack * 1.6) { toast('Ese lado es el interior de una curva cerrada: no hay espacio para separar la bifurcación. Prueba el otro lado, el centro o un tramo más largo.'); return; }
  pushUndo();
  const pts = offsetPts(dAlt, altSide);
  const na = p.alts.length + 1;
  p.alts.push({ pts, ctrl: pts.map((q) => q.slice()), ctrlZ: pts.map(() => null), keep: true, name: `atajo_${String(na).padStart(2, '0')}` });
  if (center) {
    // la ruta principal también se abre: se reemplazan sus puntos interiores del tramo por la curva desplazada al otro lado
    let interior = offsetPts(dMain, -1).slice(1, N);
    if (swapped) interior = interior.reverse();
    const zs = p.main.ctrlZ || arr.map(() => null);
    const nullZ = interior.map(() => null);
    if (a < b) {
      arr.splice(a + 1, b - a - 1, ...interior);
      zs.splice(a + 1, b - a - 1, ...nullZ);
    } else {
      // el tramo cruza el índice 0 (circuito cerrado): se rota la lista para que empiece en a
      p.main.ctrl = [arr[a], ...interior, ...arr.slice(b, a)];
      p.main.ctrlZ = [zs[a], ...nullZ, ...zs.slice(b, a)];
    }
    if (a < b) p.main.ctrlZ = zs;
  }
  state.selSet = null;
  endArc();
  refreshArcBox();
  scheduleBuild();
  const where = center ? 'por el centro (la pista original también se abre)' : side > 0 ? 'a la izquierda' : 'a la derecha';
  toast(`Bifurcación creada ${where}: ${len.toFixed(0)} m de pista, separación máxima ${total.toFixed(0)} m${total < sep - 1 ? ' (limitada por la curva)' : ''}.`);
}
function refreshArcBox() {
  if (typeof app !== 'undefined' && app.refreshLoopInfo && document.getElementById('loopBox') && !document.getElementById('loopBox').hidden) setTimeout(() => app.refreshLoopInfo(), 0);
  if (typeof app !== 'undefined' && app.refreshHelixInfo && document.getElementById('helixBox') && !document.getElementById('helixBox').hidden) setTimeout(() => app.refreshHelixInfo(), 0);
  refreshForkBox();
  const ctl = $('arcControls');
  if (!ctl) return;
  const sel = state.selSet;
  const run = sel ? contiguousRun(sel.key) : null;
  const ok = state.tool === 'edit' && run && run.length >= 3;
  ctl.classList.toggle('disabled', !ok);
  ctl.querySelectorAll('input,button').forEach((el) => (el.disabled = !ok));
  if (!ok) {
    $('arcInfo').textContent = state.tool === 'edit'
      ? 'Selecciona 3 o más puntos seguidos con Shift+arrastrar (en el mapa, el perfil o la vista 3D).'
      : 'Activa «Editar puntos» y selecciona 3 o más puntos seguidos con Shift+arrastrar.';
    $('arcMin').textContent = '';
    return;
  }
  $('arcInfo').textContent = `${sel.idxs.size} punto(s) seleccionado(s)${run.length !== sel.idxs.size ? ` · se usa el tramo continuo de ${run.length}` : ''}.`;
  if (!state.arc) {
    const R = fitRadiusMeters(sel.key, run);
    if (R) { $('arcRadius').value = Math.min(400, Math.max(5, Math.round(R))); $('arcRadiusNum').value = Math.round(R); }
    $('arcMin').textContent = '';
  }
}
function applyArc(Rm) {
  const L = state.layout, sel = state.selSet;
  if (!L || !sel) return;
  const key = sel.key;
  if (!state.arc) {
    const run = contiguousRun(key);
    if (!run || run.length < 3) return;
    pushUndo();
    const obj = key === 'main' ? state.project.main : state.project.alts[key];
    zArray(key);
    state.arc = { key, run, orig: obj.ctrl.map((q) => q.slice()), origZ: obj.ctrlZ.slice() };
  }
  const { run, orig, origZ } = state.arc;
  const obj = key === 'main' ? state.project.main : state.project.alts[key];
  const closed = key === 'main' ? obj.closed !== false : false;
  const k = parseInt($('arcTrans').value, 10) || 3;
  // arreglo rotado para que el tramo no cruce el índice 0 (en cerradas)
  let arr = orig.map((q) => q.slice()), zs = origZ.slice();
  let r0 = run[0];
  const n = arr.length;
  let off = 0;
  if (closed) {
    off = (r0 - k - 1 + n * 2) % n;
    arr = arr.slice(off).concat(arr.slice(0, off));
    zs = zs.slice(off).concat(zs.slice(0, off));
  }
  const ia = (run[0] - off + n) % n, ib = (run[run.length - 1] - off + n) % n;
  if (ib <= ia) return;
  const A = arr[ia], B = arr[ib];
  const M = arr[Math.floor((ia + ib) / 2)];
  const c = Math.hypot(B[0] - A[0], B[1] - A[1]);
  let R = Rm / L.scale;
  let clamped = false;
  if (R < c / 2 * 1.0005) { R = c / 2 * 1.0005; clamped = true; }
  // giro total del tramo: > 180° => arco mayor
  let turn = 0;
  for (let i = ia + 1; i < ib; i++) {
    const h1 = Math.atan2(arr[i][1] - arr[i - 1][1], arr[i][0] - arr[i - 1][0]);
    const h2 = Math.atan2(arr[i + 1][1] - arr[i][1], arr[i + 1][0] - arr[i][0]);
    let d = h2 - h1; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    turn += d;
  }
  const ux = (B[0] - A[0]) / c, uy = (B[1] - A[1]) / c;
  const nx = -uy, ny = ux;
  let side = Math.sign((M[0] - A[0]) * nx + (M[1] - A[1]) * ny) || Math.sign(-turn) || 1;
  const major = Math.abs(turn) > Math.PI;
  const h = Math.sqrt(Math.max(0, R * R - (c / 2) * (c / 2)));
  const Qx = (A[0] + B[0]) / 2, Qy = (A[1] + B[1]) / 2;
  const sgn = major ? 1 : -1;
  const Cx = Qx + sgn * side * nx * h, Cy = Qy + sgn * side * ny * h;
  const a0 = Math.atan2(A[1] - Cy, A[0] - Cx), a1 = Math.atan2(B[1] - Cy, B[0] - Cx);
  let sweep = a1 - a0;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  if (major) sweep = sweep - Math.sign(sweep || 1) * 2 * Math.PI;
  const m = Math.max(ib - ia + 1, Math.ceil(Math.abs(sweep) / (Math.PI / 10)) + 1);
  const arcPts = [];
  for (let j = 0; j < m; j++) {
    const t = a0 + sweep * (j / (m - 1));
    arcPts.push([Cx + R * Math.cos(t), Cy + R * Math.sin(t)]);
  }
  const dir = Math.sign(sweep) || 1;
  const TA = [-Math.sin(a0) * dir, Math.cos(a0) * dir], TB = [-Math.sin(a1) * dir, Math.cos(a1) * dir];
  const hermite = (P0, T0, P1, T1, count) => {
    const Lh = Math.hypot(P1[0] - P0[0], P1[1] - P0[1]);
    const n0 = Math.hypot(T0[0], T0[1]) || 1, n1 = Math.hypot(T1[0], T1[1]) || 1;
    const m0 = [T0[0] / n0 * Lh, T0[1] / n0 * Lh], m1 = [T1[0] / n1 * Lh, T1[1] / n1 * Lh];
    const out = [];
    for (let j = 1; j <= count; j++) {
      const t = j / (count + 1), t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      out.push([h00 * P0[0] + h10 * m0[0] + h01 * P1[0] + h11 * m1[0], h00 * P0[1] + h10 * m0[1] + h01 * P1[1] + h11 * m1[1]]);
    }
    return out;
  };
  const N = arr.length;
  const kl = Math.min(k, ia - 1 >= 0 ? ia - 1 : 0);
  const kr = Math.min(k, N - 2 - ib >= 0 ? N - 2 - ib : 0);
  let left = [], right = [];
  if (kl > 0 && ia - kl - 1 >= 0) {
    const P0 = arr[ia - kl - 1];
    const Pm = arr[Math.max(0, ia - kl - 2)];
    left = hermite(P0, [P0[0] - Pm[0], P0[1] - Pm[1]].map((v, q) => v || (arr[ia - kl][q] - P0[q])), A, TA, kl);
  }
  if (kr > 0 && ib + kr + 1 < N) {
    const P1 = arr[ib + kr + 1];
    const Pn = arr[Math.min(N - 1, ib + kr + 2)];
    right = hermite(B, TB, P1, [Pn[0] - P1[0], Pn[1] - P1[1]].map((v, q) => v || (P1[q] - arr[ib + kr][q])), kr);
  }
  const keepW = (q, ref) => (ref && ref.length > 2 ? [q[0], q[1], ref[2]] : q);
  const before = arr.slice(0, ia - kl), after = arr.slice(ib + kr + 1);
  const zBefore = zs.slice(0, ia - kl), zAfter = zs.slice(ib + kr + 1);
  const mid = [...left, ...arcPts, ...right].map((q) => keepW(q, A));
  const zMid = mid.map(() => null);
  zMid[left.length] = zs[ia];
  zMid[left.length + arcPts.length - 1] = zs[ib];
  obj.ctrl = [...before, ...mid, ...after].map((q) => q.map((v) => +v.toFixed(3)));
  obj.ctrlZ = [...zBefore, ...zMid, ...zAfter];
  const s0 = before.length + left.length;
  state.selSet = { key, idxs: new Set(arcPts.map((_, j) => s0 + j)) };
  state.arcPreview = { cx: Cx, cy: Cy, r: R };
  $('arcMin').textContent = clamped ? `Radio mínimo para este tramo: ${(c / 2 * L.scale).toFixed(1)} m (media circunferencia).` : '';
  scheduleBuild();
}

// ---------- imagen de referencia ----------
let refUndoPushed = false;
function pushUndoRef() { pushUndo(); refUndoPushed = true; }
function syncRefControls() {
  const r = state.ref;
  $('refBox').hidden = !r;
  $('btnRefRemove').disabled = !r;
  if (!r) return;
  $('refOpacity').value = Math.round(r.opacity * 100);
  $('refOpacityVal').textContent = `${Math.round(r.opacity * 100)}%`;
  $('refScale').value = (r.scale * 100).toFixed(0);
  $('refVisible').checked = r.visible;
  $('refAbove').checked = !!r.above;
}
async function loadRefBlob(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const cv = document.createElement('canvas');
    cv.width = bmp.width; cv.height = bmp.height;
    cv.getContext('2d').drawImage(bmp, 0, 0);
    // ubicarla centrada sobre el contenido actual, a un tamaño comparable
    const b = app.contentBounds();
    let scale = 1, x = 0, y = 0;
    if (b) {
      scale = Math.min(b.w / cv.width, b.h / cv.height) || 1;
      x = b.x + (b.w - cv.width * scale) / 2;
      y = b.y + (b.h - cv.height * scale) / 2;
    }
    state.ref = { canvas: cv, w: cv.width, h: cv.height, x, y, scale, opacity: 0.5, visible: true, above: false };
    syncRefControls();
    setTool('ref');
    toast('Imagen de referencia agregada: arrástrala para moverla y usa la esquina (o el control Escala) para cambiar su tamaño.');
    editor.draw();
  } catch (err) { toast('No se pudo leer la imagen: ' + err.message); }
}

// ---------- extender / corregir la ruta principal con un trazo ----------
function extendMain(strokeIn, tol) {
  const m = state.project.main;
  const useCtrl = Array.isArray(m.ctrl);
  const closed = m.closed !== false;
  const src = useCtrl ? m.ctrl : m.pts;
  const zs = useCtrl ? zArray('main') : null;
  let items = src.map((p, i) => ({ p, z: zs ? zs[i] : null }));
  // con puntos editados, el trazo se reduce a la densidad de los puntos de control
  let stroke = strokeIn;
  if (useCtrl && items.length > 2) {
    let L = 0;
    for (let i = 1; i < src.length; i++) L += Math.hypot(src[i][0] - src[i - 1][0], src[i][1] - src[i - 1][1]);
    stroke = resampleUniform(strokeIn, L / (src.length - 1), false);
  }
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const S0 = stroke[0], S1 = stroke[stroke.length - 1];
  const first = items[0].p, last = items[items.length - 1].p;
  const newItems = (arr) => arr.map((p) => ({ p: [p[0], p[1]], z: null }));
  let result = null, closeIt = false;
  if (!closed) {
    // 1) continuar desde un extremo
    if (d(S0, last) < tol) { result = [...items, ...newItems(stroke.slice(1))]; closeIt = d(S1, first) < tol; }
    else if (d(S1, last) < tol) { result = [...items, ...newItems(stroke.slice(0, -1).reverse())]; closeIt = d(S0, first) < tol; }
    else if (d(S0, first) < tol) { result = [...newItems(stroke.slice(1).reverse()), ...items]; closeIt = d(S1, last) < tol; }
    else if (d(S1, first) < tol) { result = [...newItems(stroke.slice(0, -1)), ...items]; closeIt = d(S0, last) < tol; }
    if (result && closeIt) {
      // quita los puntos del trazo que quedaron encima del inicio para cerrar limpio
      while (result.length > 4 && d(result[result.length - 1].p, result[0].p) < tol * 0.5) result.pop();
    }
  }
  if (!result) {
    // 2) redibujar un tramo: el trazo empieza y termina sobre la pista
    const nearest = (q) => {
      let bi = -1, bd = Infinity;
      items.forEach((it, i) => { const dd = d(it.p, q); if (dd < bd) { bd = dd; bi = i; } });
      return { i: bi, d: bd };
    };
    const a = nearest(S0), b = nearest(S1);
    if (a.d > tol * 1.5 || b.d > tol * 1.5 || a.i === b.i) {
      toast(closed ? 'Empieza y termina el trazo sobre la pista para redibujar ese tramo.' : 'Empieza el trazo en un extremo (círculo verde) para continuar la pista, o sobre la pista para redibujar un tramo.');
      return;
    }
    let ia = a.i, ib = b.i;
    let S = stroke;
    const n = items.length;
    const nxt = (i) => (i + 1) % n;
    const t = [items[nxt(ia) === 0 && !closed ? ia : nxt(ia)].p[0] - items[ia].p[0], items[nxt(ia) === 0 && !closed ? ia : nxt(ia)].p[1] - items[ia].p[1]];
    const sd = [S[Math.min(3, S.length - 1)][0] - S[0][0], S[Math.min(3, S.length - 1)][1] - S[0][1]];
    let forward = t[0] * sd[0] + t[1] * sd[1] >= 0;
    if (!closed) forward = ia < ib;
    if (!forward) { S = S.slice().reverse(); [ia, ib] = [ib, ia]; }
    if (closed) {
      // se conserva el arco ib -> ia (hacia adelante) y se reemplaza ia -> ib por el trazo
      const kept = [];
      for (let i = ib; ; i = nxt(i)) { kept.push(items[i]); if (i === ia) break; }
      result = [...newItems(S.slice(1, -1)), ...kept];
    } else {
      result = [...items.slice(0, ia + 1), ...newItems(S.slice(1, -1)), ...items.slice(ib)];
    }
  }
  pushUndo();
  const pts = result.map((it) => it.p);
  if (useCtrl) { m.ctrl = pts; m.ctrlZ = result.map((it) => it.z); }
  else m.pts = pts;
  if (closeIt) { m.closed = true; state.closed = true; syncControls(); toast('Pista cerrada.'); }
  scheduleBuild();
}

// ---------- puntos de control ----------
function ctrlArray(key) {
  const p = state.project;
  if (key === 'main') return p.main && p.main.ctrl;
  return p.alts[key] && p.alts[key].ctrl;
}
function makePin(z) {
  const v = +z.toFixed(3);
  return state.pinLocal ? { z: v, local: true } : v;
}
function pinVal(v) { return v === null || v === undefined ? null : typeof v === 'object' ? v.z : v; }
function pinLocal(v) { return !!(v && typeof v === 'object' && v.local); }

function zArray(key) {
  const p = state.project;
  const obj = key === 'main' ? p.main : p.alts[key];
  if (!obj || !obj.ctrl) return null;
  if (!Array.isArray(obj.ctrlZ) || obj.ctrlZ.length !== obj.ctrl.length) obj.ctrlZ = obj.ctrl.map((_, i) => (obj.ctrlZ && obj.ctrlZ[i] != null ? obj.ctrlZ[i] : null));
  return obj.ctrlZ;
}
/** Posición s de cada punto de control sobre su ruta (recorrido monótono en la principal para no saltar de rama en los cruces). */
function computeCtrlS() {
  const L = state.layout, p = state.project;
  state.ctrlS = null;
  if (!L) return;
  const res = {};
  L.routes.forEach((r, k) => {
    const obj = k === 0 ? p.main : p.alts[r.altIndex];
    if (!obj || !obj.ctrl) return;
    const pts = obj.ctrl.map((q) => L.toWorld(q[0], q[1]));
    const sArr = new Array(pts.length).fill(0);
    if (k === 0) {
      const order = pts.map((_, i) => i);
      if (p.reverse) order.reverse();
      let prev = -1, prevPt = null;
      for (const oi of order) {
        const [X, Y] = pts[oi];
        let best = -1, bd = Infinity;
        if (prev < 0) {
          for (let i = 0; i < r.n; i++) { const d = Math.hypot(r.x[i] - X, r.y[i] - Y); if (d < bd) { bd = d; best = i; } }
        } else {
          const chord = Math.hypot(X - prevPt[0], Y - prevPt[1]);
          const win = Math.ceil((3 * chord + 20) / r.ds);
          for (let k2 = 0; k2 <= win; k2++) {
            let i = prev + k2;
            if (r.closed) i %= r.n; else if (i >= r.n) break;
            const d = Math.hypot(r.x[i] - X, r.y[i] - Y);
            if (d < bd) { bd = d; best = i; }
          }
        }
        sArr[oi] = r.s[best];
        prev = best; prevPt = [X, Y];
      }
    } else {
      pts.forEach(([X, Y], i) => { sArr[i] = nearestOnSamples(r, X, Y).s; });
    }
    res[k] = sArr;
  });
  state.ctrlS = res;
}
function collectPins() {
  const L = state.layout, p = state.project;
  const pins = [];
  if (!L || !state.ctrlS) return pins;
  L.routes.forEach((r, k) => {
    const key = k === 0 ? 'main' : r.altIndex;
    const za = zArray(key);
    const sArr = state.ctrlS[k];
    if (!za || !sArr) return;
    const n = sArr.length;
    za.forEach((z, i) => {
      if (z === null || z === undefined) return;
      const pin = { route: k, s: sArr[i], z: pinVal(z), local: pinLocal(z) };
      if (pin.local) {
        // distancia a los puntos de control vecinos (hacia atrás y hacia adelante en s)
        const nb = [];
        if (r.closed) nb.push(sArr[(i - 1 + n) % n], sArr[(i + 1) % n]);
        else { if (i > 0) nb.push(sArr[i - 1]); if (i < n - 1) nb.push(sArr[i + 1]); }
        let rl = 40, rr = 40;
        for (const sv of nb) {
          const dd = r.closed ? ((((sv - pin.s) % r.L) + r.L * 1.5) % r.L) - r.L / 2 : sv - pin.s;
          if (dd < 0) rl = Math.max(4, -dd); else if (dd > 0) rr = Math.max(4, dd);
        }
        pin.rl = rl; pin.rr = rr;
      }
      pins.push(pin);
    });
  });
  void p;
  return pins;
}

/** Crea puntos de control editables para las rutas que aún no los tienen. Devuelve true si cambió algo. */
function ensureCtrl() {
  const L = state.layout, p = state.project;
  if (!L || !p.main) return false;
  // espaciado cómodo para editar a mano (~50 puntos por vuelta como máximo)
  const spacing = Math.max(state.geom.detail, state.geom.lapLength / 50) / L.scale;
  let changed = false;
  if (!p.main.ctrl) {
    p.main.ctrl = deriveControlPoints(p.main.pts, p.main.closed !== false, spacing, state.geom.sketchSmooth);
    p.main.ctrlZ = p.main.ctrl.map(() => null);
    p.main.scale = L.scale;
    p.main.center = [L.cx, L.cy];
    changed = true;
  }
  p.alts.forEach((a) => {
    if (!a.ctrl) { a.ctrl = deriveControlPoints(a.pts, false, spacing, state.geom.sketchSmooth); a.ctrlZ = a.ctrl.map(() => null); changed = true; }
  });
  return changed;
}
function hasCtrl() {
  const p = state.project;
  return !!(p.main && p.main.ctrl) || p.alts.some((a) => a.ctrl);
}
function respaceAll(factor) {
  const p = state.project;
  if (!hasCtrl()) return;
  pushUndo();
  const re = (arr, closed) => {
    let L = 0;
    for (let i = 1; i < arr.length; i++) L += Math.hypot(arr[i][0] - arr[i - 1][0], arr[i][1] - arr[i - 1][1]);
    const avg = L / Math.max(1, arr.length - 1);
    return respaceControlPoints(arr, closed, avg * factor);
  };
  const remap = (obj, closed) => {
    const old = obj.ctrl, oldZ = obj.ctrlZ || [];
    obj.ctrl = re(old, closed);
    const nz = obj.ctrl.map(() => null);
    oldZ.forEach((z, i) => {
      if (z === null || z === undefined) return;
      let bi = 0, bd = Infinity;
      obj.ctrl.forEach((q, j) => { const d = Math.hypot(q[0] - old[i][0], q[1] - old[i][1]); if (d < bd) { bd = d; bi = j; } });
      nz[bi] = z;
    });
    obj.ctrlZ = nz;
  };
  if (p.main.ctrl) remap(p.main, p.main.closed !== false);
  p.alts.forEach((a) => { if (a.ctrl) remap(a, false); });
  state.sel = null;
  scheduleBuild();
}
function resetCtrl() {
  const p = state.project;
  if (!hasCtrl()) return;
  pushUndo();
  if (p.main) { delete p.main.ctrl; delete p.main.ctrlZ; delete p.main.scale; delete p.main.center; }
  p.alts.forEach((a) => { delete a.ctrl; delete a.ctrlZ; });
  state.sel = null;
  scheduleBuild();
}

// ---------- overrides de cruces (anclados a posición en el lienzo) ----------
function branchDir(L, route, s) {
  const r = L.routes[route];
  const i = Math.min(r.n - 1, Math.max(0, Math.round(s / r.ds)) % r.n);
  return [r.tx[i], -r.ty[i]];
}
function findOverride(L, c) {
  const [lx, ly] = L.toLayout(c.x, c.y);
  const tol = (L.gp.width * 3) / L.scale;
  let best = null, bd = Infinity;
  for (const o of state.overrides) {
    const d = Math.hypot(o.lx - lx, o.ly - ly);
    if (d < tol && d < bd) { bd = d; best = o; }
  }
  return best;
}
function overridesMap(L) {
  const map = {};
  for (const c of L.crossings) {
    const o = findOverride(L, c);
    if (!o) continue;
    let order = 'auto';
    if (o.upDir) {
      const da = branchDir(L, c.ra, c.sa), db = branchDir(L, c.rb, c.sb);
      const pa = Math.abs(da[0] * o.upDir[0] + da[1] * o.upDir[1]);
      const pb = Math.abs(db[0] * o.upDir[0] + db[1] * o.upDir[1]);
      order = pa >= pb ? 'a' : 'b';
    }
    map[c.id] = { order, type: o.type || 'auto', sep: o.sep > 0 ? o.sep : undefined };
  }
  return map;
}
function setCrossingOverride(id, { order, type, sep }) {
  const L = state.layout;
  const c = L.crossings.find((q) => q.id === id);
  if (!c) return;
  pushUndo();
  let o = findOverride(L, c);
  if (!o) {
    const [lx, ly] = L.toLayout(c.x, c.y);
    o = { lx, ly, upDir: null, type: 'auto' };
    state.overrides.push(o);
  }
  if (order !== undefined) {
    o.upDir = order === 'auto' ? null : order === 'a' ? branchDir(L, c.ra, c.sa) : branchDir(L, c.rb, c.sb);
  }
  if (type !== undefined) o.type = type;
  if (sep !== undefined) { if (sep > 0) o.sep = sep; else delete o.sep; }
  scheduleElev();
}

// ---------- pipeline ----------
let buildPending = false, elevPending = false;
function scheduleBuild() { buildPending = true; elevPending = true; tick(); }
function scheduleElev() { elevPending = true; tick(); }
let tickQueued = false;
function tick() {
  if (tickQueued) return;
  tickQueued = true;
  requestAnimationFrame(() => {
    tickQueued = false;
    let fit3d = false;
    if (buildPending) {
      buildPending = false;
      const hadLayout = !!state.layout;
      try {
        state.layout = state.project.main ? buildLayout(state.project, state.geom) : null;
      } catch (err) {
        console.error(err);
        state.layout = null;
        toast('Error al construir el trazado: ' + err.message);
      }
      fit3d = !hadLayout;
      if (state.tool === 'edit' && state.layout && ensureCtrl()) {
        state.layout = buildLayout(state.project, state.geom);
      }
      computeCtrlS();
      // los puentes siguen a sus puntos de control aunque se muevan (se reasignan al punto más cercano)
      { const m = state.project.main;
        if (m && m.ctrl && m.bridges) for (const b of m.bridges) for (const k of ['a', 'b']) {
          let bi = 0, bd = Infinity;
          m.ctrl.forEach((q, i) => { const d = (q[0] - b[k][0]) ** 2 + (q[1] - b[k][1]) ** 2; if (d < bd) { bd = d; bi = i; } });
          b[k] = m.ctrl[bi].slice(0, 2);
        } }
      if (state.layout && state.layout.scaleLocked) {
        state.geom.lapLength = Math.round(state.layout.routes[0].L);
        $('lapLength').value = state.geom.lapLength;
        $('lapLengthVal').textContent = `${state.geom.lapLength} m`;
      }
    }
    if (elevPending) {
      elevPending = false;
      if (state.layout) {
        try {
          state.elev.flatZones = app.flatZonesS();
          state.elev.profileZones = app.profileZonesS();
          state.scene.suspRanges = app.suspZonesS();
          state.result = computeElevation(state.layout, state.elev, overridesMap(state.layout), collectPins());
        } catch (err) {
          console.error(err);
          state.result = null;
          toast('Error en la elevación: ' + err.message);
        }
      } else state.result = null;
      refreshPanels();
      syncSceneControls();
      preview.update(fit3d);
    }
    editor.draw();
    profile.draw();
  });
}
let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    editor.draw();
    profile.draw();
    preview.setHover(state.hover);
  });
}

// ---------- paneles ----------
function groupCardHTML(g) {
  const t = g.type, id = `${t}-${g.gid}`;
  const first = state.items[t][0];
  const isFirst = first === g;
  const own = isFirst || g.custom;
  const painting = state.tool === 'itemPaint' && state.itemPaintTarget && state.itemPaintTarget.type === t && state.itemPaintTarget.gid === g.gid;
  const num = (f, v, min, max, step, w = 64) => `<input type="number" data-f="${f}" value="${v}" min="${min}" max="${max}" step="${step}" style="width:${w}px">`;
  const rng = (f, v, min, max, step) => `<input type="range" data-f="${f}" value="${v}" min="${min}" max="${max}" step="${step}">`;
  let extra = '';
  if (t === 'puddle') extra = `<div class="field"><label>Diámetro (todos iguales) <span class="val">${num('size', g.size, 0.3, 40, 0.1)} m</span></label>${rng('size', Math.min(20, g.size), 0.5, 20, 0.1)}</div>`;
  if (t === 'pad') extra = `<div class="field"><label>Ancho <span class="val">${num('width', g.width, 0.3, 30, 0.1)} m</span></label>${rng('width', Math.min(15, g.width), 0.5, 15, 0.1)}</div>
    <div class="field"><label>Largo <span class="val">${num('length', g.length, 0.3, 60, 0.1)} m</span></label>${rng('length', Math.min(30, g.length), 0.5, 30, 0.1)}</div>`;
  if (t === 'strip') extra = `<div class="field"><label>Largo máximo <span class="val">${num('maxLen', g.maxLen, 2, 2000, 1, 70)} m</span></label></div>
    <div class="field"><label>Largo <span class="val" data-v="len">${(+g.len).toFixed(0)} m</span></label>${rng('len', g.len, 1, g.maxLen, 0.5)}</div>
    <div class="field"><label>Ancho (% del ancho de la pista) <span class="val" data-v="widthPct">${g.widthPct} %</span></label>${rng('widthPct', g.widthPct, 2, 60, 1)}</div>
    <div class="field"><label>Posición en la pista</label><select data-f="lane">
      <option value="center"${g.lane === 'center' ? ' selected' : ''}>Centro</option>
      <option value="inner"${g.lane === 'inner' ? ' selected' : ''}>Cara interna de la curva</option>
      <option value="outer"${g.lane === 'outer' ? ' selected' : ''}>Cara externa de la curva</option>
      <option value="random"${g.lane === 'random' ? ' selected' : ''}>Mezcla al azar</option></select></div>`;
  const nMoves = Object.keys(g.moves || {}).length;
  const selCard = state.selItem && state.selItem.type === t && state.selItem.gid === g.gid;
  const shared = own
    ? `<div class="field"><label>Cantidad máxima <span class="val">${num('max', g.max, 0, 999, 1)}</span></label></div>
    <div class="field"><label>Cantidad <span class="val" data-v="count">${g.count} de ${g.max}</span></label>${rng('count', g.count, 0, Math.max(1, g.max), 1)}</div>
    ${extra}`
    : `<div class="meta">Usa la cantidad y las medidas de <b>${groupName(t, first.gid)}</b>. Marca «Parámetros propios» para darle valores distintos.</div>`;
  return `<div class="igroup${painting ? ' painting' : ''}${selCard ? ' sel' : ''}" data-type="${t}" data-gid="${g.gid}">
    <div class="head"><span class="swatch" style="background:${ITEM_COLORS[t]}"></span><b>${groupName(t, g.gid)}</b>
      <label class="check small"><input type="checkbox" data-f="enabled"${g.enabled ? ' checked' : ''}> Activo</label><span style="flex:1"></span>
      <button class="x" data-act="del" id="del-${id}" title="Eliminar grupo">✕</button></div>
    ${isFirst ? `<div class="meta">Grupo de referencia: los demás grupos usan su cantidad y medidas salvo que tengan parámetros propios.</div>` : `<label class="check small"><input type="checkbox" data-f="custom"${g.custom ? ' checked' : ''}> Parámetros propios (custom parameters)</label>`}
    <div class="field"><label>Distribución</label><select data-f="mode">
      <option value="random"${g.mode === 'random' ? ' selected' : ''}>${t === 'strip' ? 'Al azar (privilegia las curvas)' : 'Al azar en la pista'}</option>
      <option value="painted"${g.mode === 'painted' ? ' selected' : ''}>Solo en zonas pintadas</option></select></div>
    <div class="row gap"><button data-act="paint" id="paint-${id}" class="${painting ? 'on' : ''}">${painting ? 'Pintando… (Navegar para terminar)' : 'Pintar zonas'}</button><button data-act="clearPaint" id="clearPaint-${id}"${g.paint.length ? '' : ' disabled'}>Borrar zonas</button></div>
    ${shared}
    <div class="field"><label>Semilla</label><div class="row">${num('seed', g.seed, 0, 99999, 1, 80)}<button data-act="dice" id="dice-${id}">Aleatoria</button></div></div>
    <div class="row gap"><button data-act="resetMoves" id="reset-${id}"${nMoves || (g.removed && g.removed.length) ? '' : ' disabled'}>Restablecer movidos (${nMoves}) y borrados (${(g.removed || []).length})</button></div>
    <div class="meta" data-info></div>
  </div>`;
}
let itemDefaultTex = null;
function refreshItemTex() {
  if (!$('itemTexThumb-pad')) return;
  if (!itemDefaultTex) itemDefaultTex = { pad: makePadCanvas(), border: makeGlowCanvas() };
  for (const key of ['puddle', 'pad', 'strip', 'border']) {
    const img = $(`itemTexThumb-${key}`);
    const cv = state.itemTex[key] || itemDefaultTex[key] || null;
    img.hidden = !cv;
    if (cv) img.src = cv.toDataURL('image/png');
    $(`btnItemTexRemove-${key}`).disabled = !state.itemTex[key];
  }
  const sc = state.scene;
  $('stripBorder').checked = !!sc.stripBorder;
  $('stripBorderHeight').value = Math.min(5, sc.stripBorderHeight); $('stripBorderHeightNum').value = sc.stripBorderHeight;
  $('stripBorderBox').classList.toggle('disabled', !sc.stripBorder);
  $('stripBorderTexBox').classList.toggle('disabled', !sc.stripBorder);
}
function renderItemsPanel() {
  for (const t of ITEM_TYPES) {
    const box = $(`groups-${t}`);
    if (!box) continue;
    box.innerHTML = (state.items[t] || []).map(groupCardHTML).join('');
  }
  refreshItemsInfo();
}
function refreshItemsInfo() {
  const inst = itemInstances();
  document.querySelectorAll('.igroup').forEach((card) => {
    const t = card.dataset.type, gid = card.dataset.gid;
    const g0 = itemGroup({ type: t, gid });
    const g = g0 && effectiveGroup(g0, state.items[t][0]);
    const gi = inst.find((q) => q.type === t && q.gid === gid);
    const n = gi ? gi.items.length : 0;
    const info = card.querySelector('[data-info]');
    if (!g || !info) return;
    let txt = !g.enabled ? 'Grupo desactivado (no se muestra ni se exporta).'
      : `${n} ${ITEM_LABEL[t]} colocados (${gi ? gi.items.filter((it) => it.moved).length : 0} movidos a mano). Se exportan como ${itemName(t, gid, 0)} … ${itemName(t, gid, Math.max(0, n - 1))}.`;
    if (g.enabled && g.mode === 'painted' && !g.paint.some((q) => !q.e)) txt = 'Pinta zonas sobre la pista con «Pintar zonas» (en el mapa o en 3D): los elementos solo aparecen ahí.';
    else if (g.enabled && n < g.count) txt += ` No caben más de ${n} con esta separación.`;
    info.textContent = txt;
  });
  const el = $('itemSelInfo');
  if (el) {
    const it = findItemInst(state.selItem);
    el.innerHTML = it ? `Seleccionado: <b>${it.name}</b>${it.moved ? ' (movido a mano) <button class="small" id="btnItemReset">Volver a su posición</button>' : ''}` : '';
    const b = $('btnItemReset');
    if (b) b.addEventListener('click', () => { const g = itemGroup(state.selItem); if (!g) return; pushUndo(); delete g.moves[state.selItem.idx]; renderItemsPanel(); itemsChanged(); });
  }
}
function bindItemsPanel() {
  const addGroup = (type) => {
    pushUndo();
    const list = state.items[type];
    const gid = nextGroupId(list);
    const g = defaultGroup(type, gid, 1 + list.length * 17);
    if (list.length) { for (const k of SHARED_KEYS[type]) g[k] = list[0][k]; g.custom = false; }
    list.push(g);
    renderItemsPanel();
    itemsChanged();
    const card = document.querySelector(`.igroup[data-type="${type}"][data-gid="${gid}"]`);
    setTimeout(() => focusPanel('items', card), 0);
    toast(`Nuevo grupo ${groupName(type, gid)}${list.length > 1 ? ` (usa los parámetros de ${groupName(type, list[0].gid)})` : ''}.`);
  };
  $('btnNewPuddle').addEventListener('click', () => addGroup('puddle'));
  $('btnTbPuddle').addEventListener('click', () => addGroup('puddle'));
  // texturas de los elementos y borde de los nitro strips
  for (const key of ['puddle', 'pad', 'strip', 'border']) {
    $(`btnItemTex-${key}`).addEventListener('click', () => $(`fileItemTex-${key}`).click());
    $(`fileItemTex-${key}`).addEventListener('change', async (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      try {
        const bmp = await createImageBitmap(f);
        const k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(bmp.width * k)); cv.height = Math.max(1, Math.round(bmp.height * k));
        cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
        state.itemTex[key] = cv;
        refreshItemTex(); itemsChanged();
      } catch (err) { toast('No se pudo leer la textura: ' + err.message); }
    });
    $(`btnItemTexRemove-${key}`).addEventListener('click', () => { state.itemTex[key] = null; refreshItemTex(); itemsChanged(); });
  }
  const sc0 = state.scene;
  $('stripBorder').addEventListener('change', (e) => { sc0.stripBorder = e.target.checked; refreshItemTex(); itemsChanged(); });
  const setBH = (v) => { if (!(v > 0)) return; sc0.stripBorderHeight = Math.min(20, v); $('stripBorderHeight').value = Math.min(5, sc0.stripBorderHeight); $('stripBorderHeightNum').value = sc0.stripBorderHeight; itemsChanged(true); };
  $('stripBorderHeight').addEventListener('input', () => setBH(parseFloat($('stripBorderHeight').value)));
  $('stripBorderHeightNum').addEventListener('change', () => setBH(parseFloat($('stripBorderHeightNum').value)));
  refreshItemTex();
  $('btnTbPad').addEventListener('click', () => addGroup('pad'));
  $('btnTbStrip').addEventListener('click', () => addGroup('strip'));
  $('btnNewPad').addEventListener('click', () => addGroup('pad'));
  $('btnNewStrip').addEventListener('click', () => addGroup('strip'));
  const panel = document.querySelector('section[data-panel="items"]');
  let editing = false;
  const cardOf = (el) => el.closest('.igroup');
  const groupOf = (card) => itemGroup({ type: card.dataset.type, gid: card.dataset.gid });
  const apply = (el, live) => {
    const card = cardOf(el);
    if (!card || !el.dataset.f) return;
    const g = groupOf(card);
    if (!g) return;
    if (!editing) { pushUndo(); editing = true; }
    const f = el.dataset.f;
    let v = el.type === 'checkbox' ? el.checked : el.tagName === 'SELECT' ? el.value : parseFloat(el.value);
    if (typeof v === 'number' && !isFinite(v)) return;
    if (f === 'custom') {
      g.custom = !!v;
      if (g.custom) { const first = state.items[g.type][0]; for (const k of SHARED_KEYS[g.type]) g[k] = first[k]; } // parte desde los valores del grupo de referencia
    } else if (f === 'max') { v = Math.max(0, Math.round(v)); g.max = v; g.count = v; }
    else if (f === 'count') g.count = Math.min(g.max, Math.max(0, Math.round(v)));
    else if (f === 'seed') g.seed = Math.round(v);
    else if (f === 'maxLen') { g.maxLen = Math.max(2, v); g.len = Math.min(g.len, g.maxLen); }
    else if (f === 'len') g.len = Math.min(g.maxLen, Math.max(1, v));
    else g[f] = v;
    // sincroniza el par número/deslizador y las etiquetas sin reconstruir la tarjeta
    card.querySelectorAll(`[data-f="${f}"]`).forEach((o) => { if (o !== el && o.type !== 'checkbox') o.value = g[f]; });
    const lab = (k, txt) => { const x = card.querySelector(`[data-v="${k}"]`); if (x) x.textContent = txt; };
    lab('count', `${g.count} de ${g.max}`);
    lab('len', `${(+g.len).toFixed(0)} m`);
    lab('widthPct', `${g.widthPct} %`);
    itemsChanged(live);
  };
  panel.addEventListener('input', (e) => { if (e.target.type === 'range' || e.target.type === 'number') apply(e.target, true); });
  panel.addEventListener('change', (e) => {
    if (!e.target.dataset.f) return;
    apply(e.target, false);
    editing = false;
    if (['max', 'maxLen', 'mode', 'enabled', 'custom'].includes(e.target.dataset.f)) renderItemsPanel();
  });
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const card = cardOf(b), g = card && groupOf(card);
    if (!g) return;
    const act = b.dataset.act;
    const ref = { type: g.type, gid: g.gid };
    if (act === 'del') {
      pushUndo();
      const list = state.items[g.type];
      if (list[0] === g && list[1] && !list[1].custom) for (const k of SHARED_KEYS[g.type]) list[1][k] = g[k]; // el siguiente hereda la referencia
      state.items[g.type] = state.items[g.type].filter((q) => q !== g);
      if (state.selItem && state.selItem.type === g.type && state.selItem.gid === g.gid) state.selItem = null;
      if (state.itemPaintTarget && state.itemPaintTarget.type === g.type && state.itemPaintTarget.gid === g.gid) setTool('pan');
    } else if (act === 'paint') {
      if (state.tool === 'itemPaint' && state.itemPaintTarget && state.itemPaintTarget.type === g.type && state.itemPaintTarget.gid === g.gid) { setTool('pan'); renderItemsPanel(); return; }
      if (g.mode !== 'painted') { pushUndo(); g.mode = 'painted'; }
      setTool('itemPaint');
      state.itemPaintTarget = ref;
      if (preview.setPaintMode) preview.setPaintMode('itemPaint');
    } else if (act === 'clearPaint') { pushUndo(); g.paint = []; }
    else if (act === 'dice') { pushUndo(); g.seed = Math.floor(Math.random() * 99999); }
    else if (act === 'resetMoves') { pushUndo(); g.moves = {}; g.removed = []; }
    renderItemsPanel();
    itemsChanged();
    editor.draw();
  });
}
// mientras se arrastra un deslizador de una lista (atajos, cruces, puentes), esa lista no se reconstruye (perdería el arrastre)
let rangeDrag = null;
document.addEventListener('pointerdown', (e) => { if (e.target && e.target.matches && e.target.matches('input[type=range]')) rangeDrag = e.target; }, true);
window.addEventListener('pointerup', () => { if (rangeDrag) { rangeDrag = null; setTimeout(() => refreshPanels(), 0); } }, true);
const draggingIn = (el) => !!(rangeDrag && el && el.contains(rangeDrag));
function refreshPanels() {
  if (typeof refreshBridgeList === 'function') refreshBridgeList();
  if (typeof refreshItemsInfo === 'function' && document.querySelector('.igroup')) refreshItemsInfo();
  const L = state.layout, E = state.result;
  $('emptyMsg').hidden = !!(state.project.main || state.image);
  $('btnTrace').disabled = !state.image;
  const hasOut = !!(L && E);
  for (const id of ['btnExportBlender', 'btnExportMax', 'btnExportJSON', 'btnExportOBJ', 'btnExportGLB', 'btnExportGLB2', 'btnExportFBX', 'btnExportFBX2']) $(id).disabled = !hasOut;
  // cruces
  const cl = $('crossList');
  const skipCross = draggingIn(cl);
  if (!skipCross) cl.innerHTML = '';
  $('crossCount').textContent = E ? E.crossings.length : 0;
  if (E && !skipCross) {
    const ov = overridesMap(L);
    E.crossings.forEach((c, idx) => {
      const A = L.routes[c.ra], B = L.routes[c.rb];
      const o = ov[c.id] || {};
      const req = c.hreq ?? (E.ep.clearance + E.ep.deck);
      const ok = c.pinned || c.clearance >= req - 0.25;
      const div = document.createElement('div');
      div.className = 'item' + (state.selCross === c.id ? ' sel' : '');
      div.dataset.cross = c.id;
      const sepV = o.sep > 0 ? o.sep : req;
      div.innerHTML = `
        <div class="head"><strong>Cruce ${idx + 1}</strong><span class="${ok ? 'ok' : 'bad'}">${c.clearance.toFixed(1)} m de separación</span></div>
        <div class="meta">A: ${A.name} s=${c.sa.toFixed(0)} m · B: ${B.name} s=${c.sb.toFixed(0)} m · arriba: ${c.up.toUpperCase()}</div>
        <div class="ctrls">
          <select data-k="order">
            <option value="auto">Arriba: auto (${c.up === 'a' ? 'A' : 'B'})</option>
            <option value="a">Arriba: tramo A</option>
            <option value="b">Arriba: tramo B</option>
          </select>
          <select data-k="type">
            <option value="auto">Tipo: por defecto</option>
            <option value="mixed">Mixto</option>
            <option value="bridge">Puente</option>
            <option value="tunnel">Túnel</option>
          </select>
        </div>
        <div class="field${c.pinned ? ' disabled' : ''}" style="margin-top:6px"><label>Separación entre pistas (altura del puente) <span class="val"><input type="number" data-k="sepN" min="1" max="60" step="0.1" style="width:60px" value="${(+sepV).toFixed(1)}"> m</span></label>
          <input type="range" data-k="sepR" min="1" max="30" step="0.1" value="${Math.min(30, sepV)}"></div>
        <div class="row gap"><button class="small" data-k="flip">⇅ Invertir arriba/abajo</button>${o.sep > 0 ? '<button class="small" data-k="sepReset">Usar la separación general</button>' : ''}</div>
        <div class="meta">${c.pinned ? 'La separación la definen los puntos del spline editados a mano cerca del cruce (tienen prioridad).' : o.sep > 0 ? `Separación propia (general: ${(E.ep.clearance + E.ep.deck).toFixed(1)} m).` : 'Usa la separación general (altura libre + tablero).'}</div>`;
      const so = div.querySelector('[data-k=order]'), stp = div.querySelector('[data-k=type]');
      const sN = div.querySelector('[data-k=sepN]'), sR = div.querySelector('[data-k=sepR]');
      let sepTimer = null;
      const setSep = (v, now) => {
        if (!(v > 0)) return;
        sN.value = v.toFixed(1); sR.value = Math.min(30, v);
        clearTimeout(sepTimer);
        sepTimer = setTimeout(() => setCrossingOverride(c.id, { sep: v }), now ? 0 : 120);
      };
      sR.addEventListener('input', () => setSep(parseFloat(sR.value), false));
      sN.addEventListener('change', () => setSep(parseFloat(sN.value), true));
      div.querySelector('[data-k=flip]').addEventListener('click', () => app.toggleCrossing(c.id));
      const sr = div.querySelector('[data-k=sepReset]');
      if (sr) sr.addEventListener('click', () => setCrossingOverride(c.id, { sep: 0 }));
      div.addEventListener('click', (e) => { if (e.target.closest('input,select,button')) return; app.selectCrossing(c.id); });
      so.value = o.order && o.order !== 'auto' ? o.order : 'auto';
      stp.value = o.type || 'auto';
      so.addEventListener('change', () => setCrossingOverride(c.id, { order: so.value }));
      stp.addEventListener('change', () => setCrossingOverride(c.id, { type: stp.value }));
      div.addEventListener('mouseenter', () => { if (c.ra === 0) app.setHover(c.sa, 'list'); });
      cl.appendChild(div);
    });
  }
  // rutas alternativas
  const al = $('altList');
  const skipAlts = draggingIn(al);
  if (!skipAlts) al.innerHTML = '';
  $('altCount').textContent = state.project.alts.length;
  if (!skipAlts) state.project.alts.forEach((a, i) => {
    const r = L && L.routes.find((q) => q.kind === 'alt' && q.altIndex === i);
    const div = document.createElement('div');
    div.className = 'item alt-card' + (a.collapsed ? ' collapsed' : '');
    const name = r ? r.name : `atajo_${String(i + 1).padStart(2, '0')}`;
    const E = edgeParams(state.scene, { kind: 'alt', edges: a.edges || null });
    const SIDES = [['none', 'Ninguno'], ['left', 'Izquierda'], ['right', 'Derecha'], ['both', 'Ambos lados']];
    const sideSel = (k) => `<select class="ae" data-k="${k}">${SIDES.map(([v, t]) => `<option value="${v}"${E[k] === v ? ' selected' : ''}>${t}</option>`).join('')}</select>`;
    const numF = (k, label, min, max, step, unit = 'm') => `<div class="field"><label>${label} <span class="val"><input type="number" class="aen" data-k="${k}" min="${min}" step="${step}" style="width:58px" value="${E[k]}"> ${unit}</span></label><input type="range" class="aer" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${Math.min(max, E[k])}"></div>`;
    const texRow = (kind, def) => `<div class="row gap" style="flex-wrap:nowrap"><button class="atex small" data-kind="${kind}">Cargar textura…</button><button class="atexRm small" data-kind="${kind}"${app.altOwnTex(a, kind) ? '' : ' disabled'}>${def}</button><img class="thumb athumb" data-kind="${kind}" alt=""></div>`;
    div.innerHTML = `
      <div class="head"><span class="row" style="gap:4px;min-width:0"><button class="x atoggle" title="Mostrar u ocultar los parámetros del atajo">${a.collapsed ? '▸' : '▾'}</button><label class="check" style="margin:0"><input type="checkbox" class="akeep" ${a.keep !== false ? 'checked' : ''}> <strong>${name}</strong></label></span>
      <span><button class="x flip" title="Invertir sentido del atajo">⇄</button> <button class="x del" title="Eliminar ruta">✕</button></span></div>
      <div class="meta">${r ? `${r.L.toFixed(0)} m · sale en s=${r.forkS.toFixed(0)} m, vuelve en s=${r.mergeS.toFixed(0)} m` : a.keep === false ? 'Descartada (no se exporta)' : ''}</div>
      <div class="abody">
      <label class="check small" style="margin-top:4px"><input type="checkbox" class="awOn"${a.width > 0 ? ' checked' : ''}> Ancho propio</label>
      <div class="field awBox${a.width > 0 ? '' : ' disabled'}"><label>Ancho <span class="val"><input type="number" class="aw" min="2" max="80" step="0.5" style="width:60px" value="${a.width > 0 ? a.width : (state.geom.altWidthSame === false ? state.geom.altWidth : state.geom.width)}"> m</span></label><input type="range" class="awR" min="2" max="40" step="0.5" value="${Math.min(40, a.width > 0 ? a.width : (state.geom.altWidthSame === false ? state.geom.altWidth : state.geom.width))}"></div>
      <h4 class="mini atexH">Material de la pista</h4>
      ${texRow('track', 'Como la pista')}
      <h4 class="mini adirtH">Camino de tierra</h4>
      <div class="field"><label>Lado</label>${sideSel('dirtSide')}</div>
      <div class="adirtBox${E.dirtSide === 'none' ? ' disabled' : ''}">
        ${numF('dirtWidth', 'Ancho', 0.2, 15, 0.1)}
        ${numF('dirtTile', 'Repetición de la textura', 0.5, 30, 0.5)}
        ${texRow('dirt', 'Como la pista')}
      </div>
      <h4 class="mini abarH">Barrera</h4>
      <div class="field"><label>Lado</label>${sideSel('barrierSide')}</div>
      <div class="abarBox${E.barrierSide === 'none' ? ' disabled' : ''}">
        ${numF('barrierHeight', 'Altura', 0.1, 3, 0.05)}
        ${numF('barrierThick', 'Grosor (0 = plano)', 0, 1.5, 0.05)}
        ${numF('barrierTile', 'Tiling', 0.5, 20, 0.5)}
        ${texRow('barrier', 'Como la pista')}
      </div>
      </div>`;
    if (state.selAlt === i) div.classList.add('sel');
    div.dataset.alt = i;
    // miniaturas de las texturas (la propia o la heredada de la pista)
    div.querySelectorAll('img.athumb').forEach((img) => {
      const k = img.dataset.kind;
      const cv = k === 'track' ? app.altTexCanvas(a) : k === 'dirt' ? app.dirtTexCanvas(a) : app.barrierTexCanvas(a);
      img.src = thumbURL(cv);
      img.classList.toggle('inherited', !app.altOwnTex(a, k));
    });
    div.querySelector('input.akeep').addEventListener('change', (e) => { pushUndo(); a.keep = e.target.checked; scheduleBuild(); });
    div.querySelector('button.del').addEventListener('click', () => { pushUndo(); state.project.alts.splice(i, 1); if (state.selAlt === i) state.selAlt = null; else if (state.selAlt > i) state.selAlt--; scheduleBuild(); });
    div.querySelector('button.flip').addEventListener('click', () => { pushUndo(); a.flip = !a.flip; scheduleBuild(); });
    div.querySelector('button.atoggle').addEventListener('click', () => { a.collapsed = !a.collapsed; div.classList.toggle('collapsed', a.collapsed); div.querySelector('button.atoggle').textContent = a.collapsed ? '▸' : '▾'; });
    // ancho propio del atajo: casilla + número + deslizador
    let awEdit = false;
    const setW = (v, done) => {
      if (!(v > 0)) return;
      if (!awEdit) { pushUndo(); awEdit = true; }
      a.width = Math.min(80, Math.max(2, v));
      div.querySelector('input.aw').value = a.width; div.querySelector('input.awR').value = Math.min(40, a.width);
      scheduleBuild();
      if (done) awEdit = false;
    };
    div.querySelector('input.awOn').addEventListener('change', (e) => { pushUndo(); if (e.target.checked) a.width = parseFloat(div.querySelector('input.aw').value) || state.geom.width; else delete a.width; scheduleBuild(); });
    div.querySelector('input.aw').addEventListener('change', (e) => setW(parseFloat(e.target.value), true));
    div.querySelector('input.awR').addEventListener('input', (e) => setW(parseFloat(e.target.value), false));
    div.querySelector('input.awR').addEventListener('change', (e) => setW(parseFloat(e.target.value), true));
    // camino de tierra y barrera propios: al primer cambio el atajo copia los valores que tenía y deja de depender de los generales
    let aeEdit = false;
    const setE = (k, v, done) => {
      if (!aeEdit) { pushUndo(); aeEdit = true; }
      if (!a.edges) a.edges = { ...edgeParams(state.scene, { kind: 'alt', edges: null }) };
      a.edges[k] = v;
      const rr = state.layout && state.layout.routes.find((q) => q.kind === 'alt' && q.altIndex === i);
      if (rr) rr.edges = a.edges; // la ruta ya construida usa el mismo objeto
      div.querySelector('.adirtBox').classList.toggle('disabled', a.edges.dirtSide === 'none');
      div.querySelector('.abarBox').classList.toggle('disabled', a.edges.barrierSide === 'none');
      div.querySelectorAll(`[data-k="${k}"]`).forEach((el) => { if (el.tagName !== 'SELECT' && document.activeElement !== el) el.value = el.type === 'range' ? Math.min(+el.max, v) : v; });
      sceneChanged();
      if (done) aeEdit = false;
    };
    div.querySelectorAll('select.ae').forEach((el) => el.addEventListener('change', () => setE(el.dataset.k, el.value, true)));
    div.querySelectorAll('input.aer').forEach((el) => {
      el.addEventListener('input', () => setE(el.dataset.k, parseFloat(el.value), false));
      el.addEventListener('change', () => setE(el.dataset.k, parseFloat(el.value), true));
    });
    div.querySelectorAll('input.aen').forEach((el) => el.addEventListener('change', () => { const v = parseFloat(el.value); if (Number.isFinite(v) && v >= +el.min) setE(el.dataset.k, v, true); }));
    // texturas propias del atajo
    div.querySelectorAll('button.atex').forEach((btn) => btn.addEventListener('click', () => pickAltTexture(a, btn.dataset.kind)));
    div.querySelectorAll('button.atexRm').forEach((btn) => btn.addEventListener('click', () => { const t = state.altTexs[a.uid]; if (t) t[btn.dataset.kind] = null; refreshPanels(); sceneChanged(); }));
    div.addEventListener('click', (e) => { if (e.target.closest('input,button,label,select,img')) return; if (e.target.closest('.abody') && state.selAlt === i) return; selectAlt(state.selAlt === i ? null : i); });
    al.appendChild(div);
  });
  // zonas planas
  const fl = $('flatZoneList');
  fl.innerHTML = '';
  const sl = $('suspZoneList');
  if (sl && !draggingIn(sl)) {
    sl.innerHTML = '';
    const sz = app.suspZonesS();
    state.suspZones.forEach((Z, i) => {
      const c = sz.find((q) => q.idx === i);
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `<div class="head"><span><strong>suspendido_${String(i + 1).padStart(2, '0')}</strong>${c ? ` · s ${c.s0.toFixed(0)}–${c.s1.toFixed(0)} m` : ''}</span><button class="x del" title="Quitar (el terreno vuelve a adaptarse)">✕</button></div>
        <div class="field"><label>Pilares <span class="val"><input type="number" class="spN" min="0" max="200" step="1" style="width:52px" value="${Z.pillars ?? 3}"></span></label><input type="range" class="spR" min="0" max="40" step="1" value="${Math.min(40, Z.pillars ?? 3)}"></div>
        <label class="check small"><input type="checkbox" class="spDirt"${Z.dirt ? ' checked' : ''}> Camino de tierra</label>
        <label class="check small"><input type="checkbox" class="spBar"${Z.barrier ? ' checked' : ''}> Barreras</label>`;
      let editing = false;
      const upd = (patch, done = true) => {
        if (!editing) { pushUndo(); editing = true; }
        Object.assign(Z, patch);
        if (done) editing = false;
        state.scene.suspRanges = app.suspZonesS();
        preview.update(false, true); // pista, bordes y pilares
      };
      const pil = (v, done) => { v = Math.max(0, Math.min(200, Math.round(v))); div.querySelector('.spN').value = v; div.querySelector('.spR').value = Math.min(40, v); upd({ pillars: v }, done); };
      div.querySelector('.spR').addEventListener('input', (e) => pil(parseFloat(e.target.value), false));
      div.querySelector('.spR').addEventListener('change', () => { editing = false; });
      div.querySelector('.spN').addEventListener('change', (e) => pil(parseFloat(e.target.value), true));
      div.querySelector('.spDirt').addEventListener('change', (e) => upd({ dirt: e.target.checked }));
      div.querySelector('.spBar').addEventListener('change', (e) => upd({ barrier: e.target.checked }));
      div.querySelector('.del').addEventListener('click', () => { pushUndo(); state.suspZones.splice(i, 1); scheduleElev(); });
      sl.appendChild(div);
    });
  }
  const pl = $('profileZoneList');
  if (pl) {
    pl.innerHTML = '';
    const pz = app.profileZonesS();
    state.profileZones.forEach((Z, i) => {
      const c = pz.find((q) => q.idx === i);
      const zs = Z.pts.map((q) => q[1]);
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `<div class="head"><span>${Z.flat ? 'Tramo aplanado' : 'Perfil'} ${i + 1}${c ? ` · s ${c.s0.toFixed(0)}–${c.s1.toFixed(0)} m` : ''} · z ${Math.min(...zs).toFixed(1)}–${Math.max(...zs).toFixed(1)} m</span><button class="x" title="Quitar (la elevación vuelve a ser automática)">✕</button></div>`;
      div.querySelector('button').addEventListener('click', () => { pushUndo(); state.profileZones.splice(i, 1); scheduleElev(); });
      pl.appendChild(div);
    });
  }
  const fz = app.flatZonesS();
  state.flatZones.forEach((z, i) => {
    const sr = fz[i];
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `<div class="head"><span>Zona plana ${i + 1}${sr ? ` · s ${sr[0].toFixed(0)}–${sr[1].toFixed(0)} m` : ''}</span><button class="x" title="Quitar">✕</button></div>`;
    div.querySelector('button').addEventListener('click', () => { pushUndo(); state.flatZones.splice(i, 1); scheduleElev(); });
    fl.appendChild(div);
  });
  refreshCtrlBox();
  // validación
  const val = $('validation');
  val.innerHTML = '';
  const msgs = [];
  if (L) msgs.push(...L.warnings.filter((w) => !(w.overlap && E && stackedOK(L, E, w.overlap)))); // tramos apilados (helix) con altura libre: no es problema
  if (E) msgs.push(...E.validation.msgs);
  if (L && E && msgs.length === 0) msgs.push({ level: 'info', msg: 'Sin problemas: pendientes, radios verticales y holguras dentro de los límites.' });
  for (const m of msgs) {
    const d = document.createElement('div');
    d.className = `vmsg ${m.level}`;
    d.innerHTML = `<span class="tag">${m.level === 'error' ? 'ERROR' : m.level === 'warn' ? 'AVISO' : 'OK'}</span><span></span>`;
    d.lastChild.textContent = m.msg;
    if (typeof m.s === 'number' && (m.route === 0 || m.route === undefined)) d.addEventListener('mouseenter', () => app.setHover(m.s, 'val'));
    val.appendChild(d);
  }
  // estadísticas
  if (L && E) {
    const v = E.validation;
    const alts = L.routes.length - 1;
    $('stats').textContent = `vuelta ${L.routes[0].L.toFixed(0)} m · desnivel ${(v.zMax - v.zMin).toFixed(1)} m · pendiente máx ${(v.maxGrade * 100).toFixed(1)} % · R cresta ${isFinite(v.minRc) ? v.minRc.toFixed(0) : '∞'} m · ${E.crossings.length} cruces${alts ? ` · ${alts} atajo(s)` : ''} · ${E.solver.ms.toFixed(0)} ms`;
    // info de export
    try {
      const pts = routeSamples(L, E, 0);
      const kn = bezierKnots(pts, L.routes[0].closed, state.exp.knotSpacing, L.routes[0].k);
      $('exportInfo').textContent = `Ruta principal: ${kn.length} nudos Bézier, error máx ${bezierError(pts, kn, L.routes[0].closed).toFixed(3)} m respecto al trazado muestreado.`;
    } catch { /* noop */ }
  } else {
    $('stats').textContent = '';
    $('exportInfo').textContent = '';
  }
}

function refreshCtrlBox() {
  const box = $('ctrlBox');
  if (!box) return;
  const p = state.project;
  const on = hasCtrl();
  box.hidden = false;
  const n = (p.main && p.main.ctrl ? p.main.ctrl.length : 0) + p.alts.reduce((a, r) => a + (r.ctrl ? r.ctrl.length : 0), 0);
  $('ctrlInfo').textContent = on ? `${n} puntos de control editables. «Detalle» y «Suavizado del trazo» ya no se aplican a estas rutas.` : 'Elige «Editar puntos» para crear puntos de control editables.';
  for (const id of ['btnCtrlLess', 'btnCtrlMore', 'btnCtrlReset']) $(id).disabled = !on;
}

// ---------- controles ----------
const fmt = {
  m: (v) => `${(+v).toFixed(0)} m`,
  m1: (v) => `${(+v).toFixed(1)} m`,
  pct: (v) => `${(+v).toFixed(1)} %`,
  hills: (v) => `${Math.round(v * 100)} % (±${(v * state.elev.hillsMax).toFixed(1)} m)`,
  int: (v) => `${(+v).toFixed(0)}`,
  half: (v) => `${(+v).toFixed(1)}`,
  deg: (v) => `${(+v).toFixed(0)}°`,
  kmh: (v) => `${(+v).toFixed(0)} km/h`,
  smooth: (v) => `${Math.round(v * 100)} %`,
};
const PARAMS = [
  ['lapLength', 'geom', fmt.m, 'build'],
  ['width', 'geom', fmt.m1, 'build'],
  ['altWidth', 'geom', fmt.m1, 'build'],
  ['detail', 'geom', fmt.m, 'build'],
  ['sketchSmooth', 'geom', fmt.int, 'build'],
  ['hills', 'elev', fmt.hills, 'elev'],
  ['hillCount', 'elev', fmt.half, 'elev'],
  ['hillsMax', 'elev', fmt.m, 'elev'],
  ['lambdaMin', 'elev', fmt.m, 'elev'],
  ['smooth', 'elev', fmt.smooth, 'elev'],
  ['maxGrade', 'elev', fmt.pct, 'elev'],
  ['rCrest', 'elev', fmt.m, 'elev'],
  ['rSag', 'elev', fmt.m, 'elev'],
  ['startFlat', 'elev', fmt.m, 'elev'],
  ['clearance', 'elev', fmt.m1, 'elev'],
  ['deck', 'elev', fmt.m1, 'elev'],
  ['bankMax', 'elev', fmt.deg, 'elev'],
  ['designSpeed', 'elev', fmt.kmh, 'elev'],
  ['knotSpacing', 'exp', fmt.m, 'panels'],
];
function groupObj(g) { return g === 'geom' ? state.geom : g === 'elev' ? state.elev : state.exp; }
function syncControls() {
  for (const [id, g, f] of PARAMS) {
    const el = $(id);
    el.value = groupObj(g)[id];
    const lab = $(id + 'Val');
    if (lab) lab.textContent = f(groupObj(g)[id]);
  }
  $('useImageWidth').checked = state.geom.useImageWidth;
  $('altWidthSame').checked = state.geom.altWidthSame !== false;
  $('altInheritWidth').checked = !!state.geom.altInheritWidth;
  $('altFromCenter').checked = state.geom.altFromCenter !== false;
  $('altWidthBox').classList.toggle('disabled', state.geom.altWidthSame !== false);
  $('closed').checked = state.closed;
  $('reverse').checked = !!state.project.reverse;
  $('seed').value = state.elev.seed;
  $('crossType').value = state.elev.crossType;
  $('bank').checked = state.elev.bank;
  $('edges').checked = state.exp.edges;
  $('blenderMesh').checked = state.exp.blenderMesh;
  $('bankFlip').checked = state.exp.bankSign < 0;
  $('thrAuto').checked = state.trace.threshold === null;
  $('thr').disabled = state.trace.threshold === null;
  if (state.trace.threshold !== null) $('thr').value = state.trace.threshold;
  $('thrVal').textContent = state.trace.threshold === null ? 'auto' : state.trace.threshold;
  $('invert').value = String(state.trace.invert);
  $('imgOpacity').value = Math.round(state.imageOpacity * 100);
  $('imgOpVal').textContent = `${Math.round(state.imageOpacity * 100)}%`;
}
function bindControls() {
  for (const [id, g, f, what] of PARAMS) {
    const el = $(id);
    el.addEventListener('input', () => {
      if (id === 'lapLength' && state.layout && state.layout.scaleLocked && state.project.main && state.project.main.scale) {
        // escala fija por edición: el control reescala la pista completa
        state.project.main.scale *= parseFloat(el.value) / state.layout.routes[0].L;
      }
      groupObj(g)[id] = parseFloat(el.value);
      $(id + 'Val').textContent = f(el.value);
      if (id === 'hillsMax') $('hillsVal').textContent = fmt.hills(state.elev.hills);
      if (what === 'build') scheduleBuild();
      else if (what === 'elev') scheduleElev();
      else refreshPanels();
    });
  }
  $('useImageWidth').addEventListener('change', (e) => { state.geom.useImageWidth = e.target.checked; scheduleBuild(); });
  $('altWidthSame').addEventListener('change', (e) => { state.geom.altWidthSame = e.target.checked; syncControls(); scheduleBuild(); });
  $('altInheritWidth').addEventListener('change', (e) => { state.geom.altInheritWidth = e.target.checked; scheduleBuild(); });
  $('altFromCenter').addEventListener('change', (e) => { state.geom.altFromCenter = e.target.checked; scheduleBuild(); });
  // bifurcar: nueva ruta alternativa entre el primer y el último punto seleccionado
  $('forkSep').addEventListener('input', () => { $('forkSepVal').textContent = `${$('forkSep').value} m`; });
  $('forkSepVal').textContent = `${$('forkSep').value} m`;
  // botones de la barra: radio fijo y bifurcar con los valores del panel «Puntos seleccionados»
  $('btnTbRadius').addEventListener('click', () => {
    focusPanel('arc');
    const sel = state.selSet, run = sel ? contiguousRun(sel.key) : null;
    if (!run || run.length < 3) { toast('Para una curva de radio fijo selecciona 3 o más puntos seguidos con Shift+arrastrar.'); return; }
    onRadius($('arcRadiusNum').value);
  });
  $('openOnDelete').addEventListener('change', (e) => { state.openOnDelete = e.target.checked; });
  const bwPair = (v) => { if (!(v > 0)) return; $('bridgeWidthNum').value = v; $('bridgeWidth').value = Math.min(40, v); };
  $('bridgeWidth').addEventListener('input', () => bwPair(parseFloat($('bridgeWidth').value)));
  $('bridgeWidthNum').addEventListener('change', () => bwPair(parseFloat($('bridgeWidthNum').value)));
  $('btnBridge').addEventListener('click', () => createBridge(parseFloat($('bridgeWidthNum').value)));
  $('btnTbBridge').addEventListener('click', () => {
    focusPanel('arc', $('bridgeControls'));
    if (!openEndsSelected()) { toast('Para un puente: abre el circuito (borra un punto con «Abrir» activado) y selecciona los dos extremos con Shift.'); return; }
    createBridge(parseFloat($('bridgeWidthNum').value) || state.geom.width);
  });
  // helix: igual que el rizo (botón de la barra con sus parámetros)
  $('btnHelix').addEventListener('click', () => {
    const box = $('helixBox');
    box.hidden = !box.hidden;
    $('btnHelix').classList.toggle('active', !box.hidden);
    if (!box.hidden) { $('loopBox').hidden = true; $('btnLoop').classList.remove('active'); if (state.tool !== 'edit') setTool('edit'); }
    refreshHelixInfo();
  });
  const helixSync = () => {
    const r = parseFloat($('helixRadius').value) || 30;
    $('helixRadiusR').value = Math.min(+$('helixRadiusR').max, r);
    $('helixRBox').classList.toggle('disabled', !$('helixDiff').checked);
    if (!$('helixDiff').checked) { $('helixR0').value = r; $('helixR1').value = r; }
    $('helixPitchVal').textContent = `${$('helixPitch').value} m`;
    refreshHelixInfo();
  };
  $('helixRadiusR').addEventListener('input', (e) => { $('helixRadius').value = e.target.value; helixSync(); });
  for (const id of ['helixRadius', 'helixTurns', 'helixDiff', 'helixR0', 'helixR1', 'helixPitch', 'helixDir', 'helixSide']) $(id).addEventListener('input', helixSync);
  $('helixDiff').addEventListener('change', helixSync);
  $('btnHelixAdd').addEventListener('click', () => { if (addHelix(...helixInputs())) refreshHelixInfo(); });
  helixSync();
  app.refreshHelixInfo = refreshHelixInfo;
  // aplanar (en la barra del perfil): una sola vez, los puntos siguen editables
  $('btnFlatten').addEventListener('click', () => { app.flattenSelected(); });
  // rizo: el botón de la barra muestra sus parámetros; «Añadir rizo» lo crea en los puntos seleccionados
  $('btnLoop').addEventListener('click', () => {
    const box = $('loopBox');
    box.hidden = !box.hidden;
    $('btnLoop').classList.toggle('active', !box.hidden);
    if (!box.hidden) { $('helixBox').hidden = true; $('btnHelix').classList.remove('active'); if (state.tool !== 'edit') setTool('edit'); }
    refreshLoopInfo();
  });
  // radio: barra deslizable (0 = automático) y número (acepta más que la barra), sincronizados
  // tope de la barra del radio: lo fija el usuario (se recuerda en este navegador)
  const setLoopMax = (m, save = true) => {
    m = Math.max(5, Math.min(5000, Math.round(m) || 150));
    $('loopRadiusMax').value = m;
    $('loopRadiusR').max = m; $('loopRadius').max = m;
    const cur = parseFloat($('loopRadius').value) || 0;
    if (cur > m) { $('loopRadius').value = m; }
    $('loopRadiusR').value = Math.min(m, cur);
    if (save) { try { localStorage.setItem('tsg.loopRadiusMax', String(m)); } catch { /* sin almacenamiento */ } }
    refreshLoopInfo();
  };
  { let m0 = 150; try { m0 = parseFloat(localStorage.getItem('tsg.loopRadiusMax')) || 150; } catch { /* sin almacenamiento */ } setLoopMax(m0, false); }
  $('loopRadiusMax').addEventListener('change', (e) => setLoopMax(parseFloat(e.target.value)));
  $('loopRadiusR').addEventListener('input', (e) => { const v = parseFloat(e.target.value) || 0; $('loopRadius').value = v > 0 ? v : ''; refreshLoopInfo(); });
  $('loopRadius').addEventListener('input', (e) => { const m = parseFloat($('loopRadiusMax').value) || 150; let v = parseFloat(e.target.value) || 0; if (v > m) { v = m; e.target.value = m; } $('loopRadiusR').value = Math.max(0, v); });
  for (const id of ['loopTurns', 'loopSep', 'loopSide', 'loopRadius']) $(id).addEventListener('input', () => { $('loopSepVal').textContent = `${$('loopSep').value} m`; refreshLoopInfo(); });
  $('btnLoopAdd').addEventListener('click', () => { if (addLoop(parseFloat($('loopTurns').value), parseFloat($('loopSep').value), $('loopSide').value, parseFloat($('loopRadius').value) || 0)) refreshLoopInfo(); });
  $('loopSepVal').textContent = `${$('loopSep').value} m`;
  app.refreshLoopInfo = refreshLoopInfo;
  $('btnTbFork').addEventListener('click', () => {
    focusPanel('arc');
    const sel = state.selSet;
    if (!sel || sel.key !== 'main' || sel.idxs.size < 2) { toast('Para bifurcar selecciona 2 o más puntos de la ruta principal con Shift: sale en el primero y vuelve en el último.'); return; }
    forkSelection({ right: -1, left: 1, center: 0 }[$('forkSide').value], parseFloat($('forkSep').value));
  });
  $('btnFork').addEventListener('click', () => forkSelection({ right: -1, left: 1, center: 0 }[$('forkSide').value], parseFloat($('forkSep').value)));
  $('closed').addEventListener('change', (e) => {
    state.closed = e.target.checked;
    if (state.project.main) { pushUndo(); state.project.main.closed = state.closed; }
    scheduleBuild();
  });
  $('reverse').addEventListener('change', (e) => { pushUndo(); state.project.reverse = e.target.checked; state.overrides = []; scheduleBuild(); });
  $('seed').addEventListener('change', (e) => { state.elev.seed = parseInt(e.target.value, 10) || 0; scheduleElev(); });
  $('btnDice').addEventListener('click', () => { state.elev.seed = Math.floor(Math.random() * 99999); $('seed').value = state.elev.seed; scheduleElev(); });
  $('crossType').addEventListener('change', (e) => { state.elev.crossType = e.target.value; scheduleElev(); });
  $('bank').addEventListener('change', (e) => { state.elev.bank = e.target.checked; scheduleElev(); });
  $('edges').addEventListener('change', (e) => { state.exp.edges = e.target.checked; });
  $('blenderMesh').addEventListener('change', (e) => { state.exp.blenderMesh = e.target.checked; });
  $('bankFlip').addEventListener('change', (e) => { state.exp.bankSign = e.target.checked ? -1 : 1; });
  $('thrAuto').addEventListener('change', (e) => {
    state.trace.threshold = e.target.checked ? null : parseInt($('thr').value, 10);
    syncControls();
  });
  $('thr').addEventListener('input', (e) => { state.trace.threshold = parseInt(e.target.value, 10); $('thrVal').textContent = e.target.value; });
  $('invert').addEventListener('change', (e) => { const v = e.target.value; state.trace.invert = v === 'true' ? true : v === 'false' ? false : v; });
  $('imgOpacity').addEventListener('input', (e) => { state.imageOpacity = e.target.value / 100; $('imgOpVal').textContent = `${e.target.value}%`; editor.draw(); });
  $('drawSmooth').addEventListener('input', (e) => { state.drawSmooth = parseFloat(e.target.value); $('drawSmoothVal').textContent = e.target.value; editor.draw(); });
  $('showRaw').addEventListener('change', (e) => { state.showRaw = e.target.checked; editor.draw(); });
  $('zExag').addEventListener('input', (e) => { preview.zExag = parseFloat(e.target.value); preview.update(false, true); });
  $('btnView3dReset').addEventListener('click', () => preview.fit());
  $('btnFit').addEventListener('click', () => editor.fit());

  // herramientas
  document.querySelectorAll('#toolbar [data-tool], .viewProfile [data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool === state.tool && b.dataset.tool === 'profile' ? 'pan' : b.dataset.tool)));

  // ejemplos
  const sel = $('sampleSelect');
  for (const [k, s] of Object.entries(SAMPLES)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = s.name;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => { if (sel.value) loadSample(sel.value); sel.value = ''; });
  $('btnNew').addEventListener('click', () => {
    pushUndo();
    state.project = { main: null, alts: [], start: null, reverse: false };
    state.flatZones = []; state.profileZones = []; state.profileSel = null; state.suspZones = []; state.overrides = []; state.image = null;
    syncControls(); scheduleBuild(); setTool('draw');
    setTimeout(() => editor.fit(), 0);
  });
  document.querySelectorAll('#gizmoBox [data-gizmo]').forEach((b) => b.addEventListener('click', () => {
    preview.setGizmoMode(b.dataset.gizmo);
    document.querySelectorAll('#gizmoBox [data-gizmo]').forEach((q) => q.classList.toggle('active', q === b));
  }));
  // alturas: solo este punto
  for (const id of ['pinLocal', 'pinLocal3d']) {
    $(id).addEventListener('change', (e) => { state.pinLocal = e.target.checked; $('pinLocal').checked = $('pinLocal3d').checked = state.pinLocal; });
  }
  // curva de radio fijo
  const onRadius = (v) => {
    const R = Math.max(1, parseFloat(v) || 0);
    $('arcRadius').value = Math.min(400, Math.max(5, R));
    $('arcRadiusNum').value = Math.round(R * 10) / 10;
    applyArc(R);
  };
  $('arcRadius').addEventListener('input', (e) => onRadius(e.target.value));
  $('arcRadiusNum').addEventListener('change', (e) => onRadius(e.target.value));
  $('arcTrans').addEventListener('input', (e) => { $('arcTransVal').textContent = e.target.value; if (state.arc) applyArc(parseFloat($('arcRadiusNum').value)); });
  $('btnArcApply').addEventListener('click', () => onRadius($('arcRadiusNum').value));
  $('btnArcDone').addEventListener('click', () => app.clearMultiSel());
  // imagen de referencia
  $('btnRefLoad').addEventListener('click', () => $('fileRef').click());
  $('fileRef').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadRefBlob(f); });
  $('refOpacity').addEventListener('input', (e) => { if (!state.ref) return; state.ref.opacity = e.target.value / 100; $('refOpacityVal').textContent = `${e.target.value}%`; editor.draw(); });
  $('refScale').addEventListener('change', (e) => { if (!state.ref) return; pushUndoRef(); app.refScaleTo(parseFloat(e.target.value) / 100); });
  $('refVisible').addEventListener('change', (e) => { if (!state.ref) return; state.ref.visible = e.target.checked; editor.draw(); });
  $('refAbove').addEventListener('change', (e) => { if (!state.ref) return; state.ref.above = e.target.checked; editor.draw(); });
  $('btnRefRemove').addEventListener('click', () => { pushUndoRef(); state.ref = null; syncRefControls(); if (state.tool === 'ref') setTool('pan'); editor.draw(); });
  $('btnCtrlLess').addEventListener('click', () => respaceAll(1.5));
  $('btnCtrlMore').addEventListener('click', () => respaceAll(1 / 1.5));
  $('btnCtrlReset').addEventListener('click', resetCtrl);
  // Esc = botón «Navegar» y quita cualquier selección (en la cámara de juego, Esc sale del juego)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || (preview.game && preview.game.active)) return;
    const t = e.target || {};
    if ((t.tagName === 'INPUT' && ['text', 'number', 'search'].includes(t.type)) || t.tagName === 'TEXTAREA') { t.blur(); return; }
    clearAllSelections();
    const nav = document.querySelector('button[data-tool="pan"]');
    if (nav) nav.click(); else setTool('pan');
  });
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    // Supr borra lo que esté seleccionado: puntos (uno o varios), atajo, elemento de pista o cerro
    if (state.tool === 'edit' && state.selSet && state.selSet.idxs.size) {
      e.preventDefault();
      app.deleteCtrlMany(state.selSet.key, [...state.selSet.idxs]);
    } else if (state.tool === 'edit' && state.sel) {
      e.preventDefault();
      app.deleteCtrl(state.sel.key, state.sel.idx);
    } else if (state.selAlt != null) {
      e.preventDefault();
      const i = state.selAlt;
      pushUndo();
      state.project.alts.splice(i, 1);
      state.selAlt = null;
      scheduleBuild();
      toast('Ruta alternativa borrada (Ctrl+Z para deshacer).');
    } else if (state.selBridge != null && state.project.main.bridges && state.project.main.bridges[state.selBridge]) {
      e.preventDefault();
      pushUndo();
      state.project.main.bridges.splice(state.selBridge, 1);
      state.selBridge = null;
      scheduleBuild();
      toast('Puente quitado: el tramo vuelve al ancho de la pista (Ctrl+Z para deshacer).');
    } else if (state.selItem) {
      e.preventDefault();
      const g = itemGroup(state.selItem);
      if (!g) return;
      pushUndo();
      g.removed = [...new Set([...(g.removed || []), state.selItem.idx])];
      if (g.moves) delete g.moves[state.selItem.idx];
      const nm = itemName(g.type, g.gid, state.selItem.idx);
      state.selItem = null;
      renderItemsPanel(); itemsChanged(); preview.updateHandles();
      toast(`${nm} borrado («Restablecer» en su grupo lo recupera).`);
    } else if (state.selHill != null) {
      e.preventDefault();
      deleteSelectedHill();
    }
  });
  $('btnUndo').addEventListener('click', undo);
  $('btnUndo').disabled = true;
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  });

  // imagen
  $('btnLoadImage').addEventListener('click', () => $('fileImage').click());
  $('fileImage').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) loadImageBlob(file);
  });
  // Pegar una imagen con Ctrl+V / Cmd+V (captura de pantalla, imagen copiada del navegador, etc.)
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData ? [...e.clipboardData.items] : [];
    const item = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (!item) {
      // sin imagen: dejar que el texto se pegue normalmente en campos de texto
      const tag = (e.target && e.target.tagName) || '';
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') toast('El portapapeles no tiene una imagen. Copia el minimapa (clic derecho → Copiar imagen, o una captura) y vuelve a pegar.');
      return;
    }
    e.preventDefault();
    const file = item.getAsFile();
    if (!file) return;
    if (state.tool === 'ref') loadRefBlob(file);
    else loadImageBlob(file, 'pegada');
  });
  $('btnTestImage').addEventListener('click', () => {
    const keys = Object.keys(SAMPLES);
    const k = state.lastSample || keys[Math.floor(Math.random() * keys.length)];
    const cv = rasterizeLayout(SAMPLES[k].build(), 800, 600, 26);
    setImage(cv);
    runTrace();
  });
  $('btnTrace').addEventListener('click', runTrace);

  // proyecto
  $('btnSave').addEventListener('click', saveProject);
  $('btnOpen').addEventListener('click', () => $('fileProject').click());
  $('fileProject').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) showOpenDialog(files);
  });

  // exportación
  const needOut = () => state.layout && state.result;
  $('btnExportBlender').addEventListener('click', () => needOut() && download('track_spline_blender.py', exportBlender(state.layout, state.result, state.exp), 'text/x-python'));
  $('btnExportMax').addEventListener('click', () => needOut() && download('track_spline_3dsmax.ms', exportMax(state.layout, state.result, state.exp), 'text/plain'));
  $('btnExportJSON').addEventListener('click', () => needOut() && download('track_spline.json', exportJSON(state.layout, state.result, state.project, { geom: state.geom, elev: state.elev }), 'application/json'));
  $('btnExportOBJ').addEventListener('click', () => needOut() && download('track_spline.obj', exportOBJ(state.layout, state.result, state.exp), 'text/plain'));
}

function setTool(t) {
  state.tool = t;
  if (t === 'sculpt' && state.scene && !state.scene.terrain) { state.scene.terrain = true; if (typeof syncSceneControls === 'function') { syncSceneControls(); sceneChanged(); } } // esculpir necesita el terreno
  const p = state.project;
  const needs = p.main && (!p.main.ctrl || p.alts.some((a) => !a.ctrl));
  if (t === 'edit' && state.layout && needs) { pushUndo(); ensureCtrl(); scheduleBuild(); }
  if (t !== 'edit') { state.sel = null; state.selSet = null; endArc(); }
  refreshArcBox();
  refreshCtrlBox();
  if (typeof editor !== 'undefined') { editor.draw(); profile.draw(); preview.updateHandles(); }
  const pb = document.getElementById('paintBox');
  if (pb) pb.hidden = !PAINT_TOOLS.includes(t);
  const eraseLbl = document.getElementById('paintEraseLbl');
  if (eraseLbl) eraseLbl.hidden = t === 'sculpt';
  const subLbl = document.getElementById('paintSubdivLbl');
  if (subLbl) subLbl.hidden = t !== 'paint';
  const sb = document.getElementById('sculptBox');
  if (sb) sb.hidden = t !== 'sculpt';
  if (t !== 'itemPaint' && state.itemPaintTarget) { const wasDeco = state.itemPaintTarget.type === 'deco'; state.itemPaintTarget = null; if (typeof renderItemsPanel === 'function') renderItemsPanel(); if (wasDeco && typeof renderDecoPanel === 'function') renderDecoPanel(); }
  const hb = document.getElementById('hillBox');
  if (hb) hb.hidden = t !== 'hill';
  const rb = document.getElementById('riverBox');
  if (rb) rb.hidden = t !== 'river';
  const phb = document.getElementById('paintHillHint');
  if (phb) { const h = t === 'paint' && state.selHill != null ? state.hills.find((q) => q.id === state.selHill) : null; phb.hidden = !h; if (h) phb.textContent = `subdivides ${h.name || hillName(h.id)} · Esc = terreno`; }
  if (typeof syncSceneControls === 'function' && PAINT_TOOLS.includes(t)) syncSceneControls();
  if (typeof preview !== 'undefined' && preview.setPaintMode) preview.setPaintMode(PAINT_TOOLS.includes(t) ? t : null);
  if (typeof preview !== 'undefined' && preview.updateHillGizmo) preview.updateHillGizmo();
  const ds = document.getElementById('drawSmoothBox');
  if (ds) ds.hidden = !(t === 'draw' || t === 'alt' || t === 'extend');
  const gb = document.getElementById('gizmoBox');
  if (gb) gb.hidden = t !== 'edit';
  const eb = document.getElementById('editBox');
  if (eb) eb.hidden = t !== 'edit';
  if (t === 'pan') document.querySelectorAll('.panel.focus-ring').forEach((p) => p.classList.remove('focus-ring')); // Navegar / Esc quitan el resaltado
  // al editar puntos, la barra lateral muestra «Puntos seleccionados»
  if (t === 'edit') { try { focusPanel('arc'); } catch { /* aún iniciando */ } }
  document.querySelectorAll('#toolbar [data-tool], .viewProfile [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
}

async function loadImageBlob(blob, origin = 'cargada') {
  try {
    const bmp = await createImageBitmap(blob);
    const cv = document.createElement('canvas');
    cv.width = bmp.width; cv.height = bmp.height;
    cv.getContext('2d').drawImage(bmp, 0, 0);
    setImage(cv);
    toast(`Imagen ${origin} (${bmp.width}×${bmp.height} px). Trazando…`);
    runTrace();
  } catch (err) {
    toast('No se pudo leer la imagen: ' + err.message);
  }
}

function setImage(cv) {
  state.image = { canvas: cv, w: cv.width, h: cv.height };
  pushUndo();
  state.project = { main: null, alts: [], start: null, reverse: false };
  state.flatZones = []; state.profileZones = []; state.profileSel = null; state.suspZones = []; state.overrides = [];
  refreshPanels();
  setTimeout(() => editor.fit(), 0);
  scheduleBuild();
}

let worker = null, traceId = 0;
function runTrace() {
  if (!state.image) return;
  if (!worker) worker = new Worker(new URL('./trace-worker.js', import.meta.url), { type: 'module' });
  const { canvas } = state.image;
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const id = ++traceId;
  $('busy').hidden = false;
  worker.onmessage = (e) => {
    if (e.data.id !== id) return;
    $('busy').hidden = true;
    if (!e.data.ok) { toast('No se pudo trazar: ' + e.data.error.split('\n')[0]); return; }
    if (!e.data.main) { toast('No se encontró un trazado en la imagen. Ajusta el umbral o el tipo de pista.'); return; }
    pushUndo();
    state.project = { main: e.data.main, alts: e.data.alts, start: null, reverse: false };
    state.closed = e.data.main.closed;
    state.overrides = []; state.flatZones = []; state.profileZones = []; state.profileSel = null; state.suspZones = [];
    const inf = e.data.info;
    $('traceInfo').textContent = `Trazado en ${inf.ms} ms · modo: ${inf.modeName} · ${inf.crossNodes} cruce(s) y ${inf.forkNodes} bifurcación(es) en el esqueleto · ${e.data.alts.length} ruta(s) alternativa(s) · ${e.data.main.closed ? 'circuito cerrado' : 'ruta abierta'}.`;
    state.imageOpacity = Math.min(state.imageOpacity, 0.35);
    syncControls();
    scheduleBuild();
  };
  worker.postMessage({ id, image: { width: data.width, height: data.height, data: data.data }, opts: state.trace });
}

function loadSample(k) {
  const s = SAMPLES[k];
  pushUndo();
  state.lastSample = k;
  state.project = { ...s.build(), start: null, reverse: false };
  state.closed = true;
  state.geom.lapLength = s.lap || 1000;
  state.flatZones = []; state.profileZones = []; state.profileSel = null; state.suspZones = []; state.overrides = []; state.image = null;
  syncControls();
  scheduleBuild();
  preview.fitted = false;
  setTimeout(() => editor.fit(), 0);
}

function saveProject() {
  let thumbnail = null;
  try { thumbnail = makeTrackThumbnail(state.layout, state.result, app.hillsWorld()); } catch (err) { console.warn('miniatura', err); }
  const data = {
    format: 'track-spline-generator', version: 1,
    thumbnail, // miniatura en planta (JPEG), va primero para leerla rápido al abrir
    savedAt: new Date().toISOString(),
    stats: state.layout ? { length: Math.round(state.layout.routes[0].L), routes: state.layout.routes.length, crossings: state.result ? state.result.crossings.length : 0, hills: state.hills.length } : null,
    project: state.project, geom: state.geom, closed: state.closed,
    elev: { ...state.elev, flatZones: undefined, profileZones: undefined }, exp: state.exp, trace: state.trace,
    overrides: state.overrides, flatZones: state.flatZones, profileZones: state.profileZones, suspZones: state.suspZones,
    image: state.image ? state.image.canvas.toDataURL('image/png') : null,
    scene: state.scene,
    densityPaint: state.densityPaint,
    terrainSculpt: state.terrainSculpt,
    decoSets: state.decoSets,
    assets: (() => { let tot = 0; return state.assets.map((a) => { tot += a.buffer.byteLength; return { id: a.id, name: a.name, data: tot <= 60 * 1048576 ? bufToB64(a.buffer) : null }; }); })(),
    ref3d: state.ref3d ? { name: state.ref3d.name, settings: ref3dSettings(), data: state.ref3d.buffer.byteLength <= 40 * 1048576 ? bufToB64(state.ref3d.buffer) : null } : null,
    hills: state.hills,
    rivers: state.rivers,
    items: state.items,
    game: state.game,
    sky: state.skyCustom && state.skyTex ? state.skyTex.toDataURL('image/jpeg', 0.9) : null,
    trackTex: state.trackTex ? state.trackTex.toDataURL('image/png') : null,
    bridgeTex: state.bridgeTex ? state.bridgeTex.toDataURL('image/png') : null,
    barrierTex: state.barrierTex ? state.barrierTex.toDataURL('image/png') : null,
    altTexs: Object.fromEntries(Object.entries(state.altTexs).filter(([uid]) => state.project.alts.some((a) => a.uid === uid)).map(([uid, t]) => [uid, Object.fromEntries(Object.entries(t).map(([k, cv]) => [k, cv ? cv.toDataURL('image/png') : null]))])),
    coveredTex: state.coveredTex ? state.coveredTex.toDataURL('image/png') : null,
    dirtTex: state.dirtTex ? state.dirtTex.toDataURL('image/png') : null,
    riverWallTex: state.riverWallTex ? state.riverWallTex.toDataURL('image/png') : null,
    suspTex: state.suspTex ? state.suspTex.toDataURL('image/png') : null,
    suspBarrierTex: state.suspBarrierTex ? state.suspBarrierTex.toDataURL('image/png') : null,
    suspDirtTex: state.suspDirtTex ? state.suspDirtTex.toDataURL('image/png') : null,
    fallWallTex: state.fallWallTex ? state.fallWallTex.toDataURL('image/png') : null,
    terrainTex: state.terrainTex ? state.terrainTex.toDataURL('image/png') : null,
    grassTex: state.grassTex ? state.grassTex.toDataURL('image/png') : null,
    itemTex: Object.fromEntries(Object.entries(state.itemTex).map(([k, v]) => [k, v ? v.toDataURL('image/png') : null])),
    ref: state.ref ? { image: state.ref.canvas.toDataURL('image/png'), x: state.ref.x, y: state.ref.y, scale: state.ref.scale, opacity: state.ref.opacity, visible: state.ref.visible, above: !!state.ref.above } : null,
    imageOpacity: state.imageOpacity,
  };
  download('pista.tsg.json', JSON.stringify(data), 'application/json');
}

/** Miniatura de respaldo para proyectos guardados sin ella: dibuja los puntos de la ruta principal y los atajos. */
function fallbackThumb(d) {
  const P = d && d.project;
  if (!P || !P.main) return null;
  const lines = [P.main.ctrl && P.main.ctrl.length >= 2 ? P.main.ctrl : P.main.pts, ...(P.alts || []).map((a) => a.ctrl || a.pts)].filter((a) => a && a.length >= 2);
  if (!lines.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of lines) for (const q of l) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
  const W = 360, H = 240, pad = 20, k = Math.min((W - 2 * pad) / Math.max(1e-6, x1 - x0), (H - 2 * pad) / Math.max(1e-6, y1 - y0));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#12151c'; g.fillRect(0, 0, W, H);
  g.lineJoin = 'round'; g.lineCap = 'round';
  lines.forEach((l, i) => {
    g.strokeStyle = i ? '#4fb3ff' : '#dde3ee'; g.lineWidth = i ? 3 : 5;
    g.beginPath();
    l.forEach((q, j) => { const x = W / 2 + (q[0] - (x0 + x1) / 2) * k, y = H / 2 + (q[1] - (y0 + y1) / 2) * k; j ? g.lineTo(x, y) : g.moveTo(x, y); });
    if (i === 0 && P.main.closed !== false) g.closePath();
    g.stroke();
  });
  return cv.toDataURL('image/jpeg', 0.8);
}

/** Diálogo «Abrir»: miniaturas de los proyectos elegidos (o de una carpeta) para escoger cuál abrir. */
async function showOpenDialog(files, dirName = null) {
  document.querySelector('.open-dialog-back')?.remove();
  const back = document.createElement('div');
  back.className = 'open-dialog-back';
  back.innerHTML = `<div class="open-dialog" role="dialog" aria-label="Abrir proyecto">
      <div class="od-head"><strong>Abrir proyecto</strong><span class="od-sub"></span><span class="grow"></span>
        <button class="od-more" title="Elegir otros archivos .tsg.json (puedes seleccionar varios)">Elegir archivos…</button>
        ${window.showDirectoryPicker ? '<button class="od-dir" title="Ver las miniaturas de todos los proyectos .json de una carpeta">Abrir carpeta…</button>' : ''}
        <button class="od-close" title="Cerrar (Esc)">✕</button></div>
      <div class="od-grid"></div>
      <div class="od-foot"><span class="od-info">Cargando…</span><span class="grow"></span><button class="od-cancel">Cancelar</button><button class="od-ok primary" disabled>Abrir</button></div>
    </div>`;
  document.body.appendChild(back);
  const grid = back.querySelector('.od-grid');
  back.querySelector('.od-sub').textContent = dirName ? `carpeta «${dirName}»` : '';
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && chosen) { e.preventDefault(); e.stopPropagation(); go(); }
  };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  back.querySelector('.od-close').addEventListener('click', close);
  back.querySelector('.od-cancel').addEventListener('click', close);
  back.querySelector('.od-more').addEventListener('click', () => { close(); $('fileProject').click(); });
  back.querySelector('.od-dir')?.addEventListener('click', async () => {
    try {
      const dh = await window.showDirectoryPicker({ id: 'tsg-projects' });
      const list = [];
      for await (const [name, h] of dh.entries()) if (h.kind === 'file' && /\.json$/i.test(name)) list.push(await h.getFile());
      close();
      if (!list.length) { toast('No hay archivos .json en esa carpeta.'); return; }
      showOpenDialog(list, dh.name);
    } catch (err) { if (err.name !== 'AbortError') toast('No se pudo leer la carpeta: ' + err.message); }
  });
  let chosen = null;
  const entries = [];
  const pick = (en) => {
    chosen = en;
    grid.querySelectorAll('.od-card').forEach((c) => c.classList.toggle('sel', c === en.el));
    back.querySelector('.od-ok').disabled = !en.data;
  };
  const go = () => { if (!chosen || !chosen.data) return; close(); openProject(chosen.data); };
  back.querySelector('.od-ok').addEventListener('click', go);
  files.sort((a, b) => b.lastModified - a.lastModified);
  for (const f of files) {
    const el = document.createElement('div');
    el.className = 'od-card';
    el.innerHTML = `<div class="od-img"><span>…</span></div><div class="od-name"></div><div class="od-meta"></div>`;
    el.querySelector('.od-name').textContent = f.name.replace(/\.tsg\.json$|\.json$/i, '');
    el.title = f.name;
    grid.appendChild(el);
    const en = { f, el, data: null };
    entries.push(en);
    el.addEventListener('click', () => pick(en));
    el.addEventListener('dblclick', () => { pick(en); go(); });
  }
  let ok = 0;
  for (const en of entries) {
    try {
      const d = JSON.parse(await en.f.text());
      const valid = d && (d.format === 'track-spline-generator' || (d.project && d.project.main));
      if (!valid) throw new Error('no es un proyecto');
      en.data = d;
      ok++;
      const src = d.thumbnail || fallbackThumb(d);
      const box = en.el.querySelector('.od-img');
      box.innerHTML = src ? `<img alt="" src="${src}">` : '<span>sin miniatura</span>';
      if (!d.thumbnail && src) box.insertAdjacentHTML('beforeend', '<em title="Guardado con una versión anterior: se muestran solo los puntos">puntos</em>');
      const st = d.stats;
      const date = new Date(d.savedAt || en.f.lastModified);
      en.el.querySelector('.od-meta').textContent = [st ? `${st.length} m` : '', st && st.crossings ? `${st.crossings} cruce${st.crossings === 1 ? '' : 's'}` : '', st && st.hills ? `${st.hills} cerro${st.hills === 1 ? '' : 's'}` : '', date.toLocaleDateString('es') + ' ' + date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })].filter(Boolean).join(' · ');
    } catch (err) {
      en.el.classList.add('bad');
      en.el.querySelector('.od-img').innerHTML = '<span>no válido</span>';
      en.el.querySelector('.od-meta').textContent = err.message;
    }
    if (!chosen && en.data) pick(en);
  }
  back.querySelector('.od-info').textContent = `${ok} proyecto${ok === 1 ? '' : 's'}${entries.length > ok ? ` · ${entries.length - ok} no válido${entries.length - ok === 1 ? '' : 's'}` : ''} · doble clic o Enter para abrir`;
}

async function openProject(text) {
  let d;
  if (typeof text === 'object' && text) d = text;
  else try { d = JSON.parse(text); } catch { toast('Archivo no válido.'); return; }
  if (d.format !== 'track-spline-generator') {
    // también acepta un JSON exportado (trae "project")
    if (d.project && d.project.main) d = { project: d.project, geom: d.params?.geom, elev: d.params?.elev };
    else { toast('No es un proyecto de Track Spline Generator.'); return; }
  }
  pushUndo();
  state.project = d.project;
  if (d.geom) Object.assign(state.geom, d.geom);
  if (d.elev) Object.assign(state.elev, d.elev, { flatZones: [], profileZones: [] });
  if (d.exp) Object.assign(state.exp, d.exp);
  if (d.trace) Object.assign(state.trace, d.trace);
  state.closed = d.closed ?? (d.project.main ? d.project.main.closed !== false : true);
  state.overrides = d.overrides || [];
  state.flatZones = d.flatZones || [];
  state.profileZones = d.profileZones || []; state.profileSel = null;
  state.suspZones = d.suspZones || [];
  state.imageOpacity = d.imageOpacity ?? 0.35;
  state.image = null;
  if (d.image) {
    const img = new Image();
    img.src = d.image;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    cv.getContext('2d').drawImage(img, 0, 0);
    state.image = { canvas: cv, w: cv.width, h: cv.height };
  }
  state.scene.tunnelOverrides = []; // los ajustes por túnel son de cada proyecto
  state.scene.treeAssets = []; state.scene.grassAssets = [];
  if (d.scene) Object.assign(state.scene, d.scene);
  const toCanvas = async (url) => {
    if (!url) return null;
    const img = new Image();
    img.src = url;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    cv.getContext('2d').drawImage(img, 0, 0);
    return cv;
  };
  state.trackTex = await toCanvas(d.trackTex);
  state.bridgeTex = await toCanvas(d.bridgeTex);
  state.barrierTex = await toCanvas(d.barrierTex);
  state.coveredTex = await toCanvas(d.coveredTex);
  state.altTexs = {};
  for (const [uid, t] of Object.entries(d.altTexs || {})) state.altTexs[uid] = { track: await toCanvas(t.track), barrier: await toCanvas(t.barrier), dirt: await toCanvas(t.dirt) };
  // proyectos antiguos: una textura y unos bordes generales para todos los atajos → pasan a cada atajo
  {
    const legacy = { track: await toCanvas(d.altTex), barrier: await toCanvas(d.altBarrierTex), dirt: await toCanvas(d.altDirtTex) };
    const sc = state.scene;
    const keys = ['dirtSide', 'dirtWidth', 'dirtTile', 'barrierSide', 'barrierHeight', 'barrierThick', 'barrierTile'];
    const gk = (k) => 'alt' + k[0].toUpperCase() + k.slice(1);
    const hadEdges = (sc.altDirtSide && sc.altDirtSide !== 'none') || (sc.altBarrierSide && sc.altBarrierSide !== 'none');
    state.project.alts.forEach((a, i) => {
      if (!a.uid) a.uid = `al${Date.now().toString(36)}${i}${Math.floor(Math.random() * 1e4).toString(36)}`;
      if (hadEdges && !a.edges) a.edges = Object.fromEntries(keys.map((k) => [k, sc[gk(k)] ?? DEFAULT_SCENE[gk(k)]]));
      if (legacy.track || legacy.barrier || legacy.dirt) state.altTexs[a.uid] = { ...legacy, ...Object.fromEntries(Object.entries(state.altTexs[a.uid] || {}).filter(([, v]) => v)) };
    });
    for (const k of keys) sc[gk(k)] = DEFAULT_SCENE[gk(k)];
  }
  state.dirtTex = await toCanvas(d.dirtTex);
  state.riverWallTex = await toCanvas(d.riverWallTex);
  state.suspTex = await toCanvas(d.suspTex);
  state.suspBarrierTex = await toCanvas(d.suspBarrierTex);
  state.suspDirtTex = await toCanvas(d.suspDirtTex);
  state.fallWallTex = await toCanvas(d.fallWallTex);
  state.densityPaint = d.densityPaint || [];
  state.terrainSculpt = d.terrainSculpt || [];
  refreshSculptInfo();
  // biblioteca de assets y sets de decoración
  state.assets = [];
  for (const a of d.assets || []) {
    if (!a.data) { toast(`«${a.name}» era muy grande para guardarse dentro del proyecto: vuelve a cargarlo.`); continue; }
    try { state.assets.push(await loadAsset(b64ToBuf(a.data), a.name, a.id)); } catch (err) { toast(`No se pudo cargar ${a.name}: ${err.message}`); }
  }
  state.decoSets = d.decoSets || [];
  state.rivers = d.rivers || []; state.selRiver = null; renderRiverPanel();
  state.selDeco = null;
  renderAssetList(); renderVegAssetLists(); renderDecoPanel();
  // modelo de referencia 3D guardado con el proyecto
  if (state.ref3d) { state.ref3d = null; preview.setReference(null); }
  if (d.ref3d && d.ref3d.data) { try { await loadRef3d(b64ToBuf(d.ref3d.data), d.ref3d.name, { ...d.ref3d.settings, sel: false }); } catch (err) { toast('No se pudo cargar el modelo de referencia: ' + err.message); } }
  else if (d.ref3d) toast(`El proyecto usaba «${d.ref3d.name}» como referencia 3D, pero era muy grande para guardarse dentro: vuelve a importarlo.`);
  syncRef3dControls();
  state.hills = d.hills || (d.hillPaint ? migrateHillPaint(d.hillPaint) : []);
  state.selHill = null;
  refreshHillPanel();
  state.items = d.items || { puddle: [], pad: [], strip: [] };
  state.selItem = null;
  renderItemsPanel();
  itemsChanged();
  if (d.game) Object.assign(state.game, d.game);
  if (app.syncGameCam) app.syncGameCam();
  if (d.sky) { state.skyTex = await toCanvas(d.sky); state.skyCustom = true; } else { state.skyTex = makeDefaultSky(); state.skyCustom = false; }
  refreshSkyThumb();
  state.terrainTex = await toCanvas(d.terrainTex);
  state.grassTex = await toCanvas(d.grassTex);
  for (const k of Object.keys(state.itemTex)) state.itemTex[k] = d.itemTex ? await toCanvas(d.itemTex[k]) : null;
  if (typeof refreshItemTex === 'function') refreshItemTex();
  syncSceneControls();
  state.ref = null;
  if (d.ref && d.ref.image) {
    const img = new Image();
    img.src = d.ref.image;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    cv.getContext('2d').drawImage(img, 0, 0);
    state.ref = { canvas: cv, w: cv.width, h: cv.height, x: d.ref.x, y: d.ref.y, scale: d.ref.scale, opacity: d.ref.opacity, visible: d.ref.visible !== false, above: !!d.ref.above };
  }
  syncRefControls();
  syncControls();
  scheduleBuild();
  preview.fitted = false;
  setTimeout(() => editor.fit(), 0);
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

let toastTimer = null;
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'tooltip';
    Object.assign(t.style, { left: '50%', bottom: '24px', transform: 'translateX(-50%)', padding: '8px 14px', borderColor: '#f2a93b' });
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4500);
}


// ---------- escena 3D: terreno, árboles y texturas ----------
function sceneChanged() { preview.update(false); if (typeof editor !== 'undefined') editor.draw(); }
function terrainDensityLabel() {
  const L = state.layout;
  if (!L) return `${state.scene.terrainDensity}`;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of L.routes) for (let i = 0; i < r.n; i++) { minX = Math.min(minX, r.x[i]); maxX = Math.max(maxX, r.x[i]); minY = Math.min(minY, r.y[i]); maxY = Math.max(maxY, r.y[i]); }
  const M = state.scene.terrainMargin;
  const area = (maxX - minX + 2 * M) * (maxY - minY + 2 * M);
  const cell = terrainCell(area, state.scene);
  return `celda ${cell.toFixed(1)} m · ~${Math.round((area / (cell * cell)) * 2).toLocaleString('es')} triángulos`;
}
/** Objetivo de los controles de cerro: el cerro seleccionado o los valores para cerros nuevos. */
function hillTarget() {
  const h = state.hills.find((x) => x.id === state.selHill);
  if (h) return { hill: h, get: (k) => h[k], set: (k, v) => { h[k] = v; } };
  const sc = state.scene;
  const map = { height: 'hillHeight', hard: 'hillHard', flat: 'hillFlat', density: 'hillDensity', maxTris: 'hillMaxTris' };
  return { hill: null, get: (k) => sc[map[k]], set: (k, v) => { sc[map[k]] = v; } };
}
function hillCellLabel(d) { return `celda ${(20 * Math.pow(1 / 20, d / 100)).toFixed(1)} m`; }
function refreshHillPanel() {
  if (!$('hillSelBox')) return;
  const t = hillTarget();
  const set = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v; };
  set('hillH', Math.min(150, t.get('height'))); set('hillHNum', t.get('height'));
  set('hillHeight', Math.min(150, t.get('height'))); $('hillHeightVal').textContent = `${t.get('height')} m`;
  set('hillProfile', t.get('hard') ? 'hard' : 'soft'); set('hillHard', t.get('hard') ? 'hard' : 'soft');
  set('hillFlat', t.get('flat')); set('hillFlatBar', t.get('flat'));
  $('hillFlatVal').textContent = `${Math.round(t.get('flat') * 100)} %${t.get('flat') >= 0.99 ? ' (meseta)' : ''}`;
  set('hillDensity', t.get('density')); $('hillDensityVal').textContent = hillCellLabel(t.get('density'));
  set('hillMaxTris', t.get('maxTris'));
  $('hillSelBox').classList.toggle('active', !!t.hill);
  $('hillSelName').textContent = t.hill ? `Cerro seleccionado: ${t.hill.name}` : 'Valores para cerros nuevos';
  $('btnHillDelete').disabled = !t.hill; $('btnHillDeselect').disabled = !t.hill;
  const info = state.hillInfo || [];
  if (t.hill) {
    const hi = info.find((x) => x.id === t.hill.id);
    $('hillInfo').textContent = hi ? `${hi.tris.toLocaleString('es')} triángulos · celda de ${hi.cell.toFixed(1)} m. Shift + pintar encima lo agranda (sin Shift se pinta un cerro nuevo encima); Supr lo elimina.` : 'Calculando…';
  } else {
    const tot = info.reduce((a, x) => a + x.tris, 0);
    $('hillInfo').textContent = state.hills.length
      ? `${state.hills.length} cerro(s) · ${tot.toLocaleString('es')} triángulos. Haz clic en un cerro (en el mapa o en 3D) para seleccionarlo y editarlo.`
      : 'Con «Pintar cerros» cada trazo nuevo crea un cerro; si empiezas sobre uno existente, lo agrandas.';
  }
}
const VEG_CHECKS = ['terrain', 'skirts', 'trees', 'grass', 'treeOnSlopes', 'treeOnTops', 'grassOnSlopes', 'grassOnTops'];
const VEG_NUMS = ['treeDensity', 'treeScale', 'treeOffset', 'treeSpread', 'treeHillDensity', 'treeTilt', 'grassDensity', 'grassScale', 'grassOffset', 'grassSpread', 'grassHillDensity', 'grassTilt'];
const VEG_FMT = {
  treeDensity: (v) => `${v}`, grassDensity: (v) => `${v}`,
  treeScale: (v) => `${(+v).toFixed(2)}×`, grassScale: (v) => `${(+v).toFixed(2)}×`,
  treeOffset: (v) => `${v} m`, grassOffset: (v) => `${v} m`, treeSpread: (v) => `${v} m`, grassSpread: (v) => `${v} m`,
  treeHillDensity: (v) => `${v}`, grassHillDensity: (v) => `${v}`,
  treeTilt: (v) => (v <= 0 ? '0 % (rectos)' : v >= 100 ? '100 % (según la normal)' : `${v} %`),
  grassTilt: (v) => (v <= 0 ? '0 % (rectos)' : v >= 100 ? '100 % (según la normal)' : `${v} %`),
};
let grassDefaultCanvas = null;
let trackDefaultCanvas = null;
function defaultTrackCanvas() { if (!trackDefaultCanvas) trackDefaultCanvas = makeAsphaltCanvas(); return trackDefaultCanvas; }
let barrierDefaultCanvas = null, dirtDefaultCanvas = null;
const darkCache = new WeakMap();
/** Copia de una textura oscurecida (k = 0.2 → 20 % más oscura), guardada por lienzo de origen. */
function darkenedCanvas(src, k) {
  let c = darkCache.get(src);
  if (c && c.k === k) return c.cv;
  const cv = document.createElement('canvas');
  cv.width = src.width; cv.height = src.height;
  const g = cv.getContext('2d');
  g.drawImage(src, 0, 0);
  g.fillStyle = `rgba(0,0,0,${k})`;
  g.fillRect(0, 0, cv.width, cv.height);
  darkCache.set(src, { k, cv });
  return cv;
}
function defaultBarrierCanvas() { if (!barrierDefaultCanvas) barrierDefaultCanvas = makeBarrierCanvas(); return barrierDefaultCanvas; }
function defaultDirtCanvas() { if (!dirtDefaultCanvas) dirtDefaultCanvas = makeSandCanvas(); return dirtDefaultCanvas; }
let bridgeDefaultCanvas = null;
function defaultBridgeCanvas() { if (!bridgeDefaultCanvas) bridgeDefaultCanvas = makeBridgeCanvas(); return bridgeDefaultCanvas; }
function syncSceneControls() {
  const sc = state.scene;
  const set = (id, v) => { const el = $(id); if (el && el !== rangeDrag) { if (el.type === 'checkbox') el.checked = !!v; else el.value = v; } }; // no toca el deslizador que se está arrastrando
  for (const k of VEG_CHECKS) set(k, sc[k]);
  for (const k of ['terrainDensity', 'terrainMaxPolys', 'terrainMargin', 'terrainGap', 'terrainFalloff', 'treeSide', 'grassSide', 'treeSeed', 'trackTexDir', ...VEG_NUMS]) set(k, sc[k]);
  for (const k of VEG_NUMS) { const el = $(k + 'Val'); if (el) el.textContent = VEG_FMT[k](sc[k]); }
  $('treeHillBox').classList.toggle('disabled', !(sc.treeOnSlopes || sc.treeOnTops));
  $('grassHillBox').classList.toggle('disabled', !(sc.grassOnSlopes || sc.grassOnTops));
  set('hillBrush', Math.min(250, sc.hillBrush)); set('hillBrushNum', sc.hillBrush);
  set('trackTexReps', Math.min(1000, sc.trackTexReps)); set('trackTexRepsNum', sc.trackTexReps);
  set('terrainTexRepX', Math.min(200, sc.terrainTexRepX)); set('terrainTexRepXNum', sc.terrainTexRepX);
  set('terrainTexRepY', Math.min(200, sc.terrainTexRepY)); set('terrainTexRepYNum', sc.terrainTexRepY);
  $('terrainDensityVal').textContent = terrainDensityLabel();
  $('terrainMarginVal').textContent = `${sc.terrainMargin} m`;
  $('terrainGapVal').textContent = `${(+sc.terrainGap).toFixed(2)} m`;
  $('terrainFalloffVal').textContent = `${sc.terrainFalloff} m`;
  $('treeDensityVal').textContent = `${sc.treeDensity}`;
  set('paintSubdiv', sc.paintSubdiv ?? 1); set('paintSubdivP', sc.paintSubdiv ?? 1);
  set('paintBrush', Math.min(200, sc[brushKey(state.tool)]));
  set('sculptStrength', sc.sculptStrength); set('sculptStrengthP', sc.sculptStrength); set('sculptBrushP', Math.min(200, sc.sculptBrush));
  set('sculptDetail', sc.sculptDetail !== false);
  if ($('sculptStrengthVal')) $('sculptStrengthVal').textContent = `${sc.sculptStrength} m`;
  if ($('sculptStrengthPVal')) $('sculptStrengthPVal').textContent = `${sc.sculptStrength} m`;
  if ($('sculptBrushPVal')) $('sculptBrushPVal').textContent = `${sc.sculptBrush} m`;
  refreshHillPanel();
  for (const k of ['tunnelShape', 'tunnelType', 'tunnelOpen', 'tunnelHeight', 'caveSize', 'tunnelPillars', 'tunnelDensity', 'portalFrame', 'portalDepth', 'startGateHeight']) set(k, sc[k]);
  set('caveRocks', sc.caveRocks !== false);
  set('startGate', sc.startGate); if (document.activeElement !== $('startText')) set('startText', sc.startText);
  $('startGateHeightVal').textContent = `${sc.startGateHeight} m`;
  $('tunnelDensityVal').textContent = (() => { const { N, step } = tunnelResolution(sc); return `${N - 1} lados · cada ${step.toFixed(1)} m`; })();
  $('portalFrameVal').textContent = `${(+sc.portalFrame).toFixed(1)} m`;
  $('portalDepthVal').textContent = `${(+sc.portalDepth).toFixed(1)} m`;
  set('tunnelWidth', Math.min(40, sc.tunnelWidth)); set('tunnelWidthNum', sc.tunnelWidth);
  $('tunnelHeightVal').textContent = `${sc.tunnelHeight} m`;
  $('caveSizeVal').textContent = `${Math.round(sc.caveSize * 100)} %`;
  $('tunnelPillarsVal').textContent = `${sc.tunnelPillars}`;
  document.querySelectorAll('#tunnelMeshMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === (sc.tunnelMeshMode || 'uniform')));
  set('tunnelMaxTris', Math.min(150000, sc.tunnelMaxTris ?? 60000)); set('tunnelMaxTrisNum', sc.tunnelMaxTris ?? 60000);
  set('tunnelAdapt', sc.tunnelAdapt ?? 0.5); $('tunnelAdaptVal').textContent = `${Math.round((sc.tunnelAdapt ?? 0.5) * 100)} %`;
  $('tunnelAdaptBox').hidden = sc.tunnelMeshMode !== 'optimized';
  $('caveBox').classList.toggle('disabled', sc.tunnelType !== 'natural');
  $('pillarBox').classList.toggle('disabled', sc.tunnelOpen === 'none');
  set('riverMode', sc.riverMode); set('riverWalls', sc.riverWalls); set('riverDepth', sc.riverDepth); set('riverWallSubdiv', sc.riverWallSubdiv);
  if ($('riverDepthVal')) $('riverDepthVal').textContent = `${(+sc.riverDepth).toFixed(1)} m`;
  if ($('riverWallSubdivVal')) $('riverWallSubdivVal').textContent = `${sc.riverWallSubdiv}`;
  if ($('riverCarvedBox')) $('riverCarvedBox').classList.toggle('disabled', sc.riverMode !== 'carved');
  { const n = sc.paintSubdiv ?? 1, t = `${n} (×${subdivFactor(n)} pol.)`; $('paintSubdivVal').textContent = t; $('paintSubdivPVal').textContent = t; }
  $('paintBrushVal').textContent = `${sc[brushKey(state.tool)]} m`;
  $('treeScaleVal').textContent = `${(+sc.treeScale).toFixed(2)}×`;
  $('treeOffsetVal').textContent = `${sc.treeOffset} m`;
  $('treeSpreadVal').textContent = `${sc.treeSpread} m`;
  const thumb = (imgId, canvas, btn) => {
    const img = $(imgId);
    img.hidden = !canvas;
    if (canvas) img.src = canvas.toDataURL('image/png');
    $(btn).disabled = !canvas;
  };
  thumb('trackTexThumb', state.trackTex || defaultTrackCanvas(), 'btnTrackTexRemove');
  $('btnTrackTexRemove').disabled = !state.trackTex;
  thumb('bridgeTexThumb', state.bridgeTex || defaultBridgeCanvas(), 'btnBridgeTexRemove');
  for (const [k, id] of [['riverWallTex', 'riverWall'], ['fallWallTex', 'fallWall'], ['suspTex', 'suspTex'], ['suspBarrierTex', 'suspBarrierTex'], ['suspDirtTex', 'suspDirtTex']]) { const img = $(id + 'Thumb'); img.hidden = !state[k]; if (state[k]) img.src = thumbURL(state[k]); $(id + 'Remove').disabled = !state[k]; }
  set('riverWallTile', sc.riverWallTile ?? 4); set('riverWallTileNum', sc.riverWallTile ?? 4);
  thumb('coveredTexThumb', app.coveredTexCanvas(), 'btnCoveredTexRemove'); $('btnCoveredTexRemove').disabled = !state.coveredTex;
  thumb('barrierTexThumb', state.barrierTex || defaultBarrierCanvas(), 'btnBarrierTexRemove');
  $('btnBarrierTexRemove').disabled = !state.barrierTex;
  thumb('dirtTexThumb', state.dirtTex || defaultDirtCanvas(), 'btnDirtTexRemove');
  $('btnDirtTexRemove').disabled = !state.dirtTex;
  for (const k of ['dirtSide', 'barrierSide']) set(k, sc[k] || 'none');
  {
    const tt = sc.terrainType || 'forest';
    document.querySelectorAll('#terrainType button').forEach((b) => b.classList.toggle('on', b.dataset.type === tt));
    $('beachBox').hidden = tt !== 'beach'; $('mountainBox').hidden = tt !== 'mountain'; $('coastCommonBox').hidden = tt === 'forest';
    $('coastBeachBox').hidden = tt !== 'beach'; $('coastHeightBox').hidden = tt !== 'beach';
    set('coastSide', sc.coastSide || 'right'); set('cliffSide', sc.cliffSide || 'left');
    for (const k of ['coastLand', 'coastBeach', 'coastHeight', 'cliffHeight', 'wallHeight']) { set(k, sc[k]); set(k + 'Num', sc[k]); }
    $('terrainTypeInfo').textContent = tt === 'beach'
      ? `Del lado de la costa, la tierra sigue la pista unos ${sc.coastLand} m (irregular) y luego baja como playa hasta el agua; ${sc.coastSide === 'both' ? 'la costa está a ambos lados' : 'al otro lado el terreno es de bosque'}. Se agrega un plano de agua («agua» en la exportación). Izquierda y derecha, según el sentido de marcha.`
      : tt === 'mountain' ? `Del lado del acantilado queda una franja de tierra de unos ${sc.coastLand} m y luego un corte de ${sc.cliffHeight} m hasta el agua; al otro lado se levanta una pared de roca de ${sc.wallHeight} m. Izquierda y derecha, según el sentido de marcha.` : '';
  }
  for (const k of ['dirtWidth', 'dirtTile', 'barrierHeight', 'barrierThick', 'barrierTile']) { set(k, sc[k]); set(k + 'Num', sc[k]); }
  $('dirtBox').classList.toggle('disabled', !sc.dirtSide || sc.dirtSide === 'none');
  $('barrierBox').classList.toggle('disabled', !sc.barrierSide || sc.barrierSide === 'none');
  $('btnBridgeTexRemove').disabled = !state.bridgeTex;
  set('trackTexOpacity', sc.trackTexOpacity ?? 1);
  document.querySelectorAll('#trackMeshMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === (sc.trackMeshMode || 'uniform')));
  set('trackDensity', sc.trackDensity ?? 100); set('trackDensityNum', sc.trackDensity ?? 100);
  set('trackMaxTris', Math.min(300000, sc.trackMaxTris ?? 200000)); set('trackMaxTrisNum', sc.trackMaxTris ?? 200000);
  set('trackAdapt', sc.trackAdapt ?? 0.5);
  $('trackAdaptVal').textContent = `${Math.round((sc.trackAdapt ?? 0.5) * 100)} %`;
  $('trackAdaptBox').hidden = sc.trackMeshMode !== 'optimized';
  $('trackTexOpacityVal').textContent = `${Math.round((sc.trackTexOpacity ?? 1) * 100)} %`;
  thumb('terrainTexThumb', state.terrainTex, 'btnTerrainTexRemove');
  { const gi = $('grassTexThumb'); if (!state.grassTex && !grassDefaultCanvas) grassDefaultCanvas = makeGrassCanvas(); gi.src = (state.grassTex || grassDefaultCanvas).toDataURL('image/png'); $('btnGrassTexRemove').disabled = !state.grassTex; }
  const L = state.layout;
  $('trackTexInfo').textContent = `${state.trackTex ? 'Textura propia' : 'Textura de asfalto por defecto'}: una repetición cada ${L ? (L.routes[0].L / sc.trackTexReps).toFixed(1) : '?'} m; a lo ancho cubre la pista una vez. Baja la opacidad para ver debajo los colores por altura (solo en la vista 3D; se exporta con la textura).`;
}
function refreshPaintInfo() {
  editor.draw();
}
/** Selecciona el modelo de referencia (gizmo en 3D, arrastre en el mapa). */
function selectRef3d(on) {
  const R = state.ref3d;
  if (!R) return;
  R.sel = !!on && !R.locked;
  if (R.sel) {
    if (state.selAlt != null) selectAlt(null);
    if (state.selHill != null || state.selTunnel != null) selectHill(null, false);
    if (state.selItem) selectItem(null);
    if (state.selBridge != null) selectBridge(null);
    setTimeout(() => { try { focusPanel('ref3d'); } catch { /* iniciando */ } }, 0);
  }
  preview.updateReference();
  syncRef3dControls();
  editor.draw();
}
function syncRef3dControls() {
  const R = state.ref3d;
  const box = $('ref3dBox');
  if (!box) return;
  box.hidden = !R;
  $('btnRef3dRemove').disabled = !R;
  if (!R) { $('ref3dInfo').textContent = 'Importa un .fbx o .glb (por ejemplo, una pista anterior de tu juego) para compararlo con la pista nueva. Se muestra como un solo objeto que puedes mover, pero no editar.'; return; }
  const set = (id, v) => { const el = $(id); if (el && el !== rangeDrag && document.activeElement !== el) { if (el.type === 'checkbox') el.checked = !!v; else el.value = v; } };
  set('ref3dVisible', R.visible !== false); set('ref3dShow2d', R.show2d !== false); set('ref3dLocked', !!R.locked);
  set('ref3dX', R.pos[0]); set('ref3dY', R.pos[1]); set('ref3dZ', R.pos[2]);
  set('ref3dRot', R.rotZ || 0); set('ref3dRotNum', R.rotZ || 0); set('ref3dScale', R.scale || 1);
  set('ref3dUnit', R.unitOpt || 'auto'); set('ref3dUp', R.upOpt || 'auto'); set('ref3dLook', R.look || 'flat'); set('ref3dColor', R.color || '#4fc3f7');
  set('ref3dOpacity', R.opacity ?? 0.6); $('ref3dOpacityVal').textContent = `${Math.round((R.opacity ?? 0.6) * 100)} %`;
  set('ref3dGizmo', R.gizmo || 'translate');
  $('btnRef3dSelect').classList.toggle('active', !!R.sel);
  const b = R.bbox;
  $('ref3dInfo').textContent = `${R.name} (${R.format}) · ${R.tris.toLocaleString('es')} triángulos · ${b ? `${b[0].toFixed(0)} × ${b[1].toFixed(0)} × ${b[2].toFixed(1)} m` : ''} · unidades ${R.unitScale === 1 ? 'm' : `×${+R.unitScale.toFixed(4)}`} · ${R.upAxis.toUpperCase()} arriba${R.sel ? ' · seleccionado: muévelo con el gizmo en 3D o arrastrando su silueta en el mapa' : ''}.`;
}
/** Lee (o vuelve a leer, al cambiar unidades o eje) el modelo desde su archivo original. */
async function loadRef3d(buffer, name, keep = null) {
  const opts = keep || {};
  const unitOpt = opts.unitOpt || 'auto', upOpt = opts.upOpt || 'auto';
  const res = await parseReference(buffer, name, { upAxis: upOpt, unitScale: unitOpt === 'auto' ? null : parseFloat(unitOpt) });
  const fp = footprint(res.inner);
  const size = [fp.u1 - fp.u0, fp.v1 - fp.v0];
  const zb = new (await import('three')).Box3().setFromObject(res.inner);
  const prev = state.ref3d;
  state.ref3d = {
    name, format: res.format, buffer, inner: res.inner, meshes: res.meshes, fp, tris: res.tris,
    unitScale: res.unitScale, upAxis: res.upAxis, unitOpt, upOpt, bbox: [size[0], size[1], zb.max.z - zb.min.z],
    pos: opts.pos || [0, 0, 0], rotZ: opts.rotZ || 0, scale: opts.scale || 1,
    visible: opts.visible ?? true, show2d: opts.show2d ?? true, locked: !!opts.locked,
    look: opts.look || 'flat', color: opts.color || '#4fc3f7', opacity: opts.opacity ?? 0.6, gizmo: opts.gizmo || 'translate', sel: !!opts.sel,
  };
  if (prev && prev.inner && prev.inner !== res.inner) prev.inner.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  preview.setReference(state.ref3d);
  syncRef3dControls();
  editor.draw();
}
async function importRef3dFile(file) {
  try {
    toast(`Leyendo ${file.name}…`);
    const buf = await file.arrayBuffer();
    await loadRef3d(buf, file.name);
    const R = state.ref3d;
    selectRef3d(true);
    toast(`Referencia cargada: ${R.name}, ${R.tris.toLocaleString('es')} triángulos, ${R.bbox[0].toFixed(0)} × ${R.bbox[1].toFixed(0)} m. Si no coincide con la pista, usa «Centrar en la pista» o revisa unidades y eje.`);
  } catch (err) { console.warn(err); toast('No se pudo leer el modelo: ' + err.message); }
}
/** Mueve el modelo para que su centro en planta quede en el centro de la pista (conserva Z y giro). */
function centerRef3d() {
  const R = state.ref3d, L = state.layout;
  if (!R || !L) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of L.routes) for (let i = 0; i < r.n; i++) { x0 = Math.min(x0, r.x[i]); x1 = Math.max(x1, r.x[i]); y0 = Math.min(y0, r.y[i]); y1 = Math.max(y1, r.y[i]); }
  const cu = (R.fp.u0 + R.fp.u1) / 2, cv = (R.fp.v0 + R.fp.v1) / 2;
  const th = ((R.rotZ || 0) * Math.PI) / 180, k = R.scale || 1;
  const wx = k * (cu * Math.cos(th) - cv * Math.sin(th)), wy = k * (cu * Math.sin(th) + cv * Math.cos(th));
  R.pos = [+((x0 + x1) / 2 - wx).toFixed(3), +((y0 + y1) / 2 - wy).toFixed(3), R.pos[2]];
  preview.updateReference(); syncRef3dControls(); editor.draw();
}
function bufToB64(buf) {
  const u = new Uint8Array(buf); let out = '';
  for (let i = 0; i < u.length; i += 0x8000) out += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(out);
}
function b64ToBuf(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; }
const REF3D_KEEP = ['pos', 'rotZ', 'scale', 'visible', 'show2d', 'locked', 'look', 'color', 'opacity', 'gizmo', 'unitOpt', 'upOpt'];
function ref3dSettings() { const R = state.ref3d; const o = {}; for (const k of REF3D_KEEP) o[k] = R[k]; return o; }
// ---------- decoración: biblioteca de assets y sets ----------
/** Lo que la exportación necesita de la decoración: biblioteca, sets y sus zonas pintadas. */
function decoExportInfo() { return { assetById: (id) => app.assetById(id), sets: state.decoSets, paintFor: (set) => app.decoPaintWorld(set) }; }
function decoChanged() { preview.buildDeco(); editor.draw(); }
function selectDecoSet(id) {
  state.selDeco = id;
  const st = state.decoSets.find((x) => x.id === id);
  if (st) st.collapsed = false; // se abre para mostrar sus parámetros
  renderDecoPanel();
  if (id != null) setTimeout(() => { try { focusPanel('deco', document.querySelector(`#decoList .item[data-id="${id}"]`)); } catch { /* iniciando */ } }, 0);
}
function refreshDecoCounts() {
  const c = state.decoCounts || {};
  document.querySelectorAll('#decoList .item').forEach((el) => {
    const k = c[el.dataset.id];
    const m = el.querySelector('.dcount');
    if (m) m.textContent = k ? `${k.count.toLocaleString('es')} elementos · ${k.tris.toLocaleString('es')} tri.` : '';
  });
  const tot = Object.values(c).reduce((a, k) => a + k.count, 0);
  if ($('decoInfo')) $('decoInfo').textContent = state.decoSets.length ? `${state.decoSets.length} set(s) · ${tot.toLocaleString('es')} elementos. Se exportan en «decoracion/<set>/<set>_0001…», cada uno como objeto propio con el pivote en su base.` : 'Sin sets. «+ Nuevo set» agrega cubos de color que luego puedes reemplazar por modelos.';
}
/** Fichas para elegir modelos de la biblioteca (árboles, hierba o un set). */
function assetChipsHTML(selected) {
  if (!state.assets.length) return '<span class="empty">Biblioteca vacía: carga modelos en «Decoración».</span>';
  return state.assets.map((a) => `<span class="chip${selected.includes(a.id) ? ' on' : ''}" data-aid="${a.id}" title="${a.name} · ${a.tris.toLocaleString('es')} tri.">${a.name.replace(/\.(fbx|glb|gltf)$/i, '')}</span>`).join('');
}
function renderVegAssetLists() {
  const sc = state.scene;
  for (const [id, key] of [['treeAssetList', 'treeAssets'], ['grassAssetList', 'grassAssets']]) {
    const el = $(id);
    if (!el) continue;
    const sel = (sc[key] || []).filter((a) => state.assets.some((x) => x.id === a));
    el.innerHTML = assetChipsHTML(sel);
    el.querySelectorAll('.chip').forEach((ch) => ch.addEventListener('click', () => {
      const cur = new Set(sc[key] || []);
      if (cur.has(ch.dataset.aid)) cur.delete(ch.dataset.aid); else cur.add(ch.dataset.aid);
      sc[key] = [...cur];
      renderVegAssetLists();
      sceneChanged();
    }));
  }
}
function renderAssetList() {
  const el = $('assetList');
  if (!el) return;
  el.innerHTML = state.assets.length ? '' : '<div class="meta">Sin modelos.</div>';
  for (const a of state.assets) {
    const d = document.createElement('div');
    d.className = 'item';
    const used = [state.scene.treeAssets, state.scene.grassAssets, ...state.decoSets.map((x) => x.assets)].some((l) => (l || []).includes(a.id));
    d.innerHTML = `<div class="head"><strong>${a.name}</strong><button class="x" title="Quitar de la biblioteca">✕</button></div>
      <div class="meta">${a.format} · ${a.tris.toLocaleString('es')} tri. · ${a.size.map((v) => v.toFixed(2)).join(' × ')} m · ${a.parts.length} malla(s)${used ? ' · en uso' : ''}</div>`;
    d.querySelector('button.x').addEventListener('click', () => {
      state.assets = state.assets.filter((x) => x.id !== a.id);
      for (const k of ['treeAssets', 'grassAssets']) state.scene[k] = (state.scene[k] || []).filter((x) => x !== a.id);
      for (const set of state.decoSets) set.assets = (set.assets || []).filter((x) => x !== a.id);
      renderAssetList(); renderVegAssetLists(); renderDecoPanel(); sceneChanged();
    });
    el.appendChild(d);
  }
}
async function loadAssetFiles(files) {
  let ok = 0;
  for (const f of files) {
    try { const A = await loadAsset(await f.arrayBuffer(), f.name); state.assets.push(A); ok++; } catch (err) { console.warn(err); toast(`No se pudo leer ${f.name}: ${err.message}`); }
  }
  if (ok) toast(`${ok} modelo(s) en la biblioteca. Elígelos en los árboles, la hierba o en un set de decoración.`);
  renderAssetList(); renderVegAssetLists(); renderDecoPanel();
}
function renderDecoPanel() {
  const el = $('decoList');
  if (!el || draggingIn(el)) return;
  el.innerHTML = state.decoSets.length ? '' : '<div class="meta">Sin sets.</div>';
  state.decoSets.forEach((set, si) => {
    const d = document.createElement('div');
    d.className = 'item deco-card' + (state.selDeco === set.id ? ' sel' : '') + (set.collapsed ? ' collapsed' : '');
    d.dataset.id = set.id;
    const painting = state.tool === 'itemPaint' && state.itemPaintTarget && state.itemPaintTarget.type === 'deco' && state.itemPaintTarget.id === set.id;
    const models = (set.assets || []).filter((a) => state.assets.some((x) => x.id === a));
    const num = (f, v, min, step, w = 58) => `<input type="number" data-f="${f}" value="${v}" min="${min}" step="${step}" style="width:${w}px">`;
    const rng = (f, v, min, max, step) => `<input type="range" data-f="${f}" value="${v}" min="${min}" max="${max}" step="${step}">`;
    const fld = (label, f, v, min, max, step, unit = '') => `<div class="field"><label>${label} <span class="val">${num(f, v, min, step)}${unit}</span></label>${rng(f, Math.min(max, v), min, max, step)}</div>`;
    d.innerHTML = `<div class="head"><span><button class="dtoggle" title="Mostrar u ocultar los parámetros">${set.collapsed ? '▸' : '▾'}</button><span class="swatch" style="background:${set.color}"></span><input class="dn" value="${set.name}" title="Nombre del set (se usa al exportar)"></span>
        <span><input type="color" class="dc" value="${set.color}" title="Color de los cubos o planos"> <button class="x" title="Quitar el set">✕</button></span></div>
      <div class="meta"><span class="dcount"></span></div>
      <div class="dbody">
      <div class="field"${models.length ? ' hidden' : ''}><label>Forma</label><select class="dshape"><option value="cube">Cubos</option><option value="plane">Planos (de frente, 1 cara con UV)</option></select></div>
      <div class="row gap wrap"><label class="check"><input type="checkbox" class="dv"${set.visible !== false ? ' checked' : ''}> Visible</label>
        <select class="dm"><option value="road">Junto a la pista</option><option value="painted">Solo en zonas pintadas</option></select></div>
      <div class="row gap wrap dpaint"${set.mode === 'painted' ? '' : ' hidden'}><button class="dp${painting ? ' active' : ''}">${painting ? 'Terminar de pintar' : 'Pintar zonas'}</button><button class="dpc"${set.paint && set.paint.length ? '' : ' disabled'}>Borrar zonas</button><span class="small muted">clic derecho o Alt borra</span></div>
      <div class="field droad"${set.mode === 'painted' ? ' hidden' : ''}><label>Lado</label><select class="ds"><option value="both">Ambos lados</option><option value="left">Izquierda</option><option value="right">Derecha</option></select></div>
      ${fld('Cantidad máxima', 'max', set.max, 0, 3000, 10)}
      ${fld(set.mode === 'painted' ? 'Densidad (por 1000 m²)' : 'Densidad (por 100 m y lado)', 'density', set.density, 0.1, 80, 0.1)}
      <div class="droad"${set.mode === 'painted' ? ' hidden' : ''}>${fld('Distancia al borde', 'offset', set.offset, 0, 80, 0.5, ' m')}${fld('Dispersión', 'spread', set.spread, 0, 150, 1, ' m')}</div>
      ${fld('Separación mínima', 'spacing', set.spacing, 0.1, 40, 0.1, ' m')}
      ${models.length ? fld('Escala de los modelos', 'modelScale', set.modelScale ?? 1, 0.01, 10, 0.01, ' ×') : fld('Tamaño (cubo o plano)', 'size', set.size, 0.05, 20, 0.05, ' m')}
      ${fld('Variación de tamaño', 'sizeVar', Math.round((set.sizeVar ?? 0.3) * 100), 0, 100, 1, ' %')}
      <div class="field"><label>Rotación</label><select class="drm"><option value="random">Al azar</option><option value="fixed">Fija, respecto de la pista</option></select></div>
      <div class="drrand"${set.rotMode === 'fixed' ? ' hidden' : ''}>${fld('Rotación al azar (rango)', 'rot', set.rot ?? 360, 0, 360, 1, ' °')}</div>
      <div class="drfix"${set.rotMode === 'fixed' ? '' : ' hidden'}>
        <p class="hint">0° = de frente al auto que viene por la pista (el frente es el lado -Y del elemento).</p>
        ${fld('Giro del lado izquierdo', 'rotLeft', set.rotLeft ?? 0, -180, 180, 1, ' °')}${fld('Giro del lado derecho', 'rotRight', set.rotRight ?? 0, -180, 180, 1, ' °')}</div>
      ${fld('Orientación según la normal', 'tilt', set.tilt ?? 0, 0, 100, 1, ' %')}
      <div class="row gap wrap"><label class="check"><input type="checkbox" class="dsl"${set.onSlopes ? ' checked' : ''}> En laderas de cerros</label><label class="check"><input type="checkbox" class="dtp"${set.onTops ? ' checked' : ''}> En cimas</label></div>
      <div class="field"><label>Modelos (reemplazan a los cubos)</label><div class="asset-chips dassets">${assetChipsHTML(models)}</div></div>
      <div class="row gap"><button class="dseed" title="Otra distribución al azar con los mismos parámetros">Otra distribución</button></div>
      </div>`;
    d.querySelector('.dm').value = set.mode || 'road';
    d.querySelector('.dshape').value = set.shape || 'cube';
    d.querySelector('.drm').value = set.rotMode || 'random';
    d.querySelector('.dshape').addEventListener('change', (e) => { set.shape = e.target.value; decoChanged(); });
    d.querySelector('.drm').addEventListener('change', (e) => { pushUndo(); set.rotMode = e.target.value; renderDecoPanel(); decoChanged(); });
    d.querySelector('.dtoggle').addEventListener('click', () => { set.collapsed = !set.collapsed; d.classList.toggle('collapsed', set.collapsed); d.querySelector('.dtoggle').textContent = set.collapsed ? '▸' : '▾'; });
    d.querySelector('.ds').value = set.side || 'both';
    let editing = false;
    const commit = (rerender = false) => { if (rerender) renderDecoPanel(); decoChanged(); };
    const setF = (f, v, done) => {
      if (!Number.isFinite(v)) return;
      if (!editing) { pushUndo(); editing = true; }
      set[f] = f === 'sizeVar' ? Math.max(0, Math.min(1, v / 100)) : v;
      d.querySelectorAll(`[data-f="${f}"]`).forEach((inp) => { if (inp !== document.activeElement && inp !== rangeDrag) inp.value = f === 'sizeVar' ? Math.round(set[f] * 100) : set[f]; });
      commit();
      if (done) editing = false;
    };
    d.querySelectorAll('input[data-f]').forEach((inp) => {
      const f = inp.dataset.f;
      inp.addEventListener(inp.type === 'range' ? 'input' : 'change', () => setF(f, parseFloat(inp.value), inp.type !== 'range'));
      if (inp.type === 'range') inp.addEventListener('change', () => { editing = false; });
    });
    d.querySelector('.dn').addEventListener('change', (e) => { const v = e.target.value.trim().replace(/[^\w\-áéíóúñÁÉÍÓÚÑ ]/g, '').replace(/\s+/g, '_'); if (v) set.name = v; e.target.value = set.name; });
    d.querySelector('.dc').addEventListener('input', (e) => { set.color = e.target.value; d.querySelector('.swatch').style.background = set.color; commit(); });
    d.querySelector('.dv').addEventListener('change', (e) => { set.visible = e.target.checked; commit(); });
    d.querySelector('.dm').addEventListener('change', (e) => { pushUndo(); set.mode = e.target.value; commit(true); });
    d.querySelector('.ds').addEventListener('change', (e) => { set.side = e.target.value; commit(); });
    d.querySelector('.dsl').addEventListener('change', (e) => { set.onSlopes = e.target.checked; commit(); });
    d.querySelector('.dtp').addEventListener('change', (e) => { set.onTops = e.target.checked; commit(); });
    d.querySelector('.dseed').addEventListener('click', () => { set.seed = (set.seed | 0) + 1; commit(); });
    d.querySelector('button.x').addEventListener('click', () => { pushUndo(); state.decoSets = state.decoSets.filter((x) => x !== set); if (state.selDeco === set.id) state.selDeco = null; commit(true); renderAssetList(); });
    d.querySelector('.dp').addEventListener('click', () => {
      if (painting) { setTool('pan'); renderDecoPanel(); return; }
      state.itemPaintTarget = { type: 'deco', id: set.id };
      setTool('itemPaint');
      state.itemPaintTarget = { type: 'deco', id: set.id };
      if (preview.setPaintMode) preview.setPaintMode('itemPaint');
      renderDecoPanel();
    });
    d.querySelector('.dpc').addEventListener('click', () => { pushUndo(); set.paint = []; commit(true); });
    d.querySelectorAll('.dassets .chip').forEach((ch) => ch.addEventListener('click', () => {
      const cur = new Set(set.assets || []);
      if (cur.has(ch.dataset.aid)) cur.delete(ch.dataset.aid); else cur.add(ch.dataset.aid);
      set.assets = [...cur];
      commit(true); renderAssetList();
    }));
    d.addEventListener('click', (e) => { if (e.target.closest('input,button,select,.chip')) return; state.selDeco = set.id; el.querySelectorAll('.item').forEach((x) => x.classList.toggle('sel', x === d)); });
    el.appendChild(d);
  });
  refreshDecoCounts();
}
function refreshSculptInfo() {
  const el = $('sculptInfo');
  if (!el) return;
  const n = state.terrainSculpt.length;
  const up = state.terrainSculpt.filter((q) => q.h > 0).length;
  el.textContent = n ? `${n} toques (${up} elevan, ${n - up} hunden). Son parte de la misma malla del terreno; junto a la pista se desvanecen para no taparla.` : 'Sin relieve esculpido. Con «Esculpir relieve», clic derecho eleva y clic izquierdo hunde (en el mapa o en la vista 3D).';
  if ($('btnSculptClear')) $('btnSculptClear').disabled = !n;
}
function refreshSkyThumb() {
  if (state.skyTex) $('skyThumb').src = state.skyTex.toDataURL('image/jpeg', 0.7);
}
async function loadTexture(file, which) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(bmp.width * k)); cv.height = Math.max(1, Math.round(bmp.height * k));
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    state[which] = cv;
    syncSceneControls();
    sceneChanged();
    editor.draw();
  } catch (err) { toast('No se pudo leer la textura: ' + err.message); }
}
const TERRAIN_KEYS = ['terrainMargin', 'terrainDensity', 'terrainMaxPolys', 'terrainGap', 'terrainFalloff', 'terrainTexRepX', 'terrainTexRepY', 'paintFactor', 'skirts'];
const TREE_KEYS = ['treeSide', 'treeDensity', 'treeScale', 'treeOffset', 'treeSpread', 'treeOnSlopes', 'treeOnTops', 'treeHillDensity', 'treeTilt'];
/** Lleva la barra lateral a una sección (la despliega o la trae al frente si flota) y la marca con un borde amarillo. */
function focusPanel(id, sub = null) {
  if (sub && sub.closest) { const c = sub.closest('.collapsible.collapsed'); if (c) c.classList.remove('collapsed'); } // abre el bloque que contiene lo pedido
  const sec = document.querySelector(`section.panel[data-panel="${id}"]`);
  if (!sec) return;
  document.querySelectorAll('.panel.focus-ring').forEach((p) => p.classList.remove('focus-ring'));
  sec.classList.add('focus-ring');
  const api = panels[id];
  if (sec.classList.contains('collapsed') && api && api.setCollapsed) api.setCollapsed(false);
  if (sec.classList.contains('floating')) {
    sec.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    if (sub) sec.scrollTo({ top: Math.max(0, sub.getBoundingClientRect().top - sec.getBoundingClientRect().top + sec.scrollTop - 40), behavior: 'smooth' });
    return;
  }
  const sb = $('sidebar');
  const target = sub && sub.getBoundingClientRect().height ? sub : sec;
  // la sección arriba; si hay un elemento interior (un grupo, el cerro seleccionado) y no cabe, se baja hasta él
  let top = sec.getBoundingClientRect().top - sb.getBoundingClientRect().top + sb.scrollTop - 6;
  if (target !== sec) {
    const subTop = target.getBoundingClientRect().top - sb.getBoundingClientRect().top + sb.scrollTop;
    if (subTop + target.getBoundingClientRect().height - top > sb.clientHeight - 10) top = subTop - 60;
  }
  sb.scrollTo({ top, behavior: 'smooth' });
}
/** Botones (fuera de la barra lateral) con parámetros asociados: a qué sección llevan. */
const PANEL_FOR_BUTTON = {
  'tool:edit': 'arc', 'tool:draw': 'trace', 'tool:extend': 'trace', 'tool:alt': 'alts', 'tool:start': 'gate', 'tool:ref': 'ref',
  btnDecoNew: 'deco', 'tool:hill': 'hills', 'tool:river': 'rivers', 'tool:paint': 'terrain', 'tool:sculpt': 'terrain', 'tool:flat': 'elev', 'tool:profile': 'elev', 'tool:susp': 'susp', btnSculptTool: 'terrain', btnRef3dTop: 'ref3d',
  btnGame: 'sky', btnExportBlender: 'export', btnExportMax: 'export', btnExportJSON: 'export', btnExportOBJ: 'export',
  btnExportGLB2: 'export', btnExportFBX2: 'export', btnTbRadius: 'arc', btnTbFork: 'arc', btnGenTerrain: 'terrain', btnGenTrees: 'trees',
};
function bindPanelFocus() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button');
    if (!b || b.closest('#sidebar') || b.closest('.panel.floating')) return;
    const key = b.dataset.tool ? `tool:${b.dataset.tool}` : b.id;
    const pid = PANEL_FOR_BUTTON[key];
    if (pid) setTimeout(() => focusPanel(pid), 0); // después de la acción del botón (por si crea algo en la sección)
  });
}
/** Botones de la barra: activa el terreno / los árboles con los valores por defecto (si estaban apagados). */
function generateFromToolbar(kind) {
  const sc = state.scene;
  if (kind === 'terrain') {
    if (!sc.terrain) { for (const k of TERRAIN_KEYS) sc[k] = DEFAULT_SCENE[k]; sc.terrain = true; syncSceneControls(); sceneChanged(); toast('Terreno generado con los valores por defecto.'); }
    focusPanel('terrain');
  } else {
    if (!sc.trees) { for (const k of TREE_KEYS) sc[k] = DEFAULT_SCENE[k]; sc.trees = true; syncSceneControls(); sceneChanged(); toast('Árboles generados con los valores por defecto.'); }
    focusPanel('trees');
  }
}
/** Bloques colapsables (árboles, hierba): se recuerda el estado en este navegador. */
function initCollapsibles() {
  document.querySelectorAll('.collapsible').forEach((c) => {
    const key = 'tsg.coll.' + c.id;
    try { if (localStorage.getItem(key) === '1') c.classList.add('collapsed'); } catch { /* sin almacenamiento */ }
    c.querySelector('.coll-head').addEventListener('click', () => {
      c.classList.toggle('collapsed');
      try { localStorage.setItem(key, c.classList.contains('collapsed') ? '1' : '0'); } catch { /* sin almacenamiento */ }
    });
  });
}
function bindSceneControls() {
  initCollapsibles();
  initButtonIcons(); // iconos pequeños en todos los botones (también los que se creen después)
  renderRiverPanel();
  const sc = state.scene;
  $('btnGenTerrain').addEventListener('click', () => generateFromToolbar('terrain'));
  $('btnGenTrees').addEventListener('click', () => generateFromToolbar('trees'));
  const num = (id, key, isInt = false) => $(id).addEventListener('input', () => {
    const v = parseFloat($(id).value);
    if (!isFinite(v)) return;
    sc[key] = isInt ? Math.round(v) : v;
    syncSceneControls();
    sceneChanged();
  });
  for (const k of ['terrainDensity', 'terrainMargin', 'terrainGap', 'terrainFalloff', ...VEG_NUMS]) num(k, k);
  // subdivisiones del pincel de densidad (barra y panel): solo afectan a las pinceladas nuevas
  for (const id of ['paintSubdiv', 'paintSubdivP']) $(id).addEventListener('input', () => { sc.paintSubdiv = Math.round(parseFloat($(id).value)) || 1; syncSceneControls(); });
  // tamaño del pincel de cerros (panel) sincronizado con el de la barra
  const setHillBrush = (v) => {
    if (!isFinite(v) || v <= 0) return;
    sc.hillBrush = Math.round(Math.min(1000, Math.max(1, v)));
    if (state.tool === 'hill') { $('paintBrush').value = Math.min(200, sc.hillBrush); $('paintBrushVal').textContent = `${sc.hillBrush} m`; }
    if (document.activeElement !== $('hillBrush')) $('hillBrush').value = Math.min(250, sc.hillBrush);
    if (document.activeElement !== $('hillBrushNum')) $('hillBrushNum').value = sc.hillBrush;
    editor.draw();
  };
  $('hillBrush').addEventListener('input', () => setHillBrush(parseFloat($('hillBrush').value)));
  $('hillBrushNum').addEventListener('input', () => setHillBrush(parseFloat($('hillBrushNum').value)));
  app.setHillBrush = setHillBrush;
  // [ y ] cambian el tamaño del pincel activo
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key !== '[' && e.key !== ']') return;
    if (!PAINT_TOOLS.includes(state.tool)) return;
    const f = e.key === ']' ? 1.15 : 1 / 1.15;
    if (state.tool === 'hill') setHillBrush(sc.hillBrush * f);
    else if (state.tool === 'sculpt') { sc.sculptBrush = Math.round(Math.min(200, Math.max(2, sc.sculptBrush * f))); syncSceneControls(); editor.draw(); }
    else { const k = brushKey(state.tool); sc[k] = Math.round(Math.min(200, Math.max(k === 'riverBrush' ? 1 : 3, sc[k] * f))); syncSceneControls(); editor.draw(); } // subdivisión, ríos y pinceles de elementos
    e.preventDefault();
  });
  $('paintBrush').addEventListener('input', () => {
    const v = parseFloat($('paintBrush').value);
    if (state.tool === 'hill') { sc.hillBrush = v; if (app.setHillBrush) app.setHillBrush(v); } else if (state.tool === 'sculpt') { sc.sculptBrush = v; syncSceneControls(); } else sc[brushKey(state.tool)] = v; // cada pincel guarda su tamaño (subdivisión, ríos…)
    $('paintBrushVal').textContent = `${v} m`;
    editor.draw();
  });
  // controles de cerro (editan el cerro seleccionado o los valores para cerros nuevos)
  let hillEditing = false;
  const hillSet = (k, v) => {
    const t = hillTarget();
    if (t.hill && !hillEditing) { pushUndo(); hillEditing = true; }
    t.set(k, v);
    refreshHillPanel();
    if (t.hill) sceneChanged();
  };
  const hillEnd = () => { hillEditing = false; };
  const bindHill = (id, k, parse) => {
    $(id).addEventListener('input', () => { const v = parse($(id).value); if (v !== null && (typeof v !== 'number' || isFinite(v))) hillSet(k, v); });
    $(id).addEventListener('change', hillEnd);
  };
  const clampNum = (lo, hi, int = false) => (v) => { let x = parseFloat(v); if (!isFinite(x)) return null; x = Math.min(hi, Math.max(lo, x)); return int ? Math.round(x) : x; };
  bindHill('hillH', 'height', clampNum(1, 400));
  bindHill('hillHNum', 'height', clampNum(1, 400));
  bindHill('hillHeight', 'height', clampNum(1, 400));
  bindHill('hillProfile', 'hard', (v) => v === 'hard');
  bindHill('hillHard', 'hard', (v) => v === 'hard');
  bindHill('hillFlat', 'flat', clampNum(0, 1));
  bindHill('hillFlatBar', 'flat', clampNum(0, 1));
  bindHill('hillDensity', 'density', clampNum(1, 100, true));
  bindHill('hillMaxTris', 'maxTris', clampNum(50, 2000000, true));
  $('btnHillDelete').addEventListener('click', () => deleteSelectedHill());
  $('btnHillDeselect').addEventListener('click', () => selectHill(null));
  $('startGate').addEventListener('change', (e) => { sc.startGate = e.target.checked; sceneChanged(); });
  $('startText').addEventListener('input', (e) => { sc.startText = e.target.value || 'START'; sceneChanged(); });
  for (const k of ['tunnelDensity', 'portalFrame', 'portalDepth', 'startGateHeight']) num(k, k, false);
  $('btnHillTool').addEventListener('click', () => { if (!sc.terrain) { sc.terrain = true; syncSceneControls(); sceneChanged(); } setTool('hill'); });
  $('btnHillClear').addEventListener('click', () => { if (!state.hills.length) return; pushUndo(); state.hills = []; state.selHill = null; refreshHillPanel(); editor.draw(); sceneChanged(); });
  for (const k of ['tunnelShape', 'tunnelType', 'tunnelOpen']) $(k).addEventListener('change', (e) => { sc[k] = e.target.value; syncSceneControls(); sceneChanged(); });
  for (const k of ['tunnelHeight', 'caveSize', 'tunnelPillars']) num(k, k, k === 'tunnelPillars');
  document.querySelectorAll('#tunnelMeshMode button').forEach((b) => b.addEventListener('click', () => { sc.tunnelMeshMode = b.dataset.mode; syncSceneControls(); sceneChanged(); }));
  const tMax = (v) => { v = Math.round(Math.max(100, v)); if (!Number.isFinite(v)) return; sc.tunnelMaxTris = v; syncSceneControls(); sceneChanged(); };
  $('tunnelMaxTris').addEventListener('input', (e) => tMax(parseFloat(e.target.value)));
  $('tunnelMaxTrisNum').addEventListener('change', (e) => tMax(parseFloat(e.target.value)));
  $('tunnelAdapt').addEventListener('input', (e) => { sc.tunnelAdapt = Math.max(0, Math.min(1, parseFloat(e.target.value))); syncSceneControls(); sceneChanged(); });
  $('paintErase').addEventListener('change', (e) => { state.paintErase = e.target.checked; });
  $('btnPaintTool').addEventListener('click', () => { if (!sc.terrain) { sc.terrain = true; syncSceneControls(); sceneChanged(); } setTool('paint'); });
  // relieve esculpido en el terreno
  $('btnSculptTool').addEventListener('click', () => { if (!sc.terrain) { sc.terrain = true; syncSceneControls(); sceneChanged(); } setTool('sculpt'); });
  $('btnSculptClear').addEventListener('click', () => { if (!state.terrainSculpt.length) return; pushUndo(); state.terrainSculpt = []; refreshSculptInfo(); editor.draw(); sceneChanged(); });
  const sStr = (v) => { if (!(v > 0)) return; sc.sculptStrength = Math.round(Math.min(50, v) * 100) / 100; syncSceneControls(); };
  $('sculptStrength').addEventListener('input', (e) => sStr(parseFloat(e.target.value)));
  $('sculptStrengthP').addEventListener('input', (e) => sStr(parseFloat(e.target.value)));
  $('sculptBrushP').addEventListener('input', (e) => { sc.sculptBrush = Math.round(parseFloat(e.target.value)); syncSceneControls(); editor.draw(); });
  $('sculptDetail').addEventListener('change', (e) => { sc.sculptDetail = e.target.checked; sceneChanged(); });
  refreshSculptInfo();
  // decoración: biblioteca y sets
  $('btnAssetLoad').addEventListener('click', () => $('fileAssets').click());
  $('fileAssets').addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) loadAssetFiles(fs); });
  $('btnDecoNew').addEventListener('click', () => {
    pushUndo();
    let n = 1;
    while (state.decoSets.some((x) => x.name === `set_${n}`)) n++;
    const set = defaultDecoSet(`d${Date.now().toString(36)}${n}`, n);
    state.decoSets.push(set);
    state.selDeco = set.id;
    renderDecoPanel(); decoChanged();
    setTimeout(() => focusPanel('deco', document.querySelector(`#decoList .item[data-id="${set.id}"]`)), 0);
  });
  renderAssetList(); renderVegAssetLists(); renderDecoPanel();
  // modelo de referencia 3D
  $('btnRef3d').addEventListener('click', () => $('fileRef3d').click());
  $('btnRef3dTop').addEventListener('click', () => $('fileRef3d').click());
  $('fileRef3d').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importRef3dFile(f); });
  $('btnRef3dRemove').addEventListener('click', () => { if (!state.ref3d) return; state.ref3d.inner.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); state.ref3d = null; preview.setReference(null); syncRef3dControls(); editor.draw(); });
  $('btnRef3dSelect').addEventListener('click', () => { if (state.ref3d) selectRef3d(!state.ref3d.sel); });
  $('btnRef3dCenter').addEventListener('click', centerRef3d);
  $('btnRef3dReset').addEventListener('click', () => { const R = state.ref3d; if (!R) return; R.pos = [0, 0, 0]; R.rotZ = 0; R.scale = 1; preview.updateReference(); syncRef3dControls(); editor.draw(); });
  const refSet = (k, v, rebuildLook = true) => { const R = state.ref3d; if (!R) return; R[k] = v; if (k === 'locked' && v) R.sel = false; preview.updateReference(); syncRef3dControls(); editor.draw(); };
  $('ref3dVisible').addEventListener('change', (e) => refSet('visible', e.target.checked));
  $('ref3dShow2d').addEventListener('change', (e) => refSet('show2d', e.target.checked));
  $('ref3dLocked').addEventListener('change', (e) => refSet('locked', e.target.checked));
  $('ref3dGizmo').addEventListener('change', (e) => refSet('gizmo', e.target.value));
  $('ref3dLook').addEventListener('change', (e) => refSet('look', e.target.value));
  $('ref3dColor').addEventListener('input', (e) => refSet('color', e.target.value));
  $('ref3dOpacity').addEventListener('input', (e) => refSet('opacity', parseFloat(e.target.value)));
  const posSet = () => { const R = state.ref3d; if (!R) return; const v = ['ref3dX', 'ref3dY', 'ref3dZ'].map((id, i) => { const x = parseFloat($(id).value); return isFinite(x) ? x : R.pos[i]; }); R.pos = v; preview.updateReference(); editor.draw(); };
  for (const id of ['ref3dX', 'ref3dY', 'ref3dZ']) $(id).addEventListener('change', posSet);
  const rotSet = (v) => { if (!isFinite(v)) return; v = ((v + 180) % 360 + 360) % 360 - 180; refSet('rotZ', +v.toFixed(2)); };
  $('ref3dRot').addEventListener('input', (e) => rotSet(parseFloat(e.target.value)));
  $('ref3dRotNum').addEventListener('change', (e) => rotSet(parseFloat(e.target.value)));
  $('ref3dScale').addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (v > 0) refSet('scale', v); });
  const reparse = async (k, v) => { const R = state.ref3d; if (!R) return; const keep = { ...ref3dSettings(), [k]: v, sel: R.sel }; try { await loadRef3d(R.buffer, R.name, keep); } catch (err) { toast('No se pudo volver a leer el modelo: ' + err.message); } };
  $('ref3dUnit').addEventListener('change', (e) => reparse('unitOpt', e.target.value));
  $('ref3dUp').addEventListener('change', (e) => reparse('upOpt', e.target.value));
  syncRef3dControls();
  $('btnPaintClear').addEventListener('click', () => {
    const hs = state.selHill != null ? state.hills.find((h) => h.id === state.selHill) : null;
    if (hs && hs.subdiv && hs.subdiv.length) { pushUndo(); hs.subdiv = []; editor.draw(); preview.update(false); toast(`Subdivisión de ${hs.name || hillName(hs.id)} borrada.`); return; } // con un cerro seleccionado: la suya
    if (!state.densityPaint.length) return; pushUndo(); state.densityPaint = []; refreshPaintInfo(); editor.draw(); sceneChanged();
  });
  // ríos y cascadas: valores para los nuevos (barra) y botones del panel
  $('riverMode').addEventListener('change', (e) => { sc.riverMode = e.target.value; syncSceneControls(); });
  $('riverWalls').addEventListener('change', (e) => { sc.riverWalls = e.target.value; syncSceneControls(); });
  $('riverDepth').addEventListener('input', (e) => { sc.riverDepth = parseFloat(e.target.value); syncSceneControls(); });
  $('riverWallSubdiv').addEventListener('input', (e) => { sc.riverWallSubdiv = Math.round(parseFloat(e.target.value)); syncSceneControls(); });
  $('btnRiverTool').addEventListener('click', () => setTool('river'));
  // texturas propias de los tramos suspendidos (pista, barrera y camino de tierra)
  for (const [id, key] of [['suspTex', 'suspTex'], ['suspBarrierTex', 'suspBarrierTex'], ['suspDirtTex', 'suspDirtTex']]) {
    $(id + 'Btn').addEventListener('click', () => $(id + 'File').click());
    $(id + 'File').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadTexture(f, key); });
    $(id + 'Remove').addEventListener('click', () => { state[key] = null; syncSceneControls(); sceneChanged(); editor.draw(); });
  }
  $('btnSuspTool').addEventListener('click', () => setTool('susp'));
  $('caveRocks').addEventListener('change', (e) => { sc.caveRocks = e.target.checked; sceneChanged(); });
  // material de las paredes socavadas (ríos y cascadas)
  for (const [id, key] of [['riverWall', 'riverWallTex'], ['fallWall', 'fallWallTex']]) {
    $(id + 'Btn').addEventListener('click', () => $(id + 'File').click());
    $(id + 'File').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadTexture(f, key); });
    $(id + 'Remove').addEventListener('click', () => { state[key] = null; syncSceneControls(); sceneChanged(); });
  }
  $('btnRiverClear').addEventListener('click', () => { if (!state.rivers.length) return; pushUndo(); state.rivers = []; state.selRiver = null; riversChanged(); });
  // wireframe
  const wire = () => { preview.wire.on = $('wireOn').checked; preview.wire.color = $('wireColor').value; preview.wire.opacity = parseFloat($('wireOpacity').value); preview.applyWireframe(); };
  $('wireOn').addEventListener('change', wire);
  $('wireColor').addEventListener('input', wire);
  $('wireOpacity').addEventListener('input', wire);
  // F3: mostrar u ocultar el wireframe (en cualquier momento, incluso con un campo enfocado)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'F3') return;
    e.preventDefault();
    $('wireOn').checked = !$('wireOn').checked;
    wire();
    toast(`Wireframe ${$('wireOn').checked ? 'visible' : 'oculto'} (F3)`);
  });
  // cámara de juego
  const game = new GameCam(preview, app);
  preview.game = game;
  const setCam = (m) => { state.game.mode = m; game.setMode(m); document.querySelectorAll('#gameBar [data-cam]').forEach((b) => b.classList.toggle('active', b.dataset.cam === m)); };
  const exitGame = () => {
    if (!game.active) return;
    game.stop();
    $('gameBar').hidden = true;
    $('btnGame').classList.remove('active');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };
  $('btnGame').addEventListener('click', () => {
    if (game.active) { exitGame(); return; }
    if (!game.start()) { toast('Primero crea o carga una pista.'); return; }
    $('gameBar').hidden = false;
    $('btnGame').classList.add('active');
    $('btnGamePause').textContent = 'Pausa';
    setCam(state.game.mode);
  });
  document.querySelectorAll('#gameBar [data-cam]').forEach((b) => b.addEventListener('click', () => setCam(b.dataset.cam)));
  // ajustes de la cámara de juego (se guardan con el proyecto)
  const CAM_DEF = { camDist: 8.5, camHeight: 2.9, camTilt: 0, fov: 62 };
  const camCtl = [['gameCamDist', 'camDist', (v) => `${v} m`], ['gameCamHeight', 'camHeight', (v) => `${v} m`], ['gameCamTilt', 'camTilt', (v) => `${v}°`], ['gameCamFov', 'fov', (v) => `${v}°`]];
  const syncCam = () => { for (const [id, k, fmt] of camCtl) { const v = state.game[k] ?? CAM_DEF[k]; $(id).value = v; $(id + 'Val').textContent = fmt(v); } };
  for (const [id, k] of camCtl) $(id).addEventListener('input', (e) => { state.game[k] = parseFloat(e.target.value); syncCam(); });
  $('btnGameCam').addEventListener('click', () => { $('gameCamBox').hidden = !$('gameCamBox').hidden; $('btnGameCam').classList.toggle('active', !$('gameCamBox').hidden); syncCam(); });
  $('btnGameCamReset').addEventListener('click', () => { Object.assign(state.game, CAM_DEF); syncCam(); });
  syncCam();
  app.syncGameCam = syncCam;
  // velocidad: negativa = marcha atrás
  const speedLabel = (v) => `${v} km/h${v < 0 ? ' (marcha atrás)' : v === 0 ? ' (detenido)' : ''}`;
  const setSpeed = (v, from) => {
    if (!isFinite(v)) return;
    state.game.speed = Math.max(-400, Math.min(600, v));
    if (from !== 'range') $('gameSpeed').value = Math.max(-200, Math.min(320, state.game.speed));
    if (from !== 'num') $('gameSpeedNum').value = state.game.speed;
    $('gameSpeedVal').textContent = speedLabel(state.game.speed);
  };
  setSpeed(state.game.speed, null);
  $('gameSpeed').addEventListener('input', (e) => setSpeed(parseFloat(e.target.value), 'range'));
  $('gameSpeedNum').addEventListener('change', (e) => setSpeed(parseFloat(e.target.value), 'num'));
  $('btnGamePause').addEventListener('click', () => { game.paused = !game.paused; $('btnGamePause').textContent = game.paused ? 'Seguir' : 'Pausa'; });
  $('btnGameRestart').addEventListener('click', () => { game.s = 0; game.lapTime = 0; game.snapCamera = true; });
  $('btnGameFull').addEventListener('click', () => { const el = document.querySelector('.view3d'); if (document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen?.().catch(() => toast('El navegador no permitió la pantalla completa.')); });
  $('btnGameExit').addEventListener('click', exitGame);
  document.addEventListener('keydown', (e) => {
    if (!game.active) return;
    const t = e.target || {};
    const typing = (t.tagName === 'INPUT' && ['text', 'number', 'search', 'email'].includes(t.type)) || t.tagName === 'TEXTAREA';
    if (typing) return;
    if (e.key === 'c' || e.key === 'C') setCam(state.game.mode === 'third' ? 'first' : 'third');
    else if (e.key === ' ') { e.preventDefault(); $('btnGamePause').click(); }
    else if (e.key === 'Escape' && !document.fullscreenElement) exitGame();
  });
  // cielo
  $('btnSkyLoad').addEventListener('click', () => $('fileSky').click());
  $('fileSky').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const bmp = await createImageBitmap(f);
      const k = Math.min(1, 4096 / bmp.width);
      const cv = document.createElement('canvas');
      cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      state.skyTex = cv; state.skyCustom = true;
      refreshSkyThumb(); game.applySky();
    } catch (err) { toast('No se pudo leer el cielo: ' + err.message); }
  });
  $('btnSkyReset').addEventListener('click', () => { state.skyTex = makeDefaultSky(); state.skyCustom = false; refreshSkyThumb(); game.applySky(); });
  $('terrainMaxPolys').addEventListener('change', () => { sc.terrainMaxPolys = Math.max(500, parseInt($('terrainMaxPolys').value, 10) || 200000); syncSceneControls(); sceneChanged(); });
  $('treeSeed').addEventListener('change', () => { sc.treeSeed = parseInt($('treeSeed').value, 10) || 0; sceneChanged(); });
  $('btnTreeDice').addEventListener('click', () => { sc.treeSeed = Math.floor(Math.random() * 99999); syncSceneControls(); sceneChanged(); });
  for (const k of VEG_CHECKS) $(k).addEventListener('change', (e) => { sc[k] = e.target.checked; syncSceneControls(); sceneChanged(); });
  for (const k of ['treeSide', 'grassSide', 'trackTexDir']) $(k).addEventListener('change', (e) => { sc[k] = e.target.value; sceneChanged(); });
  $('btnGrassTex').addEventListener('click', () => $('fileGrassTex').click());
  $('fileGrassTex').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadTexture(f, 'grassTex'); });
  $('btnGrassTexRemove').addEventListener('click', () => { state.grassTex = null; syncSceneControls(); sceneChanged(); });
  // pares slider + número
  const pair = (range, numId, key, min, isInt) => {
    const apply = (v) => {
      v = Math.max(min, isInt ? Math.round(v) : v);
      if (!isFinite(v)) return;
      sc[key] = v;
      syncSceneControls();
      sceneChanged();
    };
    $(range).addEventListener('input', () => apply(parseFloat($(range).value)));
    $(numId).addEventListener('change', () => apply(parseFloat($(numId).value)));
  };
  pair('trackTexReps', 'trackTexRepsNum', 'trackTexReps', 1, true);
  pair('tunnelWidth', 'tunnelWidthNum', 'tunnelWidth', 4, false);
  pair('terrainTexRepX', 'terrainTexRepXNum', 'terrainTexRepX', 0.1, false);
  pair('terrainTexRepY', 'terrainTexRepYNum', 'terrainTexRepY', 0.1, false);
  pair('riverWallTile', 'riverWallTileNum', 'riverWallTile', 0.5, false); // paredes socavadas de ríos y cascadas
  // texturas
  $('btnTrackTex').addEventListener('click', () => $('fileTrackTex').click());
  $('fileTrackTex').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadTexture(f, 'trackTex'); });
  $('btnTrackTexRemove').addEventListener('click', () => { state.trackTex = null; syncSceneControls(); sceneChanged(); });
  $('btnBridgeTex').addEventListener('click', () => $('fileBridgeTex').click());
  $('fileBridgeTex').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadTexture(f, 'bridgeTex'); });
  $('btnBridgeTexRemove').addEventListener('click', () => { state.bridgeTex = null; syncSceneControls(); sceneChanged(); });
  // tipo de terreno: bosque / playa / montaña
  document.querySelectorAll('#terrainType button').forEach((b) => b.addEventListener('click', () => {
    sc.terrainType = b.dataset.type;
    if (!sc.terrain) sc.terrain = true;
    syncSceneControls(); sceneChanged();
  }));
  for (const k of ['coastSide', 'cliffSide']) $(k).addEventListener('change', (e) => { sc[k] = e.target.value; syncSceneControls(); sceneChanged(); });
  pair('coastLand', 'coastLandNum', 'coastLand', 0, true);
  pair('coastBeach', 'coastBeachNum', 'coastBeach', 1, true);
  pair('coastHeight', 'coastHeightNum', 'coastHeight', 0.5, false);
  pair('cliffHeight', 'cliffHeightNum', 'cliffHeight', 2, true);
  pair('wallHeight', 'wallHeightNum', 'wallHeight', 1, true);
  // bordes de la pista: camino de tierra y barrera
  for (const k of ['dirtSide', 'barrierSide']) $(k).addEventListener('change', (e) => { sc[k] = e.target.value; syncSceneControls(); sceneChanged(); });
  pair('dirtWidth', 'dirtWidthNum', 'dirtWidth', 0.2, false);
  pair('dirtTile', 'dirtTileNum', 'dirtTile', 0.5, false);
  pair('barrierHeight', 'barrierHeightNum', 'barrierHeight', 0.1, false);
  pair('barrierThick', 'barrierThickNum', 'barrierThick', 0, false); // 0 = plano de una cara
  pair('barrierTile', 'barrierTileNum', 'barrierTile', 0.5, false);
  // textura propia de los tramos cubiertos (las de cada atajo están en su tarjeta)
  for (const [btn, file, rem, key] of [['btnCoveredTex', 'fileCoveredTex', 'btnCoveredTexRemove', 'coveredTex']]) {
    $(btn).addEventListener('click', () => $(file).click());
    $(file).addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadTexture(f, key); });
    $(rem).addEventListener('click', () => { state[key] = null; syncSceneControls(); sceneChanged(); });
  }
  $('btnBarrierTex').addEventListener('click', () => $('fileBarrierTex').click());
  $('fileBarrierTex').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadTexture(f, 'barrierTex'); });
  $('btnBarrierTexRemove').addEventListener('click', () => { state.barrierTex = null; syncSceneControls(); sceneChanged(); });
  $('btnDirtTex').addEventListener('click', () => $('fileDirtTex').click());
  $('fileDirtTex').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadTexture(f, 'dirtTex'); });
  $('btnDirtTexRemove').addEventListener('click', () => { state.dirtTex = null; syncSceneControls(); sceneChanged(); });
  // geometría de la pista (densidad del trazado)
  {
    const trackMeshChanged = () => { syncSceneControls(); preview.update(false, true); };
    document.querySelectorAll('#trackMeshMode button').forEach((b) => b.addEventListener('click', () => { sc.trackMeshMode = b.dataset.mode; trackMeshChanged(); }));
    const dens = (v) => { v = Math.round(Math.max(1, Math.min(100, v))); if (!isFinite(v)) return; sc.trackDensity = v; trackMeshChanged(); };
    $('trackDensity').addEventListener('input', (e) => dens(parseFloat(e.target.value)));
    $('trackDensityNum').addEventListener('change', (e) => dens(parseFloat(e.target.value)));
    const cap = (v) => { v = Math.round(Math.max(200, v)); if (!isFinite(v)) return; sc.trackMaxTris = v; trackMeshChanged(); };
    $('trackMaxTris').addEventListener('input', (e) => cap(parseFloat(e.target.value)));
    $('trackMaxTrisNum').addEventListener('change', (e) => cap(parseFloat(e.target.value)));
    $('trackAdapt').addEventListener('input', (e) => { sc.trackAdapt = Math.max(0, Math.min(1, parseFloat(e.target.value))); trackMeshChanged(); });
  }
  $('trackTexOpacity').addEventListener('input', () => { sc.trackTexOpacity = parseFloat($('trackTexOpacity').value); $('trackTexOpacityVal').textContent = `${Math.round(sc.trackTexOpacity * 100)} %`; preview.update(false, true); editor.draw(); });
  $('btnTerrainTex').addEventListener('click', () => $('fileTerrainTex').click());
  $('fileTerrainTex').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadTexture(f, 'terrainTex'); });
  $('btnTerrainTexRemove').addEventListener('click', () => { state.terrainTex = null; syncSceneControls(); sceneChanged(); });
  // exportar escena
  const glb = async () => {
    if (!state.layout || !state.result) return;
    const { exportGLB } = await import('./export-glb.js');
    toast('Generando escena .glb…');
    try {
      const { buffer, info } = await exportGLB(state.layout, state.result, state.scene, { track: state.trackTex || defaultTrackCanvas(), bridge: state.bridgeTex || defaultBridgeCanvas(), barrier: state.barrierTex || defaultBarrierCanvas(), dirt: state.dirtTex || defaultDirtCanvas(), altFor: (r) => app.altTexturesFor(r), susp: state.suspTex, suspBarrier: state.suspBarrierTex, suspDirt: state.suspDirtTex, riverWall: state.riverWallTex, fallWall: state.fallWallTex, covered: app.coveredTexCanvas(), deco: decoExportInfo(), terrain: state.terrainTex, grass: state.grassTex, items: state.itemTex }, app.terrainPaintWorld(), app.hillsWorld(), itemInstances());
      download('track_scene.glb', buffer, 'model/gltf-binary');
      toast(`Escena exportada: pista ${info.trackTris.toLocaleString('es')} triángulos${info.terrainTris ? `, terreno ${info.terrainTris.toLocaleString('es')}` : ''}${info.hills ? `, ${info.hills} cerro(s)` : ''}${info.tunnels ? `, ${info.tunnels} túnel(es)` : ''}${info.gateTris ? ', pórtico de salida' : ''}${info.items ? `, ${info.items} elementos de pista` : ''}${info.trees ? `, ${info.trees} árboles` : ''}. Todo como objetos separados.`);
    } catch (err) { console.error(err); toast('No se pudo exportar la escena: ' + err.message); }
  };
  $('btnExportGLB').addEventListener('click', glb);
  $('btnExportGLB2').addEventListener('click', glb);
  const fbx = async () => {
    if (!state.layout || !state.result) return;
    const { exportFBX } = await import('./export-fbx.js');
    toast('Generando escena .fbx…');
    try {
      const { buffer, info } = await exportFBX(state.layout, state.result, state.scene, { track: state.trackTex || defaultTrackCanvas(), bridge: state.bridgeTex || defaultBridgeCanvas(), barrier: state.barrierTex || defaultBarrierCanvas(), dirt: state.dirtTex || defaultDirtCanvas(), altFor: (r) => app.altTexturesFor(r), susp: state.suspTex, suspBarrier: state.suspBarrierTex, suspDirt: state.suspDirtTex, riverWall: state.riverWallTex, fallWall: state.fallWallTex, covered: app.coveredTexCanvas(), deco: decoExportInfo(), terrain: state.terrainTex, grass: state.grassTex, items: state.itemTex }, app.terrainPaintWorld(), app.hillsWorld(), itemInstances());
      download('track_scene.fbx', buffer, 'application/octet-stream');
      toast(`FBX exportado (${(buffer.length / 1048576).toFixed(1)} MB): pista${info.terrainTris ? ', terreno' : ''}${info.hills ? `, ${info.hills} cerro(s)` : ''}${info.tunnels ? `, ${info.tunnels} túnel(es)` : ''}${info.gateTris ? ', pórtico' : ''}${info.items ? `, ${info.items} elementos de pista` : ''}${info.trees ? `, ${info.trees} árboles` : ''}${info.grass ? ', hierba' : ''}. Z arriba, en metros, con texturas incrustadas.`);
    } catch (err) { console.error(err); toast('No se pudo exportar el FBX: ' + err.message); }
  };
  $('btnExportFBX').addEventListener('click', fbx);
  $('btnExportFBX2').addEventListener('click', fbx);
  app.onTrackMeshInfo = (m) => {
    const el = $('trackMeshInfo');
    if (!el) return;
    const f = (v) => Math.round(v).toLocaleString('es');
    el.textContent = `${f(m.rows)} secciones de ${f(m.samples)} muestras · ${f(m.tris)} triángulos${m.uniTris ? ` (uniforme a esta densidad: ${f(m.uniTris)})` : ''}. ${state.scene.trackMeshMode === 'optimized' ? 'Las curvas, los cambios de pendiente, el peralte y los cambios de ancho reciben más secciones; las rectas, menos.' : 'Secciones a distancia pareja.'} El mapeado UV sigue la distancia recorrida, así que la textura se ve igual con más o menos secciones. El tope de triángulos manda sobre la densidad.`;
  };
  app.onSceneInfo = (info) => {
    $('terrainInfo').textContent = state.scene.terrain ? `Terreno: ${info.terrainTris.toLocaleString('es')} triángulos, celda de ${info.terrainCell.toFixed(1)} m${info.terrainCellFine ? ` (${info.terrainCellFine.toFixed(1)} m en lo pintado)` : ''} · ${info.ms.toFixed(0)} ms. Nunca atraviesa la pista: queda al menos ${state.scene.terrainGap} m bajo su superficie.` : 'Desactivado.';
    $('treesInfo').textContent = state.scene.trees ? `${info.trees} árboles${info.treesOnHills ? ` (${info.treesOnHills} sobre cerros)` : ''}.${!(state.scene.treeOnSlopes || state.scene.treeOnTops) && state.hills.length ? ' Sin marcar laderas ni cima, solo van sobre el terreno.' : ''}` : 'Desactivado.';
    $('grassInfo').textContent = state.scene.grass ? `${(info.grass || 0).toLocaleString('es')} matas · ${(info.grassTris || 0).toLocaleString('es')} triángulos. Se exporta como una sola malla «hierba» con la textura recortada por transparencia.` : 'Desactivado.';
    const tl = info.tunnels || [];
    state.hillInfo = info.hills || [];
    refreshHillPanel();
    state.tunnelInfo = tl;
    if (state.selTunnel != null && !tl.some((t) => t.id === state.selTunnel)) state.selTunnel = null;
    refreshTunnelInfo();
  };
}

// ---------- ayudas (hints) sobre cada opción ----------
const HINTS = {
  btnLoadImage: 'Abre un PNG/JPG de minimapa. También puedes copiar una imagen y pegarla con Ctrl+V.',
  btnTestImage: 'Genera una imagen de minimapa con el último ejemplo elegido y la traza, para probar el trazado por imagen.',
  thr: 'Brillo que separa pista y fondo (0–255). Solo se usa si desactivas el modo automático.',
  thrAuto: 'Automático: prueba varias formas de separar la pista del fondo y se queda con la que da un circuito más limpio.',
  invert: 'Cómo está dibujada la pista en la imagen. «Pista con borde» sirve para minimapas con contorno oscuro y relleno claro. En automático se elige solo.',
  imgOpacity: 'Transparencia de la imagen de fondo en el mapa. Solo visual.',
  btnTrace: 'Vuelve a trazar la imagen con el modo y el umbral elegidos. Reemplaza el trazado actual.',
  lapLength: 'Largo real de la vuelta en metros. Define la escala de todo: ancho, pendientes y alturas se miden con esta escala.',
  width: 'Ancho de la pista en metros. Se usa para el mallado, la holgura de los cruces y los avisos de horquillas.',
  altWidthSame: 'Si está marcado, los atajos tienen el mismo ancho que la pista. Desmárcalo para darles su propio ancho (con una transición en los empalmes).',
  altWidth: 'Ancho general de las rutas alternativas. Cada atajo puede tener además su propio ancho en la lista de rutas alternativas.',
  trackDensity: 'Densidad del trazado de la pista: cuántas secciones transversales tiene la malla. 100 % = una por cada muestra de la ruta; 1 % = una cada ~16 m.',
  trackDensityNum: 'Densidad exacta en %.',
  trackMaxTris: 'Tope de triángulos de la pista (todas las rutas): si la densidad pide más, las secciones se separan.',
  trackMaxTrisNum: 'Tope exacto de triángulos de la pista (puede superar el máximo del control deslizante).',
  trackAdapt: 'Solo en «Optimizado»: al mínimo, las curvas tienen apenas algo más de geometría que las rectas; al máximo, las rectas tienen mucho menos que las curvas.',
  trackTexOpacity: 'Opacidad de la textura de la pista en las vistas 2D y 3D: bájala para ver los colores por altura que hay debajo. No cambia la exportación.',
  btnTbBridge: 'Crea un puente entre los dos extremos abiertos seleccionados (cierra el circuito), con el ancho del panel «Puntos seleccionados».',
  openOnDelete: 'Si está activado, al borrar un punto de un circuito cerrado el circuito queda abierto en ese lugar (en vez de cerrarse con un punto menos).',
  bridgeWidth: 'Ancho propio del puente (con una transición suave en sus extremos).',
  btnBridge: 'Une los dos extremos seleccionados con un puente de ancho propio.',
  btnTbRadius: 'Curva de radio fijo con los puntos seleccionados (3 o más seguidos), usando el radio del panel «Puntos seleccionados».',
  btnTbFork: 'Bifurca la pista entre el primer y el último punto seleccionado, con el lado y la separación del panel «Puntos seleccionados».',
  altFromCenter: 'Activado (por defecto): los atajos salen desde el eje de la pista y su calzada queda unos centímetros por debajo de la principal donde se superponen, para no cortarla. Desactivado: salen desde el borde de la pista, pegados borde con borde.',
  altInheritWidth: 'Los atajos toman el ancho de la pista en la salida y en la llegada, y pasan de forma gradual a su propio ancho. Desactivado: el atajo tiene su ancho desde el borde de la pista.',
  stripBorder: 'Agrega a todos los nitro strips un borde: paredes sin espesor que suben desde su contorno (una cara, sin techo), para ponerles una textura de «glow».',
  stripBorderHeight: 'Altura del borde de los nitro strips (igual para todos).',
  stripBorderHeightNum: 'Altura exacta del borde en metros.',
  btnTbPuddle: 'Agrega un grupo de charcos (water puddles) y te lleva a sus parámetros.',
  btnTbPad: 'Agrega un grupo de turbo pads y te lleva a sus parámetros.',
  btnTbStrip: 'Agrega un grupo de nitro strips y te lleva a sus parámetros.',
  btnNewPuddle: 'Crea otro grupo de charcos (puddlesA, puddlesB…), con su propia cantidad, tamaño y zonas.',
  btnNewPad: 'Crea otro grupo de turbo pads (turbopadA, turbopadB…), con su propia cantidad, medidas y zonas.',
  btnNewStrip: 'Crea otro grupo de nitro strips (nitrostripA, nitrostripB…), con su propia cantidad, largo, ancho y posición.',
  btnGenTerrain: 'Genera el terreno con los valores por defecto (si ya está activo, conserva tus valores) y te lleva a su sección.',
  btnGenTrees: 'Genera árboles con los valores por defecto (si ya están activos, conserva tus valores) y te lleva a su sección.',
  forkSide: 'Hacia dónde sale la bifurcación, según el sentido de carrera. «Por el centro»: la nueva ruta sale a un lado y la pista original se abre hacia el otro, cada una la mitad de la separación.',
  forkSep: 'Distancia máxima entre la pista y la nueva ruta, a mitad del tramo.',
  btnFork: 'Crea una ruta alternativa que sale en el primer punto seleccionado y vuelve a juntarse en el último.',
  useImageWidth: 'Toma el ancho de cada tramo desde la imagen (útil si el minimapa dibuja rectas anchas y tramos angostos).',
  detail: 'Distancia entre puntos de control del spline. Menos metros = sigue el trazo con más fidelidad; más metros = curva más limpia.',
  sketchSmooth: 'Suaviza el trazo crudo (imagen o dibujo) antes de ajustar el spline. Súbelo si el trazado sale ondulado.',
  closed: 'Circuito cerrado (vueltas) o ruta abierta de salida a meta.',
  reverse: 'Invierte el sentido de carrera. Cambia qué tramo es «A» y «B» en cada cruce.',
  hills: 'Cantidad de colinas aleatorias: 0 = plano, 100 % = amplitud máxima. Los cruces se resuelven igual.',
  hillCount: 'Cuántas ondulaciones tiene la vuelta, aproximadamente.',
  hillsMax: 'Altura de las colinas cuando «Colinas» está al 100 %.',
  lambdaMin: 'Largo mínimo de cada ondulación. Más alto = colinas largas y suaves; más bajo = lomas cortas.',
  seed: 'Número que define la forma de las colinas. La misma semilla siempre da el mismo perfil.',
  btnDice: 'Elige una semilla al azar para probar otro perfil de colinas.',
  smooth: 'Qué tan redondas son las colinas. Más alto = transiciones más suaves.',
  maxGrade: 'Pendiente máxima permitida (subida o bajada). Es un límite duro: el optimizador nunca la supera.',
  rCrest: 'Radio mínimo en la cima de una loma. Más grande = el kart no despega en las crestas.',
  rSag: 'Radio mínimo en el fondo de un valle. Más grande = compresión más suave.',
  startFlat: 'Metros planos antes y después de la meta, para la parrilla de salida.',
  clearance: 'Altura libre entre el tramo de abajo y el tablero del puente, en cada cruce.',
  deck: 'Espesor del tablero del puente. Se suma a la altura libre.',
  crossType: 'Cómo se separan los tramos en un cruce: el de arriba sube (puente), el de abajo baja (túnel) o mitad y mitad (mixto).',
  bank: 'Inclina la pista hacia el interior de las curvas.',
  bankMax: 'Inclinación lateral máxima en las curvas.',
  designSpeed: 'Velocidad usada para calcular cuánto peralte necesita cada curva.',
  knotSpacing: 'Distancia entre nudos Bézier al exportar. Menos = más nudos y más fiel; más = curva más liviana.',
  edges: 'Exporta también los bordes izquierdo y derecho como splines aparte (útil en 3ds Max para Loft/Sweep).',
  blenderMesh: 'El script de Blender asigna un perfil como bevel para que la pista se vea con su ancho y peralte al importar.',
  bankFlip: 'Invierte el signo del peralte en Blender si en tu flujo aparece al revés.',
  zExag: 'Exagera la altura solo en la vista 3D, para ver mejor las colinas: estira la pista y el terreno. Cerros, túneles, árboles, hierba y pórtico mantienen su forma y solo se apoyan. No cambia los datos.',
  drawSmooth: 'Suaviza el trazo mientras dibujas, para corregir el pulso de la mano. La línea gruesa muestra el resultado.',
  pinLocal: 'Activado: al cambiar la altura de un punto (en el perfil o en 3D) solo se mueve el tramo hasta los puntos vecinos; el resto de la pista queda igual. Desactivado: el cambio se reparte suavemente en una zona más amplia.',
  trackTexDir: 'Hacia dónde se repite la textura a lo largo de la pista: vertical = el eje V de la imagen sigue la pista (lo habitual en texturas de asfalto verticales); horizontal = el eje U.',
  trackTexReps: 'Cuántas veces se repite la textura a lo largo de la ruta principal (los atajos usan la misma densidad). Números enteros para que la vuelta cierre sin costura.',
  trackTexRepsNum: 'Repeticiones exactas a lo largo de la vuelta.',
  terrain: 'Agrega una malla de terreno que sigue la pista por debajo. Nunca atraviesa la pista: en cada punto queda bajo su superficie.',
  terrainDensity: 'Densidad de la malla del terreno: más alto = celdas más chicas, el terreno queda más pegado a la pista y hay más polígonos.',
  terrainMaxPolys: 'Tope de triángulos del terreno. Si la densidad pide más, las celdas se agrandan hasta respetar este número.',
  terrainMargin: 'Cuánto terreno se extiende alrededor de la pista.',
  terrainGap: 'Distancia mínima entre la superficie de la pista y el terreno debajo.',
  terrainFalloff: 'Distancia en la que el terreno pasa de seguir la altura de la pista al relieve general del entorno.',
  skirts: 'Agrega faldones a los costados de la pista que bajan hacia el terreno, para que no se vea el espacio entre ambos.',
  terrainTexRepX: 'Repeticiones de la textura del terreno en el eje X (de lado a lado del terreno).',
  terrainTexRepY: 'Repeticiones de la textura del terreno en el eje Y.',
  terrainTexRepXNum: 'Repeticiones exactas en X.',
  terrainTexRepYNum: 'Repeticiones exactas en Y.',
  trees: 'Agrega árboles simples (conos verdes) a los costados de la pista. Nunca se ponen encima de otro tramo de pista.',
  treeSide: 'A qué lado de la pista, según el sentido de carrera.',
  treeOnSlopes: 'Permite árboles en las laderas de los cerros. Sin marcar laderas ni cima, los árboles van solo sobre el terreno.',
  treeOnTops: 'Permite árboles en la parte superior de los cerros (sobre el 85 % de su altura).',
  treeHillDensity: 'Árboles repartidos sobre los cerros permitidos, por cada 1000 m² de cerro.',
  treeTilt: 'Inclinación de los árboles: 0 = rectos hacia arriba; 100 = alineados con la normal del suelo (perpendiculares a la superficie).',
  grass: 'Agrega matas de hierba: dos planos cruzados con una textura con transparencia.',
  grassSide: 'A qué lado de la pista va la hierba, según el sentido de carrera.',
  grassDensity: 'Matas de hierba por cada 100 m de pista y por lado.',
  grassScale: 'Tamaño de las matas de hierba.',
  grassOffset: 'Distancia mínima entre el borde de la pista y la hierba.',
  grassSpread: 'Ancho de la franja con hierba, desde la distancia al borde hacia afuera.',
  grassOnSlopes: 'Permite hierba en las laderas de los cerros. Sin marcar laderas ni cima, solo va sobre el terreno.',
  grassOnTops: 'Permite hierba en la parte superior de los cerros.',
  grassHillDensity: 'Matas de hierba repartidas sobre los cerros permitidos, por cada 1000 m².',
  grassTilt: 'Inclinación de la hierba: 0 = recta hacia arriba; 100 = alineada con la normal del suelo.',
  btnGrassTex: 'Carga una textura de hierba (PNG con transparencia; la base de la hierba abajo).',
  btnGrassTexRemove: 'Vuelve a la textura de hierba por defecto.',
  hillBrush: 'Radio del pincel para pintar cerros. También con [ y ] mientras pintas.',
  hillBrushNum: 'Radio exacto del pincel de cerros en metros.',
  treeDensity: 'Cuántos árboles por cada 100 m de pista y por lado (aproximado).',
  treeScale: 'Tamaño de los árboles. 1 = unos 9 m de alto.',
  treeOffset: 'Distancia mínima desde el borde de la pista.',
  treeSpread: 'Cuánto se alejan al azar, más allá de la distancia mínima.',
  treeSeed: 'Semilla de la distribución de árboles.',
  btnExportFBX: 'Exporta la misma escena en FBX binario (7.4): cada elemento como objeto propio con su pivote, materiales y texturas incrustadas, Z arriba y en metros. Probado en Blender; pensado también para 3ds Max, Maya, Unity o Unreal.',
  btnExportFBX2: 'Escena 3D completa en FBX (Blender, 3ds Max, Maya, Unity, Unreal).',
  btnExportGLB: 'Exporta pista con UV, terreno y árboles, con las texturas incrustadas, en un .glb (glTF binario).',
  paintSubdiv: 'Subdivisiones extra de las pinceladas que hagas ahora: cada lado de la celda del terreno se divide n + 1 veces ((n + 1)² más polígonos). Las pinceladas ya hechas conservan su valor. El tope de polígonos se sigue respetando.',
  paintSubdivP: 'Subdivisiones extra de las pinceladas que hagas ahora: cada lado de la celda del terreno se divide n + 1 veces ((n + 1)² más polígonos). Las pinceladas ya hechas conservan su valor. El tope de polígonos se sigue respetando.',
  btnPaintTool: 'Activa «Pintar subdivisión»: pinta en el mapa las zonas del terreno (o del cerro seleccionado) que necesitan más detalle. Alt o clic derecho borra.',
  btnPaintClear: 'Borra todas las zonas pintadas; el terreno vuelve a ser uniforme.',
  paintBrush: 'Radio del pincel en metros.',
  coastSide: 'Lado de la pista (según el sentido de marcha) donde está la costa. Con un solo lado, el otro es terreno de bosque.',
  cliffSide: 'Lado del acantilado (según el sentido de marcha); al otro lado se levanta una pared de roca.',
  coastLand: 'Ancho medio (irregular) de la franja de tierra entre la pista y la playa o el borde del acantilado.', coastLandNum: 'Ancho medio exacto de la franja de tierra.',
  coastBeach: 'Largo medio de la playa, desde donde termina la tierra hasta el fondo bajo el agua.', coastBeachNum: 'Largo medio exacto de la playa.',
  coastHeight: 'Cuántos metros sobre el agua queda el punto más bajo de la pista.', coastHeightNum: 'Altura exacta sobre el agua.',
  cliffHeight: 'Caída del acantilado: el agua queda esta altura bajo el punto más bajo de la pista.', cliffHeightNum: 'Altura exacta del acantilado.',
  wallHeight: 'Altura media de la pared de roca del lado opuesto al acantilado.', wallHeightNum: 'Altura media exacta de la pared de roca.',
  dirtSide: 'Camino de tierra a un costado o a ambos (izquierda / derecha según el sentido de marcha). Si hay barrera, ésta nace donde termina el camino.',
  dirtWidth: 'Ancho del camino de tierra en metros.', dirtWidthNum: 'Ancho exacto del camino de tierra.',
  dirtTile: 'Cada cuántos metros de pista se repite la textura del camino de tierra.', dirtTileNum: 'Metros por repetición de la textura del camino.',
  barrierSide: 'Barrera de contención a un costado o a ambos. Se abre sola en las salidas de los atajos; dentro de los túneles sigue, con la pared del túnel después.',
  barrierHeight: 'Altura de la barrera.', barrierHeightNum: 'Altura exacta de la barrera en metros.',
  barrierThick: 'Grosor de la barrera. Con 0 es un plano de una sola cara (mirando a la calzada).', barrierThickNum: 'Grosor exacto de la barrera en metros.',
  barrierTile: 'Tiling de la barrera: metros de pista por cada repetición de la textura (rojo + blanco en la de por defecto).', barrierTileNum: 'Metros por repetición de la textura de la barrera.',
  btnBarrierTex: 'Carga una textura para la barrera: U a lo largo, V de abajo hacia arriba.', btnDirtTex: 'Carga una textura para el camino de tierra: U a lo ancho, V a lo largo.',
  tunnelMaxTris: 'Tope de triángulos de cada túnel (paredes, techo y veredas): manda sobre la densidad.', tunnelMaxTrisNum: 'Tope exacto de triángulos por túnel.',
  tunnelAdapt: 'Solo en «Optimizado»: al mínimo, las curvas tienen apenas algo más de secciones que las rectas; al máximo, las rectas tienen muchas menos.',
  sculptStrength: 'Cuántos metros sube (clic derecho) o baja (clic izquierdo) cada toque del pincel en su centro; al pasar varias veces se acumula.',
  sculptStrengthP: 'Cuántos metros sube o baja cada toque del pincel de relieve en su centro.',
  sculptBrushP: 'Radio del pincel de relieve en metros (también con [ y ] mientras esculpes).',
  sculptDetail: 'Las zonas esculpidas reciben más polígonos (como lo pintado con «Pintar subdivisión»), para que el relieve se vea definido.',
  btnSculptTool: 'Activa «Esculpir relieve» en el mapa y en la vista 3D: clic derecho eleva y clic izquierdo hunde el terreno. Es parte de la misma malla del terreno.',
  btnSculptClear: 'Quita todo el relieve esculpido (Ctrl+Z lo recupera).',
  paintErase: 'Pinta borrando (también con Alt o clic derecho).',
  wireOn: 'Muestra el wireframe de pista, terreno y árboles en la vista 3D (F3 lo muestra u oculta).',
  wireColor: 'Color del wireframe.',
  wireOpacity: 'Opacidad del wireframe.',
  btnGame: 'Un auto recorre la pista solo. Tercera o primera persona, velocidad ajustable; la cámara sigue curvas, pendientes y peralte.',
  gameSpeed: 'Velocidad del auto en la cámara de juego. Negativa = marcha atrás (el auto avanza hacia atrás, mirando hacia adelante).',
  gameSpeedNum: 'Velocidad exacta en km/h (negativa = marcha atrás).',
  btnSkyLoad: 'Carga otra imagen de cielo (idealmente un panorama equirectangular 2:1). Solo se ve en la cámara de juego.',
  btnSkyReset: 'Vuelve al cielo de día por defecto.',
  btnHillTool: 'Activa «Pintar cerros» (en el mapa o en la vista 3D). Un trazo que empieza fuera de los cerros crea un cerro nuevo; si empieza sobre un cerro, lo agranda. Un clic sin arrastrar solo lo selecciona. Alt, clic derecho o «Borrar» quitan.',
  btnHillClear: 'Elimina todos los cerros.',
  hillHeight: 'Altura del cerro seleccionado (o de los cerros nuevos si no hay ninguno seleccionado).',
  hillHard: 'Colina suave: laderas redondeadas. Pared rocosa: borde casi vertical.',
  hillFlatBar: 'Qué tan plana es la cima: 0 = redondeada, al máximo = meseta plana.',
  hillH: 'Altura máxima del cerro en metros sobre el terreno.',
  hillHNum: 'Altura exacta en metros.',
  hillProfile: 'Colina suave: laderas redondeadas. Pared rocosa: borde casi vertical, como un acantilado.',
  hillFlat: 'Qué tan plana es la parte superior: 0 = cima redondeada; al máximo es una meseta plana.',
  hillDensity: 'Tamaño de los triángulos de este cerro: más densidad = triángulos más chicos y paredes más nítidas.',
  hillMaxTris: 'Tope de triángulos para este cerro. Si la densidad pide más, las celdas se agrandan hasta respetarlo.',
  btnHillDelete: 'Elimina el cerro seleccionado (también con Supr).',
  btnHillDeselect: 'Deja de editar el cerro: los controles vuelven a ser los valores para cerros nuevos (también con Esc).',
  tunnelDensity: 'Polígonos de los túneles: lados de la sección y distancia entre secciones a lo largo.',
  portalFrame: 'Grosor del marco de cada boca, alrededor de la sección del túnel.',
  portalDepth: 'Cuánto sobresale la boca por fuera del cerro.',
  startGate: 'Agrega un pórtico con cartel en la línea de meta de la ruta principal.',
  startText: 'Texto del cartel del pórtico.',
  startGateHeight: 'Altura libre bajo la viga del pórtico.',
  tunnelShape: 'Forma de la sección del túnel.',
  tunnelWidth: 'Ancho interior del túnel (como mínimo el ancho de la pista + 1 m).',
  tunnelWidthNum: 'Ancho interior exacto en metros.',
  tunnelHeight: 'Altura libre del túnel sobre la calzada. Un cerro crea túnel si supera esta altura más el techo.',
  tunnelType: 'Artificial: sección perfectamente regular en todo el recorrido. Natural: caverna irregular de roca, que puede abrirse en una bóveda con estalactitas y rocas.',
  caveSize: 'Tamaño de la caverna: al mínimo es un túnel irregular; más alto, se abre una bóveda grande con más estalactitas y rocas.',
  tunnelOpen: 'Deja abierto un costado del túnel (galería), sostenido por pilares.',
  tunnelPillars: 'Cantidad de pilares por túnel en el lado abierto (cubos estirados con el pivote en su base).',
  btnDockAll: 'Vuelve a anclar todas las ventanas flotantes al panel lateral.',
  pinLocal3d: 'Activado: al cambiar la altura de un punto solo se mueve el tramo hasta los puntos vecinos; el resto de la pista queda igual.',
  arcRadius: 'Radio de la curva en metros. Los puntos seleccionados quedan sobre una circunferencia perfecta de este radio.',
  arcRadiusNum: 'Radio exacto en metros.',
  arcTrans: 'Cuántos puntos vecinos a cada lado se reacomodan para que la entrada y la salida de la curva queden fluidas.',
  refOpacity: 'Transparencia de la imagen de referencia.',
  refScale: 'Tamaño de la imagen de referencia en porcentaje. También puedes arrastrar su esquina inferior derecha con la herramienta «Referencia».',
  refVisible: 'Muestra u oculta la imagen de referencia.',
  refAbove: 'Dibuja la imagen de referencia encima de la pista en vez de debajo.',
  showRaw: 'Muestra el trazo original (imagen o dibujo) punteado debajo del spline.',
};

function initHints() {
  const tip = document.createElement('div');
  tip.className = 'tooltip hint-tip';
  tip.hidden = true;
  document.body.appendChild(tip);
  const show = (el, text) => {
    tip.textContent = text;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const tw = Math.min(280, window.innerWidth - 20);
    tip.style.maxWidth = tw + 'px';
    let x = r.left, y = r.bottom + 6;
    tip.style.left = '0px'; tip.style.top = '0px';
    const tr = tip.getBoundingClientRect();
    if (x + tr.width > window.innerWidth - 8) x = window.innerWidth - tr.width - 8;
    if (y + tr.height > window.innerHeight - 8) y = r.top - tr.height - 6;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${y}px`;
  };
  const hide = () => (tip.hidden = true);
  const attach = (el, text) => {
    el.addEventListener('mouseenter', () => show(el, text));
    el.addEventListener('mouseleave', hide);
    el.addEventListener('focus', () => show(el, text));
    el.addEventListener('blur', hide);
  };
  // icono ⓘ junto a la etiqueta de cada parámetro
  for (const [id, text] of Object.entries(HINTS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    attach(el, text);
    const field = el.closest('.field');
    const label = field ? field.querySelector('label') : el.closest('label');
    if (label && !label.querySelector('.hint-i')) {
      const i = document.createElement('span');
      i.className = 'hint-i';
      i.textContent = '?';
      const target = label.querySelector('.val');
      if (target && field) target.before(i); else label.appendChild(i);
      attach(i, text);
    }
  }
  // los botones con title pasan a usar el mismo globo de ayuda
  document.querySelectorAll('[title]').forEach((el) => {
    const text = el.getAttribute('title');
    el.removeAttribute('title');
    if (!HINTS[el.id]) attach(el, text);
  });
}

// ---------- arranque ----------
const editor = new Editor2D($('canvas2d'), app);
const profile = new ProfileView($('canvasProfile'), app);
const preview = new Preview3D($('view3d'), app);
state.skyTex = makeDefaultSky();
bindControls();
bindSceneControls();
bindItemsPanel();
bindPanelFocus();
renderItemsPanel();
refreshSkyThumb();
syncControls();
syncSceneControls();
const panels = initPanels($('sidebar'));
initSplitters();
$('btnDockAll').addEventListener('click', () => panels.dockAll());
initHints();
initHotkeys({ toast });
setTool('pan');
loadSample('figure8');
undoStack.length = 0;
$('btnUndo').disabled = true;
window.__tsg = { state, app, editor, preview, profile }; // para depuración
