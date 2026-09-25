// Trazado de una imagen de minimapa: máscara -> esqueleto -> grafo -> ruta principal + rutas alternativas.
// Funciona sobre datos RGBA crudos, sin dependencias (sirve en navegador y en Node).

const N8 = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]; // P2..P9 (N, NE, E, SE, S, SW, W, NW)

export const DEFAULT_TRACE = {
  targetSize: 900, // lado mayor de trabajo en px
  threshold: null, // null = Otsu automático
  invert: 'auto', // 'auto' | true | false
  closeRadius: 1,
};

export const MODE_NAMES = {
  light: 'pista clara sobre fondo oscuro',
  dark: 'pista oscura sobre fondo claro',
  bgdiff: 'todo lo distinto del fondo (pista con borde)',
  top: 'solo el tono más claro (relleno de la pista)',
  bottom: 'solo el tono más oscuro',
};

/** Máscara binaria según el modo. */
function makeMask(gray, W, H, mode, thr, t3) {
  const bin = new Uint8Array(W * H);
  if (mode === 'light') for (let i = 0; i < W * H; i++) bin[i] = gray[i] > thr ? 1 : 0;
  else if (mode === 'dark') for (let i = 0; i < W * H; i++) bin[i] = gray[i] <= thr ? 1 : 0;
  else if (mode === 'top') for (let i = 0; i < W * H; i++) bin[i] = gray[i] > t3[1] ? 1 : 0;
  else if (mode === 'bottom') for (let i = 0; i < W * H; i++) bin[i] = gray[i] <= t3[0] ? 1 : 0;
  else if (mode === 'bgdiff') {
    const { bg, delta } = borderStats(gray, W, H);
    for (let i = 0; i < W * H; i++) bin[i] = Math.abs(gray[i] - bg) > delta ? 1 : 0;
  }
  return bin;
}

/** Fondo estimado con el borde de la imagen: mediana y dispersión. */
function borderStats(gray, W, H) {
  const v = [];
  const ring = Math.max(1, Math.round(Math.min(W, H) * 0.01));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x < ring || y < ring || x >= W - ring || y >= H - ring) v.push(gray[y * W + x]);
  }
  v.sort((a, b) => a - b);
  const bg = v[Math.floor(v.length / 2)];
  const dev = v.map((q) => Math.abs(q - bg)).sort((a, b) => a - b);
  const mad = dev[Math.floor(dev.length / 2)];
  return { bg, delta: Math.max(14, 4 * mad) };
}

/** Otsu de 3 clases (dos umbrales). */
function otsu3(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[Math.max(0, Math.min(255, Math.round(gray[i])))]++;
  const P = new Float64Array(257), S = new Float64Array(257);
  for (let i = 0; i < 256; i++) { P[i + 1] = P[i] + hist[i]; S[i + 1] = S[i] + i * hist[i]; }
  const cls = (a, b) => { const w = P[b] - P[a]; if (w <= 0) return 0; const m = (S[b] - S[a]) / w; return w * m * m; };
  let best = -1, t = [85, 170];
  for (let a = 1; a < 255; a++) for (let b = a + 1; b < 256; b++) {
    const v = cls(0, a) + cls(a, b) + cls(b, 256);
    if (v > best) { best = v; t = [a - 1, b - 1]; }
  }
  return t;
}

/** Máscara -> esqueleto -> grafo -> rutas (+ métricas para comparar modos). */
function traceMask(binIn, W, H, opts) {
  let bin = binIn;
  clearBorder(bin, W, H);
  if (opts.closeRadius > 0) bin = morphClose(bin, W, H, opts.closeRadius);
  clearBorder(bin, W, H);
  bin = largestComponent(bin, W, H);
  fillSmallHoles(bin, W, H, W * H * 0.002);
  const dt = edt(bin, W, H);
  const skel = zhangSuen(bin, W, H);
  const graph = buildGraph(skel, W, H, dt);
  simplifyGraph(graph);
  const result = extractRoutes(graph, dt, W, H);
  return { bin, dt, skel, graph, result };
}

