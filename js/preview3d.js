// Vista 3D liviana (three.js) solo para revisar; la geometría final se hace en Blender / 3ds Max.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { TransformControls } from '../vendor/TransformControls.js';
import { edgeSamples } from './export.js';
import { buildTrackMesh, buildTerrain, buildTrees, buildHills, buildStartGate, buildGrass, makeGround, bridgePillars } from './scene.js';
import { pillarGeometry } from './tunnels.js';
import { makeBannerCanvas, makeCheckerCanvas, makeGrassCanvas, makePadCanvas, makeGlowCanvas, makeAsphaltCanvas, makeBridgeCanvas } from './gatetex.js';

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
    const dom = this.renderer.domElement;
    let down = null;
    dom.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY, e.button]; this.tcUsed = !!this.tc.axis; });
    // pintar densidad o cerros directamente sobre el terreno en 3D
    this.paintMode = null;
    this.brushRing = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 48), new THREE.MeshBasicMaterial({ color: 0xe040fb, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide }));
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
      const surf = [...(this.hillMeshes || []), ...(this.terrainMesh ? [this.terrainMesh] : [])];
      if (surf.length) { const h = ray.intersectObjects(surf, false); if (h.length) { pt = h[0].point; pt.hillId = h[0].object.userData.hillId ?? null; } }
      if (!pt) { const h = ray.intersectObjects(this.trackGroup.children, false); if (h.length) pt = h[0].point; }
      if (!pt) { const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); pt = new THREE.Vector3(); if (!ray.ray.intersectPlane(plane, pt)) return null; }
      return pt;
    };
    const moveRing = (pt) => {
      const sc = this.app.state.scene;
      const rm = this.paintMode === 'hill' ? sc.hillBrush : sc.paintBrush;
      this.brushRing.scale.setScalar(rm);
      this.brushRing.position.set(pt.x, pt.y, pt.z + 0.3);
      this.brushRing.material.color.set(this.paintMode === 'hill' ? 0xe0a050 : this.paintMode === 'itemPaint' ? this.app.itemPaintColor() : 0xe040fb);
      this.brushRing.visible = true;
      this.needsFrame = true;
    };
    this.el.addEventListener('pointermove', (e) => {
      if (!this.paintMode || (this.game && this.game.active)) { if (this.brushRing.visible) { this.brushRing.visible = false; this.needsFrame = true; } return; }
      const pt = paintHit(e);
      if (pt) moveRing(pt);
    });
    this.el.addEventListener('pointerdown', (e) => {
      if (!this.paintMode || (e.button !== 0 && e.button !== 2) || e.shiftKey || (this.game && this.game.active)) return;
      e.stopPropagation(); e.preventDefault();
      this.controls.enabled = false;
      const L = this.app.state.layout;
      const ses = { kind: this.paintMode, erase: e.button === 2 || e.altKey || this.app.state.paintErase, last: null };
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
        if (b.sub) this.app.subtractMultiSel(this.app.pickBest(inside)); else this.app.setMultiSel(this.app.pickBest(inside), b.add);
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
    const total = t.track + (sp.terrain ? t.terrain : 0) + (sp.trees ? t.trees : 0) + tun + hills + gate + grass;
    const ot = this.objTris || { hills: new Map(), tunnels: new Map() };
    const st = this.app.state;
    const nH = ot.hills.size, nT = ot.tunnels.size;
    const selIt = st.selItem ? this.findItem(st.selItem) : null;
    const selObj = selIt ? { name: selIt.name, tris: selIt.indices.length / 3 } : st.selHill != null ? ot.hills.get(st.selHill) : st.selTunnel != null ? ot.tunnels.get(st.selTunnel) : null;
    const selTxt = selObj ? `<div class="sel"><b>Seleccionado</b> · ${selObj.name}: ${f(selObj.tris)} triángulos</div>` : '';
    this.statsDiv.innerHTML = `<b>Triángulos</b> · pista ${f(t.track)}${sp.terrain ? ` · terreno ${f(t.terrain)}` : ''}${hills || tun ? ` · cerros + túneles ${f(hills + tun)} (${[hills ? `${nH} cerro${nH === 1 ? '' : 's'}: ${f(hills)}` : '', tun ? `${nT} túnel${nT === 1 ? '' : 'es'}: ${f(tun)}` : ''].filter(Boolean).join(' · ')})` : ''}${sp.trees ? ` · árboles ${f(t.trees)}` : ''}${grass ? ` · hierba ${f(grass)}` : ''}${gate ? ` · pórtico ${f(gate)}` : ''}${t.items ? ` · elementos ${f(t.items)} (${this.itemCount})` : ''} · <b>total ${f(total + (t.items || 0))}</b>${selTxt}`;
  }

  /** Wireframe superpuesto (color y opacidad elegibles) sobre pista, terreno y árboles. */
  applyWireframe() {
    for (const grp of [this.trackGroup, this.extras]) {
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
        m.material.polygonOffsetFactor = 1;
        m.material.polygonOffsetUnits = 1;
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
    const sp = this.app.state.scene;
    const tm = buildTrackMesh(L, E, { ...sp, skirts: sp.terrain && sp.skirts });
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
      const ovMat = (map) => new THREE.MeshStandardMaterial({ map, side: THREE.DoubleSide, roughness: 0.9, metalness: 0, transparent: op < 0.999, opacity: op, depthWrite: op >= 0.999, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      // grupos: pista (textura de la pista) y tableros de puente (textura propia)
      g.clearGroups();
      g.addGroup(0, tm.trackCount, 0);
      if (tm.indices.length > tm.trackCount) g.addGroup(tm.trackCount, tm.indices.length - tm.trackCount, 1);
      const ov = new THREE.Mesh(g, [ovMat(tex), ovMat(btex)]);
      ov.userData.texOverlay = true;
      this.trackGroup.add(ov);
    }
    this.triCounts.track = tm.indices.length / 3;
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
        this.group.add(new THREE.Line(lg, new THREE.LineBasicMaterial({ color: selA ? 0xffe066 : r.kind === 'alt' ? 0x4fb3ff : 0xf5f5f5 })));
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
          const ln = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xffe066, linewidth: 3, depthTest: false }));
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
      for (const off of [-Rw * 1.25, Rw * 1.25]) {
        const i = ((Math.round((upS + off) / r.ds) % r.n) + r.n) % r.n;
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
    for (const pl of bridgePillars(L, E, T)) {
      const zTop = pl.zTop * ex, zBot = pl.zBot * ex, h = zTop - zBot;
      if (h <= 0.5) continue;
      const p = new THREE.Mesh(new THREE.BoxGeometry(pl.size, pl.size, h), new THREE.MeshStandardMaterial({ color: 0x7a818f, roughness: 0.9 }));
      p.position.set(pl.x, pl.y, zBot + h / 2);
      p.rotation.z = pl.angle;
      this.pillars.add(p);
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
    this.needsFrame = true;
  }

  buildExtras() {
    const L = this.app.state.layout, E = this.app.state.result;
    const sp = this.app.state.scene;
    this.disposeGroup(this.extras);
    // la exageración Z se aplica por vértice (applyExag): terreno y pista se estiran; cerros, túneles, árboles, hierba y pórtico no
    this.extras.scale.set(1, 1, 1);
    this.terrainData = null;
    this.terrainMesh = null;
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
    if (sp.terrain || (hillsW && hillsW.length)) {
      const T = buildTerrain(L, E, sp, this.app.paintWorld ? this.app.paintWorld() : null);
      this.terrainData = T;
      if (sp.terrain) {
        const m = tex
          ? new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0 })
          : new THREE.MeshStandardMaterial({ color: 0x4f7d3a, roughness: 1, metalness: 0 });
        const tmesh = new THREE.Mesh(mkGeo(T), m);
        tmesh.userData.terrain = true;
        this.markExag(tmesh, (x, y, z) => z);
        this.terrainMesh = tmesh;
        this.extras.add(tmesh);
        info.terrainTris = T.tris;
        info.terrainCell = T.cell;
        info.terrainCellFine = T.cellFine;
      }
      // cerros: una malla por cerro (seleccionable)
      const HS = buildHills(L, E, sp, T, hillsW);
      this.hillData = HS;
      for (const h of HS.hills) {
        const m = tex
          ? new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0, color: 0xd8c8b0, side: THREE.DoubleSide })
          : new THREE.MeshStandardMaterial({ color: 0x6f7d45, roughness: 1, metalness: 0, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(mkGeo(h), m);
        mesh.userData.hillId = h.id;
        this.markExag(mesh, (x, y) => T.sample(x, y)); // el cerro se apoya en el terreno exagerado sin estirarse
        this.hillMeshes.push(mesh);
        this.extras.add(mesh);
        info.hills.push({ id: h.id, name: h.name, tris: h.tris, cell: h.cell });
        this.objTris.hills.set(h.id, { name: h.name, tris: h.tris });
        info.hillTris += h.tris;
      }
      this.setHillSelection(this.app.state.selHill, false);
      // túneles: paredes, techo, veredas y bocas como mallas separadas
      if (HS.tunnelGeo.length) {
        const natural = sp.tunnelType === 'natural';
        const wallMat = natural
          ? new THREE.MeshStandardMaterial({ color: 0x6f6259, roughness: 1, flatShading: true, side: THREE.DoubleSide })
          : new THREE.MeshStandardMaterial({ color: 0x9a9da3, roughness: 0.9, side: THREE.DoubleSide });
        const ceilMat = natural
          ? new THREE.MeshStandardMaterial({ color: 0x5d5249, roughness: 1, flatShading: true, side: THREE.DoubleSide })
          : new THREE.MeshStandardMaterial({ color: 0x7e8288, roughness: 0.9, side: THREE.DoubleSide });
        const walkMat = new THREE.MeshStandardMaterial({ color: 0x8a8a84, roughness: 0.95, side: THREE.DoubleSide });
        const portalMat = new THREE.MeshStandardMaterial({ color: natural ? 0x857566 : 0xb9bcc2, roughness: 0.85, side: THREE.DoubleSide, flatShading: natural });
        const rockMat = new THREE.MeshStandardMaterial({ color: 0x5c5049, roughness: 1, flatShading: true, side: THREE.DoubleSide });
        const pillarMat = new THREE.MeshStandardMaterial({ color: 0x8d9097, roughness: 0.85 });
        const roadZ = this.roadBaseFn(L, E);
        for (const t of HS.tunnelGeo) {
          // materiales propios por túnel (para resaltarlo al seleccionarlo)
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
          info.tunnels.push({ id: t.id, name: t.name, len: t.len, pillars: t.pillars.length, tris });
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
    if (sp.grass) {
      const GR = buildGrass(L, E, sp, ground);
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
        this.extras.add(gm);
      }
      info.grass = GR.count;
      info.grassTris = GR.tris;
    }
    if (sp.trees) {
      const TR = buildTrees(L, E, sp, ground);
      if (TR.count) {
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
        this.extras.add(tm);
      }
      info.trees = TR.count;
      info.treeTris = TR.indices.length / 3;
      info.treesOnHills = TR.trees.filter((t) => t.where !== 'terrain').length;
    }
    this.applyExag();
    info.ms = performance.now() - t0;
    if (this.grid) this.grid.visible = !sp.terrain;
    this.buildPillars();
    this.needsFrame = true;
    this.triCounts.terrain = info.terrainTris;
    this.triCounts.tunnels = info.tunnelTris || 0;
    this.triCounts.hills = info.hillTris || 0;
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

  /** Resalta el cerro seleccionado (sin reconstruir). */
  setHillSelection(id, frame = true) {
    const st = this.app.state;
    const glow = (m, sel) => { m.material.emissive.set(sel ? 0x6b5210 : 0x000000); m.material.emissiveIntensity = sel ? 0.9 : 0; };
    for (const m of this.hillMeshes || []) glow(m, st.selHill != null && m.userData.hillId === st.selHill);
    for (const m of this.tunnelMeshes || []) glow(m, st.selTunnel != null && m.userData.tunnelId === st.selTunnel);
    if (this.statsDiv) this.updateStats();
    if (frame) this.needsFrame = true;
  }

  /** Clic con Navegar: selecciona el cerro bajo el cursor (o deselecciona). */
  pickHill(e) {

    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const objs = [...this.itemsGroup.children, ...this.hillMeshes, ...(this.tunnelMeshes || []), ...(this.terrainMesh ? [this.terrainMesh] : []), ...this.trackGroup.children];
    const h = ray.intersectObjects(objs, false);
    const ud = h.length ? h[0].object.userData : {};
    const onTrack = h.length && this.trackGroup.children.includes(h[0].object);
    const altHit = onTrack ? this.app.altAtWorld(h[0].point.x, h[0].point.y) : null;
    if (altHit == null && !ud.item && this.app.state.selAlt != null) this.app.selectAlt(null);
    if (this.app.state.selBridge != null && !(onTrack && this.app.bridgeAtWorld(h[0].point.x, h[0].point.y) === this.app.state.selBridge)) this.app.selectBridge(null);
    if (h.length && h[0].object === this.terrainMesh && this.app.focusPanel) this.app.focusPanel('terrain'); // clic en el terreno: sus parámetros
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
      if (isSel) { mat.emissive = new THREE.Color(0x8a6d00); mat.emissiveIntensity = 1; }
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
  }

  setGizmoMode(m) {
    this.gizmoMode = m;
    this.tc.showX = m !== 'z';
    this.tc.showY = m !== 'z';
    this.tc.showZ = m !== 'xy';
    this.needsFrame = true;
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
    const ex = this.zExag;
    const rad = this.handleRadius();
    const geo = new THREE.SphereGeometry(rad, 14, 10);
    let selPt = null;
    const ms = st.selSet && st.selSet.idxs.size > 0 ? st.selSet : null;
    const cen = new THREE.Vector3();
    let cenN = 0;
    for (const pt of this.app.ctrlPoints()) {
      const inMulti = ms && ms.key === pt.key && ms.idxs.has(pt.idx);
      const isSel = (st.sel && st.sel.key === pt.key && st.sel.idx === pt.idx) || inMulti;
      const color = isSel ? 0xffe066 : pt.pin !== null ? 0xf2a93b : pt.k > 0 ? 0x9fd4ff : 0xffffff;
      const m = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }));
      const z = pt.pin !== null ? pt.pin : pt.z;
      m.position.set(pt.X, pt.Y, z * ex + rad * 0.6);
      if (isSel) m.scale.setScalar(1.5);
      m.renderOrder = 10;
      m.userData = { key: pt.key, idx: pt.idx };
      this.handleGroup.add(m);
      if (inMulti) { cen.add(m.position); cenN++; }
      else if (isSel) selPt = m.position.clone();
    }
    if (cenN > 0) selPt = cen.multiplyScalar(1 / cenN);
    geo.dispose();
    if (selPt) {
      if (!this.tc.dragging) {
        this.proxy.position.copy(selPt);
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
    if (this.groupMode) { this.groupMode = false; this.app.endGroupDrag(); } else this.app.endCtrlDrag();
    this.updateHandles();
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
