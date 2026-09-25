// Layouts de ejemplo generados de forma paramétrica (originales, no copias de pistas reales).
// Coordenadas en "unidades de lienzo" (~800x600), y hacia abajo como en una imagen.

function param(fn, n = 240, cx = 400, cy = 300, sc = 1) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const [x, y] = fn(t);
    pts.push([cx + x * sc, cy + y * sc]);
  }
  return pts;
}

export const SAMPLES = {
  oval: {
    name: 'Óvalo con chicane (sin cruces)',
    build: () => ({
      main: {
        closed: true,
        pts: param((t) => {
          const c = Math.cos(t), s = Math.sin(t);
          const r = 1 + 0.12 * Math.sin(3 * t);
          return [Math.sign(c) * Math.pow(Math.abs(c), 0.6) * 300 * r, Math.sign(s) * Math.pow(Math.abs(s), 0.6) * 180 * r];
        }),
      },
      alts: [],
    }),
  },
  figure8: {
    name: 'Figura en 8 (1 cruce)',
    build: () => ({
      main: { closed: true, pts: param((t) => [Math.sin(t) * 320, Math.sin(t) * Math.cos(t) * 360]) },
      alts: [],
    }),
  },
  loop: {
    name: 'Rizo sobre túnel (1 cruce)',
    build: () => ({
      main: {
        closed: true,
        // limaçon con lazo interior: r = 1 + 2cos(t)
        pts: param((t) => {
          const r = 0.9 + 1.6 * Math.cos(t);
          return [r * Math.cos(t) * 130 - 120, r * Math.sin(t) * 150];
        }),
      },
      alts: [],
    }),
  },
  trefoil: {
    name: 'Estadio trébol (3 cruces)',
    lap: 1300,
    build: () => ({
      main: { closed: true, pts: param((t) => [(Math.sin(t) + 2 * Math.sin(2 * t)) * 95, (Math.cos(t) - 2 * Math.cos(2 * t)) * 85], 300) },
      alts: [],
    }),
  },
  shortcut: {
    name: 'Circuito con atajo (ruta alternativa)',
    build: () => {
      const f = (t) => [400 + Math.cos(t) * 320 + Math.sin(2 * t) * 30, 300 + Math.sin(t) * 200 + Math.cos(3 * t) * 25];
      const main = [];
      for (let i = 0; i < 240; i++) main.push(f((i / 240) * Math.PI * 2));
      // atajo: sale tangente a la principal y corta hacia el centro
      const t1 = Math.PI * 0.18, t2 = Math.PI * 0.82;
      const alt = [];
      for (let i = 0; i <= 50; i++) {
        const u = i / 50;
        const [mx, my] = f(t1 + (t2 - t1) * u);
        const b = Math.pow(Math.sin(u * Math.PI), 1.3) * 0.6;
        alt.push([mx + (400 - mx) * b, my + (300 - my) * b]);
      }
      return { main: { closed: true, pts: main }, alts: [{ pts: alt, keep: true }] };
    },
  },
  star: {
    name: 'Estrella (4 cruces)',
    lap: 1600,
    build: () => ({
      main: { closed: true, pts: param((t) => [(Math.cos(t) + 0.6 * Math.cos(3 * t)) * 170, (Math.sin(t) - 0.6 * Math.sin(3 * t)) * 170], 320) },
      alts: [],
    }),
  },
};

/** Rasteriza un layout a una imagen de minimapa (para probar el trazado por imagen). */
export function rasterizeLayout(project, width = 800, height = 600, lineWidth = 26, doc = globalThis.document) {
  const cv = doc.createElement('canvas');
  cv.width = width;
  cv.height = height;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#1b2230';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#e8e8e8';
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const path = (pts, closed) => {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    if (closed) ctx.closePath();
    ctx.stroke();
  };
  path(project.main.pts, project.main.closed !== false);
  for (const a of project.alts || []) path(a.pts, false);
  return cv;
}