function scoreTrace(t, W, H) {
  const { result, graph, bin } = t;
  if (!result.main || result.main.pts.length < 10) return 0;
  let fg = 0;
  for (let i = 0; i < bin.length; i++) fg += bin[i];
  const frac = fg / (W * H);
  if (frac < 0.003 || frac > 0.6) return 0;
  const total = graph.edges.filter((e) => e.alive).reduce((a, e) => a + e.len, 0) || 1;
  const used = polyLen(result.main.pts) + result.alts.reduce((a, r) => a + polyLen(r.pts), 0);
  const cover = Math.min(1, used / total);
  const ws = result.main.pts.map((p) => p[2]).filter((v) => isFinite(v));
  const mean = ws.reduce((a, b) => a + b, 0) / Math.max(1, ws.length);
  const sd = Math.sqrt(ws.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, ws.length));
  const cv = sd / (mean || 1);
  const dead = graph.nodes.filter((n) => n.alive && n.inc.length === 1).length;
  const size = Math.max(W, H);
  const thick = Math.min(1, (mean / 2) / (size * 0.008)); // radio de al menos ~0,8 % del lado
  return (result.main.closed ? 1 : 0.45) * cover * thick / (1 + 1.5 * cv) - 0.03 * dead;
}

export function traceImage(img, optsIn = {}) {
  const opts = { ...DEFAULT_TRACE, ...optsIn };
  const t0 = Date.now();
  // 1) Elegir el modo de máscara probando candidatos en baja resolución
  let mode, scores = null;
  if (opts.threshold !== null && opts.threshold !== undefined) mode = opts.invert === true ? 'dark' : 'light';
  else if (opts.invert === true) mode = 'dark';
  else if (opts.invert === false) mode = 'light';
  else if (opts.invert === 'bgdiff' || opts.invert === 'top' || opts.invert === 'bottom') mode = opts.invert;
  else {
    const fs = Math.min(1, 480 / Math.max(img.width, img.height)) * Math.max(1, 240 / Math.max(img.width, img.height));
    const w = Math.max(8, Math.round(img.width * fs)), h = Math.max(8, Math.round(img.height * fs));
    const g = resizeGray(img, w, h);
    const thr = otsu(g), t3 = otsu3(g);
    scores = {};
    for (const m of ['bgdiff', 'light', 'dark', 'top', 'bottom']) {
      try { scores[m] = scoreTrace(traceMask(makeMask(g, w, h, m, thr, t3), w, h, opts), w, h); } catch { scores[m] = 0; }
    }
    mode = Object.keys(scores).reduce((a, b) => (scores[b] > scores[a] + 1e-9 ? b : a), 'bgdiff');
  }
  // 2) Trazado final a resolución de trabajo
  const f = opts.targetSize / Math.max(img.width, img.height);
  const W = Math.max(8, Math.round(img.width * f));
  const H = Math.max(8, Math.round(img.height * f));
  const gray = resizeGray(img, W, H);
  const thr = opts.threshold ?? otsu(gray);
  const t3 = otsu3(gray);
  const t = traceMask(makeMask(gray, W, H, mode, thr, t3), W, H, opts);
  const { graph, result, bin, skel } = t;
  const inv = 1 / f;
  const mapPts = (pts) => pts.map((p) => [p[0] * inv, p[1] * inv, p[2] * inv]);
  return {
    main: result.main ? { pts: mapPts(result.main.pts), closed: result.main.closed } : null,
    alts: result.alts.map((a) => ({ pts: mapPts(a.pts), keep: true })),
    info: {
      threshold: thr, mode, modeName: MODE_NAMES[mode], scores, inverted: mode === 'dark', workSize: [W, H], ms: Date.now() - t0,
      nodes: graph.nodes.filter((n) => n.alive).map((n) => ({ x: n.x * inv, y: n.y * inv, deg: n.inc.length })),
      crossNodes: graph.nodes.filter((n) => n.alive && n.inc.length >= 4).length,
      forkNodes: graph.nodes.filter((n) => n.alive && n.inc.length === 3).length,
    },
    debug: { W, H, bin, skel, f },
  };
}

// ---------- imagen ----------

