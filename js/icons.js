// Iconos pequeños para todos los botones de la interfaz (SVG en línea, trazos propios). Se eligen por id, por
// atributos (data-tool, data-gizmo…) o por palabras del texto del botón; un MutationObserver decora también los
// botones que se crean después (tarjetas de atajos, sets de decoración, diálogos…).

const P = {
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  save: 'M5 3h11l3 3v15H5zM8 3v6h8V3M8 21v-7h8v7',
  folder: 'M3 6h6l2 2h10v11H3z',
  fileNew: 'M6 3h9l4 4v14H6zM14 3v5h5M12 11v6M9 14h6',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  brush: 'M18 3l3 3-9 9-3-3zM9 12c-3 0-5 2-5 5 0 2-1 3-2 4 4 0 8-1 9-5',
  mountain: 'M3 20l6-10 4 6 3-4 5 8z',
  sculpt: 'M3 20c3-6 5-9 7-9s3 4 5 4 3-3 6-6M3 20h18',
  fit: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  pen: 'M4 20l4-1 11-11-3-3L5 16zM14 6l3 3',
  penAlt: 'M4 20l4-1 9-9-3-3-9 9zM13 6l3 3M16 17h5M18.5 14.5v5',
  cursor: 'M5 3l14 7-6 2-2 6z',
  move: 'M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3',
  tree: 'M12 2l6 9h-4l5 7H5l5-7H6zM12 18v4',
  bridge: 'M2 9h20M4 9v11M20 9v11M4 15c3-3 5-4 8-4s5 1 8 4',
  tunnel: 'M3 20V11a9 9 0 0118 0v9M8 20v-7a4 4 0 018 0v7',
  radius: 'M4 12a8 8 0 1016 0a8 8 0 10-16 0M12 12h8',
  fork: 'M6 3v5a6 6 0 006 6M18 3v5a6 6 0 01-6 6v7',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3',
  gamepad: 'M6 8h12a4 4 0 014 4v3a3 3 0 01-5 2l-2-2H9l-2 2a3 3 0 01-5-2v-3a4 4 0 014-4zM8 11v4M6 13h4M16 12h.01M18 14h.01',
  reset: 'M4 12a8 8 0 108-8H9M4 4v5h5',
  image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15 9h.01',
  wand: 'M4 20L16 8M14 3l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 11l.7 1.3 1.3.7-1.3.7-.7 1.3-.7-1.3-1.3-.7 1.3-.7z',
  target: 'M4 12a8 8 0 1016 0a8 8 0 10-16 0M12 2v4M12 18v4M2 12h4M18 12h4',
  drop: 'M12 3s6 7 6 11a6 6 0 01-12 0c0-4 6-11 6-11z',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  dice: 'M4 4h16v16H4zM9 9h.01M15 15h.01M15 9h.01M9 15h.01M12 12h.01',
  cloud: 'M7 18h10a4 4 0 000-8 6 6 0 00-11.5 1.5A3.5 3.5 0 007 18z',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  sparkle: 'M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z',
  close: 'M6 6l12 12M18 6L6 18',
  exit: 'M10 4H4v16h6M14 8l4 4-4 4M18 12H9',
  pause: 'M8 5v14M16 5v14',
  play: 'M7 4l13 8-13 8z',
  anchor: 'M12 8v13M5 12H3a9 9 0 0018 0h-2M12 8a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
  check: 'M5 12l5 5 9-10',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  box: 'M12 2l9 5v10l-9 5-9-5V7zM12 22V12M3 7l9 5 9-5',
  extend: 'M3 12h13M12 8l4 4-4 4M20 5v14',
  flat: 'M3 17h18M6 12h12M9 7h6',
  waves: 'M2 17c3 0 3-2 6-2s3 2 6 2 3-2 6-2M2 21c3 0 3-2 6-2s3 2 6 2 3-2 6-2M17 4a3 3 0 100 6 3 3 0 000-6z',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5',
  deselect: 'M4 4h4M16 4h4M4 20h4M16 20h4M4 4v4M20 4v4M4 16v4M20 16v4',
  axisXY: 'M5 19V5M5 19h14M5 5l-2 2M5 5l2 2M19 19l-2-2M19 19l-2 2',
  axisZ: 'M12 21V4M8 8l4-4 4 4',
  uniform: 'M4 6h16M4 10h16M4 14h16M4 18h16',
  optimized: 'M4 5h16M4 8h16M4 10h16M4 16h16M4 20h16',
  fullscreen: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  chevron: 'M9 6l6 6-6 6',
  flip: 'M7 7h12l-3-3M17 17H5l3 3',
  texture: 'M4 4h16v16H4zM4 12h16M12 4v16',
  swap: 'M7 7h12l-3-3M17 17H5l3 3',
  vertex: 'M3 17c4-8 14-8 18 0M10 8h4v4h-4z',
  segment: 'M3 17c4-8 14-8 18 0M3 17h.01M21 17h.01M7 11.5c3-3 7-3 10 0',
  rotate: 'M20 12a8 8 0 11-2.3-5.6M20 4v5h-5',
  scale: 'M4 20V10h10v10zM14 10l6-6M15 4h5v5',
  smooth: 'M3 16c2-6 4-6 6 0s4 6 6 0 4-6 6 0M3 20h18',
  line: 'M4 19L20 5M4 19a1.5 1.5 0 100 .01M12 12a1.5 1.5 0 100 .01M20 5a1.5 1.5 0 100 .01',
  axisX: 'M3 12h18M17 8l4 4-4 4',
  axisY: 'M12 21V3M8 7l4-4 4 4',
  angle: 'M4 20h16M4 20L16 6M10 20a6 6 0 00-2-4.5',
};

