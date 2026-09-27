// Exporta la escena (pista con UV, terreno y árboles, con texturas incrustadas) a glTF binario (.glb).
// glTF usa Y arriba: se rota la raíz para que Blender / 3ds Max la importen con Z arriba y en metros.
import * as THREE from 'three';
import { GLTFExporter } from '../vendor/exporters/GLTFExporter.js';
import { buildRivers } from './rivers.js';
import { buildTrackMesh, coveredRanges, terrainTint, buildTerrain, buildTrees, buildHills, buildStartGate, buildGrass, makeGround, bridgePillars, suspPillars, buildTriggers } from './scene.js';
import { pillarGeometry, torchGeometry } from './tunnels.js';
import { buildEdgeMeshes } from './edges.js';
import { buildCollisionMeshes } from './collision.js';
import { assetObject, builtinAsset, mergedAssetMeshes } from './assets.js';
import { decoSetItems, treeModelItems, grassModelItems } from './deco.js';
import { buildShadows, shadowCasters } from './shadows.js';
import { makeBannerCanvas, makeCheckerCanvas, makeGrassCanvas, makePadCanvas, makeGlowCanvas } from './gatetex.js';

function tex(canvas) {
  if (!canvas) return null;
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function mesh(name, positions, indices, uvs, material) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (uvs) g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(indices instanceof Uint32Array ? new THREE.BufferAttribute(indices, 1) : indices);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, material);
  m.name = name;
  return m;
}