function resizeGray(img, W, H) {
  const { width: w, height: h, data } = img;
  let hasAlpha = false;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) { hasAlpha = true; break; }
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const lum = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    g[i] = hasAlpha ? lum * (data[i * 4 + 3] / 255) : lum;
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.max(0, ((y + 0.5) * h) / H - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), ty = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, Math.max(0, ((x + 0.5) * w) / W - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), tx = sx - x0;
      const a = g[y0 * w + x0] * (1 - tx) + g[y0 * w + x1] * tx;
      const b = g[y1 * w + x0] * (1 - tx) + g[y1 * w + x1] * tx;
      out[y * W + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

export function otsu(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[Math.max(0, Math.min(255, Math.round(gray[i])))]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

function clearBorder(b, W, H) {
  for (let x = 0; x < W; x++) { b[x] = 0; b[(H - 1) * W + x] = 0; }
  for (let y = 0; y < H; y++) { b[y * W] = 0; b[y * W + W - 1] = 0; }
}

function morphClose(b, W, H, r) {
  const dil = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 0;
    for (let dy = -r; dy <= r && !v; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < W && yy < H && b[yy * W + xx]) { v = 1; break; }
    }
    dil[y * W + x] = v;
  }
  const ero = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 1;
    for (let dy = -r; dy <= r && v; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H || !dil[yy * W + xx]) { v = 0; break; }
    }
    ero[y * W + x] = v;
  }
  return ero;
}

function largestComponent(b, W, H) {
  const lab = new Int32Array(W * H);
  let best = 0, bestSize = 0, cur = 0;
  const stack = [];
  for (let i = 0; i < W * H; i++) {
    if (!b[i] || lab[i]) continue;
    cur++;
    let size = 0;
    stack.push(i);
    lab[i] = cur;
    while (stack.length) {
      const p = stack.pop();
      size++;
      const x = p % W, y = (p / W) | 0;
      for (const [dx, dy] of N8) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const q = yy * W + xx;
        if (b[q] && !lab[q]) { lab[q] = cur; stack.push(q); }
      }
    }
    if (size > bestSize) { bestSize = size; best = cur; }
  }
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = lab[i] === best ? 1 : 0;
  return out;
}

function fillSmallHoles(b, W, H, maxArea) {
  const lab = new Uint8Array(W * H);
  const stack = [];
  const comp = [];
  for (let i = 0; i < W * H; i++) {
    if (b[i] || lab[i]) continue;
    comp.length = 0;
    let border = false;
    stack.push(i);
    lab[i] = 1;
    while (stack.length) {
      const p = stack.pop();
      comp.push(p);
      const x = p % W, y = (p / W) | 0;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border = true;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const q = yy * W + xx;
        if (!b[q] && !lab[q]) { lab[q] = 1; stack.push(q); }
      }
    }
    if (!border && comp.length < maxArea) for (const p of comp) b[p] = 1;
  }
}

/** Transformada de distancia euclidiana exacta (Felzenszwalb-Huttenlocher). */
function edt(b, W, H) {
  const INF = 1e20;
  const f = new Float64Array(Math.max(W, H));
  const d = new Float64Array(Math.max(W, H));
  const v = new Int32Array(Math.max(W, H));
  const z = new Float64Array(Math.max(W, H) + 1);
  const grid = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) grid[i] = b[i] ? INF : 0;
  const pass = (n) => {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  };
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = grid[y * W + x];
    pass(H);
    for (let y = 0; y < H; y++) grid[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = grid[y * W + x];
    pass(W);
    for (let x = 0; x < W; x++) grid[y * W + x] = Math.sqrt(d[x]);
  }
  return grid;
}

