// Instrucciones de los paneles: los textos de ayuda quedan ocultos y un botón con un libro, junto al título de cada
// sección, abre una ventanita arrastrable con todas sus instrucciones (se cierra con ✕ o Esc). No son ventanas de
// herramientas: no se anclan.

let zTop = 1200;
const BOOK = '<svg class="bi" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5C4 4.7 4.7 4 5.5 4H11v15H5.5c-.8 0-1.5.5-1.5 1.2zM20 5.5c0-.8-.7-1.5-1.5-1.5H13v15h5.5c.8 0 1.5.5 1.5 1.2zM4 20.2V5.5M20 20.2V5.5"/></svg>';

/** Trae una ventanita al frente (instrucciones y ajustes comparten el orden). */
export function bringToFront(el) { el.style.zIndex = ++zTop; }

/** Texto del título de la sección (sin los botones). */
function panelTitle(sec) {
  const h2 = sec && sec.querySelector('h2');
  return h2 ? [...h2.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim() : 'Instrucciones';
}
/** Subtítulo del bloque donde está el texto (si hay y no es el mismo título de la sección). */
function subFor(el, title) {
  let p = el.previousElementSibling, sub = null;
  while (p && !sub) { if (/^H[34]$/.test(p.tagName)) sub = p.textContent.trim(); p = p.previousElementSibling; }
  if (!sub) { const coll = el.closest('.collapsible'); const h3 = coll && coll.querySelector('.coll-head h3'); if (h3) sub = h3.textContent.trim(); }
  return sub && sub.toLowerCase() !== title.toLowerCase() ? sub : null;
}

function render(sec, groups) {
  const title = panelTitle(sec);
  let html = '', lastSub = null;
  for (const g of groups) {
    const sub = subFor(g[0], title);
    if (sub && sub !== lastSub) { html += `<h4>${sub}</h4>`; lastSub = sub; }
    html += g.map((e) => (e.textContent.trim() ? `<p>${e.innerHTML}</p>` : '')).join('');
  }
  return { title, html };
}

function openPopup(sec, groups, btn) {
  const { title, html } = render(sec, groups);
  if (btn._pop && document.body.contains(btn._pop)) { btn._pop.style.zIndex = ++zTop; btn._pop.querySelector('.instr-body').innerHTML = html; return; }
  const pop = document.createElement('div');
  pop.className = 'instr-pop';
  pop.innerHTML = `<div class="instr-head">${BOOK}<span class="instr-title"></span><button class="instr-x" data-noicon title="Cerrar">✕</button></div><div class="instr-body"></div>`;
  pop.querySelector('.instr-title').textContent = title;
  pop.querySelector('.instr-body').innerHTML = html;
  document.body.appendChild(pop);
  pop.style.zIndex = ++zTop;
  // al lado del botón, dentro de la pantalla
  const r = btn.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  let x = r.right + 12, y = r.top - 6;
  if (x + w > window.innerWidth - 8) x = Math.max(8, r.left - w - 12);
  y = Math.max(52, Math.min(window.innerHeight - h - 8, y));
  pop.style.left = `${x}px`; pop.style.top = `${y}px`;
  btn._pop = pop;
  btn.classList.add('on');
  const close = () => { pop.remove(); btn._pop = null; btn.classList.remove('on'); };
  pop.querySelector('.instr-x').addEventListener('click', close);
  pop._close = close;
  pop.addEventListener('pointerdown', () => { pop.style.zIndex = ++zTop; });
  const head = pop.querySelector('.instr-head');
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.instr-x')) return;
    e.preventDefault();
    head.setPointerCapture(e.pointerId);
    const sx = e.clientX, sy = e.clientY, x0 = pop.offsetLeft, y0 = pop.offsetTop;
    const move = (ev) => {
      pop.style.left = `${Math.max(0, Math.min(window.innerWidth - 60, x0 + ev.clientX - sx))}px`;
      pop.style.top = `${Math.max(44, Math.min(window.innerHeight - 30, y0 + ev.clientY - sy))}px`;
    };
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });
}

/**
 * Oculta los textos de ayuda (p.hint sin id, y lo marcado con data-instr) y pone un botón con un libro junto al título
 * de cada sección que los tenga. Los textos con id que muestran información que cambia quedan a la vista.
 */
export function initInstructions() {
  const set = new Set(document.querySelectorAll('section.panel p.hint:not([id]), [data-instr]'));
  const bySec = new Map();
  const done = new Set();
  for (const el of set) {
    if (done.has(el)) continue;
    const sec = el.closest('section.panel');
    if (!sec) continue;
    const group = [el];
    done.add(el);
    let n = el.nextElementSibling;
    while (n && set.has(n)) { group.push(n); done.add(n); n = n.nextElementSibling; }
    for (const g of group) g.classList.add('instr-hidden');
    if (!bySec.has(sec)) bySec.set(sec, []);
    bySec.get(sec).push(group);
  }
  for (const [sec, groups] of bySec) {
    const h2 = sec.querySelector('h2');
    if (!h2) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pbtn instr-btn';
    btn.dataset.noicon = '';
    btn.innerHTML = BOOK;
    btn.title = 'Click para abrir instrucciones';
    btn.setAttribute('aria-label', 'Instrucciones');
    h2.appendChild(btn);
    btn.addEventListener('pointerdown', (e) => e.stopPropagation()); // no arrastra la ventana
    btn.addEventListener('dblclick', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => { e.stopPropagation(); if (btn._pop && document.body.contains(btn._pop)) btn._pop._close(); else openPopup(sec, groups, btn); });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const pops = [...document.querySelectorAll('.instr-pop')].filter((p) => !p.hidden && p._close);
    if (!pops.length) return;
    pops.sort((a, b) => (+b.style.zIndex || 0) - (+a.style.zIndex || 0))[0]._close();
  }, true);
}

/** Alterna el fondo de las secciones ancladas (izquierda y derecha) para distinguir dónde empieza y termina cada una. */
export function initPanelStripes() {
  const restripe = () => {
    for (const box of document.querySelectorAll('.sidebar')) {
      let i = 0;
      for (const sec of box.querySelectorAll(':scope > section.panel')) {
        if (sec.classList.contains('floating') || sec.offsetParent === null) { sec.classList.remove('alt-bg'); continue; }
        sec.classList.toggle('alt-bg', i % 2 === 1);
        i++;
      }
    }
    for (const f of document.querySelectorAll('.panel.floating')) f.classList.remove('alt-bg');
  };
  const mo = new MutationObserver(() => requestAnimationFrame(restripe));
  for (const box of document.querySelectorAll('.sidebar')) mo.observe(box, { childList: true });
  restripe();
  return restripe;
}
