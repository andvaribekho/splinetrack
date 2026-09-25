// Texturas del pórtico de salida (solo navegador): cartel con texto y cuadros de la línea de salida.
export function makeBannerCanvas(text = 'START') {
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 160;
  const g = cv.getContext('2d');
  g.fillStyle = '#c62828';
  g.fillRect(0, 0, cv.width, cv.height);
  // franjas a cuadros en los extremos
  const sq = 20;
  for (const x0 of [0, cv.width - 4 * sq]) {
    for (let j = 0; j < cv.height / sq; j++) for (let i = 0; i < 4; i++) {
      g.fillStyle = (i + j) % 2 ? '#111' : '#fff';
      g.fillRect(x0 + i * sq, j * sq, sq, sq);
    }
  }
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = 120;
  g.font = `900 ${size}px "Arial Black", Arial, sans-serif`;
  while (g.measureText(text).width > cv.width - 200 && size > 30) { size -= 4; g.font = `900 ${size}px "Arial Black", Arial, sans-serif`; }
  g.fillText(text, cv.width / 2, cv.height / 2 + 4);
  return cv;
}

export function makeCheckerCanvas() {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 64;
  const g = cv.getContext('2d');
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { g.fillStyle = (i + j) % 2 ? '#111' : '#f5f5f5'; g.fillRect(i * 32, j * 32, 32, 32); }
  return cv;
}

/** Textura de hierba por defecto: matas de hojas finas sobre fondo transparente (256×256, base abajo). */
export function makeGrassCanvas(seed = 11) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 256;
  const g = cv.getContext('2d');
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let k = 0; k < 70; k++) {
    const x0 = 20 + rnd() * 216;
    const h = 110 + rnd() * 140;
    const lean = (rnd() - 0.5) * 90;
    const w = 3 + rnd() * 5;
    const tone = rnd();
    const grad = g.createLinearGradient(0, 256, 0, 256 - h);
    grad.addColorStop(0, `rgb(${30 + 20 * tone},${70 + 30 * tone},${20 + 10 * tone})`);
    grad.addColorStop(1, `rgb(${110 + 60 * tone},${160 + 50 * tone},${50 + 30 * tone})`);
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(x0 - w, 256);
    g.quadraticCurveTo(x0 - w * 0.5 + lean * 0.3, 256 - h * 0.55, x0 + lean, 256 - h);
    g.quadraticCurveTo(x0 + w * 0.5 + lean * 0.3, 256 - h * 0.55, x0 + w, 256);
    g.closePath();
    g.fill();
  }
  return cv;
}

/** Turbo pad: amarillo con flechas negras apuntando hacia +u (adelante). */
export function makePadCanvas() {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = '#ffd21f';
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#e0a800';
  g.fillRect(0, 0, 256, 8); g.fillRect(0, 120, 256, 8);
  g.fillStyle = '#111';
  for (const x0 of [40, 130]) {
    g.beginPath();
    g.moveTo(x0, 22); g.lineTo(x0 + 34, 22); g.lineTo(x0 + 84, 64); g.lineTo(x0 + 34, 106); g.lineTo(x0, 106); g.lineTo(x0 + 50, 64);
    g.closePath(); g.fill();
  }
  return cv;
}

/** Borde de los nitro strips: degradado verde que se desvanece hacia arriba (con transparencia). */
export function makeGlowCanvas() {
  const cv = document.createElement('canvas');
  cv.width = 32; cv.height = 128;
  const g = cv.getContext('2d');
  const gr = g.createLinearGradient(0, 128, 0, 0); // abajo (v = 0) opaco, arriba transparente
  gr.addColorStop(0, 'rgba(80,255,150,0.95)');
  gr.addColorStop(0.35, 'rgba(60,240,130,0.55)');
  gr.addColorStop(1, 'rgba(40,220,110,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 32, 128);
  return cv;
}

/** Textura de pista por defecto: asfalto con líneas blancas en los bordes y línea amarilla discontinua al centro (u a lo ancho, v a lo largo). */
export function makeAsphaltCanvas() {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#44464b';
  g.fillRect(0, 0, 256, 256);
  let s = 7;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let k = 0; k < 5000; k++) {
    const v = 50 + Math.floor(rnd() * 50);
    g.fillStyle = `rgba(${v},${v},${v + 4},${0.35 + rnd() * 0.4})`;
    g.fillRect(rnd() * 256, rnd() * 256, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  g.fillStyle = '#e8e8e8';
  g.fillRect(8, 0, 7, 256); g.fillRect(241, 0, 7, 256);
  g.fillStyle = '#e2b400';
  g.fillRect(124, 0, 8, 128);
  return cv;
}

/** Textura por defecto de los puentes: café, con tablas cruzadas sutiles (V corre a lo largo del puente). */
export function makeBridgeCanvas() {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#7a5433';
  g.fillRect(0, 0, 256, 256);
  let s = 11;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  // tablas a lo ancho (8 por repetición), cada una con un tono algo distinto y veta
  for (let k = 0; k < 8; k++) {
    const y = k * 32, v = rnd();
    g.fillStyle = `rgb(${Math.round(112 + v * 22)},${Math.round(76 + v * 16)},${Math.round(46 + v * 10)})`;
    g.fillRect(0, y + 1, 256, 30);
    for (let q = 0; q < 40; q++) {
      g.fillStyle = `rgba(60,38,20,${0.08 + rnd() * 0.12})`;
      g.fillRect(rnd() * 256, y + 2 + rnd() * 26, 20 + rnd() * 60, 1);
    }
    g.fillStyle = 'rgba(40,24,12,0.55)';
    g.fillRect(0, y, 256, 2);
  }
  // bordes más oscuros
  g.fillStyle = 'rgba(50,32,18,0.6)';
  g.fillRect(0, 0, 10, 256); g.fillRect(246, 0, 10, 256);
  return cv;
}

/** Textura por defecto de la barrera de contención: bloques rojo y blanco a lo largo (U), con borde superior. */
export function makeBarrierCanvas() {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const g = cv.getContext('2d');
  g.fillStyle = '#d42a2a'; g.fillRect(0, 0, 128, 64);
  g.fillStyle = '#f2f2f2'; g.fillRect(128, 0, 128, 64);
  // leve sombreado y franjas de borde
  const gr = g.createLinearGradient(0, 0, 0, 64);
  gr.addColorStop(0, 'rgba(255,255,255,0.18)'); gr.addColorStop(0.5, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.22)');
  g.fillStyle = gr; g.fillRect(0, 0, 256, 64);
  g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, 0, 256, 3); g.fillRect(0, 61, 256, 3);
  return cv;
}

/** Textura por defecto del camino de tierra: arena café clara con grano. */
export function makeSandCanvas() {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#c9a877'; g.fillRect(0, 0, 256, 256);
  let s = 23;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let k = 0; k < 9000; k++) {
    const v = rnd();
    g.fillStyle = v < 0.5 ? `rgba(150,118,76,${0.2 + rnd() * 0.3})` : `rgba(226,204,160,${0.2 + rnd() * 0.35})`;
    g.fillRect(rnd() * 256, rnd() * 256, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  for (let k = 0; k < 60; k++) { // piedritas
    g.fillStyle = `rgba(120,96,66,${0.35 + rnd() * 0.3})`;
    g.beginPath(); g.arc(rnd() * 256, rnd() * 256, 1 + rnd() * 2.2, 0, Math.PI * 2); g.fill();
  }
  return cv;
}
