// Servidor local sin dependencias: node server.js  (o npm start)
// Sirve la app en http://localhost:5173 y abre el navegador.
import http from 'node:http';
import { readFile, stat, writeFile, mkdir, readdir, unlink, rename } from 'node:fs/promises';
import { extname, join, normalize, dirname, isAbsolute, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '5173', 10);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

// ---- guardado automático: la app envía el proyecto y el servidor lo escribe en la carpeta elegida ----
// Solo acepta pedidos de la propia app (misma dirección y el encabezado X-TSG), solo archivos .tsg.json con nombres
// limpios, y conserva los N más recientes de cada proyecto.
const SAFE = /^[\w\-. áéíóúñÁÉÍÓÚÑ]+\.tsg\.json$/;
const cleanName = (s) => String(s || 'pista').replace(/[^\w\-áéíóúñÁÉÍÓÚÑ ]/g, '').trim().replace(/\s+/g, '_').slice(0, 80) || 'pista';
const dirOf = (d) => { const v = String(d || 'autoguardado').trim() || 'autoguardado'; return isAbsolute(v) ? normalize(v) : resolve(root, v); };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(JSON.stringify(obj)); };
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
function readBody(req, max = 400 * 1048576) {
  return new Promise((res, rej) => {
    const parts = [];
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n > max) { rej(new Error('proyecto demasiado grande')); req.destroy(); } else parts.push(c); });
    req.on('end', () => res(Buffer.concat(parts)));
    req.on('error', rej);
  });
}
async function listAuto(dir, name = null) {
  let files = [];
  try { files = await readdir(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!SAFE.test(f) || !/_auto_\d{8}-\d{6}\.tsg\.json$/.test(f)) continue;
    if (name && !f.startsWith(name + '_auto_')) continue;
    try { const st = await stat(join(dir, f)); out.push({ file: f, size: st.size, mtime: st.mtimeMs }); } catch { /* borrado entre medio */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
async function autosaveApi(req, res, url) {
  const host = req.headers.host || '';
  const origin = req.headers.origin;
  if (req.headers['x-tsg'] !== '1' || (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) { json(res, 403, { error: 'solo desde la app' }); return; }
  const dir = dirOf(url.searchParams.get('dir'));
  const op = url.pathname.slice('/api/autosave/'.length);
  if (op === 'ping') { json(res, 200, { ok: true, dir }); return; }
  if (op === 'list') { json(res, 200, { dir, files: await listAuto(dir) }); return; }
  if (op === 'file') {
    const f = basename(url.searchParams.get('file') || '');
    if (!SAFE.test(f)) { json(res, 400, { error: 'nombre no válido' }); return; }
    const body = await readFile(join(dir, f));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(body);
    return;
  }
  if (op === 'save' && req.method === 'POST') {
    const name = cleanName(url.searchParams.get('name'));
    const keep = Math.max(1, Math.min(50, parseInt(url.searchParams.get('keep'), 10) || 3));
    const body = await readBody(req);
    await mkdir(dir, { recursive: true });
    const file = `${name}_auto_${stamp()}.tsg.json`;
    await writeFile(join(dir, file + '.tmp'), body);
    await rename(join(dir, file + '.tmp'), join(dir, file)); // escritura completa o nada (no queda un archivo a medias)
    const all = await listAuto(dir, name);
    for (const old of all.slice(keep)) { try { await unlink(join(dir, old.file)); } catch { /* ya no está */ } }
    json(res, 200, { ok: true, dir, file, kept: Math.min(all.length, keep) });
    return;
  }
  json(res, 404, { error: 'no existe' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url0 = new URL(req.url, 'http://x');
    if (url0.pathname.startsWith('/api/autosave/')) {
      try { await autosaveApi(req, res, url0); } catch (err) { json(res, 500, { error: err.message }); }
      return;
    }
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/') path = '/index.html';
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    const st = await stat(file);
    if (!st.isFile()) { res.writeHead(404).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-TSG-Server': '1' }); // la app sabe que hay servidor local (guardado automático en carpeta)
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('No encontrado');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`El puerto ${PORT} está ocupado. Prueba: PORT=5174 node server.js`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Track Spline Generator corriendo en ${url}  (Ctrl+C para salir)`);
  if (!process.env.NO_OPEN) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});
