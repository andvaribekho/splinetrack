// Buscador de herramientas y parámetros (barra superior, Ctrl+K o /). El índice se arma leyendo la página cada vez
// que se abre (paneles, subtítulos, etiquetas, botones, opciones de listas, ventanas de Ajustes y Exportar), así nunca
// queda desactualizado. Busca en el idioma de la interfaz y también en español, sin tildes ni mayúsculas, con palabras
// a medias, un error de tipeo y sinónimos. Al elegir: una herramienta se selecciona; cualquier otro control se muestra
// (despliega su panel, lo trae al frente o abre su ventana), se ilumina unos segundos y queda con el foco.
// Los botones de acción (generar, exportar…) solo se iluminan: no se ejecutan.
import { t, origText, getLang } from './i18n.js';

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const words = (s) => fold(s).split(/[^a-z0-9ñ+]+/).filter(Boolean);

// sinónimos (en ambos idiomas): una palabra de la búsqueda suma también estas
const SYN = {
  curva: ['spline', 'radio', 'curve'], curve: ['spline', 'radio', 'radius'], ancho: ['width', 'tramo'], width: ['ancho'],
  autosave: ['guardado automatico', 'autoguardado'], autoguardar: ['guardado automatico'], guardar: ['save', 'autoguardado'],
  idioma: ['language'], language: ['idioma'], lenguaje: ['idioma'], ingles: ['english', 'idioma'], english: ['idioma'],
  montana: ['cerro', 'mountain'], colina: ['cerro'], hill: ['cerro'], mountain: ['cerro'], cueva: ['caverna', 'tunel'], cave: ['caverna'],
  arbol: ['arboles', 'tree'], tree: ['arbol'], pasto: ['hierba', 'grass'], grass: ['hierba'], cesped: ['hierba'],
  camara: ['camera'], camera: ['camara'], auto: ['car', 'coche'], car: ['auto'], coche: ['auto'], kart: ['auto'],
  altura: ['elevacion', 'height', 'perfil'], height: ['altura', 'elevacion'], elevation: ['elevacion'], pendiente: ['grade'],
  banking: ['peralte'], bank: ['peralte'], inclinacion: ['peralte'], atajo: ['shortcut', 'ruta alternativa'], shortcut: ['atajo'],
  hotkey: ['atajos de teclado'], teclado: ['atajos de teclado'], keyboard: ['atajos de teclado'], tecla: ['atajos de teclado'],
  exportar: ['export', 'glb', 'fbx'], export: ['exportar'], trigger: ['triggers'], gatillo: ['trigger'], sombra: ['shadow'],
  suavizar: ['smooth'], smooth: ['suavizar'], borde: ['barrera', 'camino de tierra', 'edge'], barrera: ['barrier'], tierra: ['camino de tierra'],
  faldon: ['skirt'], skirt: ['faldon'], textura: ['texture'], texture: ['textura'], rio: ['river'], agua: ['rio', 'costa', 'playa'],
  puente: ['bridge'], bridge: ['puente'], tunel: ['tunnel'], tunnel: ['tunel'], meta: ['finish', 'portico'], salida: ['meta', 'portico'],
  decoracion: ['decoration', 'assets'], modelo: ['fbx', 'glb', 'model'], importar: ['cargar', 'import'], cargar: ['load', 'importar'],
  wire: ['wireframe'], malla: ['mesh', 'wireframe'], triangulos: ['polygons', 'densidad'], poligonos: ['densidad', 'triangulos'],
  brillo: ['brightness'], texto: ['tamano del texto', 'text'], fuente: ['tamano del texto'], zoom: ['encuadrar', 'fit'],
};

// cajas de opciones de la barra que solo se ven con una herramienta (o un botón de Editar puntos) activa
const BOX_TOOL = { paintBox: 'paint', sculptBox: 'sculpt', tsmoothBox: 'tsmooth', hillBox: 'hill', riverBox: 'river', editBox: 'edit', gizmoBox: 'edit' };
const SUB_BOX = { helixBox: 'btnHelix', smoothBox: 'btnSmooth', lineBox: 'btnLine', loopBox: 'btnLoop' };
const GLYPHS = /[▾▸▴◂⇥⇤⧉✕↺⋯]/g;

