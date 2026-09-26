// Atajos de teclado de la app (reasignables en «Ajustes»). Se guardan en este navegador.
// Cada acción tiene una o más combinaciones con el formato de comboOf ("W", "Ctrl+Z", "F3", "Espacio", "[").
import { comboOf } from './hotkeys.js';

const KEY = 'tsg.keymap.v1';

export const ACTIONS = [
  { id: 'vertex', group: 'Editar puntos', label: 'Nivel vértice', def: ['1'] },
  { id: 'segment', group: 'Editar puntos', label: 'Nivel segmento', def: ['2'] },
  { id: 'move', group: 'Editar puntos', label: 'Mover', def: ['W'] },
  { id: 'rotate', group: 'Editar puntos', label: 'Rotar', def: ['E'] },
  { id: 'scale', group: 'Editar puntos', label: 'Escalar', def: ['R'] },
  { id: 'delete', group: 'Edición', label: 'Borrar lo seleccionado', def: ['Delete', 'Backspace'] },
  { id: 'undo', group: 'Edición', label: 'Deshacer', def: ['Ctrl+Z'] },
  { id: 'brushDown', group: 'Pinceles', label: 'Achicar el pincel', def: ['['] },
  { id: 'brushUp', group: 'Pinceles', label: 'Agrandar el pincel', def: [']'] },
  { id: 'focus', group: 'Vistas', label: 'Encuadrar la selección en 3D', def: ['F'] },
  { id: 'wire', group: 'Vistas', label: 'Mostrar u ocultar el wireframe', def: ['F3'] },
  { id: 'gameCam', group: 'Cámara de juego', label: 'Cambiar de cámara', def: ['C'] },
  { id: 'gamePause', group: 'Cámara de juego', label: 'Pausa', def: ['Espacio'] },
];

/** Teclas y gestos fijos (no se reasignan). */
export const FIXED = [
  ['Esc', 'Herramienta «Navegar» y quita la selección; cierra ventanas de instrucciones; sale de la cámara de juego'],
  ['Ctrl+V', 'Pegar una imagen de minimapa (o de referencia con la herramienta «Referencia»)'],
  ['Enter', 'Aplica el valor escrito en un campo numérico'],
  ['Shift / Ctrl + clic', 'Agrega puntos o segmentos a la selección (Ctrl + arrastrar: selección por área)'],
  ['Alt + clic', 'Borra un punto (en el mapa) o quita un pin (en el perfil)'],
  ['Shift (mantener)', 'Mientras pintas: usa los controles de navegación en las vistas'],
  ['Clic derecho en un botón', 'Asignarle un atajo de teclado propio'],
];

function load() { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } }
function store() { try { localStorage.setItem(KEY, JSON.stringify(over)); } catch { /* sin almacenamiento */ } }
let over = load(); // {id: [combos]} solo las cambiadas

const byId = new Map(ACTIONS.map((a) => [a.id, a]));
export function bindingOf(id) {
  const a = byId.get(id);
  if (!a) return [];
  return Array.isArray(over[id]) ? over[id] : a.def;
}
export function isDefault(id) { return !Array.isArray(over[id]); }
/** Cambia el atajo de una acción (null = por defecto, [] = sin atajo). Quita esa combinación de las otras acciones. */
export function setBinding(id, combos) {
  if (combos == null) { delete over[id]; store(); return []; }
  const taken = [];
  for (const a of ACTIONS) {
    if (a.id === id) continue;
    const cur = bindingOf(a.id);
    const left = cur.filter((c) => !combos.includes(c));
    if (left.length !== cur.length) { over[a.id] = left; taken.push(a); }
  }
  over[id] = combos.slice();
  store();
  return taken;
}
export function resetAll() { over = {}; store(); }
/** Acción que usa una combinación (o null). */
export function actionOf(combo) { return ACTIONS.find((a) => bindingOf(a.id).includes(combo)) || null; }

const SYMBOL = /^[^A-Za-z0-9]$/;
/** ¿El evento corresponde a la combinación? Tolera AltGr y Shift en símbolos ([ ] en teclados en español) y el teclado numérico. */
export function comboMatches(e, combo) {
  const c = comboOf(e);
  if (c === combo) return true;
  const k = c.endsWith('++') ? '+' : c.split('+').pop();
  const norm = (x) => x.replace(/^Num([0-9])$/, '$1');
  if (!combo.includes('+') || combo === '+') {
    if (norm(k) !== norm(combo)) return false;
    const altGr = e.getModifierState && e.getModifierState('AltGraph');
    if (SYMBOL.test(combo)) return altGr || (!e.ctrlKey && !e.metaKey && !e.altKey); // el símbolo puede requerir Shift o AltGr
    return !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
  }
  return false;
}
export function matchAction(e, id) { return bindingOf(id).some((c) => comboMatches(e, c)); }
/** Texto legible de una combinación. */
export function comboLabel(c) { return c.replace(/\bDelete\b/, 'Supr').replace(/\bBackspace\b/, 'Retroceso').replace(/\bEscape\b/, 'Esc').replace(/\bArrow(Up|Down|Left|Right)\b/, (m, d) => ({ Up: '↑', Down: '↓', Left: '←', Right: '→' })[d]); }
