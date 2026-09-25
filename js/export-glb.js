// Exporta la escena (pista con UV, terreno y árboles, con texturas incrustadas) a glTF binario (.glb).
// glTF usa Y arriba: se rota la raíz para que Blender / 3ds Max la importen con Z arriba y en metros.
import * as THREE from 'three';
import { GLTFExporter } from '../vendor/exporters/GLTFExporter.js';
import { buildTrackMesh, buildTerrain, buildTrees, buildHills, buildStartGate, buildGrass, makeGround, bridgePillars } from './scene.js';
import { pillarGeometry } from './tunnels.js';
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
  // pista: un mesh independiente por ruta
  const tm = buildTrackMesh(layout, elev, { ...sp, skirts: sp.terrain && sp.skirts });
  const trackTex = tex(textures.track);
  const trackMat = new THREE.MeshStandardMaterial({ name: 'pista', color: trackTex ? 0xffffff : 0x55585e, map: trackTex, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  const trackGroup = new THREE.Group();
  trackGroup.name = 'pista';
  root.add(trackGroup);
  for (const p of tm.parts) trackGroup.add(mesh(p.name, p.positions, p.indices, p.uvs, trackMat));
  let terrain = null, HS = null;
  const tt = tex(textures.terrain);
  if (sp.terrain || (hills && hills.length)) {
    terrain = buildTerrain(layout, elev, sp, paint);
    if (sp.terrain) {
      root.add(mesh('terreno', terrain.positions, terrain.indices, terrain.uvs,
        new THREE.MeshStandardMaterial({ name: 'terreno', color: tt ? 0xffffff : 0x4f7d3a, map: tt, roughness: 1, metalness: 0 })));
    }
    HS = buildHills(layout, elev, sp, terrain, hills);
    // cerros: un objeto por cerro
    if (HS.hills.length) {
      const hg = new THREE.Group();
      hg.name = 'cerros';
      root.add(hg);
      const hillMat = new THREE.MeshStandardMaterial({ name: 'cerro', color: tt ? 0xffffff : 0x6f7d45, map: tt, roughness: 1, metalness: 0 });
      for (const h of HS.hills) if (h.indices.length) hg.add(mesh(h.name, h.positions, h.indices, h.uvs, hillMat));
    }
    // túneles: paredes, techo, veredas, bocas, estalactitas, rocas y cada pilar como objetos propios
    if (HS.tunnelGeo.length) {
      const natural = sp.tunnelType === 'natural';
      const M = (name, color, extra = {}) => new THREE.MeshStandardMaterial({ name, color, roughness: 0.95, metalness: 0, side: THREE.DoubleSide, ...extra });
      const wallMat = M('tunel_paredes', natural ? 0x6f6259 : 0x9a9da3, { flatShading: natural });
      const ceilMat = M('tunel_techo', natural ? 0x5d5249 : 0x7e8288, { flatShading: natural });
      const walkMat = M('tunel_veredas', 0x8a8a84);
      const portalMat = M('tunel_boca', natural ? 0x857566 : 0xb9bcc2, { flatShading: natural });
      const rockMat = M('roca', 0x5c5049, { flatShading: true });
      const pillarMat = new THREE.MeshStandardMaterial({ name: 'pilar', color: 0x8d9097, roughness: 0.85 });
      const tg = new THREE.Group();
      tg.name = 'tuneles';
      root.add(tg);
      for (const t of HS.tunnelGeo) {
        const grp = new THREE.Group();
        grp.name = t.name;
        tg.add(grp);
        const put = (suffix, geo, mat) => { if (geo.indices.length) grp.add(mesh(`${t.name}_${suffix}`, geo.positions, geo.indices, geo.uvs || null, mat)); };
        put('paredes', t.walls, wallMat);
        put('techo', t.ceiling, ceilMat);
        put('veredas', t.walkways, walkMat);
        for (const pt of t.portals) put(pt.suffix, pt.geo, portalMat);
        put('estalactitas', t.stalactites, rockMat);
        put('rocas', t.rocks, rockMat);
        t.pillars.forEach((pl, i) => {
          const pg = pillarGeometry(pl);
          const m = mesh(`${t.name}_pilar_${String(i + 1).padStart(2, '0')}`, pg.positions, pg.indices, null, pillarMat);
          m.position.set(pl.x, pl.y, pl.z);
          grp.add(m);
        });
      }
    }
  }
  // puentes creados a mano: tablero (textura propia, café por defecto) y un objeto por pilar, pivote en la base
  {
    const bp = bridgePillars(layout, elev, terrain);
    let grp = null;
    if (bp.length || tm.bridgeParts.length) {
      grp = new THREE.Group();
      grp.name = 'puentes';
      root.add(grp);
    }
    if (tm.bridgeParts.length) {
      const bt = tex(textures.bridge);
      const deckMat = new THREE.MeshStandardMaterial({ name: 'puente', color: bt ? 0xffffff : 0x7a5433, map: bt, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
      for (const p of tm.bridgeParts) grp.add(mesh(p.name, p.positions, p.indices, p.uvs, deckMat));
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
  // árboles: un objeto por árbol, con el pivote en el centro de la base
  let treeCount = 0;
  const ground = makeGround(terrain, HS);
  if (sp.trees) {
    const tr = buildTrees(layout, elev, sp, ground);
    treeCount = tr.count;
    if (tr.count) {
      const grp = new THREE.Group();
      grp.name = 'arboles';
      root.add(grp);
      const geo = unitCone(8);
      const mat = new THREE.MeshStandardMaterial({ name: 'arbol', color: 0x2e6b34, roughness: 0.9, flatShading: true });
      tr.trees.forEach((t, i) => {
        // geometría propia con escala 1: el origen del objeto es el centro de la base del cono
        const g = geo.clone();
        g.scale(t.r, t.r, t.h);
        g.computeVertexNormals();
        const m = new THREE.Mesh(g, mat);
        m.name = `arbol_${String(i + 1).padStart(4, '0')}`;
        m.position.set(...t.basePos);
        // inclinación según el suelo: rotación del objeto (la geometría queda recta en su espacio local)
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...t.up));
        grp.add(m);
      });
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
  // hierba: una sola malla (planos cruzados) con textura recortada por transparencia
  let grassCount = 0;
  if (sp.grass) {
    const gr = buildGrass(layout, elev, sp, ground);
    grassCount = gr.count;
    if (gr.count) {
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
  return { scene, root, info: { trackTris: tm.indices.length / 3, terrainTris: terrain && sp.terrain ? terrain.tris : 0, hills: HS ? HS.hills.length : 0, hillTris: HS ? HS.tris : 0, tunnels: HS ? HS.tunnelGeo.length : 0, gateTris, trees: treeCount, treeTris: treeCount * 16, grass: grassCount, items: itemCount } };
}

export async function exportGLB(...args) {
  const { scene, info } = await buildExportScene(...args.slice(0, 7), { yUp: true });
  const exporter = new GLTFExporter();
  const buf = await exporter.parseAsync(scene, { binary: true });
  return { buffer: buf, info };
}