const BY_ID = {
  btnOpen: 'folder', btnSave: 'save', btnNew: 'fileNew', btnUndo: 'undo', btnRedo: 'undo',
  btnFit: 'fit', btnProfileFit: 'fit', btnView3dReset: 'fit', btnGame: 'gamepad', btnGameFull: 'fullscreen', btnGamePause: 'pause', btnGameRestart: 'reset', btnGameExit: 'exit',
  btnTrace: 'wand', btnTestImage: 'image', btnLoadImage: 'image', btnRefLoad: 'image', btnRefRemove: 'trash',
  btnGenTerrain: 'mountain', btnGenTrees: 'tree', btnTbPuddle: 'drop', btnNewPuddle: 'drop', btnTbPad: 'bolt', btnNewPad: 'bolt', btnTbStrip: 'bolt', btnNewStrip: 'bolt',
  btnTbRadius: 'radius', btnArcApply: 'check', btnArcDone: 'deselect', btnTbFork: 'fork', btnFork: 'fork', btnTbBridge: 'bridge', btnBridge: 'bridge',
  btnCtrlMore: 'plus', btnCtrlLess: 'minus', btnCtrlReset: 'reset', btnDice: 'dice', btnTreeDice: 'dice', btnDockAll: 'anchor',
  btnSkyLoad: 'cloud', btnSkyReset: 'reset', btnPaintTool: 'brush', btnPaintClear: 'trash', btnSculptTool: 'sculpt', btnSculptClear: 'trash',
  btnSmooth: 'smooth', btnLine: 'line', btnLineChord: 'line', btnLineX: 'axisX', btnLineY: 'axisY', btnLineAngle: 'angle',
  btnHillTool: 'mountain', btnHillClear: 'trash', btnHillDelete: 'trash', btnHillDeselect: 'deselect',
  btnRef3d: 'box', btnRef3dTop: 'box', btnRef3dCenter: 'target', btnRef3dReset: 'reset', btnRef3dSelect: 'cursor', btnRef3dRemove: 'trash',
  btnAssetLoad: 'upload', btnDecoNew: 'plus', btnExportJSON: 'code', btnExportOBJ: 'box', btnExportBlender: 'download', btnExportMax: 'download',
  btnExportGLB: 'download', btnExportGLB2: 'download', btnExportFBX: 'download', btnExportFBX2: 'download',
};
const BY_TOOL = { pan: 'move', draw: 'pen', alt: 'penAlt', edit: 'cursor', extend: 'extend', start: 'flag', flat: 'flat', ref: 'image', paint: 'brush', hill: 'mountain', sculpt: 'sculpt', itemPaint: 'brush' };
const BY_GIZMO = { free: 'move', xy: 'axisXY', z: 'axisZ' };
const BY_TYPE = { forest: 'tree', beach: 'waves', mountain: 'mountain' };
const BY_CAM = { first: 'eye', third: 'gamepad' };
const BY_MODE = { uniform: 'uniform', optimized: 'optimized' };
// palabras del texto (en orden de prioridad)
const WORDS = [
  [/pausa/i, 'pause'], [/seguir|reanudar/i, 'play'], [/salir|cerrar/i, 'exit'], [/cancelar/i, 'close'],
  [/exportar|descargar|\.glb|\.fbx|\.py|\.ms\b/i, 'download'], [/guardar/i, 'save'], [/abrir|carpeta/i, 'folder'],
  [/cargar|importar|subir/i, 'upload'], [/por defecto|como la pista|reiniciar|restablecer|descartar|posición del archivo/i, 'reset'],
  [/borrar|eliminar|quitar/i, 'trash'], [/deseleccionar/i, 'deselect'], [/pintar/i, 'brush'], [/esculpir/i, 'sculpt'],
  [/cerro|montaña/i, 'mountain'], [/árbol|arbol|bosque/i, 'tree'], [/túnel|tunel/i, 'tunnel'], [/puente/i, 'bridge'],
  [/invertir/i, 'flip'], [/nuevo|agregar|añadir|^\s*\+/i, 'plus'], [/aceptar|aplicar|listo|ok\b/i, 'check'],
  [/centrar|encuadrar/i, 'target'], [/textura|imagen/i, 'image'], [/aleatori/i, 'dice'], [/seleccionar|mover/i, 'cursor'],
];