function zhangSuen(bin, W, H) {
  const s = new Uint8Array(bin);
  let list = [];
  for (let i = 0; i < W * H; i++) if (s[i]) list.push(i);
  const nb = (p) => {
    const x = p % W, y = (p / W) | 0;
    return N8.map(([dx, dy]) => s[(y + dy) * W + (x + dx)]);
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      const del = [];
      for (const p of list) {
        if (!s[p]) continue;
        const x = p % W, y = (p / W) | 0;
        if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
        const P = nb(p);
        let B = 0, A = 0;
        for (let k = 0; k < 8; k++) { B += P[k]; if (!P[k] && P[(k + 1) % 8]) A++; }
        if (B < 2 || B > 6 || A !== 1) continue;
        if (step === 0) {
          if (P[0] * P[2] * P[4] !== 0 || P[2] * P[4] * P[6] !== 0) continue;
        } else {
          if (P[0] * P[2] * P[6] !== 0 || P[0] * P[4] * P[6] !== 0) continue;
        }
        del.push(p);
      }
      if (del.length) changed = true;
      for (const p of del) s[p] = 0;
    }
    list = list.filter((p) => s[p]);
  }
  return s;
}

// ---------- grafo ----------

function pixelLinks(skel, W, H, p) {
  const x = p % W, y = (p / W) | 0;
  const out = [];
  for (const [dx, dy] of N8) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
    const q = yy * W + xx;
    if (!skel[q]) continue;
    if (dx !== 0 && dy !== 0) {
      // descarta diagonal si existe un camino 4-conexo equivalente
      if (skel[y * W + xx] || skel[yy * W + x]) continue;
    }
    out.push(q);
  }
  return out;
}

function buildGraph(skel, W, H, dt) {
  const links = new Map();
  const pix = [];
  for (let i = 0; i < W * H; i++) if (skel[i]) { pix.push(i); links.set(i, pixelLinks(skel, W, H, i)); }
  const nodeOf = new Int32Array(W * H).fill(-1);
  const nodes = [];
  // Clusters de píxeles de unión (grado >= 3) y extremos (grado 1)
  for (const p of pix) {
    const deg = links.get(p).length;
    if (nodeOf[p] >= 0 || (deg !== 1 && deg < 3)) continue;
    const id = nodes.length;
    const cluster = [p];
    nodeOf[p] = id;
    if (deg >= 3) {
      for (let k = 0; k < cluster.length; k++) {
        const c = cluster[k];
        const cx = c % W, cy = (c / W) | 0;
        for (const [dx, dy] of N8) {
          const q = (cy + dy) * W + (cx + dx);
          if (skel[q] && nodeOf[q] < 0 && links.get(q).length >= 3) { nodeOf[q] = id; cluster.push(q); }
        }
      }
    }
    let sx = 0, sy = 0, r = 0;
    for (const c of cluster) { sx += c % W; sy += (c / W) | 0; r = Math.max(r, dt[c]); }
    nodes.push({ id, x: sx / cluster.length, y: sy / cluster.length, r: Math.max(r, 1), pixels: cluster, inc: [], alive: true });
  }
  const edges = [];
  const visited = new Uint8Array(W * H);
  const walk = (startNode, first) => {
    const pts = [[startNode.x, startNode.y]];
    let prev = null, cur = first;
    const prevSet = new Set(startNode.pixels);
    while (true) {
      if (nodeOf[cur] >= 0) {
        const end = nodes[nodeOf[cur]];
        pts.push([end.x, end.y]);
        return { end, pts };
      }
      visited[cur] = 1;
      pts.push([cur % W, (cur / W) | 0]);
      const nx = links.get(cur).filter((q) => q !== prev && !prevSet.has(q) && (!visited[q] || nodeOf[q] >= 0));
      prevSet.clear();
      if (nx.length === 0) {
        // callejón (no debería ocurrir: los extremos son nodos)
        return { end: null, pts };
      }
      // prioriza nodos si hay alguno adyacente
      const nodeNext = nx.find((q) => nodeOf[q] >= 0 && nodeOf[q] !== startNode.id);
      const next = nodeNext ?? nx.find((q) => nodeOf[q] < 0) ?? nx[0];
      prev = cur;
      cur = next;
    }
  };
  const addEdge = (a, b, pts) => {
    const e = { id: edges.length, a: a.id, b: b.id, pts, alive: true };
    edges.push(e);
    a.inc.push({ e: e.id, end: 0 });
    b.inc.push({ e: e.id, end: 1 });
  };
  const pairSeen = new Set();
  for (const node of nodes) {
    for (const p of node.pixels) {
      for (const q of links.get(p)) {
        if (nodeOf[q] === node.id) continue;
        if (nodeOf[q] >= 0) {
          const key = Math.min(node.id, nodeOf[q]) + ':' + Math.max(node.id, nodeOf[q]);
          if (pairSeen.has(key)) continue;
          pairSeen.add(key);
          addEdge(node, nodes[nodeOf[q]], [[node.x, node.y], [nodes[nodeOf[q]].x, nodes[nodeOf[q]].y]]);
          continue;
        }
        if (visited[q]) continue;
        const { end, pts } = walk(node, q);
        if (end) addEdge(node, end, pts);
      }
    }
  }
  // Ciclos puros sin nodos (p. ej. un óvalo simple)
  for (const p of pix) {
    if (visited[p] || nodeOf[p] >= 0) continue;
    const id = nodes.length;
    const node = { id, x: p % W, y: (p / W) | 0, r: Math.max(dt[p], 1), pixels: [p], inc: [], alive: true };
    nodes.push(node);
    nodeOf[p] = id;
    visited[p] = 1;
    const nx = links.get(p);
    if (!nx.length) { node.alive = false; continue; }
    const { end, pts } = walk(node, nx[0]);
    if (end) addEdge(node, end, pts);
  }
  for (const e of edges) e.len = polyLen(e.pts);
  return { nodes, edges, W, H, dt };
}

