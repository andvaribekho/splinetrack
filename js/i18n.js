// Idioma de la interfaz. El español es el idioma fuente: cada texto en español es su propia clave (como gettext) y el
// diccionario de cada idioma (i18n-en.js…) lo traduce. Un MutationObserver traduce todo texto de la página (nodos de
// texto y los atributos title, placeholder y aria-label) apenas aparece o cambia, así los mensajes que arma el código
// se traducen sin tocarlo. Las frases con partes variables se traducen con patrones: «{0} puntos» ↔ «{0} points».
// Lo que no vive en la página (textos dibujados en un canvas, confirm/prompt, globos de ayuda) usa t() directamente.
// Los nombres que se exportan (Pista, Terreno, triggers…) y los proyectos no cambian con el idioma.
import EN from './i18n-en.js';

export const LANGS = [['es', 'Español'], ['en', 'English']];
const DICTS = { en: EN };
const KEY = 'tsg.lang';
const ATTRS = ['title', 'placeholder', 'aria-label', 'data-group'];
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);

let lang = 'es';
let dict = null; // { exact: Map, byWord: Map(palabra → [patrones]), cache: Map }
const recT = new WeakMap(); // nodo de texto → { src, out }
const recA = new WeakMap(); // elemento → { attr: { src, out } }
const missing = new Set(); // textos sin traducción vistos (para pruebas)
const produced = new Set(); // textos ya traducidos (si vuelven a pasar por t() no son faltantes)
let observer = null;
const listeners = [];

const WORD = /\p{L}{2,}/gu;
const norm = (s) => s.trim().replace(/\s+/g, ' ');
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compile(table) {
  const exact = new Map(), byWord = new Map();
  for (let [es, en] of Object.entries(table)) {
    if (es.startsWith('__')) continue;
    es = norm(es);
    if (!/\{\d+\}/.test(es)) { exact.set(es, en); continue; }
    const parts = es.split(/\{(\d+)\}/); // literal, n, literal, n, …
    let re = '^', order = [], words = [], hasWord = false;
    for (let i = 0; i < parts.length; i++) {
      if (i % 2) { re += '([\\s\\S]*?)'; order.push(+parts[i]); continue; }
      re += reEsc(parts[i]);
      // palabras completas (una palabra pegada a una parte variable, como «proyecto{1}», no sirve de ancla)
      const lit = parts[i].toLowerCase(), ws = [...lit.matchAll(WORD)];
      for (const m of ws) {
        const glued = (m.index === 0 && i > 0) || (m.index + m[0].length === lit.length && i < parts.length - 1);
        if (!glued) words.push(m[0]);
      }
      hasWord = hasWord || ws.length > 0;
    }
    if (!hasWord) continue;
    const anchor = words.length ? words.reduce((a, b) => (b.length > a.length ? b : a)) : '';
    const p = { re: new RegExp(re + '$', 'u'), order, en, len: es.replace(/\{\d+\}/g, '').length }; // len = largo del texto fijo
    if (!byWord.has(anchor)) byWord.set(anchor, []);
    byWord.get(anchor).push(p);
  }
  for (const list of byWord.values()) list.sort((a, b) => b.len - a.len); // el patrón más específico primero
  return { exact, byWord, cache: new Map() };
}

