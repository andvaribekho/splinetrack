// Instrucciones de los paneles: los textos de ayuda quedan ocultos detrás de un enlace «(instrucciones)». Al pulsarlo
// se abre una ventanita arrastrable con el texto (se cierra con ✕). No son ventanas de herramientas: no se anclan.

let zTop = 1200;

/** Título de la ventanita: el del panel y, si hay, el del bloque (subtítulo) donde está el texto. */
function titleFor(el) {
  const sec = el.closest('section.panel');
  const h2 = sec && sec.querySelector('h2');
  let t = h2 ? [...h2.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim() : 'Instrucciones';
  // subtítulo anterior dentro del panel
  let p = el.previousElementSibling, sub = null;
  while (p && !sub) { if (/^H[34]$/.test(p.tagName)) sub = p.textContent.trim(); else if (p.querySelector && p.querySelector('.coll-head h3')) sub = p.querySelector('.coll-head h3').textContent.trim(); p = p.previousElementSibling; }
  if (!sub) { const coll = el.closest('.collapsible'); const h3 = coll && coll.querySelector('.coll-head h3'); if (h3) sub = h3.textContent.trim(); }
  return sub && sub.toLowerCase() !== t.toLowerCase() ? `${t} · ${sub}` : t;
}

function openPopup(group, link) {
  if (link._pop && document.body.contains(link._pop)) { link._pop.style.zIndex = ++zTop; link._pop.querySelector('.instr-body').innerHTML = group.map((e) => `<p>${e.innerHTML}</p>`).join(''); return; }
  const pop = document.createElement('div');
  pop.className = 'instr-pop';
  pop.innerHTML = `<div class="instr-head"><span class="instr-title"></span><button class="instr-x" data-noicon title="Cerrar">✕</button></div><div class="instr-body"></div>`;
  pop.querySelector('.instr-title').textContent = titleFor(group[0]);
  pop.querySelector('.instr-body').innerHTML = group.map((e) => `<p>${e.innerHTML}</p>`).join('');
  document.body.appendChild(pop);
  pop.style.zIndex = ++zTop;
  // al lado del enlace, dentro de la pantalla
  const r = link.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  let x = r.right + 12, y = r.top - 10;
  if (x + w > window.innerWidth - 8) x = Math.max(8, r.left - w - 12);
  y = Math.max(52, Math.min(window.innerHeight - h - 8, y));
  pop.style.left = `${x}px`; pop.style.top = `${y}px`;
  link._pop = pop;
  pop.querySelector('.instr-x').addEventListener('click', () => { pop.remove(); link._pop = null; });
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
 * Oculta los textos de ayuda (p.hint sin id, y lo marcado con data-instr) detrás de un enlace por grupo de textos
 * seguidos. Los textos con id que muestran información que cambia (conteos, triángulos…) quedan a la vista.
 */
export function initInstructions() {
  const set = new Set(document.querySelectorAll('section.panel p.hint:not([id]), [data-instr]'));
  const done = new Set();
  for (const el of set) {
    if (done.has(el)) continue;
    const group = [el];
    done.add(el);
    let n = el.nextElementSibling;
    while (n && set.has(n)) { group.push(n); done.add(n); n = n.nextElementSibling; }
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'instr-link';
    link.dataset.noicon = '';
    link.textContent = '(instrucciones)';
    link.title = 'Ver las instrucciones de esta sección';
    el.before(link);
    for (const g of group) g.classList.add('instr-hidden');
    link.addEventListener('click', (e) => { e.stopPropagation(); openPopup(group, link); });
  }
  // Esc cierra la ventanita de arriba
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const pops = [...document.querySelectorAll('.instr-pop')];
    if (!pops.length) return;
    pops.sort((a, b) => (+b.style.zIndex || 0) - (+a.style.zIndex || 0))[0].querySelector('.instr-x').click();
  }, true);
}