function polyLen(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

function removeEdge(g, e) {
  e.alive = false;
  for (const nid of [e.a, e.b]) {
    const n = g.nodes[nid];
    n.inc = n.inc.filter((i) => i.e !== e.id);
  }
}

function edgeEndPts(e, end) {
  return end === 0 ? e.pts : e.pts.slice().reverse();
}

/** Poda de espolones, fusión de nodos de grado 2 y contracción de uniones cercanas. */
function simplifyGraph(g) {
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    // 1) espolones cortos
    for (const e of g.edges) {
      if (!e.alive) continue;
      const A = g.nodes[e.a], B = g.nodes[e.b];
      if (A === B) continue;
      const leaf = A.inc.length === 1 ? A : B.inc.length === 1 ? B : null;
      const other = leaf === A ? B : A;
      if (!leaf || other.inc.length < 3) continue;
      if (e.len < Math.max(2.5 * other.r, 6)) {
        removeEdge(g, e);
        leaf.alive = false;
        changed = true;
      }
    }
    // 2) contracción de uniones muy cercanas (el esqueleto parte los cruces en dos nodos de grado 3)
    for (const e of g.edges) {
      if (!e.alive || e.a === e.b) continue;
      const A = g.nodes[e.a], B = g.nodes[e.b];
      if (A.inc.length < 3 || B.inc.length < 3) continue;
      const lim = (A.inc.length === 3 && B.inc.length === 3 ? 3.2 : 1.6) * Math.max(A.r, B.r);
      if (e.len < lim || (A.inc.length === 3 && B.inc.length === 3 && e.len < 10 * Math.max(A.r, B.r) && isShallowX(g, e))) {
        contractEdge(g, e);
        changed = true;
      }
    }
    // 3) nodos de grado 2 que no son lazo propio
    for (const n of g.nodes) {
      if (!n.alive || n.inc.length !== 2) continue;
      const [i1, i2] = n.inc;
      if (i1.e === i2.e) continue;
      const e1 = g.edges[i1.e], e2 = g.edges[i2.e];
      // camino: otro extremo de e1 -> n -> otro extremo de e2
      const p1 = edgeEndPts(e1, i1.end).slice().reverse(); // termina en n
      const p2 = edgeEndPts(e2, i2.end); // empieza en n
      const aNode = g.nodes[i1.end === 0 ? e1.b : e1.a];
      const bNode = g.nodes[i2.end === 0 ? e2.b : e2.a];
      const pts = p1.concat(p2.slice(1));
      removeEdge(g, e1);
      removeEdge(g, e2);
      n.alive = false;
      const e = { id: g.edges.length, a: aNode.id, b: bNode.id, pts, alive: true, len: polyLen(pts) };
      g.edges.push(e);
      aNode.inc.push({ e: e.id, end: 0 });
      bNode.inc.push({ e: e.id, end: 1 });
      changed = true;
    }
  }
}