/** Traduce una parte variable si es un texto conocido (p. ej. «derecha (ensanche solo a ese lado)»). */
function trVal(v) {
  const core = v.trim();
  if (!core || !/\p{L}/u.test(core)) return v;
  const d = dict, hit = d.exact.get(core);
  if (hit !== undefined) return v.replace(core, () => hit);
  if (inVal) return v;
  inVal = true;
  try {
    const r = lookup(core);
    if (r != null) return v.replace(core, () => r);
    // listas armadas por partes: «derecha (ensanche…)», « · bordes 300 · pórtico 42»
    const parts = core.split(/(\s+(?=\()|\s*·\s*|,\s)/);
    if (parts.length > 1) {
      let any = false;
      const out = parts.map((p, i) => {
        if (i % 2 || !p.trim()) return p;
        const q = p.trim(), h = d.exact.get(q) ?? lookup(q) ?? lookup('· ' + q)?.replace(/^·\s*/, '');
        if (h != null) { any = true; return p.replace(q, () => h); }
        return p;
      });
      if (any) return v.replace(core, () => out.join(''));
    }
    return v;
  } finally { inVal = false; }
}
let inVal = false;

/** Traduce un texto ya recortado (sin espacios al borde). Devuelve null si no hay traducción. */
function lookup(s) {
  const d = dict;
  if (!d) return null;
  const hit = d.exact.get(s);
  if (hit !== undefined) return hit;
  if (d.cache.has(s)) return d.cache.get(s);
  let out = null, best = null, bestM = null;
  const words = new Set((s.toLowerCase().match(WORD) || []));
  words.add(''); // patrones sin palabra completa de ancla
  for (const w of words) {
    const list = d.byWord.get(w);
    if (!list) continue;
    for (const p of list) {
      if (best && p.len <= best.len) break; // la lista va de más a menos específico
      const m = p.re.exec(s);
      if (m) { best = p; bestM = m; break; }
    }
  }
  // «Mensaje fijo: detalle variable» (p. ej. «No se pudo leer la imagen: <error del navegador>»); gana si su parte fija
  // es más larga que la del patrón encontrado
  const k = s.indexOf(': ');
  if (k > 0) {
    const pre = d.exact.get(s.slice(0, k + 1));
    if (pre !== undefined && (!best || k + 1 > best.len)) { best = null; out = pre + s.slice(k + 1); }
  }
  if (best) {
    const vals = {};
    best.order.forEach((n, i) => { vals[n] = trVal(bestM[i + 1]); });
    out = best.en.replace(/\{(\d+)\}/g, (_, n) => (vals[n] !== undefined ? vals[n] : ''));
  }
  if (d.cache.size > 4000) d.cache.clear();
  d.cache.set(s, out);
  return out;
}

/** Texto traducido al idioma actual (con sus espacios al borde intactos). */
export function t(s) {
  if (lang === 'es' || s == null) return s;
  s = String(s);
  const core = s.trim();
  if (!core || !/\p{L}/u.test(core)) return s;
  const key = core.replace(/\s+/g, ' ');
  if (produced.has(key)) return s;
  const tr = lookup(key);
  if (tr == null) { if (/\p{L}{2}/u.test(key)) missing.add(key); return s; }
  if (produced.size > 20000) produced.clear();
  produced.add(tr.replace(/\s+/g, ' ').trim());
  return core === s ? tr : s.replace(core, () => tr);
}

const skipped = (el) => {
  for (let e = el; e; e = e.parentElement) { if (SKIP.has(e.tagName) || (e.dataset && e.dataset.noi18n != null)) return true; }
  return false;
};

function doText(n) {
  const cur = n.nodeValue;
  let rec = recT.get(n);
  if (!rec || cur !== rec.out) {
    if (!cur || !/\p{L}{2}/u.test(cur) || skipped(n.parentElement)) { if (rec) recT.delete(n); return; }
    rec = { src: cur, out: cur };
    recT.set(n, rec);
  }
  const out = t(rec.src);
  rec.out = out;
  if (out !== cur) n.nodeValue = out;
}

function doAttr(el, a) {
  if (!el.hasAttribute(a)) return;
  const cur = el.getAttribute(a);
  let all = recA.get(el);
  let rec = all && all[a];
  if (!rec || cur !== rec.out) {
    if (!/\p{L}{2}/u.test(cur) || skipped(el)) return;
    if (!all) { all = {}; recA.set(el, all); }
    rec = all[a] = { src: cur, out: cur };
  }
  const out = t(rec.src);
  rec.out = out;
  if (out !== cur) el.setAttribute(a, out);
}

function walk(root) {
  if (root.nodeType === 3) { doText(root); return; }
  if (root.nodeType !== 1 || skipped(root)) return;
  for (const a of ATTRS) doAttr(root, a);
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === 1 && (SKIP.has(n.tagName) || n.dataset?.noi18n != null) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (n.nodeType === 3) doText(n); else for (const a of ATTRS) doAttr(n, a);
  }
}

