// Vista 3D liviana (three.js) solo para revisar; la geometría final se hace en Blender / 3ds Max.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { TransformControls } from '../vendor/TransformControls.js';
import { edgeSamples } from './export.js';
import { buildEdgeMeshes } from './edges.js';
import { instancedGroup } from './assets.js';
import { decoSetItems, treeModelItems, grassModelItems } from './deco.js';
import { buildShadows, shadowCasters, sunVector } from './shadows.js';
import { buildTrackMesh, trackRows, trackCols, coveredRanges, terrainTint, buildTerrain, buildTrees, buildHills, buildStartGate, buildGrass, makeGround, bridgePillars, suspPillars, pillarBlocked } from './scene.js';
import { buildRivers } from './rivers.js';
import { pillarGeometry } from './tunnels.js';
import { applyRefLook } from './refmodel.js';
import { makeBannerCanvas, makeCheckerCanvas, makeGrassCanvas, makePadCanvas, makeGlowCanvas, makeAsphaltCanvas, makeBridgeCanvas } from './gatetex.js';

const BRUSH_SEGS = 72; // segmentos del aro del pincel

export class Preview3D {
  constructor(container, app) {
    this.app = app;
    this.el = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setClearColor(0x0e1117);
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0e1117, 1500, 5000);
    this.camera = new THREE.PerspectiveCamera(45, 1, 1, 20000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xdde6ff, 0x202020, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(400, -300, 800);
    this.scene.add(sun);
    this.sunLight = sun; // sigue al sol de los planos de sombra si se pide (updateSunLight)
    this.group = new THREE.Group();
    this.scene.add(this.group);
    // grupos en metros reales con la exageración Z aplicada como escala
    this.trackGroup = new THREE.Group();
    this.extras = new THREE.Group();
    this.pillars = new THREE.Group();
    this.itemsGroup = new THREE.Group(); // charcos, turbo pads, nitro strips
    this.scene.add(this.trackGroup, this.extras, this.pillars, this.itemsGroup);
    this.texCache = new Map();
    this.terrainData = null;
    this.extrasTimer = null;
    this.grid = null;
    this.marker = new THREE.Mesh(new THREE.SphereGeometry(3, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.marker.visible = false;
    this.scene.add(this.marker);
    this.zExag = 1.5;
    this.needsFrame = true;
    // --- edición de puntos en 3D ---
    this.handleGroup = new THREE.Group();
    this.scene.add(this.handleGroup);
    this.segGroup = new THREE.Group(); // segmentos seleccionados (nivel Segmento)
    this.scene.add(this.segGroup);
    this.proxy = new THREE.Object3D();
    this.scene.add(this.proxy);
    this.tc = new TransformControls(this.camera, this.renderer.domElement);
    this.tc.setSpace('world');
    this.tc.setSize(0.9);
    this.scene.add(this.tc.getHelper());
    this.gizmoMode = 'free';
    this.dragSel = null;
    this.tcUsed = false;
    this.tc.addEventListener('change', () => (this.needsFrame = true));
    this.tc.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value;
      if (e.value) this.onDragStart(); else this.onDragEnd();
    });
    this.tc.addEventListener('objectChange', () => this.onGizmoMove());
    // gizmo de altura del cerro seleccionado (solo eje Z)
    this.hillProxy = new THREE.Object3D();
    this.scene.add(this.hillProxy);
    this.hillTc = new TransformControls(this.camera, this.renderer.domElement);
    this.hillTc.setSpace('world');
    this.hillTc.setSize(1.2);
    this.hillTc.showX = false; this.hillTc.showY = false;
    this.scene.add(this.hillTc.getHelper());
    this.hillTc.enabled = false;
    this.hillTc.addEventListener('change', () => (this.needsFrame = true));
    this.hillTc.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value;
      const hd = this.hillDrag;
      if (e.value && hd) { hd.z0 = this.hillProxy.position.z; hd.active = true; }
      if (!e.value && hd && hd.active) {
        hd.active = false;
        if (Math.abs(hd.newH - hd.h0) > 0.05 && this.app.setHillHeight) this.app.setHillHeight(hd.id, hd.newH);
      }
    });
    this.hillTc.addEventListener('objectChange', () => {
      const hd = this.hillDrag;
      if (!hd || !hd.active) return;
      hd.newH = Math.max(1, Math.min(400, hd.h0 + (this.hillProxy.position.z - hd.z0)));
      // vista previa: la malla del cerro se estira en altura desde su base (al soltar se rehace de verdad)
      const k = hd.newH / hd.h0;
      for (const m of hd.meshes) { m.scale.z = k; m.position.z = hd.zb * (1 - k); }
      if (this.app.onHillHeightPreview) this.app.onHillHeightPreview(hd.id, hd.newH);
      this.needsFrame = true;
    });
    // bordes de la pista (camino de tierra y barrera), extruidos de la malla de la pista
    this.edgeGroup = new THREE.Group();
    this.scene.add(this.edgeGroup);
    this.tunnelRuns = [];
    // modelo de referencia (FBX / GLB): un solo objeto que se mueve con su propio gizmo
    this.refExag = new THREE.Group(); // escala Z = exagerar Z (igual que la pista)
    this.scene.add(this.refExag);
    this.refOuter = null;
    this.refTc = new TransformControls(this.camera, this.renderer.domElement);
    this.refTc.setSpace('world');
    this.refTc.setSize(1.1);
    this.scene.add(this.refTc.getHelper());
    this.refTc.addEventListener('change', () => (this.needsFrame = true));
    this.refTc.addEventListener('dragging-changed', (e) => { this.controls.enabled = !e.value; if (!e.value && this.app.onRef3dMoveEnd) this.app.onRef3dMoveEnd(); else if (e.value && this.app.onRef3dMoveStart) this.app.onRef3dMoveStart(); });
    this.refTc.addEventListener('objectChange', () => { if (this.refOuter && this.app.onRef3dMove) { const p = this.refOuter.position; this.app.onRef3dMove([p.x, p.y, p.z], THREE.MathUtils.radToDeg(this.refOuter.rotation.z)); } });
    const dom = this.renderer.domElement;
    let down = null;
    dom.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY, e.button]; this.tcUsed = !!this.tc.axis || !!(this.refTc && this.refTc.axis && this.refTc.enabled) || !!(this.hillTc && this.hillTc.axis && this.hillTc.enabled); });
    // pintar subdivisión, cerros o ríos directamente sobre el terreno en 3D
    this.paintMode = null;
    // aro del pincel: una cinta que se amolda a la superficie (se rehace en cada movimiento)
    {
      const N = BRUSH_SEGS, g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((N + 1) * 2 * 3), 3));
      const idx = [];
      for (let i = 0; i < N; i++) { const a = i * 2, b = a + 2; idx.push(a, b, a + 1, a + 1, b, b + 1); }
      g.setIndex(idx);
      this.brushRing = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xe040fb, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide }));
    }
    this.brushRing.frustumCulled = false;
    this.brushRing.renderOrder = 20;
    this.brushRing.visible = false;
    this.scene.add(this.brushRing);
    const paintHit = (e) => {
      const L = this.app.state.layout;
      if (!L) return null;
      const r = this.renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      let pt = null;
      const surf = [...(this.hillMeshes || []), ...(this.wallMeshes || []), ...(this.terrainMesh ? [this.terrainMesh] : [])];
      if (surf.length) { const h = ray.intersectObjects(surf, false); if (h.length) { pt = h[0].point; pt.hillId = h[0].object.userData.hillId ?? h[0].object.userData.wallHill ?? null; } }
      if (!pt) { const h = ray.intersectObjects(this.trackGroup.children, false); if (h.length) pt = h[0].point; }
      if (!pt) { const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); pt = new THREE.Vector3(); if (!ray.ray.intersectPlane(plane, pt)) return null; }
      return pt;
    };
    const moveRing = (pt) => {
      const sc = this.app.state.scene;
      const rm = this.paintMode === 'hill' ? sc.hillBrush : this.paintMode === 'sculpt' ? sc.sculptBrush : this.paintMode === 'river' ? sc.riverBrush : sc.paintBrush;
      this.shapeBrushRing(pt, rm);
      this.brushRing.material.color.set(this.paintMode === 'hill' ? 0xe0a050 : this.paintMode === 'river' ? 0x3fa7ff : this.paintMode === 'sculpt' ? 0x7ec8ff : this.paintMode === 'itemPaint' ? this.app.itemPaintColor() : 0xe040fb);
      this.brushRing.visible = true;
      this.needsFrame = true;
    };
    this.el.addEventListener('pointermove', (e) => {
      // con Shift se navega (el aro del pincel se oculta mientras tanto)
      if (!this.paintMode || e.shiftKey || this.navPaint || (this.game && this.game.active)) { if (this.brushRing.visible) { this.brushRing.visible = false; this.needsFrame = true; } return; }
      const pt = paintHit(e);
      if (pt) moveRing(pt);
    });
    this.el.addEventListener('pointerdown', (e) => {
      if (this.paintMode && e.shiftKey && !(this.game && this.game.active)) {
        // pintando, Shift = navegar como siempre: izquierdo gira, derecho desplaza, rueda / medio acercan. OrbitControls
        // invierte girar y desplazar con Shift, así que se invierten los botones mientras dura el arrastre
        const mb = this.controls.mouseButtons, keep = { LEFT: mb.LEFT, RIGHT: mb.RIGHT };
        mb.LEFT = THREE.MOUSE.PAN; mb.RIGHT = THREE.MOUSE.ROTATE;
        this.navPaint = true;
        this.controls.enabled = true;
        const up = () => { window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true); setTimeout(() => { mb.LEFT = keep.LEFT; mb.RIGHT = keep.RIGHT; this.navPaint = false; }, 0); };
        window.addEventListener('pointerup', up, true);
        window.addEventListener('pointercancel', up, true);
        return;
      }
      if (!this.paintMode || (e.button !== 0 && e.button !== 2) || (this.game && this.game.active)) return;
      e.stopPropagation(); e.preventDefault();
      this.controls.enabled = false;
      const L = this.app.state.layout;
      const ses = { kind: this.paintMode, erase: e.button === 2 || e.altKey || (this.paintMode !== 'sculpt' && this.app.state.paintErase), ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, last: null };
      const pt0 = paintHit(e);
      this.app.beginPaint(ses.kind, ses, pt0 && L ? L.toLayout(pt0.x, pt0.y) : null, pt0 ? pt0.hillId : null);
      const stroke = (ev) => {
        const pt = paintHit(ev);
        if (!pt || !L) return;
        moveRing(pt);
        this.app.addStroke(ses, L.toLayout(pt.x, pt.y));
        this.app.onPaintProgress && this.app.onPaintProgress();
      };
      stroke(e);
      const move = (ev) => stroke(ev);
      const up = () => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        this.controls.enabled = true;
        this.app.endPaint(ses.kind, ses);
      };
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
    }, true);
    this.el.addEventListener('contextmenu', (e) => { if (this.paintMode) e.preventDefault(); });
    // Shift + clic / arrastrar: selección múltiple (se captura antes que OrbitControls)
    this.el.style.position = 'relative';
    this.el.addEventListener('pointerdown', (e) => {
      if (this.app.state.tool !== 'edit' || !(e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) || e.button !== 0 || this.tc.axis) return;
      e.stopPropagation();
      e.preventDefault();
      this.controls.enabled = false;
      const r = this.el.getBoundingClientRect();
      this.box = { x0: e.clientX - r.left, y0: e.clientY - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top, add: e.ctrlKey || e.metaKey, sub: e.altKey, ev: e };
      const div = document.createElement('div');
      div.className = 'select-box';
      this.el.appendChild(div);
      this.box.div = div;
      const move = (ev) => {
        this.box.x1 = ev.clientX - r.left; this.box.y1 = ev.clientY - r.top;
        const b = this.box;
        Object.assign(div.style, { left: `${Math.min(b.x0, b.x1)}px`, top: `${Math.min(b.y0, b.y1)}px`, width: `${Math.abs(b.x1 - b.x0)}px`, height: `${Math.abs(b.y1 - b.y0)}px` });
      };
      const up = (ev) => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        const b = this.box;
        this.box = null;
        div.remove();
        this.controls.enabled = true;
        const segMode = this.app.state.subObj === 'segment';
        if (segMode && Math.abs(b.x1 - b.x0) + Math.abs(b.y1 - b.y0) < 5) {
          const sh = this.pickSegment(ev);
          if (sh && b.sub) this.app.segSelectMany({ key: sh.key, segs: [sh.seg] }, 'sub'); else if (sh) this.app.selectSegment(sh, true);
          return;
        }
        if (Math.abs(b.x1 - b.x0) + Math.abs(b.y1 - b.y0) < 5) {
          const hit = this.pickHandle(ev);
          if (hit && !b.sub) this.app.toggleMultiSel(hit);
          else if (hit && b.sub) this.app.subtractMultiSel({ key: hit.key, idxs: [hit.idx] });
          return;
        }
        const [ax, bx] = [Math.min(b.x0, b.x1), Math.max(b.x0, b.x1)], [ay, by] = [Math.min(b.y0, b.y1), Math.max(b.y0, b.y1)];
        const v = new THREE.Vector3();
        const inside = [];
        for (const m of this.handleGroup.children) {
          v.copy(m.position).project(this.camera);
          if (v.z > 1) continue;
          const sx = (v.x + 1) / 2 * r.width, sy = (1 - v.y) / 2 * r.height;
          if (sx >= ax && sx <= bx && sy >= ay && sy <= by) inside.push({ key: m.userData.key, idx: m.userData.idx });
        }
        if (segMode) this.app.segSelectMany(this.app.pickBest(inside), b.sub ? 'sub' : true, true);
        else if (b.sub) this.app.subtractMultiSel(this.app.pickBest(inside)); else this.app.setMultiSel(this.app.pickBest(inside), b.add);
      };
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
    }, true);
    dom.addEventListener('pointerup', (e) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) { down = null; return; }
      if (down && this.app.state.tool === 'pan' && down[2] === 0 && !this.tcUsed && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 4 && !(this.game && this.game.active)) {
        down = null;
        this.pickHill(e);
        return;
      }
      if (!down || this.app.state.tool !== 'edit') return;
      const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
      const btn = down[2];
      down = null;
      if (moved > 4 || this.tcUsed || btn !== 0) return;
      this.pick(e);
    });
    // doble clic en la vista 3D: entra a «Editar puntos» con el punto más cercano
    dom.addEventListener('dblclick', (e) => {
      if (this.app.state.tool === 'edit' || (this.game && this.game.active)) return;
      const r = dom.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      const objs = [...this.trackGroup.children, ...(this.terrainMesh ? [this.terrainMesh] : []), ...(this.hillMeshes || [])];
      const h = ray.intersectObjects(objs, false);
      let pt = h.length ? h[0].point : null;
      if (!pt) { const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); pt = new THREE.Vector3(); if (!ray.ray.intersectPlane(plane, pt)) return; }
      this.app.enterEditAtWorld(pt.x, pt.y);
    });
    new ResizeObserver(() => this.resize()).observe(container);
    this.controls.addEventListener('change', () => (this.needsFrame = true));
    this.clock = new THREE.Clock();
    this.game = null; // cámara de juego (se asigna desde gamecam.js)
    this.triCounts = { track: 0, terrain: 0, trees: 0 };
    this.statsDiv = document.createElement('div');
    this.statsDiv.className = 'tri-stats';
    container.appendChild(this.statsDiv);
    this.wire = { on: false, color: '#ffffff', opacity: 0.35 };
    const loop = () => {
      const dt = Math.min(0.1, this.clock.getDelta());
      if (this.game && this.game.active) {
        this.game.update(dt);
        this.renderer.render(this.scene, this.game.camera);
      } else {
        this.controls.update();
        if (this.needsFrame) { this.renderer.render(this.scene, this.camera); this.needsFrame = false; }
      }
      requestAnimationFrame(loop);
    };
    loop();
  }

  resize() {
    const r = this.el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    this.renderer.setSize(r.width, r.height);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    if (this.game) this.game.resize(r.width / r.height);
    this.needsFrame = true;
  }

  updateStats() {
    const f = (n) => n.toLocaleString('es');
    const t = this.triCounts;
    const sp = this.app.state.scene;
    const tun = t.tunnels || 0, hills = t.hills || 0, gate = t.gate || 0, grass = sp.grass ? (t.grass || 0) : 0;
    const edges = t.edges || 0, deco = t.deco || 0, rivers = t.rivers || 0, shadows = t.shadows || 0;
    const total = t.track + (sp.terrain ? t.terrain : 0) + (sp.trees ? t.trees : 0) + tun + hills + gate + grass + edges + deco + rivers + shadows;
    const ot = this.objTris || { hills: new Map(), tunnels: new Map() };
    const st = this.app.state;
    const nH = ot.hills.size, nT = ot.tunnels.size;
    const selIt = st.selItem ? this.findItem(st.selItem) : null;
    const selObj = selIt ? { name: selIt.name, tris: selIt.indices.length / 3 } : st.selHill != null ? ot.hills.get(st.selHill) : st.selTunnel != null ? ot.tunnels.get(st.selTunnel) : null;
    const selTxt = selObj ? `<div class="sel"><b>Seleccionado</b> · ${selObj.name}: ${f(selObj.tris)} triángulos</div>` : '';
    this.statsDiv.innerHTML = `<b>Triángulos</b> · pista ${f(t.track)}${edges ? ` · bordes ${f(edges)}` : ''}${sp.terrain ? ` · terreno ${f(t.terrain)}` : ''}${hills || tun ? ` · cerros + túneles ${f(hills + tun)} (${[hills ? `${nH} cerro${nH === 1 ? '' : 's'}: ${f(hills)}` : '', tun ? `${nT} túnel${nT === 1 ? '' : 'es'}: ${f(tun)}` : ''].filter(Boolean).join(' · ')})` : ''}${rivers ? ` · ríos y cascadas ${f(rivers)}` : ''}${sp.trees ? ` · árboles ${f(t.trees)}` : ''}${grass ? ` · hierba ${f(grass)}` : ''}${gate ? ` · pórtico ${f(gate)}` : ''}${t.items ? ` · elementos ${f(t.items)} (${this.itemCount})` : ''}${deco ? ` · decoración ${f(deco)}` : ''}${shadows ? ` · sombras ${f(shadows)}` : ''} · <b>total ${f(total + (t.items || 0))}</b>${selTxt}`;
  }

  /** Wireframe superpuesto (color y opacidad elegibles) sobre pista, terreno y árboles. */
  applyWireframe() {
    for (const grp of [this.trackGroup, this.extras, this.edgeGroup]) {
      for (const m of [...grp.children]) {
        if (!m.isMesh || m.userData.texOverlay) continue; // la capa de textura ya va desplazada sobre la base
        let w = m.children.find((c) => c.userData.wire);
        if (!this.wire.on) { if (w) { m.remove(w); w.material.dispose(); } continue; }
        if (!w) {
          w = new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, depthWrite: false }));
          w.userData.wire = true;
          w.renderOrder = 5;
          m.add(w);
        }
        w.material.color.set(this.wire.color);
        w.material.opacity = this.wire.opacity;
        w.material.needsUpdate = true;
        // desplaza el sólido para que las líneas no parpadeen
        m.material.polygonOffset = true;
        m.material.polygonOffsetFactor = grp === this.trackGroup ? 2 : 1;
        m.material.polygonOffsetUnits = grp === this.trackGroup ? 2 : 1;
      }
    }
    // capa de textura de la pista: entre la base (+2) y las líneas (0); sin wireframe va delante de la base (-1).
    // (el desplazamiento de polígonos no se aplica a las líneas, por eso la textura se aleja en vez de acercar las líneas)
    for (const m of this.trackGroup.children) {
      if (!m.userData.texOverlay) continue;
      for (const mt of Array.isArray(m.material) ? m.material : [m.material]) {
        mt.polygonOffset = true;
        mt.polygonOffsetFactor = this.wire.on ? 1 : -1;
        mt.polygonOffsetUnits = this.wire.on ? 1 : -1;
        mt.needsUpdate = true;
      }
    }
    this.needsFrame = true;
  }

  clear() {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      c.geometry?.dispose();
      c.material?.dispose();
    }
  }

  update(fitView = false, keepExtras = false) {
    const L = this.app.state.layout, E = this.app.state.result;
    this.clear();
    if (!L || !E) { this.needsFrame = true; return; }
    const ex = this.zExag;
    const v = E.validation;
    const span = Math.max(v.zMax - v.zMin, 0.5);
    const col = new THREE.Color();
    const bbox = new THREE.Box3();
    // malla de la pista (con UV) en metros reales; la exageración se aplica como escala del grupo
    this.disposeGroup(this.trackGroup);
    this.trackGroup.scale.set(1, 1, ex);
    this.refExag.scale.set(1, 1, ex);
    const sp = this.app.state.scene;
    // tramos cubiertos (túneles de la última reconstrucción y bajo cruces): material propio
    this.coveredCache = coveredRanges(L, E, this.tunnelRuns);
    this.app.state.coveredRanges = this.coveredCache;
    const tm = buildTrackMesh(L, E, { ...sp, skirts: sp.terrain && sp.skirts, coveredRanges: this.coveredCache });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tm.positions, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(tm.uvs, 2));
    g.setIndex(tm.indices);
    g.computeVertexNormals();
    // base: colores por altura; encima, la textura (la del usuario o la de asfalto por defecto) con su opacidad
    const colors = new Float32Array(tm.positions.length);
    for (let i = 0; i < tm.positions.length / 3; i++) {
      const t = (tm.positions[i * 3 + 2] - v.zMin) / span;
      col.setHSL(0.62 - 0.55 * t, 0.55, 0.5);
      colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 });
    this.trackGroup.add(new THREE.Mesh(g, m));
    const op = Math.max(0, Math.min(1, sp.trackTexOpacity ?? 1));
    if (op > 0.001) {
      if (!this.asphaltCanvas) this.asphaltCanvas = makeAsphaltCanvas();
      const tex = this.texture(this.app.state.trackTex || this.asphaltCanvas);
      if (!this.bridgeCanvas) this.bridgeCanvas = makeBridgeCanvas();
      const btex = this.texture(this.app.state.bridgeTex || this.bridgeCanvas);
      const atex = tex; // atajos sin textura propia: la de la pista
      const ctex = this.texture(this.app.coveredTexCanvas ? this.app.coveredTexCanvas() : null) || tex;
      const ovMat = (map) => new THREE.MeshStandardMaterial({ map, side: THREE.DoubleSide, roughness: 0.9, metalness: 0, transparent: op < 0.999, opacity: op, depthWrite: op >= 0.999, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      // grupos: pista, atajos, tramos cubiertos (túneles y bajo cruces) y tableros de puente, cada uno con su textura;
      // cada atajo con textura propia usa su material (índices 4 en adelante)
      g.clearGroups();
      const stex = this.texture(this.app.suspTexCanvas ? this.app.suspTexCanvas() : null) || tex; // tramos suspendidos
      const mats = [ovMat(tex), ovMat(atex), ovMat(ctex), ovMat(btex), ovMat(stex)];
      for (const gr of tm.groups) {
        if (!gr.count) continue;
        if (gr.mat !== 1 || !tm.altGroups) { g.addGroup(gr.start, gr.count, gr.mat); continue; }
        for (const ag of tm.altGroups) {
          if (!ag.count) continue;
          const own = this.app.altOwnTex ? this.app.altOwnTex(L.routes[ag.k], 'track') : null;
          let mi = 1;
          if (own) { mats.push(ovMat(this.texture(own))); mi = mats.length - 1; }
          g.addGroup(ag.start, ag.count, mi);
        }
      }
      const ov = new THREE.Mesh(g, mats);
      ov.userData.texOverlay = true;
      this.trackGroup.add(ov);
    }
    // atajo seleccionado: la calzada se ilumina en amarillo (malla compartida, solo el grupo de ese atajo)
    {
      const si = this.app.state.selAlt;
      const ag = si != null && tm.altGroups ? tm.altGroups.find((q) => L.routes[q.k] && L.routes[q.k].altIndex === si) : null;
      if (ag && ag.count) {
        const hg = new THREE.BufferGeometry();
        hg.setAttribute('position', g.getAttribute('position'));
        hg.setIndex(g.getIndex());
        hg.addGroup(ag.start, ag.count, 0);
        const hm = new THREE.Mesh(hg, [new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })]);
        hm.userData.altHi = true;
        hm.renderOrder = 6;
        this.trackGroup.add(hm);
      }
    }
    this.triCounts.track = tm.indices.length / 3;
    this.buildEdges(false);
    if (this.app.onTrackMeshInfo) {
      const rowsN = tm.rows.reduce((a, b) => a + b, 0);
      let uniTris = null;
      if (sp.trackMeshMode === 'optimized') uniTris = trackRows(L, E, { ...sp, skirts: sp.terrain && sp.skirts, trackMeshMode: 'uniform' }).reduce((a, q) => a + (q.length - 1), 0) * (trackCols({ ...sp, skirts: sp.terrain && sp.skirts }) - 1) * 2;
      const samples = L.routes.reduce((a, r) => a + (r.closed ? r.n + 1 : r.n), 0);
      this.app.onTrackMeshInfo({ rows: rowsN, tris: tm.indices.length / 3, uniTris, samples });
    }
    this.updateStats();
    this.applyWireframe();
    g.computeBoundingBox();
    bbox.min.set(g.boundingBox.min.x, g.boundingBox.min.y, g.boundingBox.min.z * ex);
    bbox.max.set(g.boundingBox.max.x, g.boundingBox.max.y, g.boundingBox.max.z * ex);
    L.routes.forEach((r, k) => {
      const { left, right } = edgeSamples(L, E, k);
      // bordes
      for (const arr of [left, right]) {
        const pts = arr.map((p) => new THREE.Vector3(p.x, p.y, p.z * ex + 0.15));
        if (r.closed) pts.push(pts[0].clone());
        const lg = new THREE.BufferGeometry().setFromPoints(pts);
        const selA = r.kind === 'alt' && r.altIndex === this.app.state.selAlt;
        this.group.add(new THREE.Line(lg, new THREE.LineBasicMaterial({ color: selA ? 0xffe066 : r.kind === 'alt' ? 0x4fb3ff : 0xf5f5f5, transparent: selA, opacity: selA ? 0.6 : 1 })));
      }
    });
    // puente seleccionado: bordes iluminados en amarillo
    {
      const sb = this.app.state.selBridge, r0 = L.routes[0];
      const b = sb != null && r0.bridges ? (r0.bridges.find((q) => q.idx === sb) || null) : null;
      if (b) {
        const { left, right } = edgeSamples(L, E, 0);
        const i0 = Math.round(b.s0 / r0.ds), i1 = Math.round(b.s1 / r0.ds);
        for (const arr of [left, right]) {
          const pts = [];
          for (let i = i0; i <= i1; i++) { const q = arr[((i % r0.n) + r0.n) % r0.n]; pts.push(new THREE.Vector3(q.x, q.y, q.z * ex + 0.4)); }
          const lg = new THREE.BufferGeometry().setFromPoints(pts);
          const ln = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xffe066, linewidth: 3, depthTest: false, transparent: true, opacity: 0.6 }));
          ln.renderOrder = 12; ln.userData.bridgeHi = true;
          this.group.add(ln);
        }
      }
    }
    this.buildPillars();
    // suelo
    if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); }
    const size = Math.max(bbox.max.x - bbox.min.x, bbox.max.y - bbox.min.y) * 1.4 || 1000;
    this.grid = new THREE.GridHelper(size, 28, 0x333a48, 0x1f2430);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.position.set((bbox.min.x + bbox.max.x) / 2, (bbox.min.y + bbox.max.y) / 2, (v.zMin - 2) * ex);
    this.scene.add(this.grid);
    this.grid.visible = !this.app.state.scene.terrain;
    this.bbox = bbox;
    if (fitView || !this.fitted) this.fit();
    this.buildItems();
    this.updateHandles();
    if (keepExtras && this.extras.children.length) { this.applyExag(); this.buildPillars(); }
    else this.scheduleExtras();
    this.needsFrame = true;
  }

  disposeGroup(grp) {
    for (const c of [...grp.children]) {
      grp.remove(c);
      c.traverse((o) => {
        o.geometry?.dispose();
        for (const mt of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) if (!mt.userData.keep) mt.dispose();
      });
    }
  }

  texture(canvas) {
    if (!canvas) return null;
    let t = this.texCache.get(canvas);
    if (!t) {
      t = new THREE.CanvasTexture(canvas);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      this.texCache.set(canvas, t);
    }
    return t;
  }

  buildPillars() {
    const L = this.app.state.layout, E = this.app.state.result;
    this.disposeGroup(this.pillars);
    if (!L || !E) return;
    const ex = this.zExag;
    const v = E.validation;
    const T = this.app.state.scene.terrain ? this.terrainData : null;
    E.crossings.forEach((c) => {
      const upR = c.up === 'a' ? c.ra : c.rb;
      const upS = c.up === 'a' ? c.sa : c.sb;
      const r = L.routes[upR];
      const lc = L.crossings[c.id];
      const Rw = (lc && lc.window) || 15;
      for (const off0 of [-Rw * 1.25, Rw * 1.25]) {
        // se aleja del cruce hasta un lugar donde el pilar no pise otra calzada, su camino de tierra ni un atajo
        let i = -1;
        for (let q = 0; q < 16; q++) {
          const off = off0 + Math.sign(off0) * q * 2.5;
          const ii = ((Math.round((upS + off) / r.ds) % r.n) + r.n) % r.n;
          if (!pillarBlocked(L, E, this.app.state.scene, r.x[ii], r.y[ii], 2, E.routes[upR].z[ii] - 0.5, upR, r.s[ii])) { i = ii; break; }
        }
        if (i < 0) continue;
        const zTop = E.routes[upR].z[i] * ex - 0.5;
        const zBot = (T ? T.sample(r.x[i], r.y[i]) : v.zMin - 2) * ex;
        const h = zTop - zBot;
        if (h <= 0.5) continue;
        const p = new THREE.Mesh(new THREE.BoxGeometry(2, 2, h), new THREE.MeshStandardMaterial({ color: 0x6b7385, roughness: 0.9 }));
        p.position.set(r.x[i], r.y[i], zBot + h / 2);
        this.pillars.add(p);
      }
    });
    // pilares bajo los puentes creados a mano (cada ~18 m, si hay altura bajo la calzada)
    for (const pl of bridgePillars(L, E, T, this.app.state.scene)) {
      const zTop = pl.zTop * ex, zBot = pl.zBot * ex, h = zTop - zBot;
      if (h <= 0.5) continue;
      const p = new THREE.Mesh(new THREE.BoxGeometry(pl.size, pl.size, h), new THREE.MeshStandardMaterial({ color: 0x7a818f, roughness: 0.9 }));
      p.position.set(pl.x, pl.y, zBot + h / 2);
      p.rotation.z = pl.angle;
      this.pillars.add(p);
    }
    // pilares de los tramos suspendidos (hasta el suelo: terreno o cerros)
    const sp = this.app.state.scene;
    if (sp.suspRanges && sp.suspRanges.length) {
      const k = ex - 1, T0 = this.terrainData;
      const mat = new THREE.MeshStandardMaterial({ color: 0x8a8f99, roughness: 0.85 });
      for (const pl of suspPillars(L, E, sp, this.groundCache || null)) {
        // con exageración Z: arriba sigue a la pista, abajo al suelo exagerado
        const tz = T0 ? T0.sample(pl.x, pl.y) : pl.zBot;
        const zTop = pl.zTop * ex, zBot = pl.zBot + (Number.isFinite(tz) ? tz : pl.zBot) * k, h = zTop - zBot;
        if (h <= 0.3) continue;
        const p = new THREE.Mesh(new THREE.BoxGeometry(pl.size, pl.size, h), mat);
        p.position.set(pl.x, pl.y, zBot + h / 2);
        p.rotation.z = pl.angle;
        p.userData.susp = pl.zone;
        this.pillars.add(p);
      }
    }
  }

  /** Terreno y árboles se recalculan con una pequeña espera (son más pesados). */
  scheduleExtras() {
    clearTimeout(this.extrasTimer);
    this.extrasTimer = setTimeout(() => this.buildExtras(), 220);
  }

  /**
   * Marca una malla para la exageración Z: z' = z + shift·(ex − 1).
   * shift = z (se estira todo, como el terreno) o la altura del suelo bajo cada vértice (la forma queda intacta y solo se apoya).
   */
  markExag(mesh, shiftFn) {
    const pos = mesh.geometry.getAttribute('position');
    const base = new Float32Array(pos.array);
    const shift = new Float32Array(pos.count);
    for (let v = 0; v < pos.count; v++) shift[v] = shiftFn(base[v * 3], base[v * 3 + 1], base[v * 3 + 2], v);
    mesh.userData.exag = { base, shift };
  }

  /** Aplica la exageración Z actual a las mallas marcadas (sin reconstruirlas). */
  applyExag() {
    const k = this.zExag - 1;
    this.extras.traverse((o) => {
      const ex = o.userData && o.userData.exag;
      if (ex && o.geometry) {
        const pos = o.geometry.getAttribute('position');
        const a = pos.array;
        for (let v = 0; v < pos.count; v++) a[v * 3 + 2] = ex.base[v * 3 + 2] + ex.shift[v] * k;
        pos.needsUpdate = true;
        o.geometry.computeVertexNormals();
        o.geometry.computeBoundingSphere();
        o.geometry.computeBoundingBox();
      }
      const eo = o.userData && o.userData.exagObj;
      if (eo) o.position.z = eo.z + eo.shift * k;
    });
    this.buildDeco(false);
    this.needsFrame = true;
  }

  /**
   * Decoración: sets de elementos (cubos de color o modelos) y árboles / hierba con modelos, como InstancedMesh.
   * Se apoyan en el suelo exagerado sin estirarse.
   */
  buildDeco(stats = true) {
    if (!this.decoGroup) { this.decoGroup = new THREE.Group(); this.scene.add(this.decoGroup); }
    for (const c of [...this.decoGroup.children]) { this.decoGroup.remove(c); c.traverse((o) => { if (o.isInstancedMesh) o.dispose(); }); } // la geometría es del asset: no se libera
    this.triCounts.deco = 0;
    const L = this.app.state.layout, E = this.app.state.result, sp = this.app.state.scene;
    if (!L || !E || !this.app.assetById) return;
    const T0 = this.terrainData, k = this.zExag - 1;
    const zOf = (it) => { const t = T0 ? T0.sample(it.x, it.y) : it.z; return it.z + (Number.isFinite(t) ? t : it.z) * k; };
    const byId = (id) => this.app.assetById(id);
    const add = (items, ud) => {
      if (!items || !items.length) return;
      const g = instancedGroup(byId, items, zOf);
      g.traverse((o) => { if (o.isInstancedMesh) Object.assign(o.userData, ud); });
      this.decoGroup.add(g);
    };
    const vm = this.vegModels || {};
    if (sp.trees) add(vm.trees, { veg: 'trees' });
    if (sp.grass) add(vm.grass, { veg: 'grass' });
    const sets = this.app.state.decoSets || [];
    if (sets.length) {
      const res = decoSetItems(L, E, sp, this.groundCache || null, sets, (set) => this.app.decoPaintWorld(set), (id) => !!byId(id));
      this.decoCounts = {};
      for (const { set, items } of res) {
        add(items, { decoSet: set.id });
        const tris = items.reduce((a, it) => a + (byId(it.asset) ? byId(it.asset).tris : 0), 0);
        this.decoCounts[set.id] = { count: items.length, tris };
        this.triCounts.deco += tris;
      }
      if (this.app.onDecoInfo) this.app.onDecoInfo(this.decoCounts);
    }
    if (stats) this.updateStats();
    this.needsFrame = true;
  }

  buildExtras() {
    const L = this.app.state.layout, E = this.app.state.result;
    const sp = this.app.state.scene;
    this.app.state.groundLine = null;
    this.disposeGroup(this.extras);
    if (this.paintOverlay) { for (const c of [...this.paintOverlay.children]) { this.paintOverlay.remove(c); if (c.userData.ownGeo) c.geometry.dispose(); } this.paintOverlay.userData.key = null; }
    // la exageración Z se aplica por vértice (applyExag): terreno y pista se estiran; cerros, túneles, árboles, hierba y pórtico no
    this.extras.scale.set(1, 1, 1);
    this.terrainData = null;
    this.terrainMesh = null;
    this.waterMesh = null;
    this.hillMeshes = [];
    this.tunnelMeshes = [];
    this.hillData = null;
    this.objTris = { hills: new Map(), tunnels: new Map() };
    const info = { terrainTris: 0, terrainCell: 0, trees: 0, ms: 0, tunnelTris: 0, tunnels: [], hills: [], hillTris: 0, gateTris: 0 };
    if (!L || !E) { this.needsFrame = true; return; }
    const t0 = performance.now();
    const hillsW = this.app.hillsWorld ? this.app.hillsWorld() : null;
    const mkGeo = (geo) => {
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.BufferAttribute(geo.positions, 3));
      if (geo.uvs) bg.setAttribute('uv', new THREE.BufferAttribute(geo.uvs, 2));
      bg.setIndex(geo.indices instanceof Uint32Array ? new THREE.BufferAttribute(geo.indices, 1) : geo.indices);
      bg.computeVertexNormals();
      return bg;
    };
    const add = (geo, mat, grp = this.extras) => {
      if (!geo.indices.length) return 0;
      grp.add(new THREE.Mesh(mkGeo(geo), mat));
      return geo.indices.length / 3;
    };
    const tex = this.texture(this.app.state.terrainTex);
    let newRuns = [];
    const riversW = this.app.riversWorld ? this.app.riversWorld() : null;
    this.riverMeshes = [];
    this.wallMeshes = [];
    if (sp.terrain || (hillsW && hillsW.length) || (riversW && riversW.length)) {
      const T = buildTerrain(L, E, sp, this.app.terrainPaintWorld ? this.app.terrainPaintWorld() : null);
      this.terrainData = T;
      if (sp.terrain) {
        const cols = terrainTint(T, !!tex);
        const m = tex
          ? new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0, vertexColors: !!cols })
          : new THREE.MeshStandardMaterial({ color: cols ? 0xffffff : 0x4f7d3a, roughness: 1, metalness: 0, vertexColors: !!cols });
        const tgeo = mkGeo(T.baseIndices ? { ...T, indices: T.baseIndices } : T); // sin cauces ni paredes socavadas (van aparte)
        if (cols) tgeo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
        const tmesh = new THREE.Mesh(tgeo, m);
        tmesh.userData.terrain = true;
        this.markExag(tmesh, (x, y, z) => z);
        this.terrainMesh = tmesh;
        this.extras.add(tmesh);
        // paredes de las secciones socavadas: artificiales (lisas) o naturales (roca)
        for (const [kind, geo] of Object.entries(T.cutWalls || {})) {
          if (!geo) continue;
          const cv = this.app.cutWallTexCanvas ? this.app.cutWallTexCanvas(kind) : null;
          const t = this.texture(cv);
          if (t) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; }
          const mat = new THREE.MeshStandardMaterial({ map: t, color: t ? 0xffffff : kind === 'art' ? 0x9c9d98 : 0x6b6158, roughness: kind === 'art' ? 0.85 : 1, metalness: 0, flatShading: kind === 'nat', side: THREE.DoubleSide });
          const wm = new THREE.Mesh(mkGeo(geo), mat);
          wm.userData.cutWall = kind;
          this.markExag(wm, (x, y, z) => z);
          this.wallMeshes.push(wm);
          this.extras.add(wm);
          info.terrainTris += geo.tris;
        }
        // nivel natural del suelo a lo largo de la ruta principal (para el gráfico de perfil)
        {
          const r0 = L.routes[0], step = Math.max(1, Math.round(2 / r0.ds));
          const sArr = [], zArr = [];
          for (let i = 0; i < r0.n; i += step) { sArr.push(r0.s[i]); zArr.push(T.ctx.groundAt(r0.x[i], r0.y[i])); }
          this.app.state.groundLine = { s: sArr, z: zArr };
          if (this.app.onGroundLine) setTimeout(() => this.app.onGroundLine(), 0);
        }
        if (T.wall) { // lecho y paredes de los ríos socavados: su propio material
          const wm = new THREE.Mesh(mkGeo(T.wall), this.wallMaterial('river'));
          wm.userData.riverWall = 'river';
          this.markExag(wm, (x, y, z) => z);
          this.wallMeshes.push(wm);
          this.extras.add(wm);
          info.terrainTris += T.wall.tris;
        }
        info.terrainTris = T.tris;
        // agua (playa y montaña): un plano azul al nivel del mar
        if (T.waterLevel != null) {
          const b = T.bounds, mg = 400;
          const wg = new THREE.PlaneGeometry(b.maxX - b.minX + 2 * mg, b.maxY - b.minY + 2 * mg);
          wg.translate((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, T.waterLevel);
          const wm = new THREE.Mesh(wg, new THREE.MeshStandardMaterial({ color: 0x2c7fc0, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.82, depthWrite: false }));
          wm.userData.water = true;
          wm.renderOrder = 2;
          this.markExag(wm, (x, y, z) => z);
          this.waterMesh = wm;
          this.extras.add(wm);
        }
        info.terrainCell = T.cell;
        info.terrainCellFine = T.cellFine;
      }
      // cerros: una malla por cerro (seleccionable)
      const HS = buildHills(L, E, sp, T, hillsW);
      this.hillData = HS;
      newRuns = HS.tunnels.map((t) => ({ k: t.k, e0: t.e0, e1: t.e1, s0: t.s0, s1: t.s1 }));
      for (const h of HS.hills) {
        const m = tex
          ? new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0, color: 0xd8c8b0, side: THREE.DoubleSide })
          : new THREE.MeshStandardMaterial({ color: 0x6f7d45, roughness: 1, metalness: 0, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(mkGeo(h.wall ? { ...h, indices: h.baseIndices } : h), m);
        mesh.userData.hillId = h.id;
        if (h.wall) { // cauces socavados de las cascadas: su propio material
          const wm = new THREE.Mesh(mkGeo(h.wall), this.wallMaterial('fall'));
          wm.userData.riverWall = 'fall';
          wm.userData.wallHill = h.id;
          this.markExag(wm, (x, y) => T.sample(x, y));
          this.wallMeshes.push(wm);
          this.extras.add(wm);
        }
        this.markExag(mesh, (x, y) => T.sample(x, y)); // el cerro se apoya en el terreno exagerado sin estirarse
        this.hillMeshes.push(mesh);
        this.extras.add(mesh);
        info.hills.push({ id: h.id, name: h.name, tris: h.tris, cell: h.cell });
        this.objTris.hills.set(h.id, { name: h.name, tris: h.tris });
        info.hillTris += h.tris;
      }
      this.setHillSelection(this.app.state.selHill, false);
      // ríos (sobre el terreno) y cascadas (sobre su cerro): mallas de agua con materiales distintos
      if (riversW && riversW.length) {
        const RW = buildRivers(T, HS, riversW);
        const riverMat = new THREE.MeshStandardMaterial({ color: 0x2f86d6, roughness: 0.12, metalness: 0.05, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        const fallMat = new THREE.MeshStandardMaterial({ color: 0xbfe8ff, emissive: 0x16323f, roughness: 0.25, metalness: 0, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        info.riverTris = 0;
        for (const w of RW) {
          const m = new THREE.Mesh(mkGeo(w), (w.kind === 'fall' ? fallMat : riverMat).clone()); // material propio (para resaltarlo)
          m.userData.riverId = w.id;
          m.name = w.name;
          m.renderOrder = 3;
          if (w.kind === 'fall') this.markExag(m, (x, y) => T.sample(x, y)); else this.markExag(m, (x, y, z) => z);
          this.riverMeshes.push(m);
          this.extras.add(m);
          info.riverTris += w.tris;
        }
        this.riverData = RW;
        this.setRiverSelection(this.app.state.selRiver, false);
      }
      // túneles: paredes, techo, veredas y bocas como mallas separadas
      if (HS.tunnelGeo.length) {
        // materiales según el tipo propio de cada túnel (artificial o natural)
        const matsFor = (natural) => [
          natural ? new THREE.MeshStandardMaterial({ color: 0x6f6259, roughness: 1, flatShading: true, side: THREE.DoubleSide }) : new THREE.MeshStandardMaterial({ color: 0x9a9da3, roughness: 0.9, side: THREE.DoubleSide }),
          natural ? new THREE.MeshStandardMaterial({ color: 0x5d5249, roughness: 1, flatShading: true, side: THREE.DoubleSide }) : new THREE.MeshStandardMaterial({ color: 0x7e8288, roughness: 0.9, side: THREE.DoubleSide }),
          new THREE.MeshStandardMaterial({ color: natural ? 0x857566 : 0xb9bcc2, roughness: 0.85, side: THREE.DoubleSide, flatShading: natural }),
        ];
        const walkMat = new THREE.MeshStandardMaterial({ color: 0x8a8a84, roughness: 0.95, side: THREE.DoubleSide });
        const rockMat = new THREE.MeshStandardMaterial({ color: 0x5c5049, roughness: 1, flatShading: true, side: THREE.DoubleSide });
        const pillarMat = new THREE.MeshStandardMaterial({ color: 0x8d9097, roughness: 0.85 });
        const roadZ = this.roadBaseFn(L, E);
        for (const t of HS.tunnelGeo) {
          // materiales propios por túnel (para resaltarlo al seleccionarlo)
          const [wallMat, ceilMat, portalMat] = matsFor(!!t.natural);
          const mats = [wallMat, ceilMat, walkMat, portalMat, rockMat, pillarMat].map((m) => m.clone());
          const [wm, cm, km, pm0, rm, plm] = mats;
          const addT = (geo, mat) => {
            const n = add(geo, mat);
            if (n) { const m = this.extras.children[this.extras.children.length - 1]; m.userData.tunnelId = t.id; this.tunnelMeshes.push(m); this.markExag(m, (x, y) => roadZ(x, y)); }
            return n;
          };
          let tris = addT(t.walls, wm) + addT(t.ceiling, cm) + addT(t.walkways, km) + addT(t.stalactites, rm) + addT(t.rocks, rm);
          for (const pt of t.portals) tris += addT(pt.geo, pm0);
          for (const pl of t.pillars) {
            const pm = new THREE.Mesh(mkGeo(pillarGeometry(pl)), plm);
            pm.userData.tunnelId = t.id;
            pm.userData.exagObj = { z: pl.z, shift: roadZ(pl.x, pl.y) };
            this.tunnelMeshes.push(pm);
            pm.position.set(pl.x, pl.y, pl.z);
            this.extras.add(pm);
            tris += 12;
          }
          info.tunnelTris += tris;
          info.tunnels.push({ id: t.id, name: t.name, len: t.len, pillars: t.pillars.length, tris, k: t.k, sMid: t.sMid, openMode: t.openMode, pillarCount: t.pillarCount, custom: t.custom, key: t.key, shape: t.shape, type: t.type, density: t.density, meshMode: t.meshMode, maxTris: t.maxTris, adapt: t.adapt, rocks: t.rocks, sections: t.sections, profilePts: t.profilePts });
          this.objTris.tunnels.set(t.id, { name: t.name, tris });
        }
      }
    }
    // pórtico de salida
    if (sp.startGate) {
      const G = buildStartGate(L, E, sp);
      const grp = new THREE.Group();
      grp.position.set(...G.origin);
      const bKey = G.text;
      if (!this.bannerCanvas || this.bannerCanvas.text !== bKey) { this.bannerCanvas = makeBannerCanvas(bKey); this.bannerCanvas.text = bKey; }
      if (!this.checkerCanvas) this.checkerCanvas = makeCheckerCanvas();
      const bt = this.texture(this.bannerCanvas);
      add(G.frame, new THREE.MeshStandardMaterial({ color: 0x30343c, roughness: 0.6, metalness: 0.3 }), grp);
      add(G.banner, new THREE.MeshStandardMaterial({ map: bt, roughness: 0.7 }), grp);
      add(G.line, new THREE.MeshStandardMaterial({ map: this.texture(this.checkerCanvas), roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2 }), grp);
      grp.userData.exagObj = { z: G.origin[2], shift: G.origin[2] };
      this.extras.add(grp);
      info.gateTris = G.tris;
    }
    const ground = makeGround(this.terrainData, this.hillData);
    this.groundCache = ground;
    if (this.paintMode) this.refreshPaintOverlay();
    this.vegModels = { trees: null, grass: null };
    const hasAsset = (id) => !!(this.app.assetById && this.app.assetById(id));
    if (sp.grass) {
      const GR = buildGrass(L, E, sp, ground);
      const gItems = grassModelItems(GR.insts, sp.grassAssets, hasAsset); // hierba reemplazada por modelos
      if (gItems) { this.vegModels.grass = gItems; GR.tris = gItems.reduce((a, it) => a + (this.app.assetById(it.asset).tris || 0), 0); GR.count = 0; }
      if (GR.count) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(GR.positions, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(GR.normals, 3));
        g.setAttribute('uv', new THREE.BufferAttribute(GR.uvs, 2));
        g.setIndex(new THREE.BufferAttribute(GR.indices, 1));
        if (!this.app.state.grassTex && !this.defaultGrass) this.defaultGrass = makeGrassCanvas();
        const gt = this.texture(this.app.state.grassTex || this.defaultGrass);
        const gm = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: gt, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1, metalness: 0 }));
        { // cada mata sube o baja con el suelo exagerado, sin estirarse (8 vértices por mata)
          const T0 = this.terrainData, P = GR.positions, sh = new Float32Array(GR.count);
          for (let c = 0; c < GR.count; c++) sh[c] = T0 ? T0.sample(P[c * 24], P[c * 24 + 1]) : P[c * 24 + 2];
          const pos = g.getAttribute('position');
          gm.userData.exag = { base: new Float32Array(pos.array), shift: Float32Array.from({ length: pos.count }, (_, v) => sh[Math.floor(v / 8)]) };
        }
        gm.userData.noWire = true;
        gm.userData.veg = 'grass';
        this.extras.add(gm);
      }
      info.grass = gItems ? gItems.length : GR.count;
      info.grassTris = GR.tris;
    }
    let shadowTrees = null;
    if (sp.trees) {
      const TR = buildTrees(L, E, sp, ground);
      shadowTrees = TR.trees;
      const tItems = treeModelItems(TR.trees, sp.treeAssets, hasAsset); // árboles reemplazados por modelos
      if (tItems) this.vegModels.trees = tItems;
      if (TR.count && !tItems) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(TR.positions, 3));
        g.setIndex(new THREE.BufferAttribute(TR.indices, 1));
        g.computeVertexNormals();
        const tm = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x2e6b34, roughness: 0.9, flatShading: true }));
        { // cada árbol (10 vértices) se desplaza con el suelo exagerado, sin estirarse
          const T0 = this.terrainData, per = TR.trees.map((t) => (T0 ? T0.sample(t.x, t.y) : t.z));
          const pos = g.getAttribute('position');
          tm.userData.exag = { base: new Float32Array(pos.array), shift: Float32Array.from({ length: pos.count }, (_, v) => per[Math.floor(v / 10)]) };
        }
        tm.userData.veg = 'trees';
        this.extras.add(tm);
      }
      info.trees = TR.count;
      info.treeTris = tItems ? tItems.reduce((a, it) => a + (this.app.assetById(it.asset).tris || 0), 0) : TR.indices.length / 3;
      info.treesOnHills = TR.trees.filter((t) => t.where !== 'terrain').length;
    }
    this.shadowTrees = shadowTrees;
    this.buildShadowMesh(info);
    // los bordes se cortan en los túneles: si cambiaron, se rehacen
    if (JSON.stringify(newRuns) !== JSON.stringify(this.tunnelRuns)) { this.tunnelRuns = newRuns; setTimeout(() => this.update(false, true), 0); } // pista (material de los tramos en túnel) y bordes
    this.applyExag(); // también rehace la decoración (sets y modelos de vegetación)
    info.ms = performance.now() - t0;
    if (this.grid) this.grid.visible = !sp.terrain;
    this.buildPillars();
    this.needsFrame = true;
    this.triCounts.terrain = info.terrainTris;
    this.triCounts.tunnels = info.tunnelTris || 0;
    this.triCounts.hills = info.hillTris || 0;
    this.triCounts.rivers = info.riverTris || 0;
    this.triCounts.gate = info.gateTris || 0;
    this.triCounts.trees = info.treeTris || 0;
    this.triCounts.grass = info.grassTris || 0;
    this.updateStats();
    this.applyWireframe();
    if (this.game && this.game.active) this.game.onSceneRebuilt();
    if (this.app.onSceneInfo) this.app.onSceneInfo(info);
  }

  /** Altura de la calzada más cercana (para apoyar túneles en la pista exagerada). */
  roadBaseFn(L, E) {
    const pts = [];
    L.routes.forEach((r, k) => { for (let i = 0; i < r.n; i += 2) pts.push([r.x[i], r.y[i], E.routes[k].z[i]]); });
    const cell = 12, grid = new Map();
    for (const p of pts) { const key = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`; let l = grid.get(key); if (!l) grid.set(key, (l = [])); l.push(p); }
    return (x, y) => {
      const ix = Math.floor(x / cell), iy = Math.floor(y / cell);
      let best = null, bd = Infinity;
      for (let r = 1; r <= 4 && !best; r++) {
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
          const l = grid.get(`${ix + dx},${iy + dy}`);
          if (!l) continue;
          for (const p of l) { const d = (p[0] - x) ** 2 + (p[1] - y) ** 2; if (d < bd) { bd = d; best = p; } }
        }
      }
      return best ? best[2] : 0;
    };
  }

  /** Resalta el río o la cascada seleccionados (sin reconstruir). */
  setRiverSelection(id, frame = true) {
    for (const m of this.riverMeshes || []) {
      const sel = id != null && m.userData.riverId === id;
      if (m.userData.baseEmissive === undefined) m.userData.baseEmissive = m.material.emissive.getHex();
      m.material.emissive.set(sel ? 0x6b5210 : m.userData.baseEmissive);
      m.material.emissiveIntensity = sel ? 0.45 : 1;
    }
    if (frame) this.needsFrame = true;
  }

  /** Resalta el cerro seleccionado (sin reconstruir). */
  setHillSelection(id, frame = true) {
    const st = this.app.state;
    const glow = (m, sel) => { m.material.emissive.set(sel ? 0x6b5210 : 0x000000); m.material.emissiveIntensity = sel ? 0.45 : 0; };
    for (const m of this.hillMeshes || []) glow(m, st.selHill != null && m.userData.hillId === st.selHill);
    for (const m of this.tunnelMeshes || []) glow(m, st.selTunnel != null && m.userData.tunnelId === st.selTunnel);
    if (this.statsDiv) this.updateStats();
    this.updateHillGizmo();
    if (frame) this.needsFrame = true;
  }

  /** Flecha Z sobre la cima del cerro seleccionado: arrastrarla cambia su altura. */
  updateHillGizmo() {
    if (!this.hillTc) return;
    const st = this.app.state;
    const meshes = (this.hillMeshes || []).filter((m) => st.selHill != null && m.userData.hillId === st.selHill);
    const hill = st.selHill != null ? (st.hills || []).find((h) => h.id === st.selHill) : null;
    if (!meshes.length || !hill || (this.game && this.game.active) || st.tool === 'edit') { this.hillTc.detach(); this.hillTc.enabled = false; this.hillDrag = null; return; }
    let best = null, zb = Infinity;
    for (const m of meshes) {
      const P = m.geometry.getAttribute('position');
      for (let i = 0; i < P.count; i++) { const z = P.getZ(i); if (!best || z > best[2]) best = [P.getX(i), P.getY(i), z]; if (z < zb) zb = z; }
    }
    if (!best) return;
    this.hillProxy.position.set(best[0], best[1], best[2] + 1);
    this.hillProxy.updateMatrixWorld();
    this.hillTc.attach(this.hillProxy);
    this.hillTc.enabled = true;
    this.hillDrag = { id: hill.id, h0: hill.height, newH: hill.height, meshes, zb, active: false };
  }

  /** Camino de tierra y barreras (mallas propias, seleccionables con un clic). */
  buildEdges(stats = true) {
    this.disposeGroup(this.edgeGroup);
    this.edgeGroup.scale.set(1, 1, this.zExag);
    this.triCounts.edges = 0;
    const L = this.app.state.layout, E = this.app.state.result, sp = this.app.state.scene;
    if (!L || !E) return;
    const B = buildEdgeMeshes(L, E, { ...sp, coveredRanges: this.coveredCache || [] }); // también dentro de los túneles (la pared del túnel queda después)
    const mk = (m, mat, kind) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
      g.setIndex(m.indices);
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, mat);
      mesh.userData.edge = kind;
      mesh.userData.alt = !!m.alt;
      mesh.userData.k = m.k;
      mesh.name = m.name;
      this.edgeGroup.add(mesh);
    };
    // material por textura: la pista y los atajos sin textura propia comparten el suyo
    const cache = new Map();
    const matFor = (fn, m, make) => {
      const cv = this.app[fn] ? this.app[fn](m.alt ? L.routes[m.k] : null, !!m.susp) : null;
      const key = fn + ':' + (cv ? (cv.__mid || (cv.__mid = Math.random().toString(36).slice(2))) : 'none');
      if (!cache.has(key)) cache.set(key, make(this.texture(cv)));
      return cache.get(key);
    };
    const dm = (map) => new THREE.MeshStandardMaterial({ map, color: 0xffffff, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const bm = (map) => new THREE.MeshStandardMaterial({ map, color: 0xffffff, roughness: 0.6, metalness: 0.1 });
    for (const m of B.dirt) mk(m, matFor('dirtTexCanvas', m, dm), 'dirt');
    for (const m of B.barriers) mk(m, matFor('barrierTexCanvas', m, bm), 'barrier');
    this.triCounts.edges = B.dirtTris + B.barrierTris;
    if (this.app.onEdgesInfo) this.app.onEdgesInfo(B);
    if (this.wire && this.wire.on) this.applyWireframe();
    if (stats) this.updateStats();
    this.needsFrame = true;
  }

  /** Coloca (o quita) el modelo de referencia. ref = state.ref3d o null. */
  setReference(ref) {
    if (this.refOuter) { this.refTc.detach(); this.refExag.remove(this.refOuter); this.refOuter = null; }
    if (ref && ref.inner) {
      this.refOuter = new THREE.Group();
      this.refOuter.name = 'referencia_3d';
      this.refOuter.add(ref.inner);
      this.refExag.add(this.refOuter);
    }
    this.updateReference();
  }
  /** Posición, giro, escala, aspecto y gizmo del modelo de referencia. */
  updateReference() {
    const ref = this.app.state.ref3d, o = this.refOuter;
    if (!o || !ref) { this.refTc.detach(); this.refTc.enabled = false; this.needsFrame = true; return; }
    o.position.set(ref.pos[0], ref.pos[1], ref.pos[2]);
    o.rotation.set(0, 0, THREE.MathUtils.degToRad(ref.rotZ || 0));
    o.scale.setScalar(ref.scale || 1);
    o.visible = ref.visible !== false;
    applyRefLook(ref.meshes, ref.look || 'flat', ref.color || '#4fc3f7', ref.opacity ?? 0.6);
    const on = !!ref.sel && o.visible && !ref.locked;
    if (on) { this.refTc.attach(o); this.refTc.enabled = true; this.refTc.setMode(ref.gizmo === 'rotate' ? 'rotate' : 'translate'); this.refTc.showX = ref.gizmo !== 'rotate'; this.refTc.showY = ref.gizmo !== 'rotate'; this.refTc.showZ = true; }
    else { this.refTc.detach(); this.refTc.enabled = false; }
    this.needsFrame = true;
  }

  /** Clic con Navegar: selecciona el cerro bajo el cursor (o deselecciona). */
  pickHill(e) {

    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const veg = this.extras.children.filter((o) => o.isMesh && o.userData.veg);
    const rs = this.app.state.ref3d;
    const refMeshes = this.refOuter && rs && rs.visible && !rs.locked ? rs.meshes : [];
 const edgeMeshes = this.edgeGroup.children.filter((o) => o.isMesh);
    const decoMeshes = [];
    if (this.decoGroup) this.decoGroup.traverse((o) => { if (o.isInstancedMesh) decoMeshes.push(o); });
    const water = this.waterMesh && this.extras.children.includes(this.waterMesh) ? [this.waterMesh] : [];
    const objs = [...refMeshes, ...edgeMeshes, ...(this.riverMeshes || []), ...(this.wallMeshes || []), ...water, ...decoMeshes, ...this.itemsGroup.children, ...this.hillMeshes, ...(this.tunnelMeshes || []), ...(this.terrainMesh ? [this.terrainMesh] : []), ...this.trackGroup.children, ...veg];
    const h = ray.intersectObjects(objs, false);
    const ud = h.length ? h[0].object.userData : {};
    const onTrack = h.length && this.trackGroup.children.includes(h[0].object);
    const altHit = onTrack ? this.app.altAtWorld(h[0].point.x, h[0].point.y) : null;
    if (altHit == null && !ud.item && this.app.state.selAlt != null) this.app.selectAlt(null);
    if (this.app.state.selBridge != null && !(onTrack && this.app.bridgeAtWorld(h[0].point.x, h[0].point.y) === this.app.state.selBridge)) this.app.selectBridge(null);
    if (h.length && (h[0].object === this.terrainMesh || h[0].object.userData.water) && this.app.focusPanel) this.app.focusPanel('terrain'); // clic en el terreno o el agua: sus parámetros
    if (ud.ref3d) { this.app.selectRef3d(true); return; } // modelo de referencia: se selecciona entero
    if (ud.cutWall) { this.app.selectHill(null); if (this.app.focusPanel) this.app.focusPanel('cut'); return; } // paredes de una sección socavada
    if (ud.riverWall) { this.app.selectHill(null); if (this.app.focusPanel) this.app.focusPanel('rivers', document.getElementById('riverWallHead')); return; } // paredes de un cauce: su material
    if (ud.riverId != null) { this.app.selectHill(null); if (this.app.selectRiver) this.app.selectRiver(ud.riverId); return; } // río o cascada: su tarjeta
    if (ud.decoSet != null) { // elemento decorativo: su set
      if (this.app.state.ref3d && this.app.state.ref3d.sel) this.app.selectRef3d(false);
      this.app.selectHill(null);
      if (this.app.selectDecoSet) this.app.selectDecoSet(ud.decoSet);
      return;
    }
    if (ud.edge) { // barrera o camino de tierra: sus parámetros
      if (this.app.state.ref3d && this.app.state.ref3d.sel) this.app.selectRef3d(false);
      this.app.selectHill(null);
      const r = this.app.state.layout && this.app.state.layout.routes[ud.k];
      if (ud.alt && r && this.app.focusAltEdge) this.app.focusAltEdge(r.altIndex, ud.edge); // los de un atajo: en su tarjeta
      else if (this.app.focusPanel) this.app.focusPanel('edges', document.getElementById(ud.edge === 'barrier' ? 'barrierHead' : 'dirtHead'));
      return;
    }
    if (this.app.state.ref3d && this.app.state.ref3d.sel) this.app.selectRef3d(false);
    if (ud.veg) { // árboles o hierba: sus parámetros
      this.app.selectHill(null);
      if (this.app.focusPanel) this.app.focusPanel('trees', ud.veg === 'grass' ? document.getElementById('grass') : document.getElementById('trees'));
      return;
    }
    if (ud.item) this.app.selectItem(ud.item);
    else if (altHit != null) this.app.selectAlt(altHit);
    else if (onTrack && this.app.bridgeAtWorld && this.app.bridgeAtWorld(h[0].point.x, h[0].point.y) != null) this.app.selectBridge(this.app.bridgeAtWorld(h[0].point.x, h[0].point.y));
    else if (onTrack) { this.app.selectHill(null); if (this.app.focusPanel) this.app.focusPanel('tracktex'); } // clic en la pista: su textura
    else if (ud.tunnelId != null) this.app.selectTunnel(ud.tunnelId);
    else this.app.selectHill(ud.hillId != null ? ud.hillId : null);
  }

  findItem(ref) {
    if (!ref) return null;
    for (const g of this.app.itemInstances()) if (g.type === ref.type && g.gid === ref.gid) return g.items.find((it) => it.idx === ref.idx) || null;
    return null;
  }

  /** Elementos de pista como mallas separadas (pivote en la base, alineadas con la calzada). */
  buildItems() {
    this.disposeGroup(this.itemsGroup);
    this.itemsGroup.scale.set(1, 1, this.zExag);
    const inst = this.app.itemInstances ? this.app.itemInstances() : [];
    const sel = this.app.state.selItem;
    if (!this.padCanvas) this.padCanvas = makePadCanvas();
    const IT = this.app.state.itemTex || {};
    if (!this.glowCanvas) this.glowCanvas = makeGlowCanvas();
    const tPud = this.texture(IT.puddle), tStr = this.texture(IT.strip);
    const mats = {
      puddle: new THREE.MeshStandardMaterial({ color: tPud ? 0xffffff : 0x3a8fe8, map: tPud, roughness: 0.08, metalness: 0.3, transparent: true, opacity: 0.88, polygonOffset: true, polygonOffsetFactor: -2 }),
      pad: new THREE.MeshStandardMaterial({ map: this.texture(IT.pad || this.padCanvas), roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -3 }),
      strip: new THREE.MeshStandardMaterial({ color: tStr ? 0xffffff : 0x22c55e, map: tStr, emissive: tStr ? 0x000000 : 0x0b5d2a, emissiveIntensity: 0.6, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -2 }),
    };
    const borderMat = new THREE.MeshBasicMaterial({ map: this.texture(IT.border || this.glowCanvas), transparent: true, depthWrite: false, side: THREE.FrontSide });
    let tris = 0, count = 0;
    const M = new THREE.Matrix4();
    for (const g of inst) for (const it of g.items) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(it.positions, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(it.uvs, 2));
      geo.setIndex(it.indices);
      geo.computeVertexNormals();
      const isSel = sel && sel.type === it.type && sel.gid === it.gid && sel.idx === it.idx;
      const mat = isSel ? mats[it.type].clone() : mats[it.type];
      if (isSel) { mat.emissive = new THREE.Color(0x8a6d00); mat.emissiveIntensity = 0.5; }
      const m = new THREE.Mesh(geo, mat);
      m.position.set(...it.origin);
      if (it.basis) {
        const [T, Lt, U] = it.basis;
        M.makeBasis(new THREE.Vector3(...T), new THREE.Vector3(...Lt), new THREE.Vector3(...U));
        m.quaternion.setFromRotationMatrix(M);
      }
      m.name = it.name;
      m.userData.item = { type: it.type, gid: it.gid, idx: it.idx };
      if (it.border) {
        const bg = new THREE.BufferGeometry();
        bg.setAttribute('position', new THREE.BufferAttribute(it.border.positions, 3));
        bg.setAttribute('uv', new THREE.BufferAttribute(it.border.uvs, 2));
        bg.setIndex(it.border.indices);
        bg.computeVertexNormals();
        const bm = new THREE.Mesh(bg, borderMat);
        bm.renderOrder = 3;
        m.add(bm);
        tris += it.border.indices.length / 3;
      }
      m.renderOrder = 2;
      this.itemsGroup.add(m);
      tris += it.indices.length / 3;
      count++;
    }
    this.triCounts.items = tris;
    this.itemCount = count;
    if (this.statsDiv) this.updateStats();
    this.needsFrame = true;
  }

  setPaintMode(m) {
    this.paintMode = m;
    if (!m) { this.brushRing.visible = false; this.needsFrame = true; }
    this.refreshPaintOverlay();
  }

  /** Material de las paredes socavadas: ríos o cascadas (textura propia o roca por defecto). */
  wallMaterial(kind) {
    const cv = this.app.wallTexCanvas ? this.app.wallTexCanvas(kind) : null;
    const t = this.texture(cv);
    if (t) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; }
    return new THREE.MeshStandardMaterial({ map: t, color: t ? 0xffffff : kind === 'fall' ? 0x7b7670 : 0x6d6258, roughness: 1, metalness: 0, side: THREE.DoubleSide });
  }

  /** Altura visible (con la exageración Z) de la superficie en (x, y): terreno y cerros; null si no hay terreno. */
  surfaceZ(x, y) {
    const G = this.groundCache, T0 = this.terrainData;
    if (!G || !T0) return null;
    const g = G.sample(x, y), t = T0.sample(x, y);
    if (!Number.isFinite(g)) return null;
    return g + (Number.isFinite(t) ? t : 0) * (this.zExag - 1);
  }

  /** Coloca el aro del pincel en pt con radio r, amoldado a la superficie que hay debajo. */
  shapeBrushRing(pt, r) {
    const N = BRUSH_SEGS, pos = this.brushRing.geometry.getAttribute('position'), a = pos.array;
    const w = Math.max(0.25, Math.min(r * 0.08, 3));
    const z0 = this.surfaceZ(pt.x, pt.y);
    const lift = Math.max(0.15, r * 0.004);
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
      for (let k = 0; k < 2; k++) {
        const rr = k ? r : r - w;
        const x = pt.x + c * rr, y = pt.y + s * rr;
        let z = this.surfaceZ(x, y);
        if (z == null || z0 == null) z = pt.z; // sin terreno: plano a la altura del punto
        const v = (i * 2 + k) * 3;
        a[v] = x; a[v + 1] = y; a[v + 2] = z + lift;
      }
    }
    pos.needsUpdate = true;
    this.brushRing.position.set(0, 0, 0);
    this.brushRing.scale.setScalar(1);
  }

  /**
   * Zonas pintadas iluminadas en 3D mientras se usa un pincel: las mismas mallas de terreno y cerros, dibujadas otra
   * vez con una máscara (lienzo en coordenadas del mundo) que se rehace en cada toque del pincel.
   */
  refreshPaintOverlay() {
    if (this._povRaf) return;
    this._povRaf = requestAnimationFrame(() => { this._povRaf = 0; this.drawPaintOverlay(); });
  }
  drawPaintOverlay() {
    const info = this.paintMode && this.app.paintOverlayStrokes ? this.app.paintOverlayStrokes() : null;
    if (!info || !info.strokes.length) { if (this.paintOverlay) { this.paintOverlay.visible = false; this.needsFrame = true; } return; }
    const L = this.app.state.layout;
    if (!L) return;
    // límites: los del terreno o, si no hay, los de la pista con margen
    let B = this.terrainData && this.terrainData.bounds;
    if (!B) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const r of L.routes) for (let i = 0; i < r.n; i++) { minX = Math.min(minX, r.x[i]); minY = Math.min(minY, r.y[i]); maxX = Math.max(maxX, r.x[i]); maxY = Math.max(maxY, r.y[i]); }
      const m = 300;
      B = { minX: minX - m, minY: minY - m, maxX: maxX + m, maxY: maxY + m };
    }
    if (!this.paintOverlay) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 1024;
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.NoColorSpace;
      tex.minFilter = THREE.LinearFilter;
      const mat = new THREE.ShaderMaterial({
        uniforms: { uMask: { value: tex }, uMin: { value: new THREE.Vector2() }, uSize: { value: new THREE.Vector2(1, 1) }, uColor: { value: new THREE.Color(0xe040fb) }, uTime: { value: 0 } },
        vertexShader: 'varying vec2 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xy; gl_Position = projectionMatrix * viewMatrix * w; }',
        fragmentShader: 'uniform sampler2D uMask; uniform vec2 uMin; uniform vec2 uSize; uniform vec3 uColor; varying vec2 vW; void main(){ vec2 uv = (vW - uMin) / uSize; if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard; float a = texture2D(uMask, uv).a; if (a < 0.01) discard; gl_FragColor = vec4(uColor * (0.7 + 0.6 * a), 0.28 + 0.4 * a); }',
        transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8, side: THREE.DoubleSide,
      });
      this.paintOverlay = new THREE.Group();
      this.paintOverlay.userData.canvas = cv; this.paintOverlay.userData.tex = tex; this.paintOverlay.userData.mat = mat;
      this.paintOverlay.renderOrder = 5;
      this.scene.add(this.paintOverlay);
    }
    const ov = this.paintOverlay, cv = ov.userData.canvas, mat = ov.userData.mat;
    // mallas sobre las que se dibuja (se comparten las geometrías: siguen la exageración Z)
    const surf = [...(this.terrainMesh ? [this.terrainMesh] : []), ...(this.hillMeshes || []), ...(this.wallMeshes || [])];
    const key = surf.map((m) => m.geometry.uuid).join(',') + (surf.length ? '' : `plane:${B.minX},${B.minY}`);
    if (ov.userData.key !== key) {
      for (const c of [...ov.children]) { ov.remove(c); if (c.userData.ownGeo) c.geometry.dispose(); }
      if (surf.length) for (const m of surf) { m.updateWorldMatrix(true, false); const o = new THREE.Mesh(m.geometry, mat); o.matrixAutoUpdate = false; o.matrix.copy(m.matrixWorld); o.renderOrder = 5; ov.add(o); }
      else { const g = new THREE.PlaneGeometry(B.maxX - B.minX, B.maxY - B.minY).translate((B.minX + B.maxX) / 2, (B.minY + B.maxY) / 2, 0.05); const o = new THREE.Mesh(g, mat); o.userData.ownGeo = true; o.renderOrder = 5; ov.add(o); }
      ov.userData.key = key;
    }
    const W = B.maxX - B.minX, H = B.maxY - B.minY;
    mat.uniforms.uMin.value.set(B.minX, B.minY);
    mat.uniforms.uSize.value.set(W, H);
    mat.uniforms.uColor.value.set(info.color || 0xe040fb);
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    // canvas: y hacia abajo; uv.y = 0 es la primera fila de la textura (flipY) → se dibuja con Y invertida
    const sx = cv.width / W, sy = cv.height / H;
    for (const st of info.strokes) {
      ctx.globalCompositeOperation = st.e ? 'destination-out' : 'source-over';
      ctx.fillStyle = `rgba(255,255,255,${st.a ?? 1})`;
      ctx.beginPath();
      ctx.ellipse((st.x - B.minX) * sx, (B.maxY - st.y) * sy, Math.max(1, st.r * sx), Math.max(1, st.r * sy), 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ov.userData.tex.needsUpdate = true;
    ov.visible = true;
    this.needsFrame = true;
  }

  setGizmoMode(m) {
    this.gizmoMode = m;
    const xf = (this.app.state && this.app.state.xform) || 'move';
    if (xf === 'rotate') { this.tc.setMode('rotate'); this.tc.showX = false; this.tc.showY = false; this.tc.showZ = true; }
    else if (xf === 'scale') { this.tc.setMode('scale'); this.tc.showX = true; this.tc.showY = true; this.tc.showZ = true; }
    else {
      this.tc.setMode('translate');
      this.tc.showX = m !== 'z';
      this.tc.showY = m !== 'z';
      this.tc.showZ = m !== 'xy';
    }
    this.needsFrame = true;
  }
  /** Cinta amarilla sobre los segmentos seleccionados (nivel Segmento). */
  updateSegHighlight() {
    for (const c of [...this.segGroup.children]) { this.segGroup.remove(c); c.geometry?.dispose(); c.material?.dispose(); }
    const st = this.app.state, L = st.layout, E = st.result;
    if (st.tool !== 'edit' || st.subObj !== 'segment' || !L || !E || !this.app.segSelRanges) return;
    const ex = this.zExag;
    for (const R of this.app.segSelRanges()) {
      const r = L.routes[R.k], z = E.routes[R.k].z;
      const i0 = Math.floor(R.s0 / r.ds), i1 = Math.ceil(R.s1 / r.ds);
      const pos = [], idx = [];
      for (let ii = i0; ii <= i1; ii++) {
        const i = r.closed ? ((ii % r.n) + r.n) % r.n : Math.max(0, Math.min(r.n - 1, ii));
        const hw = r.w[i] * 0.32, nx = -r.ty[i], ny = r.tx[i], zz = z[i] * ex + 0.25;
        pos.push(r.x[i] + nx * hw, r.y[i] + ny * hw, zz, r.x[i] - nx * hw, r.y[i] - ny * hw, zz);
        const v = (ii - i0) * 2;
        if (ii > i0) idx.push(v - 2, v - 1, v, v - 1, v + 1, v);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.55, depthTest: false, side: THREE.DoubleSide }));
      m.renderOrder = 9;
      this.segGroup.add(m);
    }
  }
  /** Segmento de la pista bajo el cursor en 3D (nivel Segmento) o null. */
  pickSegment(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const h = ray.intersectObjects(this.trackGroup.children, false);
    if (!h.length) return null;
    return this.app.segmentAtWorld(h[0].point.x, h[0].point.y, 12);
  }

  handleRadius() {
    const L = this.app.state.layout;
    return 0.4 * (L ? Math.max(1.5, L.gp.width * 0.28) : 3); // 40 % del tamaño anterior
  }

  updateHandles() {
    for (const c of [...this.handleGroup.children]) {
      this.handleGroup.remove(c);
      c.geometry?.dispose();
      c.material?.dispose();
    }
    const st = this.app.state;
    if (st.tool === 'pan' && st.selItem && st.layout && st.result) {
      // elemento de pista seleccionado: gizmo solo en el plano XY
      const it = this.findItem(st.selItem);
      if (it && !this.tc.dragging) {
        this.tc.showX = true; this.tc.showY = true; this.tc.showZ = false;
        this.proxy.position.set(it.origin[0], it.origin[1], it.origin[2] * this.zExag + 0.3);
        this.tc.attach(this.proxy);
      }
      this.needsFrame = true;
      return;
    }
    if (st.tool !== 'edit' || !st.layout || !st.result) {
      if (!this.tc.dragging) this.tc.detach();
      this.needsFrame = true;
      return;
    }
    if (!this.tc.dragging) this.setGizmoMode(this.gizmoMode || 'free');
    this.updateSegHighlight();
    const segMode = st.subObj === 'segment', xf = st.xform || 'move';
    const ex = this.zExag;
    const rad = this.handleRadius();
    const geo = new THREE.SphereGeometry(rad, 14, 10);
    let selPt = null;
    const ms = st.selSet && st.selSet.idxs.size > 0 ? st.selSet : null;
    const cen = new THREE.Vector3();
    let cenN = 0;
    for (const pt of this.app.ctrlPoints()) {
      const inMulti = ms && ms.key === pt.key && ms.idxs.has(pt.idx);
      const isSel = !segMode && ((st.sel && st.sel.key === pt.key && st.sel.idx === pt.idx) || inMulti);
      const color = isSel ? 0xffe066 : pt.pin !== null ? 0xf2a93b : pt.k > 0 ? 0x9fd4ff : 0xffffff;
      const m = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }));
      const z = pt.pin !== null ? pt.pin : pt.z;
      m.position.set(pt.X, pt.Y, z * ex + rad * 0.6);
      if (isSel) m.scale.setScalar(1.5); else if (segMode) m.scale.setScalar(0.6);
      m.renderOrder = 10;
      m.userData = { key: pt.key, idx: pt.idx };
      this.handleGroup.add(m);
      if (inMulti) { cen.add(m.position); cenN++; }
      else if (isSel) selPt = m.position.clone();
    }
    if (cenN > 0) selPt = cen.multiplyScalar(1 / cenN);
    if (xf !== 'move' && cenN < 2) selPt = null; // rotar / escalar necesitan 2 o más puntos
    geo.dispose();
    if (selPt) {
      if (!this.tc.dragging) {
        this.proxy.position.copy(selPt);
        this.proxy.rotation.set(0, 0, 0);
        this.proxy.scale.set(1, 1, 1);
        this.tc.attach(this.proxy);
      }
    } else if (!this.tc.dragging) this.tc.detach();
    this.needsFrame = true;
  }

  pickHandle(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObjects(this.handleGroup.children, false);
    return hits.length ? { ...hits[0].object.userData } : null;
  }

  pick(e) {
    if (this.app.state.subObj === 'segment') { this.app.selectSegment(this.pickSegment(e), false); return; }
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObjects(this.handleGroup.children, false);
    if (hits.length) this.app.selectCtrl({ ...hits[0].object.userData });
    else this.app.selectCtrl(null);
  }

  onDragStart() {
    const st = this.app.state;
    if (st.tool === 'pan' && st.selItem) {
      this.itemDragMode = true;
      this.dragStart = this.proxy.position.clone();
      this.app.beginItemDrag(st.selItem);
      return;
    }
    if ((st.xform === 'rotate' || st.xform === 'scale') && st.selSet && st.selSet.idxs.size > 1 && this.app.beginXform()) {
      this.xformMode = st.xform;
      this.dragSel = { group: true };
      return;
    }
    if (st.selSet && st.selSet.idxs.size > 0 && this.app.beginGroupDrag()) {
      this.groupMode = true;
      this.dragSel = { group: true };
      this.dragStart = this.proxy.position.clone();
      return;
    }
    const sel = st.sel;
    if (!sel) return;
    this.dragSel = { ...sel };
    this.dragStart = this.proxy.position.clone();
    this.app.beginCtrlDrag(sel.key, sel.idx);
  }

  onGizmoMove() {
    if (this.itemDragMode) {
      const p = this.proxy.position;
      this.app.dragItemBy(p.x - this.dragStart.x, p.y - this.dragStart.y);
      // el gizmo sigue al elemento ya ajustado a la pista
      const it = this.findItem(this.app.state.selItem);
      if (it) this.proxy.position.z = it.origin[2] * this.zExag + 0.3;
      return;
    }
    const d = this.dragSel;
    if (!d) return;
    const p = this.proxy.position;
    if (this.xformMode === 'rotate') { this.app.applyXform({ type: 'rotate', a: -this.proxy.rotation.z }); return; } // y del lienzo invertida
    if (this.xformMode === 'scale') {
      const c = (v) => Math.max(0.02, Math.min(50, v));
      const S = this.proxy.scale, u = this.tc.axis === 'XYZ';
      this.app.applyXform({ type: 'scale', sx: c(u ? S.x : S.x), sy: c(u ? S.x : S.y) });
      return;
    }
    if (this.groupMode) {
      const L = this.app.state.layout;
      const dX = p.x - this.dragStart.x, dY = p.y - this.dragStart.y, dZ = p.z - this.dragStart.z;
      const dz = dZ / this.zExag;
      const dx = dX / L.scale, dy = -dY / L.scale;
      if (this.gizmoMode === 'z') this.app.applyGroupDelta(0, 0, dz);
      else if (this.gizmoMode === 'xy') this.app.applyGroupDelta(dx, dy, null);
      else this.app.applyGroupDelta(dx, dy, Math.abs(dZ) > 1e-4 ? dz : null);
      return;
    }
    const rad = this.handleRadius();
    const zM = (p.z - rad * 0.6) / this.zExag;
    const zMoved = Math.abs(p.z - this.dragStart.z) > 1e-4;
    if (this.gizmoMode === 'z') {
      this.app.setPin(d.key, d.idx, zM);
    } else {
      this.app.moveCtrl3D(d.key, d.idx, p.x, p.y, this.gizmoMode !== 'xy' && zMoved ? zM : null);
    }
  }

  onDragEnd() {
    if (this.itemDragMode) {
      this.itemDragMode = false;
      this.app.endItemDrag();
      const it = this.findItem(this.app.state.selItem);
      if (it) this.proxy.position.set(it.origin[0], it.origin[1], it.origin[2] * this.zExag + 0.3);
      this.needsFrame = true;
      return;
    }
    this.dragSel = null;
    if (this.xformMode) { this.xformMode = null; this.app.endXform(); this.proxy.rotation.set(0, 0, 0); this.proxy.scale.set(1, 1, 1); }
    else if (this.groupMode) { this.groupMode = false; this.app.endGroupDrag(); } else this.app.endCtrlDrag();
    this.updateHandles();
  }

  /**
   * Planos de sombra (árboles y sets de decoración con «Proyectar sombra»): una malla unida sobre terreno, cerros y
   * calzada. Se rehace sola sin reconstruir el terreno (cambios de sol, tamaño, textura o de los sets).
   */
  buildShadowMesh(info = null) {
    if (this.shadowMesh) { this.extras.remove(this.shadowMesh); this.shadowMesh.geometry.dispose(); this.shadowMesh.material.dispose(); this.shadowMesh = null; }
    const L = this.app.state.layout, E = this.app.state.result, sp = this.app.state.scene;
    this.triCounts.shadows = 0;
    this.shadowInfo = { count: 0, tris: 0, hist: {} };
    if (L && E && sp.shadows) {
      const ground = this.groundCache || null;
      const hasAsset = (id) => !!(this.app.assetById && this.app.assetById(id));
      const sets = (this.app.state.decoSets || []).filter((q) => q.shadow && q.visible !== false);
      const decoRes = sets.length ? decoSetItems(L, E, sp, ground, sets, (set) => this.app.decoPaintWorld(set), hasAsset) : [];
      const cas = shadowCasters(sp, sp.trees ? this.shadowTrees : null, decoRes, (id) => (this.app.assetById ? this.app.assetById(id) : null));
      const T0 = this.terrainData;
      const SH = buildShadows(L, E, sp, ground, cas, { baseAt: T0 ? (x, y) => T0.sample(x, y) : null });
      if (SH.tris) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(SH.positions, 3));
        g.setAttribute('uv', new THREE.BufferAttribute(SH.uvs, 2));
        g.setIndex(new THREE.BufferAttribute(SH.indices, 1));
        const mat = new THREE.MeshBasicMaterial({ map: this.texture(this.app.shadowTexCanvas()), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        const sm = new THREE.Mesh(g, mat);
        this.markExag(sm, (x, y, z, v) => (SH.kinds[v] && T0 ? T0.sample(x, y) : z)); // sobre un cerro: se apoya; en terreno y calzada: se estira como ellos
        const k = this.zExag - 1, a = g.getAttribute('position').array, ex = sm.userData.exag;
        for (let v = 0; v < a.length / 3; v++) a[v * 3 + 2] = ex.base[v * 3 + 2] + ex.shift[v] * k;
        sm.renderOrder = 3;
        sm.userData.noWire = true;
        sm.userData.shadows = true;
        this.extras.add(sm);
        this.shadowMesh = sm;
      }
      this.shadowInfo = { count: SH.count, tris: SH.tris, hist: SH.hist };
      this.triCounts.shadows = SH.tris;
    }
    if (info) { info.shadows = this.shadowInfo.count; info.shadowTris = this.shadowInfo.tris; }
    else { this.updateStats(); if (this.app.onShadowInfo) this.app.onShadowInfo(this.shadowInfo); }
    this.updateSunLight();
    this.needsFrame = true;
  }

  /** La luz direccional sigue al sol de los planos de sombra (modo proyectado con «La luz sigue al sol»). */
  updateSunLight() {
    const sp = this.app.state.scene;
    if (sp && sp.shadows && sp.shadowMode === 'sun' && sp.sunLight !== false) { const v = sunVector(sp); this.sunLight.position.set(v[0] * 1000, v[1] * 1000, v[2] * 1000); }
    else this.sunLight.position.set(400, -300, 800);
    this.needsFrame = true;
  }

  /** Caja (en la vista 3D, con la exageración Z) de lo seleccionado, o null si no hay nada seleccionado. */
  selectionBox() {
    const st = this.app.state, L = st.layout, E = st.result;
    const box = new THREE.Box3(), v = new THREE.Vector3();
    const ex = this.zExag;
    const routeRange = (k, s0, s1) => {
      if (!L || !E || !L.routes[k]) return;
      const r = L.routes[k], z = E.routes[k].z;
      const i0 = Math.floor(s0 / r.ds), i1 = Math.ceil(s1 / r.ds);
      for (let ii = i0; ii <= i1; ii++) { const i = r.closed ? ((ii % r.n) + r.n) % r.n : Math.max(0, Math.min(r.n - 1, ii)); box.expandByPoint(v.set(r.x[i], r.y[i], z[i] * ex)); }
    };
    const meshes = (list) => { for (const m of list) { m.geometry.computeBoundingBox(); const b = m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld); box.union(b); } };
    if (st.tool === 'edit' && st.subObj === 'segment' && this.app.segSelRanges) {
      for (const R of this.app.segSelRanges()) routeRange(R.k, R.s0, R.s1);
    }
    if (box.isEmpty() && st.tool === 'edit' && (st.sel || (st.selSet && st.selSet.idxs.size))) {
      for (const m of this.handleGroup.children) {
        const u = m.userData;
        const on = (st.sel && st.sel.key === u.key && st.sel.idx === u.idx) || (st.selSet && st.selSet.key === u.key && st.selSet.idxs.has(u.idx));
        if (on) box.expandByPoint(m.position);
      }
    }
    if (box.isEmpty() && st.selHill != null) meshes((this.hillMeshes || []).filter((m) => m.userData.hillId === st.selHill));
    if (box.isEmpty() && st.selTunnel != null) meshes((this.tunnelMeshes || []).filter((m) => m.userData.tunnelId === st.selTunnel));
    if (box.isEmpty() && st.selRiver != null) { const list = []; this.extras.traverse((o) => { if (o.isMesh && o.userData.riverId === st.selRiver) list.push(o); }); meshes(list); }
    if (box.isEmpty() && st.selItem && this.findItem) { const it = this.findItem(st.selItem); if (it) { box.expandByPoint(v.set(it.origin[0], it.origin[1], it.origin[2] * ex)); box.expandByScalar(4); } }
    if (box.isEmpty() && st.selAlt != null && L) { const k = L.routes.findIndex((r) => r.kind === 'alt' && r.altIndex === st.selAlt); if (k > 0) routeRange(k, 0, L.routes[k].L); }
    if (box.isEmpty() && st.selBridge != null && L) { const b = (L.routes[0].bridges || []).find((q) => q.idx === st.selBridge); if (b) routeRange(0, b.s0, b.s1); }
    if (box.isEmpty() && st.selCross != null && E) { const c = E.crossings.find((q) => q.id === st.selCross); if (c) routeRange(c.ra, c.sa - 15, c.sa + 15); }
    if (box.isEmpty() && st.ref3d && st.ref3d.sel && this.refOuter) { box.setFromObject(this.refOuter); }
    return box.isEmpty() ? null : box;
  }

  /** Tecla F: encuadra lo seleccionado (sin selección, toda la pista), con una transición corta. */
  focusSelection() {
    const b = this.selectionBox();
    if (!b) { this.fit(); return false; }
    const c = new THREE.Vector3(), sz = new THREE.Vector3();
    b.getCenter(c); b.getSize(sz);
    const radius = Math.max(8, sz.length() / 2);
    const fov = THREE.MathUtils.degToRad(this.camera.fov || 50);
    const dist = Math.max(15, (radius / Math.sin(fov / 2)) * 1.15);
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0, -1, 0.8);
    dir.normalize();
    const t0 = this.controls.target.clone(), p0 = this.camera.position.clone();
    const t1 = c, p1 = c.clone().addScaledVector(dir, dist);
    this.camera.near = Math.min(this.camera.near, Math.max(0.1, dist / 500));
    this.camera.updateProjectionMatrix();
    const start = performance.now(), T = 280;
    const step = () => {
      const u = Math.min(1, (performance.now() - start) / T), e = u * u * (3 - 2 * u);
      this.controls.target.lerpVectors(t0, t1, e);
      this.camera.position.lerpVectors(p0, p1, e);
      this.controls.update();
      this.needsFrame = true;
      if (u < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return true;
  }

  fit() {
    const b = this.bbox;
    if (!b || b.isEmpty()) return;
    const c = new THREE.Vector3();
    b.getCenter(c);
    const size = Math.max(b.max.x - b.min.x, b.max.y - b.min.y);
    this.controls.target.copy(c);
    const r = this.el.getBoundingClientRect();
    const k = r.width > 0 && r.height > 0 && r.width < r.height ? r.height / r.width : 1;
    this.camera.position.set(c.x - size * 0.2, c.y - size * 1.2 * k, c.z + size * 0.85 * k);
    this.camera.near = Math.max(0.5, size / 2000);
    this.camera.far = size * 20;
    this.camera.updateProjectionMatrix();
    this.scene.fog.near = size * 1.5;
    this.scene.fog.far = size * 6;
    this.fitted = true;
    this.needsFrame = true;
  }

  setHover(s) {
    const L = this.app.state.layout, E = this.app.state.result;
    if (s === null || s === undefined || !L || !E) { this.marker.visible = false; this.needsFrame = true; return; }
    const r = L.routes[0];
    const i = Math.min(r.n - 1, Math.round(s / r.ds));
    this.marker.position.set(r.x[i], r.y[i], E.routes[0].z[i] * this.zExag + 2);
    this.marker.visible = true;
    this.needsFrame = true;
  }
}