const KIND_LABEL = { tool: 'Herramienta', panel: 'Panel', section: 'Sección', control: 'Parámetro', button: 'Botón', option: 'Opción', popup: 'Ventana' };

export function initSearch({ panels, toast, hintOf, enterGame }) {
  const input = document.getElementById('searchBox');
  const list = document.getElementById('searchResults');
  if (!input || !list) return null;
  let items = [], results = [], sel = 0, recent = [];
  try { recent = JSON.parse(localStorage.getItem('tsg.search.recent') || '[]'); } catch { recent = []; }

  // ---------- índice ----------
  const textOf = (el) => {
    let s = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) s += n.nodeValue;
      else if (n.nodeType === 1 && !n.matches('svg, input, select, textarea, .val, .hint-i, .bi, kbd, button, .instr-btn')) s += n.textContent;
    }
    return s.replace(GLYPHS, '').replace(/\s+/g, ' ').trim();
  };
  const srcOf = (el) => {
    let s = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) s += origText(n);
      else if (n.nodeType === 1 && !n.matches('svg, input, select, textarea, .val, .hint-i, .bi, kbd, button, .instr-btn')) s += origText(n);
    }
    return s.replace(GLYPHS, '').replace(/\s+/g, ' ').trim();
  };
  const panelOf = (el) => el.closest('section.panel[data-panel]');
  const popupOf = (el) => el.closest('#settingsPop, #exportPop');
  const headOf = (sec) => { const h = sec && sec.querySelector('h2'); return h ? textOf(h) : ''; };
  const subOf = (el, sec) => {
    // subtítulo más cercano hacia arriba dentro del panel (h3/h4 o la cabecera de un bloque plegable)
    const coll = el.closest('.collapsible');
    if (coll) { const h = coll.querySelector('.coll-head h3, .coll-head'); if (h && !h.contains(el)) return textOf(h); }
    let node = el;
    while (node && node !== sec) {
      let p = node.previousElementSibling;
      while (p) {
        if (/^H[34]$/.test(p.tagName)) return textOf(p);
        const inner = p.querySelectorAll ? p.querySelectorAll('h3, h4') : [];
        if (inner.length) return textOf(inner[inner.length - 1]);
        p = p.previousElementSibling;
      }
      node = node.parentElement;
    }
    return '';
  };
  const where = (el) => {
    const pop = popupOf(el);
    if (pop) { const ttl = pop.querySelector('.instr-title'); return [ttl ? textOf(ttl) : '', subOf(el, pop)].filter(Boolean); }
    const sec = panelOf(el);
    if (sec) { const h = headOf(sec), sb = subOf(el, sec); return [h, sb && sb !== h ? sb : ''].filter(Boolean); }
    const box = el.closest('[id]') && [...Object.keys(BOX_TOOL), ...Object.keys(SUB_BOX)].map((id) => document.getElementById(id)).filter((b) => b && b.contains(el));
    if (box && box.length) {
      const out = [];
      for (const b of box) {
        if (BOX_TOOL[b.id]) { const tb = document.querySelector(`button[data-tool="${BOX_TOOL[b.id]}"]`); if (tb) out.push(textOf(tb)); }
        if (SUB_BOX[b.id]) { const sb = document.getElementById(SUB_BOX[b.id]); if (sb) out.push(textOf(sb)); }
      }
      if (out.length) return [...new Set(out)];
    }
    const bar = el.closest('.toolbar');
    if (bar) { const lb = bar.querySelector(':scope > .label'); return [el.closest('#gameBar') ? t('Cámara de juego') : lb ? textOf(lb) : t('Barra de herramientas')]; }
    if (el.closest('.topbar')) return [t('Barra superior')];
    return [];
  };
  const controlFor = (lab) => {
    if (lab.htmlFor) return document.getElementById(lab.htmlFor);
    return lab.querySelector('input:not([type=hidden]), select, textarea') || (lab.closest('.field') && lab.closest('.field').querySelector('input:not([type=hidden]), select, textarea'));
  };

  function build() {
    const out = [], seen = new Set(), ids = new Map();
    const idOf = (el) => { if (!el) return 0; if (!ids.has(el)) ids.set(el, ids.size + 1); return ids.get(el); };
    const add = (kind, el, name, src, target, extra = '') => {
      name = (name || '').replace(/[:…]+$/, '').trim();
      if (!name || name.length < 2 || !/\p{L}{2}/u.test(name)) return;
      const key = kind + '|' + name + '|' + idOf(target || el);
      if (seen.has(key)) return;
      seen.add(key);
      const path = kind === 'section' || kind === 'panel' ? where(el).slice(0, 1) : where(el);
      const hint = (hintOf && (hintOf(target) || hintOf(el))) || '';
      out.push({ kind, el, target: target || el, name, path, src: src || '', hint: typeof hint === 'string' ? hint : '', extra,
        fn: fold(name + ' ' + src), fp: fold(path.join(' ')), fh: fold(t(hint) + ' ' + hint + ' ' + extra), wn: words(name + ' ' + src) });
    };
    const scope = document.querySelectorAll('#sidebar, #sidebarRight, .topbar .top-actions, #settingsPop, #exportPop, .view .toolbar, .toolbar');
    const roots = [...scope];
    const inRoots = (fn) => roots.forEach((r) => r.querySelectorAll && fn(r));
    // herramientas
    document.querySelectorAll('button[data-tool]').forEach((b) => add('tool', b, textOf(b), srcOf(b), b));
    // paneles y subtítulos
    document.querySelectorAll('section.panel[data-panel] h2').forEach((h) => add('panel', h, textOf(h), srcOf(h), h.closest('section.panel')));
    inRoots((r) => r.querySelectorAll('h3, h4').forEach((h) => { if (!h.closest('.instr-head')) add('section', h, textOf(h), srcOf(h), h); }));
    // parámetros con etiqueta
    inRoots((r) => r.querySelectorAll('label').forEach((lab) => {
      if (lab.closest('#searchWrap')) return;
      const c = controlFor(lab);
      add('control', lab, textOf(lab), srcOf(lab), c || lab);
    }));
    // botones
    inRoots((r) => r.querySelectorAll('button').forEach((b) => {
      if (b.dataset.tool || b.closest('.instr-head') || b.matches('.instr-x, .panel-btn, .hk-x, #btnSettings, #btnExportMenu')) return;
      add('button', b, textOf(b), srcOf(b), b);
    }));
    // opciones de listas desplegables
    inRoots((r) => r.querySelectorAll('select').forEach((s) => {
      if (s.id === 'uiLang') return;
      for (const o of s.options) add('option', o, o.textContent.trim(), origText(o), s, t('en la lista'));
    }));
    // ventanas
    add('popup', document.getElementById('btnSettings'), t('Ajustes'), 'Ajustes', document.getElementById('settingsPop'));
    add('popup', document.getElementById('btnExportMenu'), t('Exportar'), 'Exportar', document.getElementById('exportPop'));
    items = out;
  }

  // ---------- búsqueda ----------
  const lev1 = (a, b) => { // ¿distancia de edición ≤ 1?
    if (a === b) return true;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    let i = 0, j = 0, d = 0;
    while (i < la && j < lb) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++d > 1) return false;
      if (la > lb) i++; else if (lb > la) j++; else { i++; j++; }
    }
    return d + (la - i) + (lb - j) <= 1;
  };
  function score(it, toks) {
    let sc = 0;
    for (const alts of toks) {
      let best = 0;
      for (const q of alts) {
        let s = 0;
        if (q.includes(' ')) { if (it.fn.includes(q)) s = 11; else if (it.fh.includes(q)) s = 3; }
        else if (it.wn.some((w) => w === q)) s = 12;
        else if (it.wn.some((w) => w.startsWith(q))) s = 9;
        else if (q.length >= 3 && it.fn.includes(q)) s = 6;
        else if (q.length >= 4 && it.wn.some((w) => lev1(w.slice(0, q.length + 1), q) || lev1(w, q))) s = 5;
        else if (q.length >= 3 && it.fp.includes(q)) s = 3;
        else if (q.length >= 4 && it.fh.includes(q)) s = 2;
        if (alts.indexOf(q) > 0) s *= 0.7; // sinónimo: vale algo menos
        best = Math.max(best, s);
      }
      if (!best) return 0; // cada palabra tiene que aparecer
      sc += best;
    }
    sc += { tool: 4, panel: 3, popup: 3, section: 2, control: 1.5, button: 1, option: 0 }[it.kind] || 0;
    if (it.fn.startsWith(toks[0][0])) sc += 3;
    if (!visible(it.target)) sc -= 1;
    return sc;
  }
  function search(q) {
    const toks = words(q).map((w) => [w, ...(SYN[w] || []).map(fold)]);
    if (!toks.length) return [];
    const res = [];
    for (const it of items) { const s = score(it, toks); if (s > 0) res.push([s, it]); }
    res.sort((a, b) => b[0] - a[0] || a[1].name.length - b[1].name.length);
    // sin repetir el mismo destino
    const out = [], used = new Set();
    for (const [, it] of res) { const k = it.target; if (used.has(k) && it.kind !== 'option') continue; used.add(k); out.push(it); if (out.length >= 12) break; }
    return out;
  }

  // ---------- lista de resultados ----------
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function render() {
    const q = input.value.trim();
    if (!q) {
      const rec = recent.map((r) => items.find((it) => it.kind === r.kind && it.src === r.src && it.path.join() === r.path)).filter(Boolean);
      results = rec.slice(0, 8);
      list.innerHTML = results.length ? `<div class="sr-head">${esc(t('Búsquedas recientes'))}</div>` + results.map(row).join('') : `<div class="sr-empty">${esc(t('Escribe el nombre de una herramienta o parámetro'))}</div>`;
    } else {
      results = search(q);
      list.innerHTML = results.length ? results.map(row).join('') : `<div class="sr-empty">${esc(t('Sin resultados'))}</div>`;
    }
    sel = Math.min(sel, Math.max(0, results.length - 1));
    list.querySelectorAll('.sr-row').forEach((r, i) => r.classList.toggle('sel', i === sel));
    list.hidden = false;
  }
  function row(it, i) {
    const off = !visible(it.target) && !canShow(it);
    const path = it.path.filter((p) => p && fold(p) !== fold(it.name)).join(' › ');
    return `<div class="sr-row${off ? ' off' : ''}" data-i="${i}"><span class="sr-kind">${esc(t(KIND_LABEL[it.kind]))}</span><span class="sr-name">${esc(it.name)}${it.kind === 'option' ? ` <span class="muted">${esc(it.extra)}</span>` : ''}</span><span class="sr-path">${esc(path)}</span></div>`;
  }

  // ---------- mostrar el elemento ----------
  const visible = (el) => !!(el && el.isConnected && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const canShow = (it) => !!(panelOf(it.target) || popupOf(it.target) || it.target.closest('#gameBar') || it.kind === 'popup');
  function openPopup(pop) {
    if (!pop || !pop.hidden) return;
    const btn = pop.id === 'settingsPop' ? document.getElementById('btnSettings') : document.getElementById('btnExportMenu');
    if (btn) btn.click();
  }
  function reveal(it) {
    const el = it.target;
    if (it.kind === 'tool') { el.click(); flash(el); return; }
    if (it.kind === 'popup') { openPopup(el); flash(el.querySelector('.instr-head') || el); return; }
    const pop = popupOf(el);
    if (pop) openPopup(pop);
    if (el.closest('#gameBar') && document.getElementById('gameBar').hidden && enterGame) enterGame();
    // opciones de una herramienta: se elige esa herramienta (y el botón de Editar puntos que abre la caja)
    for (const [id, tool] of Object.entries(BOX_TOOL)) {
      const b = document.getElementById(id);
      if (b && b.contains(el) && b.hidden) document.querySelector(`button[data-tool="${tool}"]`)?.click();
    }
    for (const [id, btn] of Object.entries(SUB_BOX)) {
      const b = document.getElementById(id);
      if (b && b.contains(el) && b.hidden) document.getElementById(btn)?.click();
    }
    // bloques plegados que lo contienen: la caja de ajuste del auto, la de la cámara, bloques .collapsible
    for (const [box, btn] of [['carAdjBox', 'btnCarAdj'], ['gameCamBox', 'btnGameCam']]) {
      const b = document.getElementById(box);
      if (b && b.hidden && b.contains(el)) document.getElementById(btn)?.click();
    }
    for (let c = el.closest('.collapsible.collapsed'); c; c = c.parentElement && c.parentElement.closest('.collapsible.collapsed')) c.classList.remove('collapsed');
    const sec = panelOf(el);
    if (sec) {
      const api = panels && panels[sec.dataset.panel];
      if (sec.classList.contains('collapsed') && api) api.setCollapsed(false);
      if (sec.classList.contains('floating')) sec.style.zIndex = String(2000);
    }
    requestAnimationFrame(() => {
      const target = visible(el) ? el : (el.closest('label, .field') && visible(el.closest('label, .field')) ? el.closest('label, .field') : null);
      if (!target) {
        if (sec) { sec.scrollIntoView({ block: 'nearest' }); flash(sec.querySelector('h2') || sec); }
        toast(t('Ese control aparece solo en cierto modo o con algo seleccionado (por ejemplo, un tramo, un túnel o «Editar puntos»).'));
        return;
      }
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const hl = target.closest('label, .field, .row') && target.tagName !== 'BUTTON' && target.tagName !== 'H2' ? (target.closest('label') || target) : target;
      flash(hl);
      if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName) && visible(el)) { try { el.focus({ preventScroll: true }); } catch { /* */ } }
    });
  }
  function flash(el) {
    if (!el) return;
    el.classList.remove('search-flash');
    void el.offsetWidth; // reinicia la animación
    el.classList.add('search-flash');
    setTimeout(() => el.classList.remove('search-flash'), 2400);
  }
  function choose(i) {
    const it = results[i];
    if (!it) return;
    recent = [{ kind: it.kind, src: it.src, path: it.path.join() }, ...recent.filter((r) => !(r.kind === it.kind && r.src === it.src && r.path === it.path.join()))].slice(0, 8);
    try { localStorage.setItem('tsg.search.recent', JSON.stringify(recent)); } catch { /* sin almacenamiento */ }
    close();
    input.blur();
    reveal(it);
  }
  function open() { build(); render(); }
  function close() { list.hidden = true; }

  input.addEventListener('focus', open);
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(results.length - 1, sel + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (input.value) { input.value = ''; render(); } else { close(); input.blur(); } }
    e.stopPropagation(); // los atajos de la app no se disparan mientras se escribe
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  list.addEventListener('pointerdown', (e) => { const r = e.target.closest('.sr-row'); if (r) { e.preventDefault(); choose(+r.dataset.i); } });
  list.addEventListener('pointermove', (e) => { const r = e.target.closest('.sr-row'); if (r && +r.dataset.i !== sel) { sel = +r.dataset.i; list.querySelectorAll('.sr-row').forEach((x, i) => x.classList.toggle('sel', i === sel)); } });
  document.addEventListener('keydown', (e) => {
    const tg = e.target || {};
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName) || tg.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); e.stopPropagation(); input.focus(); input.select(); }
    else if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); input.focus(); input.select(); }
  }, true);

  return { build, search: (q) => { build(); return search(q); }, reveal, choose: (q, i = 0) => { build(); results = search(q); choose(i); }, items: () => items, lang: getLang };
}
