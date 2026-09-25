// Exportador FBX binario (7.4) propio, sin dependencias: toma la misma escena que el .glb (Z arriba, metros)
// y escribe modelos (mallas y nulos para los grupos), geometrías con normales y UV, materiales y texturas incrustadas.
import * as THREE from 'three';
import { buildExportScene } from './export-glb.js';

const enc = new TextEncoder();
const FILE_ID = new Uint8Array([0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2, 0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1]);
const FOOT_ID = new Uint8Array([0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e]);
const FOOT_MAGIC = new Uint8Array([0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b]);
const VERSION = 7400;
const ALWAYS_SENTINEL = new Set(['AnimationStack', 'AnimationLayer']);

// ---- propiedades tipadas ----
const I = (v) => ({ t: 'I', v });
const L = (v) => ({ t: 'L', v: BigInt(v) });
const D = (v) => ({ t: 'D', v });
const C = (v) => ({ t: 'C', v: v ? 1 : 0 });
const S = (v) => ({ t: 'S', v: typeof v === 'string' ? enc.encode(v) : v });
const R = (v) => ({ t: 'R', v });
const Ad = (a) => ({ t: 'd', v: a instanceof Float64Array ? a : Float64Array.from(a) });
const Ai = (a) => ({ t: 'i', v: a instanceof Int32Array ? a : Int32Array.from(a) });
const N = (name, props = [], children = []) => ({ name, props, children });
/** "nombre\x00\x01Clase" (convención de nombres del FBX binario). */
const nameClass = (name, cls) => { const a = enc.encode(name), b = enc.encode(cls); const out = new Uint8Array(a.length + 2 + b.length); out.set(a, 0); out[a.length] = 0; out[a.length + 1] = 1; out.set(b, a.length + 2); return out; };
const P = (...args) => N('P', args.map((a) => (typeof a === 'string' ? S(a) : a)));
const P70 = (entries) => N('Properties70', [], entries);

function propSize(p) {
  switch (p.t) {
    case 'C': return 2;
    case 'I': case 'F': return 5;
    case 'L': case 'D': return 9;
    case 'S': case 'R': return 5 + p.v.length;
    default: return 13 + p.v.byteLength; // arreglos
  }
}
function nodeSize(n, isLast) {
  let s = 13 + enc.encode(n.name).length;
  for (const p of n.props) s += propSize(p);
  n.children.forEach((c, i) => { s += nodeSize(c, i === n.children.length - 1); });
  if (n.children.length || (!n.props.length && !isLast) || ALWAYS_SENTINEL.has(n.name)) s += 13;
  return s;
}

class Buf {
  constructor(size) { this.u8 = new Uint8Array(size); this.dv = new DataView(this.u8.buffer); this.o = 0; }
  u32(v) { this.dv.setUint32(this.o, v >>> 0, true); this.o += 4; }
  i32(v) { this.dv.setInt32(this.o, v, true); this.o += 4; }
  bytes(a) { this.u8.set(a, this.o); this.o += a.length; }
  byte(v) { this.u8[this.o++] = v; }
  zeros(n) { this.o += n; }
}

