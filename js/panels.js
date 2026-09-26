// Paneles del lateral: se pueden plegar, desanclar como ventanas flotantes redimensionables y anclar a la derecha
// (barra de herramientas derecha: arrastrando la ventana contra el borde derecho o con su botón ⇥).
const KEY = 'tsg-panels-v1';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function save(st) {
  try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* sin almacenamiento: se ignora */ }
}

export function initPanels(sidebar) {
  const st = load();
  let z = 40;
  // las ventanas flotantes se apilan entre 40 y ~1000 (los globos de ayuda van siempre encima)
  const top = (sec) => {
    if (z > 900) {
      const fl = [...document.querySelectorAll('.panel.floating')].sort((a, b) => (+a.style.zIndex || 0) - (+b.style.zIndex || 0));
      z = 40;
      for (const f of fl) f.style.zIndex = ++z;
    }
    sec.style.zIndex = ++z;
  };
  const panels = [...sidebar.querySelectorAll('section.panel[data-panel]')];
  const api = {};
  const right = document.getElementById('sidebarRight');
  st._right = Array.isArray(st._right) ? st._right : []; // orden de los paneles anclados a la derecha
  // la columna derecha solo ocupa lugar si tiene paneles
  const syncRight = () => {
    const has = !!(right && right.querySelector('section.panel'));
    document.body.classList.toggle('has-right', has);
    st._right = right ? [...right.querySelectorAll('section.panel')].map((q) => q.dataset.panel) : [];
    save(st);
    window.dispatchEvent(new Event('resize'));
  };
  // guía mientras se arrastra una ventana cerca del borde derecho
  const hintR = document.createElement('div');
  hintR.className = 'dock-hint-right';
  hintR.textContent = 'Soltar para anclar a la derecha';
  document.body.appendChild(hintR);
  const nearRight = (x) => x > window.innerWidth - 36;

  for (const sec of panels) {
    const id = sec.dataset.panel;
    const h2 = sec.querySelector('h2');
    // cuerpo = todo lo que sigue al título
    const body = document.createElement('div');
    body.className = 'panel-body';
    while (h2.nextSibling) body.appendChild(h2.nextSibling);
    sec.appendChild(body);
    // botones del encabezado
    const btns = document.createElement('span');
    btns.className = 'panel-btns';
    const bCollapse = document.createElement('button');
    bCollapse.className = 'pbtn';
    bCollapse.dataset.act = 'collapse';
    bCollapse.title = 'Plegar / desplegar';
    const bFloat = document.createElement('button');
    bFloat.className = 'pbtn';
    bFloat.dataset.act = 'float';
    const bRight = document.createElement('button');
    bRight.className = 'pbtn pbtn-right';
    bRight.dataset.act = 'right';
    bRight.textContent = '⇥';
    bRight.title = 'Anclar a la barra derecha';
    btns.append(bCollapse, bRight, bFloat);
    h2.appendChild(btns);
    const placeholder = document.createElement('div');
    placeholder.className = 'panel-placeholder';
    placeholder.dataset.for = id;

    const cfg = (st[id] = st[id] || {});
    const setCollapsed = (c) => {
      cfg.collapsed = c;
      sec.classList.toggle('collapsed', c);
      bCollapse.textContent = c ? '▸' : '▾';
      save(st);
    };
    const place = () => {
      // mantener la ventana dentro de la pantalla
      const w = sec.offsetWidth || 320, h = sec.offsetHeight || 200;
      cfg.x = Math.max(0, Math.min(window.innerWidth - Math.min(w, 120), cfg.x ?? window.innerWidth - w - 40));
      cfg.y = Math.max(44, Math.min(window.innerHeight - 40, cfg.y ?? 80));
      sec.style.left = `${cfg.x}px`;
      sec.style.top = `${cfg.y}px`;
    };
    const inRight = () => !!(right && sec.parentElement === right);
    const float = () => {
      if (sec.classList.contains('floating')) return;
      const fromRight = inRight();
      if (!fromRight) sec.before(placeholder); // desde la barra derecha el lugar en la izquierda ya está guardado
      document.body.appendChild(sec);
      sec.classList.remove('docked-right');
      cfg.right = false;
      if (fromRight) syncRight();
      sec.classList.add('floating');
      sec.style.width = `${cfg.w || 330}px`;
      sec.style.height = cfg.h ? `${cfg.h}px` : '';
      top(sec);
      cfg.floating = true;
      bFloat.textContent = '⇲';
      bFloat.title = 'Volver a anclar al panel lateral';
      if (cfg.collapsed) setCollapsed(false);
      place();
      save(st);
    };
    const dock = () => {
      if (!sec.classList.contains('floating') && !inRight()) return;
      const fromRight = inRight();
      placeholder.replaceWith(sec);
      sec.classList.remove('floating', 'docked-right');
      cfg.right = false;
      if (fromRight) syncRight();
      sec.style.cssText = '';
      cfg.floating = false;
      bFloat.textContent = '⧉';
      bFloat.title = 'Desanclar como ventana flotante';
      save(st);
    };
    /** Ancla la ventana (flotante) a la barra derecha. */
    const dockRight = (before = null) => {
      if (!right || inRight()) return;
      if (!sec.classList.contains('floating')) float(); // guarda su lugar en la izquierda
      sec.classList.remove('floating');
      sec.style.cssText = '';
      sec.classList.add('docked-right');
      if (before && before.parentElement === right) right.insertBefore(sec, before); else right.appendChild(sec);
      cfg.floating = false;
      cfg.right = true;
      bFloat.textContent = '⧉';
      bFloat.title = 'Desanclar como ventana flotante';
      if (cfg.collapsed) setCollapsed(false);
      syncRight();
    };
    bFloat.textContent = '⧉';
    bFloat.title = 'Desanclar como ventana flotante';
    bRight.addEventListener('click', (e) => { e.stopPropagation(); dockRight(); });
    bCollapse.addEventListener('click', (e) => { e.stopPropagation(); setCollapsed(!sec.classList.contains('collapsed')); });
    bFloat.addEventListener('click', (e) => { e.stopPropagation(); sec.classList.contains('floating') ? dock() : float(); });
    h2.addEventListener('dblclick', (e) => { if (!e.target.closest('.pbtn')) sec.classList.contains('floating') ? dock() : float(); });

    // arrastrar la ventana por su título
    h2.addEventListener('pointerdown', (e) => {
      if (!sec.classList.contains('floating') || e.target.closest('.pbtn') || e.button !== 0) return;
      top(sec);
      const sx = e.clientX, sy = e.clientY, x0 = cfg.x, y0 = cfg.y;
      h2.setPointerCapture(e.pointerId);
      const move = (ev) => { cfg.x = x0 + ev.clientX - sx; cfg.y = y0 + ev.clientY - sy; place(); hintR.classList.toggle('on', nearRight(ev.clientX)); };
      const up = (ev) => {
        h2.removeEventListener('pointermove', move); h2.removeEventListener('pointerup', up);
        hintR.classList.remove('on');
        if (ev && nearRight(ev.clientX)) { dockRight(); return; } // soltar contra el borde derecho: se ancla ahí
        save(st);
      };
      h2.addEventListener('pointermove', move);
      h2.addEventListener('pointerup', up);
    });
    sec.addEventListener('pointerdown', () => { if (sec.classList.contains('floating')) top(sec); });
    // guardar tamaño al redimensionar (resize: both en CSS)
    new ResizeObserver(() => {
      if (!sec.classList.contains('floating')) return;
      cfg.w = sec.offsetWidth;
      cfg.h = sec.offsetHeight;
      save(st);
    }).observe(sec);

    setCollapsed(!!cfg.collapsed);
    if (cfg.floating) float();
    api[id] = { float, dock, dockRight, setCollapsed, el: sec, cfg };
  }
  // los que estaban anclados a la derecha, en su orden
  for (const id of [...st._right]) if (api[id] && api[id].cfg.right !== false) api[id].dockRight();
  syncRight();
  window.addEventListener('resize', () => {
    for (const p of Object.values(api)) if (p.el && p.el.classList.contains('floating')) {
      const s = st[p.el.dataset.panel];
      p.el.style.left = `${Math.min(s.x, window.innerWidth - 120)}px`;
    }
  });
  api.dockAll = () => { for (const p of Object.values(api)) if (p.dock) p.dock(); };
  return api;
}
