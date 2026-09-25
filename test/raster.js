// Rasterizador mínimo para tests en Node: dibuja polilíneas gruesas en un buffer RGBA.
export function rasterize(project, W = 800, H = 600, lineWidth = 26) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { data[i * 4] = 27; data[i * 4 + 1] = 34; data[i * 4 + 2] = 48; data[i * 4 + 3] = 255; }
  const r = lineWidth / 2;
  const draw = (pts, closed) => {
    const segs = closed ? pts.length : pts.length - 1;
    for (let k = 0; k < segs; k++) {
      const a = pts[k], b = pts[(k + 1) % pts.length];
      const x0 = Math.floor(Math.min(a[0], b[0]) - r - 1), x1 = Math.ceil(Math.max(a[0], b[0]) + r + 1);
      const y0 = Math.floor(Math.min(a[1], b[1]) - r - 1), y1 = Math.ceil(Math.max(a[1], b[1]) + r + 1);
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
      for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) {
        let t = ((x - a[0]) * dx + (y - a[1]) * dy) / l2; t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(x - (a[0] + dx * t), y - (a[1] + dy * t));
        if (d <= r) { const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 232; }
      }
    }
  };
  draw(project.main.pts, project.main.closed !== false);
  for (const a of project.alts || []) draw(a.pts, false);
  return { width: W, height: H, data };
}