function writeNode(b, n, isLast) {
  const start = b.o;
  const size = nodeSize(n, isLast);
  const nameB = enc.encode(n.name);
  let propsLen = 0;
  for (const p of n.props) propsLen += propSize(p);
  b.u32(start + size); b.u32(n.props.length); b.u32(propsLen);
  b.byte(nameB.length); b.bytes(nameB);
  for (const p of n.props) {
    b.byte(p.t.charCodeAt(0));
    switch (p.t) {
      case 'C': b.byte(p.v); break;
      case 'I': b.i32(p.v); break;
      case 'L': b.dv.setBigInt64(b.o, p.v, true); b.o += 8; break;
      case 'D': b.dv.setFloat64(b.o, p.v, true); b.o += 8; break;
      case 'S': case 'R': b.u32(p.v.length); b.bytes(p.v); break;
      default: {
        const a = p.v;
        b.u32(a.length); b.u32(0); b.u32(a.byteLength);
        b.bytes(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
      }
    }
  }
  n.children.forEach((c, i) => writeNode(b, c, i === n.children.length - 1));
  if (n.children.length || (!n.props.length && !isLast) || ALWAYS_SENTINEL.has(n.name)) b.zeros(13);
}

/** Serializa la lista de nodos raíz a un FBX binario completo. */
export function encodeFBX(roots) {
  const head = enc.encode('Kaydara FBX Binary  ');
  let size = head.length + 3 + 4;
  roots.forEach((n, i) => { size += nodeSize(n, i === roots.length - 1); });
  size += 13; // fin de la lista raíz
  const footStart = size;
  size += 16 + 4;
  let pad = ((size + 15) & ~15) - size;
  if (pad === 0) pad = 16;
  size += pad + 4 + 120 + 16;
  const b = new Buf(size);
  b.bytes(head); b.byte(0); b.byte(0x1a); b.byte(0);
  b.u32(VERSION);
  roots.forEach((n, i) => writeNode(b, n, i === roots.length - 1));
  b.zeros(13);
  if (b.o !== footStart) throw new Error('FBX: tamaño inconsistente');
  b.bytes(FOOT_ID); b.zeros(4); b.zeros(pad); b.u32(VERSION); b.zeros(120); b.bytes(FOOT_MAGIC);
  return b.u8;
}

async function canvasPNG(cv) {
  if (cv.convertToBlob) return new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer());
  const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Convierte una escena three.js (Z arriba, metros) a nodos FBX. */
export async function sceneToFBX(root) {
  let nextId = 1000000n;
  const nid = () => nextId++;
  const objects = [], conns = [];
  const counts = { Model: 0, Geometry: 0, Material: 0, Texture: 0, Video: 0, NodeAttribute: 0 };
  const matIds = new Map(), texIds = new Map();
  const srgb = new THREE.Color();
  const euler = new THREE.Euler();
  const OO = (child, parent) => conns.push(N('C', [S('OO'), L(child), L(parent)]));
  const OP = (child, parent, prop) => conns.push(N('C', [S('OP'), L(child), L(parent), S(prop)]));

  const texture = async (tex, label) => {
    const img = tex && tex.image;
    if (!img || !(img.getContext || img.convertToBlob)) return null;
    if (texIds.has(img)) return texIds.get(img);
    const png = await canvasPNG(img);
    const vid = nid(), tid = nid();
    const file = `textures/${label}.png`;
    objects.push(N('Video', [L(vid), S(nameClass(label, 'Video')), S('Clip')], [
      N('Type', [S('Clip')]),
      P70([P('Path', 'KString', 'XRefUrl', '', S(file))]),
      N('UseMipMap', [I(0)]), N('Filename', [S(file)]), N('RelativeFilename', [S(file)]), N('Content', [R(png)]),
    ]));
    objects.push(N('Texture', [L(tid), S(nameClass(label, 'Texture')), S('')], [
      N('Type', [S('TextureVideoClip')]), N('Version', [I(202)]), N('TextureName', [S(nameClass(label, 'Texture'))]),
      P70([P('UVSet', 'KString', '', '', S('UVMap')), P('UseMaterial', 'bool', '', '', I(1))]),
      N('Media', [S(nameClass(label, 'Video'))]), N('FileName', [S(file)]), N('RelativeFilename', [S(file)]),
      N('ModelUVTranslation', [D(0), D(0)]), N('ModelUVScaling', [D(1), D(1)]), N('Texture_Alpha_Source', [S('None')]), N('Cropping', [I(0), I(0), I(0), I(0)]),
    ]));
    OO(vid, tid);
    counts.Video++; counts.Texture++;
    texIds.set(img, tid);
    return tid;
  };

  const material = async (mat) => {
    if (matIds.has(mat)) return matIds.get(mat);
    const id = nid();
    const name = mat.name || `material_${matIds.size + 1}`;
    const col = mat.map ? [1, 1, 1] : (mat.color ? (mat.color.getRGB(srgb, THREE.SRGBColorSpace), [srgb.r, srgb.g, srgb.b]) : [0.8, 0.8, 0.8]);
    const em = mat.emissive ? (mat.emissive.getRGB(srgb, THREE.SRGBColorSpace), [srgb.r, srgb.g, srgb.b]) : [0, 0, 0];
    const props = [
      P('DiffuseColor', 'Color', '', 'A', D(col[0]), D(col[1]), D(col[2])),
      P('DiffuseFactor', 'Number', '', 'A', D(1)),
      P('EmissiveColor', 'Color', '', 'A', D(em[0]), D(em[1]), D(em[2])),
      P('EmissiveFactor', 'Number', '', 'A', D(1)),
      P('SpecularFactor', 'Number', '', 'A', D(0.2)),
      P('Shininess', 'Number', '', 'A', D(Math.max(2, (1 - (mat.roughness ?? 0.8)) * 100))),
    ];
    if (mat.opacity !== undefined && mat.opacity < 1) props.push(P('TransparencyFactor', 'Number', '', 'A', D(1 - mat.opacity)), P('Opacity', 'double', 'Number', '', D(mat.opacity)));
    objects.push(N('Material', [L(id), S(nameClass(name, 'Material')), S('')], [
      N('Version', [I(102)]), N('ShadingModel', [S('phong')]), N('MultiLayer', [I(0)]), P70(props),
    ]));
    counts.Material++;
    matIds.set(mat, id);
    if (mat.map) {
      const tid = await texture(mat.map, name);
      if (tid) {
        OP(tid, id, 'DiffuseColor');
        if (mat.alphaTest > 0 || mat.transparent) OP(tid, id, 'TransparentColor');
      }
    }
    return id;
  };

  const modelProps = (o) => {
    euler.setFromQuaternion(o.quaternion, 'ZYX'); // FBX eEulerXYZ = Rz·Ry·Rx
    const d = 180 / Math.PI;
    return P70([
      P('Lcl Translation', 'Lcl Translation', '', 'A', D(o.position.x), D(o.position.y), D(o.position.z)),
      P('Lcl Rotation', 'Lcl Rotation', '', 'A', D(euler.x * d), D(euler.y * d), D(euler.z * d)),
      P('Lcl Scaling', 'Lcl Scaling', '', 'A', D(o.scale.x), D(o.scale.y), D(o.scale.z)),
      P('DefaultAttributeIndex', 'int', 'Integer', '', I(0)),
      P('InheritType', 'enum', '', '', I(1)),
    ]);
  };

  const geometry = (mesh, name) => {
    let g = mesh.geometry;
    if (!g.getAttribute('normal')) { g = g.clone(); g.computeVertexNormals(); }
    const pos = g.getAttribute('position'), nor = g.getAttribute('normal'), uv = g.getAttribute('uv');
    const idx = g.index ? g.index.array : Uint32Array.from({ length: pos.count }, (_, i) => i);
    const T = Math.floor(idx.length / 3);
    const pvi = new Int32Array(T * 3), normals = new Float64Array(T * 9);
    for (let t = 0; t < T; t++) {
      for (let c = 0; c < 3; c++) {
        const v = idx[t * 3 + c];
        pvi[t * 3 + c] = c === 2 ? -v - 1 : v;
        normals[t * 9 + c * 3] = nor.getX(v); normals[t * 9 + c * 3 + 1] = nor.getY(v); normals[t * 9 + c * 3 + 2] = nor.getZ(v);
      }
    }
    const id = nid();
    const layers = [N('LayerElement', [], [N('Type', [S('LayerElementNormal')]), N('TypedIndex', [I(0)])]), N('LayerElement', [], [N('Type', [S('LayerElementMaterial')]), N('TypedIndex', [I(0)])])];
    const kids = [
      N('Vertices', [Ad(pos.array)]),
      N('PolygonVertexIndex', [Ai(pvi)]),
      N('GeometryVersion', [I(124)]),
      N('LayerElementNormal', [I(0)], [N('Version', [I(101)]), N('Name', [S('')]), N('MappingInformationType', [S('ByPolygonVertex')]), N('ReferenceInformationType', [S('Direct')]), N('Normals', [Ad(normals)])]),
    ];
    if (uv) {
      const uvIdx = new Int32Array(T * 3);
      for (let k = 0; k < T * 3; k++) uvIdx[k] = idx[k];
      kids.push(N('LayerElementUV', [I(0)], [N('Version', [I(101)]), N('Name', [S('UVMap')]), N('MappingInformationType', [S('ByPolygonVertex')]), N('ReferenceInformationType', [S('IndexToDirect')]), N('UV', [Ad(uv.array)]), N('UVIndex', [Ai(uvIdx)])]));
      layers.push(N('LayerElement', [], [N('Type', [S('LayerElementUV')]), N('TypedIndex', [I(0)])]));
    }
    kids.push(N('LayerElementMaterial', [I(0)], [N('Version', [I(101)]), N('Name', [S('')]), N('MappingInformationType', [S('AllSame')]), N('ReferenceInformationType', [S('IndexToDirect')]), N('Materials', [Ai([0])])]));
    kids.push(N('Layer', [I(0)], [N('Version', [I(100)]), ...layers]));
    objects.push(N('Geometry', [L(id), S(nameClass(name, 'Geometry')), S('Mesh')], kids));
    counts.Geometry++;
    return id;
  };

  const visit = async (o, parentId) => {
    const id = nid();
    const name = o.name || (o.isMesh ? 'mesh' : 'grupo');
    if (o.isMesh) {
      objects.push(N('Model', [L(id), S(nameClass(name, 'Model')), S('Mesh')], [N('Version', [I(232)]), modelProps(o), N('Shading', [C(true)]), N('Culling', [S('CullingOff')])]));
      const gid = geometry(o, name);
      OO(gid, id);
      const mid = await material(Array.isArray(o.material) ? o.material[0] : o.material);
      OO(mid, id);
    } else {
      objects.push(N('Model', [L(id), S(nameClass(name, 'Model')), S('Null')], [N('Version', [I(232)]), modelProps(o), N('Shading', [C(true)]), N('Culling', [S('CullingOff')])]));
      const aid = nid();
      objects.push(N('NodeAttribute', [L(aid), S(nameClass('', 'NodeAttribute')), S('Null')], [N('TypeFlags', [S('Null')])]));
      counts.NodeAttribute++;
      OO(aid, id);
    }
    counts.Model++;
    OO(id, parentId);
    for (const c of o.children) await visit(c, id);
  };
  await visit(root, 0n);

  const now = new Date();
  const docId = nid();
  const defs = Object.entries(counts).filter(([, n]) => n > 0);
  return [
    N('FBXHeaderExtension', [], [
      N('FBXHeaderVersion', [I(1003)]), N('FBXVersion', [I(VERSION)]), N('EncryptionType', [I(0)]),
      N('CreationTimeStamp', [], [N('Version', [I(1000)]), N('Year', [I(now.getFullYear())]), N('Month', [I(now.getMonth() + 1)]), N('Day', [I(now.getDate())]), N('Hour', [I(now.getHours())]), N('Minute', [I(now.getMinutes())]), N('Second', [I(now.getSeconds())]), N('Millisecond', [I(now.getMilliseconds())])]),
      N('Creator', [S('Track Spline Generator')]),
    ]),
    N('FileId', [R(FILE_ID)]),
    N('CreationTime', [S('1970-01-01 10:00:00:000')]),
    N('Creator', [S('Track Spline Generator')]),
    N('GlobalSettings', [], [N('Version', [I(1000)]), P70([
      P('UpAxis', 'int', 'Integer', '', I(2)), P('UpAxisSign', 'int', 'Integer', '', I(1)),
      P('FrontAxis', 'int', 'Integer', '', I(1)), P('FrontAxisSign', 'int', 'Integer', '', I(-1)),
      P('CoordAxis', 'int', 'Integer', '', I(0)), P('CoordAxisSign', 'int', 'Integer', '', I(1)),
      P('OriginalUpAxis', 'int', 'Integer', '', I(2)), P('OriginalUpAxisSign', 'int', 'Integer', '', I(1)),
      P('UnitScaleFactor', 'double', 'Number', '', D(100)), P('OriginalUnitScaleFactor', 'double', 'Number', '', D(100)),
      P('AmbientColor', 'ColorRGB', 'Color', '', D(0), D(0), D(0)),
      P('DefaultCamera', 'KString', '', '', S('Producer Perspective')),
      P('TimeMode', 'enum', '', '', I(11)),
      P('TimeSpanStart', 'KTime', 'Time', '', L(0)), P('TimeSpanStop', 'KTime', 'Time', '', L(46186158000)),
      P('CustomFrameRate', 'double', 'Number', '', D(24)),
    ])]),
    N('Documents', [], [N('Count', [I(1)]), N('Document', [L(docId), S(''), S('Scene')], [
      P70([P('SourceObject', 'object', '', ''), P('ActiveAnimStackName', 'KString', '', '', S(''))]),
      N('RootNode', [L(0)]),
    ])]),
    N('References'),
    N('Definitions', [], [N('Version', [I(100)]), N('Count', [I(1 + defs.reduce((a, [, n]) => a + n, 0))]),
      N('ObjectType', [S('GlobalSettings')], [N('Count', [I(1)])]),
      ...defs.map(([k, n]) => N('ObjectType', [S(k)], [N('Count', [I(n)])]))]),
    N('Objects', [], objects),
    N('Connections', [], conns),
    N('Takes', [], [N('Current', [S('')])]),
  ];
}

/** Exporta la escena completa (pista, terreno, cerros, túneles, árboles, hierba, pórtico y elementos) a FBX binario. */
export async function exportFBX(layout, elev, sp, textures = {}, paint = null, hills = null, items = null) {
  const { scene, root, info } = await buildExportScene(layout, elev, sp, textures, paint, hills, items, { yUp: false });
  scene.updateMatrixWorld(true);
  const nodes = await sceneToFBX(root);
  return { buffer: encodeFBX(nodes), info };
}
