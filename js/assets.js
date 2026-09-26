// Biblioteca de assets de decoración (FBX / GLB): modelos que reemplazan a los árboles, la hierba o los cubos
// de un set de decoración. Cada asset se normaliza a metros con Z arriba y conserva su pivote.
import * as THREE from 'three';
import { parseReference } from './refmodel.js';

let nextId = 1;

/** Lee un modelo y devuelve un asset {id, name, format, buffer, parts:[{geometry, material, matrix}], tris, size:[x,y,z]}. */
export async function loadAsset(buffer, name, id = null) {
  const res = await parseReference(buffer, name, { upAxis: 'auto' });
  res.inner.updateMatrixWorld(true);
  const parts = [];
  res.inner.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    parts.push({ geometry: g, material: o.material, matrix: o.matrixWorld.clone(), name: o.name || '' });
  });
  const box = new THREE.Box3().setFromObject(res.inner);
  const size = box.getSize(new THREE.Vector3());
  const aid = id ?? `a${Date.now().toString(36)}${(nextId++).toString(36)}`;
  return { id: aid, name, format: res.format, buffer, parts, tris: res.tris, size: [size.x, size.y, size.z], minZ: box.min.z };
}

/** Cubo de color con el pivote al centro de la base (lado 1 m): el elemento por defecto de un set. */
const cubeGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
const cubeMats = new Map();
export function cubeAsset(color) {
  let m = cubeMats.get(color);
  if (!m) { m = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0, name: 'cubo_' + color.replace('#', '') }); cubeMats.set(color, m); }
  return { id: 'cube:' + color, name: 'cubo', parts: [{ geometry: cubeGeo, material: m, matrix: new THREE.Matrix4() }], tris: 12, size: [1, 1, 1], minZ: 0, cube: true };
}

/** Plano vertical de color (1 × 1 m), de frente hacia -Y (el «frente» de los modelos), pivote al centro de la base. */
const planeGeo = new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2).translate(0, 0, 0.5); // normal -Y tras girar
const planeMats = new Map();
export function planeAsset(color) {
  let m = planeMats.get(color);
  if (!m) { m = new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, side: THREE.DoubleSide, name: 'plano_' + color.replace('#', '') }); planeMats.set(color, m); }
  return { id: 'plane:' + color, name: 'plano', parts: [{ geometry: planeGeo, material: m, matrix: new THREE.Matrix4() }], tris: 2, size: [1, 0, 1], minZ: 0, plane: true };
}
/** Assets propios (cubo o plano de un color) a partir de su id: 'cube:#rrggbb' / 'plane:#rrggbb'. */
export function builtinAsset(id) {
  if (!id) return null;
  if (id.startsWith('cube:')) return cubeAsset(id.slice(5));
  if (id.startsWith('plane:')) return planeAsset(id.slice(6));
  return null;
}

const Z = new THREE.Vector3(0, 0, 1);
/** Matriz de una instancia: posición, inclinación según «up», giro sobre su eje y escala uniforme. */
export function instanceMatrix(it, scale, zOverride = null) {
  const q = new THREE.Quaternion().setFromUnitVectors(Z, new THREE.Vector3(...(it.up || [0, 0, 1])));
  q.multiply(new THREE.Quaternion().setFromAxisAngle(Z, it.yaw || 0));
  return new THREE.Matrix4().compose(new THREE.Vector3(it.x, it.y, zOverride ?? it.z), q, new THREE.Vector3(scale * (it.sx ?? 1), scale * (it.sy ?? 1), scale * (it.sz ?? 1)));
}

/**
 * Instancias agrupadas por asset como InstancedMesh (una por parte del modelo). items: [{..., asset}] con la escala
 * ya calculada en it.scale. Devuelve un THREE.Group. zOf(it) permite mover la base (exagerar Z).
 */
export function instancedGroup(assetsById, items, zOf = null) {
  const grp = new THREE.Group();
  const byAsset = new Map();
  for (const it of items) { if (!byAsset.has(it.asset)) byAsset.set(it.asset, []); byAsset.get(it.asset).push(it); }
  const tmp = new THREE.Matrix4();
  for (const [aid, list] of byAsset) {
    const A = assetsById(aid);
    if (!A) continue;
    for (const part of A.parts) {
      const im = new THREE.InstancedMesh(part.geometry, part.material, list.length);
      list.forEach((it, i) => { tmp.multiplyMatrices(instanceMatrix(it, it.scale, zOf ? zOf(it) : null), part.matrix); im.setMatrixAt(i, tmp); });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.userData.instItems = list;
      im.userData.partMatrix = part.matrix;
      grp.add(im);
    }
  }
  return grp;
}

