// Miniatura de la pista (vista en planta) para guardar dentro del proyecto .tsg.json.
import { zColor } from './editor2d.js';

/**
 * layout / elev: resultado actual. hills: cerros en metros (app.hillsWorld()) o null.
 * Devuelve un data URL JPEG (o null si no hay pista).
 */
export function makeTrackThumbnail(layout, elev, hills = null, W = 360, H = 240) {
  if (!layout || !layout.routes.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of layout.routes) {
    for (let i = 0; i < r.n; i++) {
      const h = r.w[i] / 2;
      minX = Math.min(minX, r.x[i] - h); maxX = Math.max(maxX, r.x[i] + h);
      minY = Math.min(minY, r.y[i] - h); maxY = Math.max(maxY, r.y[i] + h);
    }
  }
  const pad = 14;
  const k = Math.min((W - 2 * pad) / Math.max(1, maxX - minX), (H - 2 * pad) / Math.max(1, maxY - minY));
  const ox = W / 2 - ((minX + maxX) / 2) * k, oy = H / 2 + ((minY + maxY) / 2) * k;
  const P = (x, y) => [ox + x * k, oy - y * k]; // mundo (Y arriba) -> imagen
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#171b24'); bg.addColorStop(1, '#0d1016');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  // cerros: manchas café
  if (hills) {
    g.fillStyle = 'rgba(122,98,64,0.55)';
    for (const h of hills) for (const q of h.strokes) {
      if (q.e) continue;
      const [x, y] = P(q.x, q.y);
      g.beginPath(); g.arc(x, y, Math.max(1, q.r * k), 0, Math.PI * 2); g.fill();
    }
  }
  const zr = elev ? elev.validation : null;
  const zmin = zr ? zr.zMin : 0, span = zr ? Math.max(zr.zMax - zr.zMin, 0.5) : 1;
  // segmentos de todas las rutas ordenados por altura: lo más alto queda encima (cruces)
  const segs = [];
  layout.routes.forEach((r, kr) => {
    const zs = elev && elev.routes[kr] ? elev.routes[kr].z : null;
    const last = r.closed ? r.n : r.n - 1;
    for (let i = 0; i < last; i++) {
      const j = (i + 1) % r.n;
      const br = !!(r.bridges && r.bridges.some((b) => { const d = r.closed ? (((r.s[i] - b.s0) % r.L) + r.L) % r.L : r.s[i] - b.s0; return d >= 0 && d < b.s1 - b.s0; }));
      segs.push({ r, i, j, z: zs ? (zs[i] + zs[j]) / 2 : 0, alt: r.kind === 'alt', br });
    }
  });
  segs.sort((a, b) => a.z - b.z);
  const stroke = (sg, pass) => {
    const { r, i, j } = sg;
    const [x0, y0] = P(r.x[i], r.y[i]), [x1, y1] = P(r.x[j], r.y[j]);
    const w = Math.max(2, r.w[i] * k);
    if (pass === 0) { g.strokeStyle = '#05070b'; g.lineWidth = w + 3; }
    else { g.strokeStyle = sg.br ? '#8a5f38' : zColor((sg.z - zmin) / span); g.lineWidth = w; }
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
  };
  g.lineCap = 'round';
  for (const sg of segs) stroke(sg, 0); // contorno de todo
  for (const sg of segs) stroke(sg, 1); // calzada, lo más alto al final
  // en cada cruce, el tramo de arriba se redibuja con su contorno para que se lea el paso superior
  if (elev && elev.crossings) {
    for (const c of elev.crossings) {
      const kr = c.up === 'a' ? c.ra : c.rb, sv = c.up === 'a' ? c.sa : c.sb;
      const r = layout.routes[kr];
      if (!r) continue;
      const zs = elev.routes[kr].z;
      const ic = Math.round(sv / r.ds), half = Math.ceil(Math.max(12, r.w[0] * 2) / r.ds);
      const win = [];
      for (let q = ic - half; q < ic + half; q++) {
        if (!r.closed && (q < 0 || q >= r.n - 1)) continue;
        const i = ((q % r.n) + r.n) % r.n, j = (i + 1) % r.n;
        win.push({ r, i, j, z: (zs[i] + zs[j]) / 2 });
      }
      g.lineCap = 'butt';
      for (const sg of win) stroke(sg, 0);
      for (const sg of win) stroke(sg, 1);
      g.lineCap = 'round';
    }
  }
  // línea de meta
  const m = layout.routes[0];
  if (m && m.n > 1) {
    const [x, y] = P(m.x[0], m.y[0]);
    const nx = -m.ty[0], ny = m.tx[0], h = (m.w[0] / 2) * k + 2;
    g.strokeStyle = '#ffffff'; g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(x - nx * h, y + ny * h); g.lineTo(x + nx * h, y - ny * h); g.stroke();
  }
  return cv.toDataURL('image/jpeg', 0.82);
}
