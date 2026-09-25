// Curva de caída del pincel de relieve: cuánto eleva (o hunde) cada toque según la distancia al centro.
// Una curva = puntos de control [[t, f], ...] con t = distancia / radio (0 = centro, 1 = borde) y f = fuerza (0..1).
// Se interpola con un spline cúbico monótono (Fritsch–Carlson) con pendiente nula en el centro y en el borde,
// así el relieve no hace punta en el centro ni escalón en el borde.

export const SCULPT_PRESETS = {
  bell: { name: 'Campana', pts: [[0, 1], [0.25, 0.8789], [0.5, 0.5625], [0.75, 0.1914], [1, 0]] },
  mesa: { name: 'Meseta dura', pts: [[0, 1], [0.86, 1], [1, 0]] },
  mesaSoft: { name: 'Meseta suave', pts: [[0, 1], [0.5, 1], [0.8, 0.3], [1, 0]] },
  gentle: { name: 'Pendiente suave', pts: [[0, 1], [0.1, 0.98], [0.3, 0.77], [0.5, 0.53], [0.7, 0.29], [0.9, 0.05], [1, 0]] },
  peak: { name: 'Punta', pts: [[0, 1], [0.06, 0.86], [0.3, 0.42], [0.65, 0.1], [1, 0]] },
};
export const DEFAULT_SCULPT_CURVE = SCULPT_PRESETS.bell.pts;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Ordena y limpia una curva: t en [0,1] creciente, extremos en t = 0 y t = 1, f en [0,1]. */
export function normCurve(pts) {
  let p = (Array.isArray(pts) ? pts : DEFAULT_SCULPT_CURVE).filter((q) => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1]))
    .map((q) => [clamp(+q[0], 0, 1), clamp(+q[1], 0, 1)]).sort((a, b) => a[0] - b[0]);
  if (p.length < 2) p = DEFAULT_SCULPT_CURVE.map((q) => q.slice());
  p[0][0] = 0;
  p[p.length - 1][0] = 1;
  const out = [p[0]];
  for (let i = 1; i < p.length - 1; i++) if (p[i][0] - out[out.length - 1][0] > 0.005 && 1 - p[i][0] > 0.005) out.push(p[i]);
  out.push(p[p.length - 1]);
  return out.map((q) => [+q[0].toFixed(4), +q[1].toFixed(4)]);
}

/** Evaluador f(t) del spline cúbico monótono de la curva. */
export function curveEval(pts) {
  const p = normCurve(pts), n = p.length;
  const x = p.map((q) => q[0]), y = p.map((q) => q[1]);
  const d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((y[i + 1] - y[i]) / (x[i + 1] - x[i]));
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  // extremos con pendiente nula (el centro no hace punta y el borde se funde con el terreno)
  m[0] = 0; m[n - 1] = 0;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
  }
  return (t) => {
    t = clamp(t, 0, 1);
    let i = 0;
    while (i < n - 2 && t > x[i + 1]) i++;
    const h = x[i + 1] - x[i], u = (t - x[i]) / h, u2 = u * u, u3 = u2 * u;
    const v = (2 * u3 - 3 * u2 + 1) * y[i] + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * y[i + 1] + (u3 - u2) * h * m[i + 1];
    return clamp(v, 0, 1);
  };
}

/** Tabla de la curva (n muestras en t ∈ [0,1]) para usarla rápido al rasterizar el relieve. */
export function curveLUT(pts, n = 65) {
  const f = curveEval(pts), out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = +f(i / (n - 1)).toFixed(5);
  out[n - 1] = 0;
  return out;
}

/** Busca el preset que coincide con la curva (o null si es personalizada). */
export function presetOf(pts) {
  const s = JSON.stringify(normCurve(pts));
  for (const [k, v] of Object.entries(SCULPT_PRESETS)) if (JSON.stringify(normCurve(v.pts)) === s) return k;
  return null;
}