/** Dos uniones de grado 3 unidas por un tramo corto cuyas otras ramas salen en V hacia afuera = cruce en ángulo bajo. */
function isShallowX(g, e) {
  const A = g.nodes[e.a], B = g.nodes[e.b];
  const test = (N, O) => {
    const ux = O.x - N.x, uy = O.y - N.y;
    const ul = Math.hypot(ux, uy) || 1;
    const others = N.inc.filter((i) => i.e !== e.id);
    if (others.length !== 2) return false;
    return others.every((i) => {
      const d = incDir(g, N, i);
      return (d[0] * ux + d[1] * uy) / ul < -0.2;
    });
  };
  return test(A, B) && test(B, A);
}

function contractEdge(g, e) {
  const A = g.nodes[e.a], B = g.nodes[e.b];
  removeEdge(g, e);
  const nx = (A.x + B.x) / 2, ny = (A.y + B.y) / 2;
  A.x = nx; A.y = ny;
  A.r = Math.max(A.r, B.r);
  for (const inc of B.inc) {
    const ed = g.edges[inc.e];
    if (inc.end === 0) { ed.a = A.id; ed.pts = [[nx, ny], ...ed.pts]; }
    else { ed.b = A.id; ed.pts = [...ed.pts, [nx, ny]]; }
    A.inc.push(inc);
  }
  B.inc = [];
  B.alive = false;
  for (const inc of A.inc) {
    const ed = g.edges[inc.e];
    if (inc.end === 0) ed.pts[0] = [nx, ny]; else ed.pts[ed.pts.length - 1] = [nx, ny];
    ed.len = polyLen(ed.pts);
  }
}

// ---------- recorrido ----------

function incDir(g, node, inc) {
  const e = g.edges[inc.e];
  const pts = edgeEndPts(e, inc.end);
  const target = Math.max(2.5 * node.r, 6);
  let acc = 0;
  let p = pts[pts.length - 1];
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc >= target) { p = pts[i]; break; }
  }
  const dx = p[0] - node.x, dy = p[1] - node.y;
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

const key = (inc) => inc.e * 2 + inc.end;