/** Cono unitario con el pivote en el centro de la base (z = 0) y la punta en z = 1. */
function unitCone(seg = 8) {
  const pos = [], idx = [];
  for (let k = 0; k < seg; k++) { const a = (k / seg) * Math.PI * 2; pos.push(Math.cos(a), Math.sin(a), 0); }
  pos.push(0, 0, 1, 0, 0, 0);
  const apex = seg, bottom = seg + 1;
  for (let k = 0; k < seg; k++) { const a = k, c = (k + 1) % seg; idx.push(a, c, apex, c, a, bottom); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Escena de exportación (compartida por .glb y .fbx). yUp = true rota la raíz para glTF (Y arriba); FBX va en Z arriba. */
export async function buildExportScene(layout, elev, sp, textures = {}, paint = null, hills = null, items = null, { yUp = true } = {}) {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.name = 'TrackSplineGenerator';
  if (yUp) root.rotation.x = -Math.PI / 2; // Z arriba -> Y arriba
  scene.add(root);
  // pista: un mesh independiente por ruta (se llena después de conocer los túneles, por los tramos cubiertos)
  const trackGroup = new THREE.Group();
  trackGroup.name = 'pista';
  root.add(trackGroup);
  let tm = null, covAll = [];
  let terrain = null, HS = null;
  const tt = tex(textures.terrain);
  // paredes socavadas de ríos y cascadas: textura propia (textures.riverWall / fallWall) o roca por defecto
  const wallMats = {};
  const wallMat = (kind) => wallMats[kind] || (wallMats[kind] = (() => {
    const t = tex(kind === 'fall' ? textures.fallWall : textures.riverWall);
    if (t) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return new THREE.MeshStandardMaterial({ name: kind === 'fall' ? 'cauce_cascada' : 'cauce_rio', color: t ? 0xffffff : kind === 'fall' ? 0x7b7670 : 0x6d6258, map: t, roughness: 1, metalness: 0 });
  })());
  const riverList = [...((paint && !Array.isArray(paint) && paint.rivers) || []), ...(hills || []).flatMap((h) => h.falls || [])];
  if (sp.terrain || (hills && hills.length) || riverList.length) {
    terrain = buildTerrain(layout, elev, sp, paint);
    if (sp.terrain) {
      const cols = terrainTint(terrain, !!tt);
      const tm = mesh('terreno', terrain.positions, terrain.baseIndices || terrain.indices, terrain.uvs,
        new THREE.MeshStandardMaterial({ name: 'terreno', color: tt || cols ? 0xffffff : 0x4f7d3a, map: tt, roughness: 1, metalness: 0, vertexColors: !!cols }));
      if (cols) tm.geometry.setAttribute('color', new THREE.BufferAttribute(cols, 3)); // pasto, arena y roca
      root.add(tm);
      // paredes de las secciones socavadas
      const cw = terrain.cutWalls || {};
      // material general de cada tipo o uno propio por tramo (su textura: «muro_socavado_NN» / «roca_socavada_NN»)
      const nn = (i) => String(i + 1).padStart(2, '0');
      const ownOf = (i, kind, part = 'face') => (textures.cutWallFor && i != null ? textures.cutWallFor(i, kind, part) : null);
      const cutMats = {};
      // part: face (cara interior), top (tapa), out (cara exterior); gen = textura general de esa parte
      const cutMat = (kind, own = null, i = null, part = 'face', gen = null) => {
        const sfx = part === 'top' ? '_tapa' : part === 'out' ? '_exterior' : '';
        const key = `${kind}${sfx}${own ? i : ''}`;
        if (cutMats[key]) return cutMats[key];
        const t = tex(own || gen || (kind === 'art' ? textures.cutArt : textures.cutNat));
        return (cutMats[key] = new THREE.MeshStandardMaterial({ name: (kind === 'art' ? 'muro_socavado' : 'roca_socavada') + sfx + (own ? `_${nn(i)}` : ''), color: t ? 0xffffff : kind === 'art' ? 0x9c9d98 : 0x6b6158, map: t, roughness: kind === 'art' ? 0.85 : 1, metalness: 0 }));
      };
      if (cw.art && cw.art.parts) { // paredes lisas: una por tramo, extruidas desde la pista
        for (const q of cw.art.parts) {
          const ownF = ownOf(q.idx, 'art'), ownT = ownOf(q.idx, 'art', 'top'), ownO = ownOf(q.idx, 'art', 'out');
          const split = q.sub && (ownT || ownO || textures.cutArtTop || textures.cutArtOut); // tapa o exterior con otra textura: objetos por parte
          if (!split) { root.add(mesh(`socavado_${nn(q.idx)}_paredes`, q.positions, q.indices, q.uvs, cutMat('art', ownF, q.idx))); continue; }
          // cada parte: su textura propia → la general de esa parte → la de la cara interior (mismo material)
          const matOf = (part, ownP, gen) => (part !== 'face' && ownP ? cutMat('art', ownP, q.idx, part) : part !== 'face' && gen ? cutMat('art', null, null, part, gen) : cutMat('art', ownF, q.idx));
          for (const [part, sfx, ownP, gen] of [['face', '', null, null], ['top', '_tapa', ownT, textures.cutArtTop], ['out', '_exterior', ownO, textures.cutArtOut]]) {
            if (q.sub[part].length) root.add(mesh(`socavado_${nn(q.idx)}_paredes${sfx}`, q.positions, q.sub[part], q.uvs, matOf(part, ownP, gen)));
          }
        }
      }
      else if (cw.art) root.add(mesh('terreno_muros_socavados', cw.art.positions, cw.art.indices, cw.art.uvs, cutMat('art')));
      if (cw.nat) {
        // roca: los tramos con la textura general van juntos (como siempre); los que tienen la suya, un objeto propio
        const parts = cw.nat.parts || [{ idx: null, ...cw.nat }];
        const gen = parts.filter((q) => !ownOf(q.idx, 'nat')), own = parts.filter((q) => ownOf(q.idx, 'nat'));
        if (gen.length) {
          const P = [], U = [], I = [];
          for (const q of gen) { const b = P.length / 3; P.push(...q.positions); U.push(...q.uvs); for (const v of q.indices) I.push(b + v); }
          root.add(mesh('terreno_roca_socavada', new Float32Array(P), new Uint32Array(I), new Float32Array(U), cutMat('nat')));
        }
        for (const q of own) root.add(mesh(`socavado_${nn(q.idx)}_roca`, q.positions, q.indices, q.uvs, cutMat('nat', ownOf(q.idx, 'nat'), q.idx)));
      }
      if (terrain.wall) root.add(mesh('terreno_cauces', terrain.wall.positions, terrain.wall.indices, terrain.wall.uvs, wallMat('river'))); // lecho y paredes de los ríos
      // agua (playa / montaña): plano al nivel del mar
      if (terrain.waterLevel != null) {
        const b = terrain.bounds, mg = 400;
        const x0 = b.minX - mg, x1 = b.maxX + mg, y0 = b.minY - mg, y1 = b.maxY + mg, z = terrain.waterLevel;
        root.add(mesh('agua', new Float32Array([x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z]), [0, 1, 2, 0, 2, 3], new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
          new THREE.MeshStandardMaterial({ name: 'agua', color: 0x2c7fc0, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.85 })));
      }
    }
    HS = buildHills(layout, elev, sp, terrain, hills);
    // cerros: un objeto por cerro
    if (HS.hills.length) {
      const hg = new THREE.Group();
      hg.name = 'cerros';
      root.add(hg);
      const hillMat = new THREE.MeshStandardMaterial({ name: 'cerro', color: tt ? 0xffffff : 0x6f7d45, map: tt, roughness: 1, metalness: 0 });
      for (const h of HS.hills) {
        if (h.indices.length) hg.add(mesh(h.name, h.positions, h.wall ? h.baseIndices : h.indices, h.uvs, hillMat));
        if (h.wall) hg.add(mesh(`${h.name}_cauce`, h.wall.positions, h.wall.indices, h.wall.uvs, wallMat('fall'))); // paredes de sus cascadas
      }
    }
    // ríos y cascadas: un objeto por cada uno (rio_NN / cascada_NN), con materiales distintos
    if (riverList.length) {
      const RW = buildRivers(terrain, HS, riverList);
      if (RW.length) {
        const rg = new THREE.Group();
        rg.name = 'rios';
        root.add(rg);
        const riverMat = new THREE.MeshStandardMaterial({ name: 'rio', color: 0x2f86d6, roughness: 0.12, metalness: 0.05, transparent: true, opacity: 0.85 });
        const fallMat = new THREE.MeshStandardMaterial({ name: 'cascada', color: 0xbfe8ff, roughness: 0.25, metalness: 0, transparent: true, opacity: 0.9 });
        let bedMat = null;
        for (const w of RW) {
          rg.add(mesh(w.name, w.positions, w.indices, w.uvs, w.kind === 'fall' ? fallMat : riverMat));
          if (w.bed) { // lecho de un río socavado (opcional): rio_NN_lecho
            if (!bedMat) { const t = tex(textures.riverBed); bedMat = new THREE.MeshStandardMaterial({ name: 'lecho_rio', color: t ? 0xffffff : 0x6b5a45, map: t, roughness: 1, metalness: 0 }); }
            rg.add(mesh(w.bed.name, w.bed.positions, w.bed.indices, w.bed.uvs, bedMat));
          }
        }
      }
    }
    // túneles: paredes, techo, veredas, bocas, estalactitas, rocas y cada pilar como objetos propios
    if (HS.tunnelGeo.length) {
      const M = (name, color, extra = {}) => new THREE.MeshStandardMaterial({ name, color, roughness: 0.95, metalness: 0, side: THREE.DoubleSide, ...extra });
      // materiales por tipo (cada túnel puede ser artificial o natural)
      const byType = {};
      const matsFor = (natural) => byType[natural] || (byType[natural] = {
        wall: M(natural ? 'tunel_paredes_natural' : 'tunel_paredes', natural ? 0x6f6259 : 0x9a9da3, { flatShading: natural }),
        ceil: M(natural ? 'tunel_techo_natural' : 'tunel_techo', natural ? 0x5d5249 : 0x7e8288, { flatShading: natural }),
        portal: M(natural ? 'tunel_boca_natural' : 'tunel_boca', natural ? 0x857566 : 0xb9bcc2, { flatShading: natural }),
      });
      const walkMat = M('tunel_veredas', 0x8a8a84);
      const rockMat = M('roca', 0x5c5049, { flatShading: true });
      const pillarMat = new THREE.MeshStandardMaterial({ name: 'pilar', color: 0x8d9097, roughness: 0.85 });
      // texturas de paredes y techo (propias del túnel o generales; las veredas usan la de las paredes)
      const tile = Math.max(0.5, sp.tunnelTexTile ?? 6);
      const texMats = new Map();
      const texMat = (cv, name, natural) => {
        if (!cv) return null;
        const key = cv;
        if (!texMats.has(key)) {
          const tx = tex(cv);
          tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
          tx.repeat.set(6 / tile, 6 / tile);
          texMats.set(key, M(name, 0xffffff, { map: tx, flatShading: natural }));
        }
        return texMats.get(key);
      };
      const tTex = (uid, kind) => (textures.tunnelTex ? textures.tunnelTex(uid, kind) : null);
      // antorcha por defecto como un «asset» más (soporte + llama), para usar el mismo camino que los modelos
      const TG = torchGeometry();
      const geoOf = (g) => { const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(g.positions), 3)); bg.setIndex(g.indices); bg.computeVertexNormals(); return bg; };
      const TORCH = { id: '__antorcha', name: 'antorcha', parts: [
        { name: 'soporte', geometry: geoOf(TG.wood), material: new THREE.MeshStandardMaterial({ name: 'antorcha', color: 0x4a3526, roughness: 0.9, metalness: 0 }), matrix: new THREE.Matrix4() },
        { name: 'llama', geometry: geoOf(TG.flame), material: new THREE.MeshBasicMaterial({ name: 'antorcha_llama', color: 0xffa22e, side: THREE.DoubleSide }), matrix: new THREE.Matrix4() },
      ] };
      const decoAsset = (id) => (id === '__antorcha' ? TORCH : textures.assetById ? textures.assetById(id) : null);
      const tg = new THREE.Group();
      tg.name = 'tuneles';
      root.add(tg);
      for (const t of HS.tunnelGeo) {
        const grp = new THREE.Group();
        grp.name = t.name;
        tg.add(grp);
        const put = (suffix, geo, mat) => { if (geo.indices.length) grp.add(mesh(`${t.name}_${suffix}`, geo.positions, geo.indices, geo.uvs || null, mat)); };
        const tm = matsFor(!!t.natural);
        const own = t.texUid && textures.tunnelTex && (textures.tunnelTex(t.texUid, 'wall') !== textures.tunnelTex(null, 'wall') || textures.tunnelTex(t.texUid, 'ceil') !== textures.tunnelTex(null, 'ceil'));
        const wT = texMat(tTex(t.texUid, 'wall'), own ? `${t.name}_paredes` : 'tunel_paredes_textura', !!t.natural);
        const cT = texMat(tTex(t.texUid, 'ceil'), own ? `${t.name}_techo` : 'tunel_techo_textura', !!t.natural);
        put('paredes', t.walls, wT || tm.wall);
        put('techo', t.ceiling, cT || tm.ceil);
        put('veredas', t.walkways, wT || walkMat);
        for (const pt of t.portals) put(pt.suffix, pt.geo, tm.portal);
        if (t.shell) put('cascara', t.shell, tm.portal); // «Quitar cerro»: exterior del túnel
        // rocas y estalactitas: una malla por tipo (single mesh) o cada una como objeto propio con su pivote
        // (la roca en el piso, la estalactita en su base pegada al techo)
        const items = (list, nm) => list.forEach((it, i) => {
          const m = mesh(`${t.name}_${nm}_${String(i + 1).padStart(2, '0')}`, new Float32Array(it.positions), it.indices, null, rockMat);
          m.position.set(it.x, it.y, it.z);
          grp.add(m);
        });
        if (t.singleMesh === false) { items(t.stalItems || [], 'estalactita'); items(t.rockItems || [], 'roca'); }
        else { put('estalactitas', t.stalactites, rockMat); put('rocas', t.rocks, rockMat); }
        // decoración de pared: una malla por material («single mesh») o cada elemento con su pivote en la pared
        if (t.wallDeco && t.wallDeco.length) {
          const D = t.deco || {};
          const aid = D.model != null && decoAsset(D.model) ? D.model : '__antorcha';
          const rot = ((D.rot || 0) * Math.PI) / 180;
          const items = t.wallDeco.map((w) => ({ x: w.x, y: w.y, z: w.z, yaw: w.yaw + rot, scale: D.scale || 1, asset: aid }));
          if (D.single !== false) for (const m of mergedAssetMeshes(decoAsset, items, `${t.name}_decoracion`)) grp.add(m);
          else items.forEach((it, i) => grp.add(assetObject(decoAsset(aid), it, `${t.name}_decoracion_${String(i + 1).padStart(2, '0')}`)));
        }
        t.pillars.forEach((pl, i) => {
          const pg = pillarGeometry(pl);
          const m = mesh(`${t.name}_pilar_${String(i + 1).padStart(2, '0')}`, pg.positions, pg.indices, null, pillarMat);
          m.position.set(pl.x, pl.y, pl.z);
          grp.add(m);
        });
      }
    }
  }
  // pista: rutas (pista / atajos) y tramos cubiertos (túneles y bajo cruces) con materiales propios
  {
    const cov = coveredRanges(layout, elev, HS ? HS.tunnels.map((t) => ({ k: t.k, s0: t.s0, s1: t.s1 })) : []);
    covAll = cov;
    tm = buildTrackMesh(layout, elev, { ...sp, skirts: sp.terrain && sp.skirts, coveredRanges: cov });
    const M = (name, t, fallback) => new THREE.MeshStandardMaterial({ name, color: t ? 0xffffff : fallback, map: t, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
    const trackMat = M('pista', tex(textures.track), 0x55585e);
    const altMat = M('pista_atajo', tex(textures.alt || textures.track), 0x55585e);
    const covMat = M('pista_cubierta', tex(textures.covered || textures.track), 0x44464b);
    // cada atajo con textura propia tiene su material (pista_<atajo>); los demás comparten pista_atajo
    const altOwn = new Map();
    const matFor = (p) => {
      if (!p.alt) return trackMat;
      const r = layout.routes[p.k];
      const own = r && textures.altFor ? textures.altFor(r).track : null;
      if (!own) return altMat;
      if (!altOwn.has(r.name)) altOwn.set(r.name, M(`pista_${r.name}`, tex(own), 0x55585e));
      return altOwn.get(r.name);
    };
    for (const p of tm.parts) if (p.indices.length) trackGroup.add(mesh(p.name, p.positions, p.indices, p.uvs, matFor(p)));
    for (const p of tm.coveredParts) trackGroup.add(mesh(p.name, p.positions, p.indices, p.uvs, covMat));
    // tramos suspendidos: textura propia (pista_suspendida) o el material de la pista
    const suspMat = textures.susp ? M('pista_suspendida', tex(textures.susp), 0x55585e) : null;
    for (const p of tm.suspParts || []) trackGroup.add(mesh(p.name, p.positions, p.indices, p.uvs, suspMat || matFor(p)));
  }
  // puentes creados a mano: tablero (textura propia, café por defecto) y un objeto por pilar, pivote en la base
  {
    const bp = bridgePillars(layout, elev, terrain, sp);
    let grp = null;
    const hasB = tm.bridgeParts.some((q) => q.type === 'bridge' || !q.type), hasT = tm.bridgeParts.some((q) => q.type === 'track' || q.type === 'cut');
    if (bp.length || hasB) {
      grp = new THREE.Group();
      grp.name = 'puentes';
      root.add(grp);
    }
    let grpT = null; // tramos de pista: su tablero con material propio (tramo_NN)
    if (hasT) { grpT = new THREE.Group(); grpT.name = 'tramos'; root.add(grpT); }
    if (tm.bridgeParts.length) {
      const bt = tex(textures.bridge);
      // cada puente con su propio material de piso (puente_NN)
      for (const p of tm.bridgeParts) {
        const own = textures.bridgeFor ? textures.bridgeFor(p.bridge) : null;
        const t = own && own.deck ? tex(own.deck) : bt;
        const deckMat = new THREE.MeshStandardMaterial({ name: p.name, color: t ? 0xffffff : 0x7a5433, map: t, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
        (p.type === 'track' || p.type === 'cut' ? grpT : grp).add(mesh(p.name, p.positions, p.indices, p.uvs, deckMat));
      }
    }
    if (bp.length) {
      const mat = new THREE.MeshStandardMaterial({ name: 'puente_pilar', color: 0x7a818f, roughness: 0.9 });
      const cnt = {};
      for (const pl of bp) {
        cnt[pl.bridge] = (cnt[pl.bridge] || 0) + 1;
        const pg = pillarGeometry({ size: pl.size, h: pl.zTop - pl.zBot, angle: pl.angle });
        const m = mesh(`puente_${String(pl.bridge + 1).padStart(2, '0')}_pilar_${String(cnt[pl.bridge]).padStart(2, '0')}`, pg.positions, pg.indices, null, mat);
        m.position.set(pl.x, pl.y, pl.zBot);
        grp.add(m);
      }
    }
  }
  // bordes de la pista: camino de tierra y barreras (extruidos de las secciones de la pista, también en los túneles)
  {
    const B = buildEdgeMeshes(layout, elev, { ...sp, coveredRanges: covAll }); // también dentro de los túneles (mismas secciones que la pista)
    if (B.dirt.length || B.barriers.length) {
      const grp = new THREE.Group();
      grp.name = 'bordes';
      root.add(grp);
      const DM = (name, t) => new THREE.MeshStandardMaterial({ name, color: t ? 0xffffff : 0xc9a877, map: t, roughness: 1, metalness: 0 });
      const BM = (name, t) => new THREE.MeshStandardMaterial({ name, color: t ? 0xffffff : 0xd42a2a, map: t, roughness: 0.6, metalness: 0.1 });
      const dirtMat = DM('camino_tierra', tex(textures.dirt)), barMat = BM('barrera', tex(textures.barrier));
      const dirtAlt = DM('camino_tierra_atajo', tex(textures.altDirt || textures.dirt)), barAlt = BM('barrera_atajo', tex(textures.altBarrier || textures.barrier));
      // cada atajo con textura propia de barrera / camino tiene su material (barrera_<atajo>, camino_tierra_<atajo>)
      const own = new Map();
      const suspDirt = textures.suspDirt ? DM('camino_tierra_suspendido', tex(textures.suspDirt)) : null;
      const suspBar = textures.suspBarrier ? BM('barrera_suspendida', tex(textures.suspBarrier)) : null;
      const edgeMat = (m, kind) => {
        if (m.bridge != null) { // camino de tierra y barrera de un puente: materiales únicos de ese puente
          const nm = `${kind === 'dirt' ? 'camino_tierra' : 'barrera'}_${m.bridgeTy || 'puente'}_${String(m.bridge + 1).padStart(2, '0')}`;
          if (!own.has(nm)) {
            const bt2 = textures.bridgeFor ? textures.bridgeFor(m.bridge)[kind] : null;
            own.set(nm, kind === 'dirt' ? DM(nm, tex(bt2 || textures.dirt)) : BM(nm, tex(bt2 || textures.barrier)));
          }
          return own.get(nm);
        }
        if (m.susp && (kind === 'dirt' ? suspDirt : suspBar)) return kind === 'dirt' ? suspDirt : suspBar; // bordes del tramo suspendido
        if (!m.alt) return kind === 'dirt' ? dirtMat : barMat;
        const r = layout.routes[m.k];
        const t = r && textures.altFor ? textures.altFor(r)[kind] : null;
        if (!t) return kind === 'dirt' ? dirtAlt : barAlt;
        const key = kind + ':' + r.name;
        if (!own.has(key)) own.set(key, kind === 'dirt' ? DM(`camino_tierra_${r.name}`, tex(t)) : BM(`barrera_${r.name}`, tex(t)));
        return own.get(key);
      };
      for (const m of B.dirt) grp.add(mesh(m.name, m.positions, m.indices, m.uvs, edgeMat(m, 'dirt')));
      for (const m of B.barriers) grp.add(mesh(m.name, m.positions, m.indices, m.uvs, edgeMat(m, 'barrier')));
    }
  }
  // pórtico de salida: pivote en la base, al centro de la calzada
  let gateTris = 0;
  if (sp.startGate) {
    const G = buildStartGate(layout, elev, sp);
    const grp = new THREE.Group();
    grp.name = 'portico_salida';
    grp.position.set(...G.origin);
    root.add(grp);
    const bt = tex(makeBannerCanvas(G.text));
    const ct = tex(makeCheckerCanvas());
    grp.add(mesh('portico_salida_estructura', G.frame.positions, G.frame.indices, G.frame.uvs, new THREE.MeshStandardMaterial({ name: 'portico', color: 0x30343c, roughness: 0.6, metalness: 0.3 })));
    grp.add(mesh('portico_salida_cartel', G.banner.positions, G.banner.indices, G.banner.uvs, new THREE.MeshStandardMaterial({ name: 'portico_cartel', map: bt, roughness: 0.7 })));
    grp.add(mesh('linea_salida', G.line.positions, G.line.indices, G.line.uvs, new THREE.MeshStandardMaterial({ name: 'linea_salida', map: ct, roughness: 0.8 })));
    gateTris = G.tris;
  }
  // árboles: una sola malla («single mesh») o un objeto por árbol, con el pivote en el centro de la base
  let treeCount = 0;
  const ground = makeGround(terrain, HS);
  // pilares de los tramos suspendidos: suspendido_NN_pilar_MM, pivote en la base
  {
    const sp2 = sp.suspRanges && sp.suspRanges.length ? sp : null;
    const pls = sp2 ? suspPillars(layout, elev, sp2, ground) : [];
    if (pls.length) {
      const grp = new THREE.Group();
      grp.name = 'suspendidos';
      root.add(grp);
      const mat = new THREE.MeshStandardMaterial({ name: 'suspendido_pilar', color: 0x8a8f99, roughness: 0.85 });
      for (const pl of pls) {
        const pg = pillarGeometry({ size: pl.size, h: pl.zTop - pl.zBot, angle: pl.angle });
        const m = mesh(`suspendido_${String(pl.zone + 1).padStart(2, '0')}_pilar_${String(pl.n).padStart(2, '0')}`, pg.positions, pg.indices, null, mat);
        m.position.set(pl.x, pl.y, pl.zBot);
        grp.add(m);
      }
    }
  }
  // decoración (textures.deco = {assetById, sets, paintFor}): modelos de la biblioteca para árboles, hierba y sets
  const DC = textures.deco || null;
  const byId = (id) => (DC && DC.assetById ? DC.assetById(id) : null);
  const hasAsset = (id) => !!byId(id);
  const putItems = (grp, items, prefix) => items.forEach((it, i) => { const A = byId(it.asset); if (A) grp.add(assetObject(A, it, `${prefix}_${String(i + 1).padStart(4, '0')}`)); });
  let shadowTrees = null;
  if (sp.trees) {
    const tr = buildTrees(layout, elev, sp, ground);
    shadowTrees = tr.trees;
    treeCount = tr.count;
    const tItems = treeModelItems(tr.trees, sp.treeAssets, hasAsset);
    const single = sp.treeSingle !== false; // «single mesh»: todos los árboles en una malla (una por material con modelos)
    if (tItems) { // árboles con modelos: un objeto por árbol (pivote del modelo) o combinados
      const grp = new THREE.Group();
      grp.name = 'arboles';
      root.add(grp);
      if (single) for (const m of mergedAssetMeshes(byId, tItems, 'arboles_malla')) grp.add(m);
      else putItems(grp, tItems, 'arbol');
    } else if (tr.count) {
      const grp = new THREE.Group();
      grp.name = 'arboles';
      root.add(grp);
      const mat = new THREE.MeshStandardMaterial({ name: 'arbol', color: 0x2e6b34, roughness: 0.9, flatShading: true });
      if (single) grp.add(mesh('arboles_malla', tr.positions, tr.indices, null, mat));
      else {
        const geo = unitCone(8);
        tr.trees.forEach((t, i) => {
          // geometría propia con escala 1: el origen del objeto es el centro de la base del cono
          const g = geo.clone();
          g.scale(t.r * (t.ex || 1), t.r * (t.ey || 1), t.h);
          g.computeVertexNormals();
          const m = new THREE.Mesh(g, mat);
          m.name = `arbol_${String(i + 1).padStart(4, '0')}`;
          m.position.set(...t.basePos);
          // inclinación según el suelo y giro aleatorio sobre su eje: rotación del objeto (geometría recta en su espacio local)
          m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...t.up)).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), t.yaw || 0));
          grp.add(m);
        });
      }
    }
  }
  // elementos de pista: un objeto por elemento (puddlesA-1, turbopadA-1, nitrostripA-1…), pivote en la base sobre la calzada
  let itemCount = 0;
  if (items && items.some((g) => g.items.length)) {
    const ig = new THREE.Group();
    ig.name = 'elementos_pista';
    root.add(ig);
    const IT = textures.items || {};
    const tp = tex(IT.puddle), ts = tex(IT.strip);
    const mats = {
      puddle: new THREE.MeshStandardMaterial({ name: 'charco', color: tp ? 0xffffff : 0x3a8fe8, map: tp, roughness: 0.08, metalness: 0.3 }),
      pad: new THREE.MeshStandardMaterial({ name: 'turbopad', map: tex(IT.pad || makePadCanvas()), roughness: 0.6 }),
      strip: new THREE.MeshStandardMaterial({ name: 'nitrostrip', color: ts ? 0xffffff : 0x22c55e, map: ts, emissive: ts ? 0x000000 : 0x0b5d2a, roughness: 0.5 }),
    };
    const borderMat = new THREE.MeshStandardMaterial({ name: 'nitrostrip_borde', map: tex(IT.border || makeGlowCanvas()), transparent: true, depthWrite: false, roughness: 1, side: THREE.FrontSide });
    const Mx = new THREE.Matrix4();
    for (const g of items) {
      if (!g.items.length) continue;
      const gg = new THREE.Group();
      gg.name = g.name;
      ig.add(gg);
      for (const it of g.items) {
        const m = mesh(it.name, it.positions, it.indices, it.uvs, mats[it.type]);
        m.position.set(...it.origin);
        if (it.basis) {
          const [T, Lt, U] = it.basis;
          Mx.makeBasis(new THREE.Vector3(...T), new THREE.Vector3(...Lt), new THREE.Vector3(...U));
          m.quaternion.setFromRotationMatrix(Mx);
        }
        if (it.border) {
          const b = mesh(`${it.name}_borde`, it.border.positions, it.border.indices, it.border.uvs, borderMat);
          m.add(b); // hijo del nitro strip: se mueve con él
          b.position.set(0, 0, 0);
        }
        gg.add(m);
        itemCount++;
      }
    }
  }
  // triggers: cubos invisibles (material transparente «trigger», opacidad 0) de todo el ancho de la pista, pivote en el
  // centro de la base; en los extras de glTF (userData) va de qué trigger se trata (túnel: entrada / salida, o propio)
  let triggerCount = 0;
  {
    const tun = HS ? HS.tunnels.map((t) => ({ id: t.id, k: t.k, e0: t.e0, e1: t.e1, name: `tunel_${String(t.id + 1).padStart(2, '0')}` })) : [];
    const TR = buildTriggers(layout, elev, sp, textures.triggers || [], tun);
    if (TR.length) {
      const grp = new THREE.Group();
      grp.name = 'triggers';
      root.add(grp);
      const mat = new THREE.MeshBasicMaterial({ name: 'trigger', color: 0x00ffff, transparent: true, opacity: 0, depthWrite: false });
      const Mx = new THREE.Matrix4();
      for (const t of TR) {
        const g = new THREE.BoxGeometry(t.d, t.w, t.h).translate(0, 0, t.h / 2);
        const m = new THREE.Mesh(g, mat);
        m.name = t.name;
        m.position.set(...t.center);
        Mx.makeBasis(new THREE.Vector3(...t.T).normalize(), new THREE.Vector3(...t.L).normalize(), new THREE.Vector3(...t.U).normalize());
        m.quaternion.setFromRotationMatrix(Mx);
        m.userData = { trigger: t.kind, ...(t.tunnel ? { tunnel: t.tunnel } : {}), ...(t.label ? { label: t.label } : {}), width: +t.w.toFixed(3), depth: t.d, height: t.h };
        grp.add(m);
        triggerCount++;
      }
    }
  }
  // colisión: camino de tierra (plano) y costados (plano o volumen), material invisible «colision»; en los extras de glTF
  // (userData) va {collision: 'dirt' | 'sides'} para que el motor los use como colisionadores y no los dibuje
  let collisionTris = 0;
  {
    const C = buildCollisionMeshes(layout, elev, sp, { deck: textures.collisionDeck ?? 1 });
    if (C.dirt.length || C.sides.length) {
      const grp = new THREE.Group();
      grp.name = 'colision';
      root.add(grp);
      const mat = new THREE.MeshBasicMaterial({ name: 'colision', color: 0xff00ff, transparent: true, opacity: 0, depthWrite: false });
      for (const m of [...C.dirt, ...C.sides]) {
        const o = mesh(m.name, m.positions, m.indices, null, mat);
        o.userData = { collision: m.side ? 'sides' : 'dirt', ...(m.side ? { thickness: m.plane ? 0 : +(+sp.collThick).toFixed(3), oneSided: !!m.plane } : { oneSided: true }) };
        grp.add(o);
      }
      collisionTris = C.tris;
    }
  }
  // hierba: una sola malla (planos cruzados) con textura recortada por transparencia
  let grassCount = 0;
  if (sp.grass) {
    const gr = buildGrass(layout, elev, sp, ground);
    grassCount = gr.count;
    const gItems = grassModelItems(gr.insts, sp.grassAssets, hasAsset);
    if (gItems) {
      const grp = new THREE.Group();
      grp.name = 'hierba';
      root.add(grp);
      putItems(grp, gItems, 'hierba');
    } else if (gr.count) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(gr.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(gr.normals, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(gr.uvs, 2));
      g.setIndex(new THREE.BufferAttribute(gr.indices, 1));
      const gt = tex(textures.grass || makeGrassCanvas());
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ name: 'hierba', map: gt, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1, metalness: 0 }));
      m.name = 'hierba';
      root.add(m);
    }
  }
  // sets de decoración: decoracion/<set>/<set>_malla («single mesh») o <set>_0001… (cubos de color o modelos), pivote en la base
  let decoCount = 0;
  if (DC && DC.sets && DC.sets.length) {
    const res = decoSetItems(layout, elev, sp, ground, DC.sets, DC.paintFor, hasAsset);
    const dg = new THREE.Group();
    dg.name = 'decoracion';
    for (const { set, items } of res) {
      if (!items.length) continue;
      const sg = new THREE.Group();
      sg.name = set.name;
      dg.add(sg);
      const assetOf = (id) => builtinAsset(id) || byId(id);
      if (set.single !== false) for (const m of mergedAssetMeshes(assetOf, items, `${set.name}_malla`)) sg.add(m); // «single mesh»: una malla por material
      else items.forEach((it, i) => {
        const A = assetOf(it.asset);
        if (A) sg.add(assetObject(A, it, `${set.name}_${String(i + 1).padStart(4, '0')}`));
      });
      decoCount += items.length;
    }
    if (dg.children.length) root.add(dg);
  }
  // planos de sombra: todas en una sola malla («sombras»), con la textura de sombra (transparente)
  let shadowCount = 0, shadowTris = 0;
  if (sp.shadows) {
    const sets = (DC && DC.sets ? DC.sets : []).filter((q) => q.shadow && q.visible !== false);
    const decoRes = sets.length ? decoSetItems(layout, elev, sp, ground, sets, DC.paintFor, hasAsset) : [];
    const cas = shadowCasters(sp, shadowTrees, decoRes, (id) => builtinAsset(id) || byId(id));
    const SH = buildShadows(layout, elev, sp, ground, cas, {});
    if (SH.tris) {
      const st = tex(textures.shadow);
      const mat = new THREE.MeshBasicMaterial({ name: 'sombra', color: st ? 0xffffff : 0x000000, map: st, transparent: true, opacity: st ? 1 : 0.2, depthWrite: false });
      const m = mesh('sombras', SH.positions, SH.indices, SH.uvs, mat);
      root.add(m);
      shadowCount = SH.count; shadowTris = SH.tris;
    }
  }
  return { scene, root, info: { shadows: shadowCount, shadowTris, decoCount, trackTris: tm.indices.length / 3, terrainTris: terrain && sp.terrain ? terrain.tris : 0, hills: HS ? HS.hills.length : 0, hillTris: HS ? HS.tris : 0, tunnels: HS ? HS.tunnelGeo.length : 0, gateTris, trees: treeCount, treeTris: treeCount * 16, grass: grassCount, items: itemCount, triggers: triggerCount, collisionTris } };
}

export async function exportGLB(...args) {
  const { scene, info } = await buildExportScene(...args.slice(0, 7), { yUp: true });
  const exporter = new GLTFExporter();
  const buf = await exporter.parseAsync(scene, { binary: true });
  return { buffer: buf, info };
}
