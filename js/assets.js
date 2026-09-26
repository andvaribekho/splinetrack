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