function extractRoutes(g, dt, W, H) {
  const nodes = g.nodes.filter((n) => n.alive && n.inc.length > 0);
  const fixedPairs = new Map();
  const forks = [];
  for (const n of nodes) {
    const incs = n.inc;
    const dirs = incs.map((i) => incDir(g, n, i));
    const cost = (a, b) => 1 + (dirs[a][0] * dirs[b][0] + dirs[a][1] * dirs[b][1]); // 0 = recto
    const pair = (a, b) => { fixedPairs.set(key(incs[a]), incs[b]); fixedPairs.set(key(incs[b]), incs[a]); };
    if (incs.length === 2) pair(0, 1);
    else if (incs.length === 4) {
      const opts = [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]];
      let best = opts[0], bc = Infinity;
      for (const o of opts) { const c = cost(...o[0]) + cost(...o[1]); if (c < bc) { bc = c; best = o; } }
      pair(...best[0]); pair(...best[1]);
    } else if (incs.length === 3) {
      const opts = [[0, 1, 2], [0, 2, 1], [1, 2, 0]].map(([a, b, free]) => ({ a, b, free, c: cost(a, b) }));
      opts.sort((p, q) => p.c - q.c);
      forks.push({ n, incs, opts });
    } else if (incs.length >= 5) {
      const used = new Set();
      const cand = [];
      for (let a = 0; a < incs.length; a++) for (let b = a + 1; b < incs.length; b++) cand.push([cost(a, b), a, b]);
      cand.sort((p, q) => p[0] - q[0]);
      for (const [, a, b] of cand) if (!used.has(a) && !used.has(b)) { used.add(a); used.add(b); pair(a, b); }
    }
  }
  const run = (choice) => {
    const pairs = new Map(fixedPairs);
    forks.forEach((f, k) => {
      const o = f.opts[choice[k]];
      pairs.set(key(f.incs[o.a]), f.incs[o.b]);
      pairs.set(key(f.incs[o.b]), f.incs[o.a]);
    });
    return strands(g, pairs);
  };
  let bestChoice = forks.map(() => 0);
  if (forks.length > 0 && forks.length <= 6) {
    let bestScore = -Infinity;
    const total = Math.pow(3, forks.length);
    for (let c = 0; c < total; c++) {
      const choice = [];
      let v = c;
      for (let k = 0; k < forks.length; k++) { choice.push(v % 3); v = Math.floor(v / 3); }
      const st = run(choice);
      const loop = st.filter((s) => s.closed).reduce((m, s) => Math.max(m, s.len), 0);
      const straight = choice.reduce((acc, ch, k) => acc + forks[k].opts[ch].c, 0);
      const score = loop - straight * 5;
      if (score > bestScore) { bestScore = score; bestChoice = choice; }
    }
  }
  const st = run(bestChoice);
  const closedSt = st.filter((s) => s.closed).sort((p, q) => q.len - p.len);
  let mainSt = closedSt[0];
  let closed = true;
  if (!mainSt) {
    mainSt = st.slice().sort((p, q) => q.len - p.len)[0];
    closed = false;
  }
  if (!mainSt) return { main: null, alts: [] };
  const mainNodes = new Set(mainSt.nodes);
  const alts = st.filter((s) => s !== mainSt && !s.closed && s.startNode !== null && s.endNode !== null &&
    mainNodes.has(s.startNode) && mainNodes.has(s.endNode) &&
    g.nodes[s.startNode].inc.length >= 3 && g.nodes[s.endNode].inc.length >= 3 && s.len > 10);
  const cleanPts = (s, isMain) => {
    const crossNodes = nodes.filter((n) => n.inc.length >= 3);
    const nodeR = (n) => n.r * (n.inc.length >= 4 ? 2.4 : 1.6);
    const inNode = (p) => crossNodes.some((n) => Math.hypot(p[0] - n.x, p[1] - n.y) < nodeR(n));
    let src = s.pts.slice();
    const closedS = s.closed;
    if (closedS) {
      if (src.length > 1 && Math.hypot(src[0][0] - src[src.length - 1][0], src[0][1] - src[src.length - 1][1]) < 1e-6) src.pop();
      const k0 = src.findIndex((p) => !inNode(p));
      if (k0 > 0) src = src.slice(k0).concat(src.slice(0, k0));
    }
    // Reemplaza cada tramo dentro de un nodo por una curva de Hermite tangente a los brazos.
    const pts = [];
    const n = src.length;
    let i = 0;
    while (i < n) {
      const p = src[i];
      if (!inNode(p) || (!isMain && (i === 0 || i === n - 1))) { pts.push(p); i++; continue; }
      let j = i;
      while (j < n && inNode(src[j]) && !(!isMain && j === n - 1)) j++;
      const a = i - 1, b = j < n ? j : closedS ? 0 : -1;
      if (a >= 0 && b >= 0) {
        const P0 = src[a], P1 = src[b];
        // tangentes: desde puntos más alejados del nodo
        const rr = crossNodes.reduce((m, nd) => Math.max(m, Math.hypot(P0[0] - nd.x, P0[1] - nd.y) < nodeR(nd) * 1.5 ? nd.r : m), 6);
        const walk = (start, dir) => {
          let k = start, acc = 0;
          for (let g = 0; g < n && acc < rr * 2; g++) {
            const kn = closedS ? (k + dir + n) % n : k + dir;
            if (kn < 0 || kn >= n) break;
            acc += Math.hypot(src[kn][0] - src[k][0], src[kn][1] - src[k][1]);
            k = kn;
          }
          return src[k];
        };
        const back = walk(a, -1);
        const fwd = walk(b, 1);
        let t0 = [P0[0] - back[0], P0[1] - back[1]];
        let t1 = [fwd[0] - P1[0], fwd[1] - P1[1]];
        const L = Math.hypot(P1[0] - P0[0], P1[1] - P0[1]);
        const n0 = Math.hypot(...t0) || 1, n1 = Math.hypot(...t1) || 1;
        t0 = [t0[0] / n0 * L, t0[1] / n0 * L];
        t1 = [t1[0] / n1 * L, t1[1] / n1 * L];
        const steps = Math.max(2, Math.ceil(L / 2));
        for (let k = 1; k < steps; k++) {
          const t = k / steps, t2 = t * t, t3 = t2 * t;
          const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
          pts.push([h00 * P0[0] + h10 * t0[0] + h01 * P1[0] + h11 * t1[0], h00 * P0[1] + h10 * t0[1] + h01 * P1[1] + h11 * t1[1]]);
        }
      }
      i = j;
    }
    // submuestreo cada ~2 px
    const out = [pts[0]];
    for (const p of pts) if (Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) >= 2) out.push(p);
    // ancho desde la distancia al borde (NaN cerca de nodos -> interpolado)
    const wv = out.map((p) => {
      for (const n of crossNodes) if (Math.hypot(p[0] - n.x, p[1] - n.y) < n.r * 2.2) return NaN;
      const xi = Math.round(p[0]), yi = Math.round(p[1]);
      return 2 * dt[Math.min(H - 1, Math.max(0, yi)) * W + Math.min(W - 1, Math.max(0, xi))];
    });
    fillNaN(wv);
    return out.map((p, i) => [p[0], p[1], wv[i]]);
  };
  return {
    main: { pts: cleanPts(mainSt, true), closed },
    alts: alts.map((a) => ({ pts: cleanPts(a, false) })),
  };
}

