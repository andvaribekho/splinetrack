// Decoración: sets de elementos (cubos de color por defecto, o modelos de la biblioteca) y el reemplazo de árboles
// e hierba por modelos. Resuelve qué asset y qué escala lleva cada instancia (lo usan la vista 3D y la exportación).
import { buildDecoInstances } from './scene.js';

export const DECO_COLORS = ['#f2c200', '#e53935', '#43a047', '#1e88e5', '#8e24aa', '#fb8c00', '#00acc1', '#6d4c41'];

/** Valores de un set nuevo. */
export function defaultDecoSet(id, index) {
  return {
    id, name: `set_${index}`, color: DECO_COLORS[(index - 1) % DECO_COLORS.length],
    mode: 'road', side: 'both', density: 8, offset: 4, spread: 25, spacing: 2.5, max: 300,
    shape: 'cube', rotMode: 'random', rotLeft: 0, rotRight: 0, collapsed: false,
    size: 1.2, sizeVar: 0.3, rot: 360, tilt: 60, onSlopes: false, onTops: false, hillDensity: 5, seed: index * 13,
    modelScale: 1, assets: [], paint: [], visible: true,
  };
}

/** Elección determinística de un asset para la instancia i (reparto parejo entre los modelos del set). */
const pickOf = (list, u) => list[Math.min(list.length - 1, Math.floor(u * list.length))];

/**
 * Instancias de cada set: [{set, items:[{x,y,z,up,yaw,scale,asset}]}]. paintFor(set) = zonas pintadas en metros.
 * hasAsset(id) indica si un id de la biblioteca está cargado (los que no, se ignoran y quedan cubos).
 */
export function decoSetItems(layout, elev, sp, ground, sets, paintFor, hasAsset) {
  const out = [];
  for (const set of sets || []) {
    if (set.visible === false) { out.push({ set, items: [] }); continue; }
    const inst = buildDecoInstances(layout, elev, sp, ground, set, paintFor ? paintFor(set) : null);
    const models = (set.assets || []).filter((a) => hasAsset(a));
    const items = inst.map((it) => models.length
      ? { ...it, asset: pickOf(models, it.pick), scale: Math.max(0.01, set.modelScale ?? 1) * it.s }
      : { ...it, asset: (set.shape === 'plane' ? 'plane:' : 'cube:') + set.color, scale: Math.max(0.05, set.size || 1) * it.s });
    out.push({ set, items });
  }
  return out;
}

/** Árboles con modelos: misma posición, inclinación y giro que los conos; escala = altura / 9 m (1 con escala 1). */
export function treeModelItems(trees, assetIds, hasAsset) {
  const models = (assetIds || []).filter((a) => hasAsset(a));
  if (!models.length) return null;
  return trees.map((t, i) => {
    const u = (((i + 1) * 2654435761) >>> 0) / 4294967296;
    return { x: t.x - t.up[0] * 0.1, y: t.y - t.up[1] * 0.1, z: t.z - t.up[2] * 0.1, up: t.up, yaw: t.yaw || 0, scale: t.h / 9, asset: pickOf(models, u) };
  });
}

/** Hierba con modelos: escala = altura / 0.9 m. */
export function grassModelItems(insts, assetIds, hasAsset) {
  const models = (assetIds || []).filter((a) => hasAsset(a));
  if (!models.length || !insts) return null;
  return insts.map((g, i) => {
    const u = (((i + 7) * 2246822519) >>> 0) / 4294967296;
    return { x: g.x, y: g.y, z: g.z, up: g.up, yaw: g.yaw, scale: g.h / 0.9, asset: pickOf(models, u) };
  });
}
