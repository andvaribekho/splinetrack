// Atajos de teclado definidos por el usuario: clic derecho sobre cualquier botón y presionar una tecla.
// Se guardan en este navegador. Esc cancela; Supr o Retroceso quitan el atajo del botón.
const KEY = 'tsg.hotkeys.v1';
const MODS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

function load() { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } }
function store(map) { try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* sin almacenamiento */ } }

function btnText(el) {
  let t = '';
  el.childNodes.forEach((n) => { if (!(n.classList && n.classList.contains('hk'))) t += n.textContent; });
  return t.trim();
}
/** Identificador estable de un botón. */
export function buttonKey(el) {
  if (el.id) return `#${el.id}`;
  if (el.dataset.tool) return `tool:${el.dataset.tool}`;
  if (el.dataset.cam) return `cam:${el.dataset.cam}`;
  if (el.dataset.speed) return `speed:${el.dataset.speed}`;
  const t = btnText(el);
  return t ? `txt:${t}` : null;
}
function findButton(k) {
  if (k.startsWith('#')) return document.getElementById(k.slice(1));
  if (k.startsWith('tool:')) return document.querySelector(`button[data-tool="${k.slice(5)}"]`);
  if (k.startsWith('cam:')) return document.querySelector(`button[data-cam="${k.slice(4)}"]`);
  if (k.startsWith('speed:')) return document.querySelector(`button[data-speed="${k.slice(6)}"]`);
  if (k.startsWith('txt:')) return [...document.querySelectorAll('button')].find((b) => btnText(b) === k.slice(4));
  return null;
}
/** Combinación legible a partir del evento ("Ctrl+Shift+K", "F2", "Alt+1"). */
export function comboOf(e) {
  let k;
  if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) k = e.code.slice(5);
  else if (/^Numpad[0-9]$/.test(e.code)) k = `Num${e.code.slice(6)}`;
  else if (e.key === ' ') k = 'Espacio';
  else k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(k);
  return parts.join('+');
}
function label(el) {
  return btnText(el) || el.getAttribute('aria-label') || el.id || 'botón';
}

export function initHotkeys({ toast } = {}) {
  let map = load(); // {buttonKey: combo}
  let notify = () => {};
  const badge = () => {
    document.querySelectorAll('button .hk').forEach((b) => b.remove());
    for (const [k, combo] of Object.entries(map)) {
      const el = findButton(k);
      if (!el) continue;
      const s = document.createElement('span');
      s.className = 'hk';
      s.textContent = combo;
      el.appendChild(s);
    }
  };
  let dlg = null;
  const close = () => { if (dlg) { dlg.remove(); dlg = null; } window.removeEventListener('keydown', capture, true); };
  const capture = (e) => {
    if (!dlg) return;
    e.preventDefault();
    e.stopPropagation();
    if (MODS.has(e.key)) return;
    const k = dlg.dataset.key;
    if (e.key === 'Escape') { close(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (map[k]) { delete map[k]; store(map); badge(); notify(); toast && toast(`Atajo quitado de «${dlg.dataset.label}».`); }
      close();
      return;
    }
    const combo = comboOf(e);
    for (const [other, c] of Object.entries(map)) if (c === combo && other !== k) delete map[other];
    map[k] = combo;
    store(map);
    badge();
    notify();
    toast && toast(`«${dlg.dataset.label}» ahora se activa con ${combo}.`);
    close();
  };
  const open = (el) => {
    close();
    const k = buttonKey(el);
    if (!k) return;
    dlg = document.createElement('div');
    dlg.className = 'hk-dialog';
    dlg.dataset.key = k;
    dlg.dataset.label = label(el);
    dlg.innerHTML = `<b>Atajo para «${dlg.dataset.label}»</b><div>Presiona una tecla o combinación (Ctrl, Alt, Shift + tecla).</div>
      <div class="meta">Actual: <kbd>${map[k] || 'ninguno'}</kbd> · Esc cancela · Supr quita el atajo</div>`;
    document.body.appendChild(dlg);
    const r = el.getBoundingClientRect(), dr = dlg.getBoundingClientRect();
    let x = r.left, y = r.bottom + 6;
    if (x + dr.width > window.innerWidth - 8) x = window.innerWidth - dr.width - 8;
    if (y + dr.height > window.innerHeight - 8) y = r.top - dr.height - 6;
    dlg.style.left = `${Math.max(8, x)}px`;
    dlg.style.top = `${Math.max(8, y)}px`;
    window.addEventListener('keydown', capture, true);
  };
  // clic derecho sobre un botón: asignar atajo
  document.addEventListener('contextmenu', (e) => {
    const el = e.target.closest && e.target.closest('button');
    if (!el) { if (dlg && !e.target.closest('.hk-dialog')) close(); return; }
    e.preventDefault();
    open(el);
  }, true);
  document.addEventListener('pointerdown', (e) => { if (dlg && !e.target.closest('.hk-dialog')) close(); }, true);
  // disparar los atajos (antes que los atajos propios de la app)
  window.addEventListener('keydown', (e) => {
    if (dlg || MODS.has(e.key) || document.body.classList.contains('hk-capturing')) return;
    const t = e.target;
    const tag = (t && t.tagName) || '';
    if ((tag === 'INPUT' && !['checkbox', 'radio', 'range', 'button'].includes(t.type)) || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    const combo = comboOf(e);
    const k = Object.keys(map).find((q) => map[q] === combo);
    if (!k) return;
    const el = findButton(k);
    if (!el || el.disabled || !el.offsetParent) return;
    e.preventDefault();
    e.stopPropagation();
    el.click();
  }, true);
  badge();
  // los botones que se crean después (listas) también muestran su atajo
  const obs = new MutationObserver(() => { clearTimeout(badge.t); badge.t = setTimeout(() => { obs.disconnect(); badge(); obs.observe(document.body, { childList: true, subtree: true }); }, 60); });
  obs.observe(document.body, { childList: true, subtree: true });
  const listeners = [];
  notify = () => listeners.forEach((f) => f());
  const changed = () => { store(map); badge(); notify(); };
  return {
    get: () => ({ ...map }),
    clear: () => { map = {}; changed(); },
    /** [{key, combo, label, found}] de los botones con atajo propio. */
    list: () => Object.entries(map).map(([k, combo]) => { const el = findButton(k); return { key: k, combo, label: el ? label(el) : k.replace(/^(#|txt:|tool:|cam:|speed:)/, ''), found: !!el }; }),
    /** Asigna (o quita con null) el atajo de un botón; la misma combinación se quita de los otros botones. */
    set: (k, combo) => { if (combo) { for (const [o, c] of Object.entries(map)) if (c === combo && o !== k) delete map[o]; map[k] = combo; } else delete map[k]; changed(); },
    onChange: (f) => listeners.push(f),
  };
}