function iconFor(btn) {
  if (btn.dataset.icon) return btn.dataset.icon;
  if (btn.id && BY_ID[btn.id]) return BY_ID[btn.id];
  if (btn.id && /^btnItemTex-/.test(btn.id)) return 'upload';
  if (btn.id && /^btnItemTexRemove-/.test(btn.id)) return 'reset';
  if (btn.dataset.tool && BY_TOOL[btn.dataset.tool]) return BY_TOOL[btn.dataset.tool];
  if (btn.dataset.gizmo && BY_GIZMO[btn.dataset.gizmo]) return BY_GIZMO[btn.dataset.gizmo];
  if (btn.dataset.type && BY_TYPE[btn.dataset.type]) return BY_TYPE[btn.dataset.type];
  if (btn.dataset.cam && BY_CAM[btn.dataset.cam]) return BY_CAM[btn.dataset.cam];
  if (btn.dataset.mode && BY_MODE[btn.dataset.mode]) return BY_MODE[btn.dataset.mode];
  const t = textOf(btn);
  for (const [re, ic] of WORDS) if (re.test(t)) return ic;
  return 'chevron';
}
function textOf(btn) {
  let t = '';
  for (const n of btn.childNodes) if (!(n.nodeType === 1 && n.classList.contains('bi'))) t += n.textContent;
  return t.trim();
}
const NS = 'http://www.w3.org/2000/svg';
function makeSvg(name) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'bi');
  svg.dataset.name = name;
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', P[name] || P.chevron);
  svg.appendChild(p);
  return svg;
}

/** Pone (o actualiza) el icono de un botón. Los botones de un solo símbolo (✕, ⇄, ▾) ya son iconos: se dejan. */
export function decorateButton(btn) {
  if (!btn || btn.tagName !== 'BUTTON' || btn.dataset.noicon != null) return;
  const t = textOf(btn);
  const cur = btn.querySelector(':scope > svg.bi');
  if (t.length <= 2 && !/[a-záéíóúñ]{2}/i.test(t)) { if (cur) cur.remove(); btn.classList.remove('has-icon'); return; }
  const name = iconFor(btn);
  if (cur && cur.dataset.name === name && btn.firstChild === cur) return;
  if (cur) cur.remove();
  btn.insertBefore(makeSvg(name), btn.firstChild);
  btn.classList.add('has-icon');
}

export function decorateAll(root = document) {
  root.querySelectorAll('button').forEach(decorateButton);
}

/** Decora todos los botones y vigila los que se agreguen o cambien de texto. */
export function initButtonIcons() {
  decorateAll();
  let pending = new Set(), raf = 0;
  const flush = () => { raf = 0; const list = pending; pending = new Set(); for (const b of list) if (b.isConnected) decorateButton(b); };
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      const b = t && (t.tagName === 'BUTTON' ? t : t.closest && t.closest('button'));
      if (b) pending.add(b);
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'BUTTON') pending.add(n);
        else if (n.querySelectorAll) n.querySelectorAll('button').forEach((x) => pending.add(x));
      }
    }
    if (pending.size && !raf) raf = requestAnimationFrame(flush);
  });
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });
}