function fillNaN(arr) {
  const n = arr.length;
  const valid = arr.map((v) => isFinite(v));
  if (!valid.some(Boolean)) { arr.fill(10); return; }
  for (let i = 0; i < n; i++) {
    if (valid[i]) continue;
    let a = i - 1; while (a >= 0 && !valid[a]) a--;
    let b = i + 1; while (b < n && !valid[b]) b++;
    if (a < 0) arr[i] = arr[b];
    else if (b >= n) arr[i] = arr[a];
    else arr[i] = arr[a] + (arr[b] - arr[a]) * ((i - a) / (b - a));
  }
}

function strands(g, pairs) {
  const used = new Set(); // clave dirigida de incidencia de salida
  const out = [];
  const edgeUsed = new Set();
  const alive = g.edges.filter((e) => e.alive);
  const follow = (startInc, startNodeId) => {
    let inc = startInc;
    let nodeId = startNodeId;
    const pts = [];
    const nodeList = [nodeId];
    let len = 0;
    let closed = false;
    let endNode = null;
    for (let guard = 0; guard < 100000; guard++) {
      const e = g.edges[inc.e];
      edgeUsed.add(e.id);
      used.add(key(inc));
      const seg = edgeEndPts(e, inc.end);
      if (pts.length) pts.push(...seg.slice(1)); else pts.push(...seg);
      len += e.len;
      const arriveNode = inc.end === 0 ? e.b : e.a;
      const arriveInc = { e: e.id, end: 1 - inc.end };
      used.add(key(arriveInc));
      nodeList.push(arriveNode);
      const nxt = pairs.get(key(arriveInc));
      if (!nxt) { endNode = arriveNode; break; }
      if (key(nxt) === key(startInc)) { closed = true; break; }
      if (edgeUsed.has(nxt.e)) { endNode = arriveNode; break; }
      inc = nxt;
      nodeId = arriveNode;
    }
    return { pts, len, closed, nodes: nodeList, startNode: closed ? null : startNodeId, endNode: closed ? null : endNode };
  };
  // Primero desde incidencias no emparejadas (extremos de hebras abiertas)
  for (const e of alive) {
    for (const end of [0, 1]) {
      const inc = { e: e.id, end };
      if (edgeUsed.has(e.id) || pairs.has(key(inc))) continue;
      out.push(follow(inc, end === 0 ? e.a : e.b));
    }
  }
  // Luego ciclos
  for (const e of alive) {
    if (edgeUsed.has(e.id)) continue;
    out.push(follow({ e: e.id, end: 0 }, e.a));
  }
  return out;
}