/** Texto original (en español) de un nodo de texto, o de un atributo si se da attr. */
export function orig(node, attr) {
  if (attr) { const r = recA.get(node); return r && r[attr] && node.getAttribute(attr) === r[attr].out ? r[attr].src : node.getAttribute(attr); }
  const r = recT.get(node);
  return r && node.nodeValue === r.out ? r.src : node.nodeValue;
}
/** Texto original de un elemento completo (concatena sus nodos de texto en español). */
export function origText(el) {
  if (!el) return '';
  if (el.nodeType === 3) return orig(el);
  let s = '';
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) s += orig(n);
  return s;
}

export function getLang() { return lang; }
export function onLangChange(fn) { listeners.push(fn); }
export function missingTexts() { return [...missing]; }

function detect() {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* sin almacenamiento */ }
  if (saved && (saved === 'es' || DICTS[saved])) return saved;
  const nav = (navigator.languages && navigator.languages[0]) || navigator.language || 'es';
  const code = nav.slice(0, 2).toLowerCase();
  if (code === 'es') return 'es';
  return DICTS[code] ? code : 'en'; // otro idioma sin diccionario: inglés
}

/** Cambia el idioma: retraduce toda la página al momento (sin recargar) y avisa a quien dibuja en canvas. */
export function setLang(l, save = true) {
  if (l !== 'es' && !DICTS[l]) l = 'es';
  lang = l;
  if (l !== 'es' && DICTS[l] && !DICTS[l].__compiled) DICTS[l].__compiled = compile(DICTS[l]);
  dict = l === 'es' ? null : DICTS[l].__compiled;
  missing.clear();
  if (save) { try { localStorage.setItem(KEY, l); } catch { /* sin almacenamiento */ } }
  document.documentElement.lang = l;
  walk(document.body);
  for (const fn of listeners) { try { fn(l); } catch (e) { console.warn(e); } }
}

/** Arranque: elige el idioma (guardado o del navegador), traduce la página y vigila lo que cambie. */
export function initI18n() {
  setLang(detect(), false);
  observer = new MutationObserver((muts) => {
    if (lang === 'es') {
      // en español solo hace falta olvidar los registros de nodos cambiados (no hay nada que traducir)
      return;
    }
    for (const m of muts) {
      if (m.type === 'characterData') doText(m.target);
      else if (m.type === 'attributes') doAttr(m.target, m.attributeName);
      else for (const n of m.addedNodes) walk(n);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

/** Para pruebas: el diccionario compilado y la búsqueda directa. */
export const __i18n = {
  lookup: (s) => lookup(s),
  dicts: DICTS,
  /** Solo para pruebas sin página: elige el diccionario sin tocar el DOM. */
  use(l) { lang = l; dict = l === 'es' ? null : (DICTS[l].__compiled ||= compile(DICTS[l])); },
};

/** Hace que un contexto 2D traduzca lo que escribe (fillText, strokeText, measureText): para los canvas de la interfaz. */
export function localizeCtx(ctx) {
  if (!ctx || ctx.__i18n) return ctx;
  const P = Object.getPrototypeOf(ctx);
  ctx.fillText = function (s, ...a) { return P.fillText.call(this, t(s), ...a); };
  ctx.strokeText = function (s, ...a) { return P.strokeText.call(this, t(s), ...a); };
  ctx.measureText = function (s) { return P.measureText.call(this, t(s)); };
  ctx.__i18n = true;
  return ctx;
}
