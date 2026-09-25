// Divisores arrastrables: panel lateral | vistas, vista 2D | vista 3D y vistas | perfil de elevación.
// Los tamaños se recuerdan en este navegador. Doble clic en un divisor vuelve al tamaño por defecto.
const KEY = 'tsg.layout.v1';

export function initSplitters() {
  const app = document.querySelector('.app');
  const ws = document.querySelector('.workspace');
  const side = document.getElementById('sidebar');
  const v2 = document.querySelector('.view2d');
  const pr = document.querySelector('.viewProfile');
  if (!app || !ws || !side || !v2 || !pr) return;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { saved = {}; }
  const sizes = { side: saved.side || null, col: saved.col || null, prof: saved.prof || null };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(sizes)); } catch { /* sin almacenamiento */ } };
  const apply = () => {
    app.style.gridTemplateColumns = sizes.side ? `${sizes.side}px 1fr` : '';
    ws.style.gridTemplateColumns = sizes.col ? `${sizes.col}px 1fr` : '';
    ws.style.gridTemplateRows = sizes.prof ? `1fr ${sizes.prof}px auto` : '';
  };
  ws.style.position = 'relative';
  app.style.position = 'relative';
  const mk = (cls, parent, title) => {
    const d = document.createElement('div');
    d.className = `splitter ${cls}`;
    d.dataset.tip = title;
    parent.appendChild(d);
    return d;
  };
  const sSide = mk('split-v', app, 'Arrastra para cambiar el ancho del panel lateral');
  const sCol = mk('split-v', ws, 'Arrastra para repartir el ancho entre la vista 2D y la 3D');
  const sRow = mk('split-h', ws, 'Arrastra para cambiar el alto del perfil de elevación');
  const place = () => {
    const ar = app.getBoundingClientRect(), wr = ws.getBoundingClientRect();
    const sr = side.getBoundingClientRect(), r2 = v2.getBoundingClientRect(), rp = pr.getBoundingClientRect();
    Object.assign(sSide.style, { left: `${sr.right - ar.left - 3}px`, top: '0px', height: `${ar.height}px` });
    Object.assign(sCol.style, { left: `${r2.right - wr.left - 3}px`, top: '0px', height: `${r2.height}px` });
    Object.assign(sRow.style, { top: `${rp.top - wr.top - 3}px`, left: '0px', width: `${wr.width}px` });
  };
  const drag = (el, onMove) => {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('active');
      document.body.classList.add(el.classList.contains('split-h') ? 'resizing-h' : 'resizing-v');
      const move = (ev) => { onMove(ev); apply(); place(); };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        el.classList.remove('active');
        document.body.classList.remove('resizing-h', 'resizing-v');
        save();
        window.dispatchEvent(new Event('resize'));
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  };
  drag(sSide, (e) => {
    const ar = app.getBoundingClientRect();
    sizes.side = Math.round(Math.min(Math.max(220, e.clientX - ar.left), ar.width * 0.6));
  });
  drag(sCol, (e) => {
    const wr = ws.getBoundingClientRect();
    sizes.col = Math.round(Math.min(Math.max(220, e.clientX - wr.left), wr.width - 220));
  });
  drag(sRow, (e) => {
    const rp = pr.getBoundingClientRect(), r2 = v2.getBoundingClientRect();
    const bottom = rp.bottom; // el perfil termina donde empieza la barra de validación
    sizes.prof = Math.round(Math.min(Math.max(80, bottom - e.clientY), bottom - r2.top - 160));
  });
  sSide.addEventListener('dblclick', () => { sizes.side = null; apply(); place(); save(); });
  sCol.addEventListener('dblclick', () => { sizes.col = null; apply(); place(); save(); });
  sRow.addEventListener('dblclick', () => { sizes.prof = null; apply(); place(); save(); });
  apply();
  place();
  new ResizeObserver(place).observe(ws);
  new ResizeObserver(place).observe(side);
  window.addEventListener('resize', place);
}
