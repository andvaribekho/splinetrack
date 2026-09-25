// Modelo 3D de referencia (FBX o GLB/glTF): se importa como un solo objeto que se puede mover pero no editar,
// para comparar las pistas nuevas con las del juego. No se exporta.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/loaders/GLTFLoader.js';
import { FBXLoader } from '../vendor/loaders/FBXLoader.js';

const EMPTY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Lee el archivo y devuelve { inner, upAxis, unitScale, tris, meshes, format }.
 * inner: grupo en metros con Z arriba y en las coordenadas del archivo (toda la jerarquía dentro, como un todo).
 * upAxis: 'auto' | 'y' | 'z' (auto: GLB siempre Y; FBX según la extensión más chica de la caja).
 */
export async function parseReference(buffer, name, { upAxis = 'auto', unitScale = null } = {}) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  // las texturas externas no están disponibles: se cambian por un píxel (sin errores 404)
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => (/^(data|blob):/.test(url) ? url : EMPTY_PNG));
  let obj, format, fileUnit = 1;
  if (ext === 'glb' || ext === 'gltf') {
    format = 'glTF';
    const data = ext === 'gltf' ? new TextDecoder().decode(buffer) : buffer;
    const gltf = await new Promise((res, rej) => new GLTFLoader(manager).parse(data, '', res, rej));
    obj = gltf.scene || gltf.scenes[0];
  } else if (ext === 'fbx') {
    format = 'FBX';
    obj = new FBXLoader(manager).parse(buffer, '');
    // el cargador pierde UnitScaleFactor cuando la escena tiene un solo nodo raíz: se lee del archivo
    const u = fbxUnitScaleFactor(buffer) ?? (obj.userData && obj.userData.unitScaleFactor);
    if (u > 0) fileUnit = u / 100; // FBX: la unidad del archivo en metros (100 = 1 m)
  } else throw new Error('Formato no soportado (usa .fbx, .glb o .gltf)');
  // animaciones / esqueletos: se muestra la pose de reposo
  obj.traverse((o) => { if (o.isSkinnedMesh) o.frustumCulled = false; });
  const scale0 = unitScale || fileUnit;
  const inner = new THREE.Group();
  inner.name = 'referencia';
  inner.add(obj);
  inner.scale.setScalar(scale0);
  let up = upAxis;
  if (up === 'auto') {
    if (format === 'glTF') up = 'y';
    else {
      inner.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(inner);
      const s = b.getSize(new THREE.Vector3());
      up = s.y < s.z ? 'y' : 'z'; // una pista es plana: el eje más corto es el vertical
    }
  }
  if (up === 'y') inner.rotation.x = Math.PI / 2; // Y arriba -> Z arriba
  inner.updateMatrixWorld(true);
  const meshes = [];
  let tris = 0;
  inner.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    meshes.push(o);
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  });
  if (!meshes.length) throw new Error('El archivo no tiene mallas');
  return { inner, upAxis: up, unitScale: scale0, fileUnit, tris: Math.round(tris), meshes, format };
}

/** UnitScaleFactor de GlobalSettings de un FBX (binario o ASCII), o null. */
export function fbxUnitScaleFactor(buffer) {
  const u8 = new Uint8Array(buffer);
  const key = 'UnitScaleFactor';
  const head = new TextDecoder('latin1').decode(u8.subarray(0, 23));
  if (head.startsWith('Kaydara FBX Binary')) {
    const dv = new DataView(buffer);
    outer: for (let i = 0; i + key.length < u8.length; i++) {
      for (let k = 0; k < key.length; k++) if (u8[i + k] !== key.charCodeAt(k)) continue outer;
      // registro de propiedad: S"UnitScaleFactor" S"double" S"Number" S"" D<valor>
      let q = i + key.length;
      for (let n = 0; n < 3; n++) { if (u8[q] !== 0x53) continue outer; const len = dv.getUint32(q + 1, true); q += 5 + len; }
      if (u8[q] === 0x44) return dv.getFloat64(q + 1, true);
      if (u8[q] === 0x46) return dv.getFloat32(q + 1, true);
    }
    return null;
  }
  const txt = new TextDecoder('latin1').decode(u8);
  const m = txt.match(/"UnitScaleFactor"\s*,\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*([-+0-9.eE]+)/);
  return m ? parseFloat(m[1]) : null;
}

/**
 * Silueta en planta (coordenadas locales del modelo, ya en metros y Z arriba) para dibujarla en el mapa 2D.
 * Devuelve { canvas, u0, v0, u1, v1, res } (res = metros por píxel; la fila 0 es v1).
 */
export function footprint(inner, maxPx = 1600) {
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner);
  const u0 = box.min.x, v0 = box.min.y, u1 = box.max.x, v1 = box.max.y;
  const res = Math.max((u1 - u0) / maxPx, (v1 - v0) / maxPx, 1e-3);
  const W = Math.max(2, Math.ceil((u1 - u0) / res) + 2), H = Math.max(2, Math.ceil((v1 - v0) / res) + 2);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#ffffff';
  const v = new THREE.Vector3();
  const P = [0, 0, 0, 0, 0, 0];
  inner.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const pos = o.geometry.getAttribute('position');
    if (!pos) return;
    const idx = o.geometry.index;
    const n = idx ? idx.count : pos.count;
    const M = o.matrixWorld;
    const px = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(M);
      px[i * 2] = (v.x - u0) / res + 1; px[i * 2 + 1] = (v1 - v.y) / res + 1;
    }
    g.beginPath();
    for (let t = 0; t + 2 < n; t += 3) {
      for (let k = 0; k < 3; k++) { const i = idx ? idx.getX(t + k) : t + k; P[k * 2] = px[i * 2]; P[k * 2 + 1] = px[i * 2 + 1]; }
      const area = (P[2] - P[0]) * (P[5] - P[1]) - (P[4] - P[0]) * (P[3] - P[1]);
      if (Math.abs(area) < 1e-4) continue; // caras verticales
      // todos con la misma orientación: el relleno «nonzero» une sin dejar huecos
      if (area > 0) { g.moveTo(P[0], P[1]); g.lineTo(P[2], P[3]); g.lineTo(P[4], P[5]); }
      else { g.moveTo(P[0], P[1]); g.lineTo(P[4], P[5]); g.lineTo(P[2], P[3]); }
      g.closePath();
    }
    g.fill('nonzero');
  });
  return { canvas: cv, u0: u0 - res, v0: v0 - res, u1: u1 + res, v1: v1 + res, res };
}

/** Materiales para mostrar el modelo: 'flat' (color plano), 'original' o 'wire', con opacidad. */
export function applyRefLook(meshes, look, color, opacity) {
  for (const m of meshes) {
    if (!m.userData.refOrig) m.userData.refOrig = m.material;
    if (m.userData.refMat) { const old = Array.isArray(m.material) ? m.material : [m.material]; if (m.material !== m.userData.refOrig) old.forEach((x) => x.dispose()); }
    const tr = opacity < 0.999;
    const common = { transparent: tr, opacity, depthWrite: !tr, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 };
    if (look === 'original') {
      const orig = Array.isArray(m.userData.refOrig) ? m.userData.refOrig : [m.userData.refOrig];
      const cl = orig.map((o) => { const c = o.clone(); Object.assign(c, common); c.needsUpdate = true; return c; });
      m.material = Array.isArray(m.userData.refOrig) ? cl : cl[0];
    } else if (look === 'wire') {
      m.material = new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: tr, opacity, depthWrite: false });
    } else {
      m.material = new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, ...common });
    }
    m.userData.refMat = true;
    m.userData.ref3d = true;
  }
}