/** Copia de un asset como objeto propio (exportación): grupo con sus partes, pivote en el del modelo. */
export function assetObject(A, it, name) {
  const uniform = (it.sx ?? 1) === (it.sy ?? 1) && (it.sy ?? 1) === (it.sz ?? 1);
  if (A.parts.length === 1 && (uniform || A.parts[0].matrix.equals(new THREE.Matrix4()))) { // una sola malla: el objeto es la malla (transformación de la instancia × la de la parte)
    const part = A.parts[0];
    const m = new THREE.Mesh(part.geometry, part.material);
    m.name = name;
    new THREE.Matrix4().multiplyMatrices(instanceMatrix(it, it.scale), part.matrix).decompose(m.position, m.quaternion, m.scale);
    return m;
  }
  const g = new THREE.Group();
  g.name = name;
  A.parts.forEach((part, k) => {
    const m = new THREE.Mesh(part.geometry, part.material);
    m.name = A.parts.length > 1 ? `${name}_${part.name || 'parte'}_${k + 1}` : `${name}_malla`;
    part.matrix.decompose(m.position, m.quaternion, m.scale);
    g.add(m);
  });
  instanceMatrix(it, it.scale).decompose(g.position, g.quaternion, g.scale);
  return g;
}

/**
 * «Single mesh» al exportar: todas las instancias en mallas combinadas, una por material (pivote en el origen).
 * items: [{..., asset, scale}]. Devuelve [THREE.Mesh] con nombre `${name}` (o `${name}_<material>` si hay varios).
 */
export function mergedAssetMeshes(assetsById, items, name) {
  const byMat = new Map(); // material -> {mat, pos:[], nor:[], uv:[], idx:[], n}
  const M = new THREE.Matrix4(), N = new THREE.Matrix3(), v = new THREE.Vector3();
  const add = (mat, geo, start, count, matrix) => {
    let b = byMat.get(mat);
    if (!b) byMat.set(mat, (b = { mat, pos: [], nor: [], uv: [], idx: [], n: 0 }));
    const P = geo.getAttribute('position'), Nr = geo.getAttribute('normal'), U = geo.getAttribute('uv'), I = geo.getIndex();
    N.getNormalMatrix(matrix);
    const base = b.n, map = new Map();
    const vert = (k) => {
      let o = map.get(k);
      if (o !== undefined) return o;
      o = base + map.size;
      map.set(k, o);
      v.fromBufferAttribute(P, k).applyMatrix4(matrix); b.pos.push(v.x, v.y, v.z);
      if (Nr) { v.fromBufferAttribute(Nr, k).applyMatrix3(N).normalize(); b.nor.push(v.x, v.y, v.z); } else b.nor.push(0, 0, 1);
      if (U) b.uv.push(U.getX(k), U.getY(k)); else b.uv.push(0, 0);
      return o;
    };
    for (let j = start; j < start + count; j++) b.idx.push(vert(I ? I.getX(j) : j));
    b.n = base + map.size;
  };
  for (const it of items) {
    const A = assetsById(it.asset);
    if (!A) continue;
    const IM = instanceMatrix(it, it.scale);
    for (const part of A.parts) {
      M.multiplyMatrices(IM, part.matrix);
      const g = part.geometry, total = g.getIndex() ? g.getIndex().count : g.getAttribute('position').count;
      if (Array.isArray(part.material)) {
        const groups = g.groups.length ? g.groups : [{ start: 0, count: total, materialIndex: 0 }];
        for (const gr of groups) { const m = part.material[gr.materialIndex || 0]; if (m) add(m, g, gr.start, Math.min(gr.count, total - gr.start), M); }
      } else add(part.material, g, 0, total, M);
    }
  }
  const out = [], used = new Set();
  for (const b of byMat.values()) {
    if (!b.idx.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    g.setIndex(b.n > 65535 ? new THREE.Uint32BufferAttribute(b.idx, 1) : new THREE.Uint16BufferAttribute(b.idx, 1));
    const m = new THREE.Mesh(g, b.mat);
    let nm = byMat.size > 1 ? `${name}_${(b.mat && b.mat.name) || 'material'}` : name;
    if (used.has(nm)) nm += `_${out.length + 1}`;
    used.add(nm);
    m.name = nm;
    out.push(m);
  }
  return out;
}
