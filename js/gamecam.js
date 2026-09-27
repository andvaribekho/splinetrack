// Cámara de juego: un auto recorre la ruta principal solo, siguiendo curvas, pendientes y peralte.
// Cámara en tercera persona (baja y detrás, al estilo arcade) o en primera persona con el capó a la vista.
import * as THREE from 'three';
import { evalAt } from './geometry.js';

function buildCar() {
  const car = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0xd81f26, roughness: 0.35, metalness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x16181d, roughness: 0.6 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x223246, roughness: 0.15, metalness: 0.4 });
  const light = new THREE.MeshStandardMaterial({ color: 0xfff3c4, emissive: 0xffe9a0, emissiveIntensity: 0.6 });
  const box = (sx, sy, sz, mat, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    m.position.set(x, y, z);
    car.add(m);
    return m;
  };
  // +X adelante, +Y izquierda, +Z arriba; origen en el suelo, al centro del auto
  const body = box(4.3, 1.86, 0.5, paint, 0, 0, 0.62);
  const hood = box(1.6, 1.8, 0.1, paint, 1.35, 0, 0.9); // capó (visible en primera persona)
  const cabin = box(2.0, 1.6, 0.52, glass, -0.35, 0, 1.13);
  const roof = box(1.7, 1.5, 0.06, paint, -0.4, 0, 1.42);
  box(0.12, 1.5, 0.08, dark, 2.12, 0, 0.62); // parachoques
  box(0.06, 0.34, 0.12, light, 2.16, 0.62, 0.72);
  box(0.06, 0.34, 0.12, light, 2.16, -0.62, 0.72);
  const spoiler = box(0.4, 1.7, 0.08, dark, -2.0, 0, 1.02); // alerón
  const dash = box(0.55, 1.75, 0.34, dark, 0.3, 0, 0.8); // tablero (solo primera persona)
  dash.visible = false;
  const wheels = [];
  for (const [x, y] of [[1.35, 0.92], [1.35, -0.92], [-1.35, 0.92], [-1.35, -0.92]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.28, 16), dark);
    w.position.set(x, y, 0.36);
    car.add(w);
    wheels.push(w);
  }
  car.userData = { body, hood, cabin, roof, wheels, spoiler, dash };
  return car;
}

export class GameCam {
  constructor(preview, app) {
    this.pv = preview;
    this.app = app;
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.05, 20000);
    this.camera.up.set(0, 0, 1);
    this.car = buildCar();
    this.car.visible = false;
    preview.scene.add(this.car);
    this.active = false;
    this.paused = false;
    this.mode = 'third';
    this.s = 0;
    this.lapTime = 0;
    this.lastLap = null;
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.camUp = new THREE.Vector3(0, 0, 1);
    this.hud = document.createElement('div');
    this.hud.className = 'game-hud';
    this.hud.hidden = true;
    preview.el.appendChild(this.hud);
    this.wheelSpin = 0;
    // órbita: arrastrar con clic izquierdo gira la cámara alrededor del auto; clic derecho la restablece
    this.orbit = { yaw: 0, pitch: 0, on: false };
    const el = preview.el;
    el.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      if (e.button === 2) { e.preventDefault(); e.stopPropagation(); this.resetOrbit(); return; }
      if (e.button !== 0 || e.target.closest?.('.game-hud')) return;
      e.preventDefault(); e.stopPropagation();
      let lx = e.clientX, ly = e.clientY;
      this.orbitDrag = true;
      el.style.cursor = 'grabbing';
      const move = (ev) => {
        const dx = ev.clientX - lx, dy = ev.clientY - ly;
        lx = ev.clientX; ly = ev.clientY;
        if (!dx && !dy) return;
        this.orbit.on = true;
        this.orbit.yaw -= dx * 0.008;
        this.orbit.pitch = Math.max(-1.2, Math.min(1.35, this.orbit.pitch + dy * 0.006));
      };
      const up = () => { this.orbitDrag = false; el.style.cursor = ''; window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); };
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
    }, true);
    el.addEventListener('contextmenu', (e) => { if (this.active) e.preventDefault(); }, true);
    // rueda: acerca o aleja la cámara (cambia «Distancia» del ajuste de cámara); en primera persona no hace nada
    el.addEventListener('wheel', (e) => {
      if (!this.active) return;
      e.preventDefault(); e.stopPropagation();
      if (this.mode === 'first') return;
      const G = this.app.state.game;
      const d = Math.max(1, Math.min(40, (G.camDist ?? 8.5) * Math.exp(e.deltaY * 0.0012)));
      G.camDist = Math.round(d * 2) / 2;
      if (this.app.syncGameCam) this.app.syncGameCam();
    }, { passive: false, capture: true });
  }

  /** Vuelve a la cámara normal (detrás del auto o desde el asiento), con transición suave. */
  /** Ángulo de derrape actual (radianes; + = la nariz apunta a la izquierda). Para pruebas. */
  driftAngle() { return this.driftYaw || 0; }

  resetOrbit() { this.orbit.yaw = 0; this.orbit.pitch = 0; this.orbit.on = false; }

  /** Brillo del auto (×, 1 = normal): multiplica el color de sus materiales (propios, no los del modelo cargado). */
  applyBrightness(b = 1) {
    b = Math.max(0.1, Math.min(4, +b || 1));
    this.car.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m || !m.color) continue;
        if (!m.userData.baseColor) m.userData.baseColor = m.color.clone();
        m.color.copy(m.userData.baseColor).multiplyScalar(b);
        if (m.emissive && m.emissiveIntensity != null) { if (m.userData.baseEmi == null) m.userData.baseEmi = m.emissiveIntensity; m.emissiveIntensity = m.userData.baseEmi * b; }
      }
    });
    this.pv.needsFrame = true;
  }

  resize(aspect) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }

  start() {
    const L = this.app.state.layout;
    if (!L || !this.app.state.result) return false;
    this.active = true;
    this.app.state.gameActive = true;
    this.paused = false;
    this.car.visible = true;
    this.savedExag = this.pv.zExag;
    this.pv.zExag = 1; // escala real mientras se maneja
    this.pv.update(false, true);
    const r = this.pv.el.getBoundingClientRect();
    this.resize(r.width / Math.max(1, r.height));
    this.s = this.app.state.hover != null ? this.app.state.hover : 0;
    this.lapTime = 0;
    this.applySky();
    this.hud.hidden = false;
    this.pv.handleGroup.visible = false;
    this.pv.tc.getHelper().visible = false;
    this.pv.statsDiv.hidden = true;
    this.snapCamera = true;
    this.resetOrbit();
    this.pv.controls.enabled = false; // la cámara del editor no se mueve mientras se orbita el auto
    this.setMode(this.mode);
    return true;
  }

  stop() {
    this.active = false;
    this.app.state.gameActive = false;
    if (this.app.onGameMove) setTimeout(() => this.app.onGameMove(null), 0);
    this.car.visible = false;
    this.hud.hidden = true;
    this.pv.scene.background = null;
    this.pv.scene.fog.color.set(0x0e1117);
    this.pv.renderer.setClearColor(0x0e1117);
    this.pv.zExag = this.savedExag ?? this.pv.zExag;
    this.pv.handleGroup.visible = true;
    this.pv.tc.getHelper().visible = true;
    this.pv.statsDiv.hidden = false;
    this.pv.triggerGroup.visible = true;
    this.pv.controls.enabled = true;
    this.pv.update(false, true);
    this.pv.needsFrame = true;
  }

  applySky() {
    const canvas = this.app.state.skyTex;
    if (!canvas) return;
    if (!this.skyTexture || this.skyCanvas !== canvas) {
      this.skyTexture?.dispose();
      this.skyTexture = new THREE.CanvasTexture(canvas);
      this.skyTexture.mapping = THREE.EquirectangularReflectionMapping;
      this.skyTexture.colorSpace = THREE.SRGBColorSpace;
      this.skyCanvas = canvas;
      // color de niebla = color del horizonte del cielo
      const c = canvas.getContext('2d').getImageData(0, Math.floor(canvas.height * 0.5) - 2, 1, 1).data;
      this.horizon = new THREE.Color(`rgb(${c[0]},${c[1]},${c[2]})`);
    }
    if (this.active) {
      this.pv.scene.background = this.skyTexture;
      // el panorama equirectangular asume Y arriba; la escena usa Z arriba
      this.pv.scene.backgroundRotation.set(Math.PI / 2, 0, 0);
      this.pv.scene.fog.color.copy(this.horizon);
    }
  }

  setMode(m) {
    this.mode = m;
    const u = this.car.userData;
    const first = m === 'first';
    const own = !!this.customCar;
    // auto 3D propio: se ocultan las piezas del auto por defecto; en primera persona no se ve el auto
    for (const c of this.car.children) if (c !== this.customCar) c.visible = !own;
    if (own) this.customCar.visible = !first;
    else {
      // primera persona: solo capó y tablero a la vista
      for (const part of [u.cabin, u.roof, u.body, u.spoiler, ...u.wheels]) part.visible = !first;
      u.dash.visible = first;
    }
    this.snapCamera = true;
  }

  /** Caja (en metros) del auto por defecto: el auto 3D cargado se escala para caber en ella. */
  defaultBox() {
    if (!this._defBox) { const c = buildCar(); c.userData.dash.visible = true; this._defBox = new THREE.Box3().setFromObject(c); }
    return this._defBox;
  }

  /**
   * Auto 3D propio (asset de loadAsset, o null = el auto por defecto). Se orienta con su lado más largo hacia adelante,
   * se escala (uniforme) para caber en la caja del auto por defecto, se centra y se apoya en el suelo.
   * adj = {dz (m), sx, sy, sz (×), rot (grados, giro sobre Z)}: ajuste manual encima del automático.
   */
  setCarModel(A, adj = {}) {
    if (this.customCar) {
      this.customCar.traverse((o) => { if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose(); });
      this.car.remove(this.customCar); this.customCar = null;
    }
    this.carInfo = null;
    if (A) {
      const inner = new THREE.Group();
      // materiales propios (copias): el brillo se ajusta sin tocar los del modelo cargado
      const cl = (mt) => (Array.isArray(mt) ? mt.map((x) => x.clone()) : mt.clone());
      for (const part of A.parts) { const m = new THREE.Mesh(part.geometry, cl(part.material)); part.matrix.decompose(m.position, m.quaternion, m.scale); inner.add(m); }
      const s0 = new THREE.Box3().setFromObject(inner).getSize(new THREE.Vector3());
      const autoRot = s0.y > s0.x * 1.05 ? Math.PI / 2 : 0; // el lado más largo va a lo largo (+X adelante)
      const rotG = new THREE.Group();
      rotG.add(inner);
      rotG.rotation.z = autoRot + ((adj.rot || 0) * Math.PI) / 180;
      rotG.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(rotG), sz = bb.getSize(new THREE.Vector3()), c = bb.getCenter(new THREE.Vector3());
      const D = this.defaultBox(), ds = D.getSize(new THREE.Vector3()), dc = D.getCenter(new THREE.Vector3());
      const k = Math.min(ds.x / Math.max(1e-6, sz.x), ds.y / Math.max(1e-6, sz.y), ds.z / Math.max(1e-6, sz.z));
      const shift = new THREE.Group();
      shift.add(rotG);
      shift.position.set(-c.x, -c.y, -bb.min.z);
      const outer = new THREE.Group();
      outer.add(shift);
      outer.scale.set(k * (adj.sx || 1), k * (adj.sy || 1), k * (adj.sz || 1));
      outer.position.set(dc.x, dc.y, adj.dz || 0);
      outer.userData.defaultPart = false;
      this.customCar = outer;
      this.car.add(outer);
      this.carInfo = { name: A.name, k, size: [sz.x * k, sz.y * k, sz.z * k], tris: A.tris };
    }
    this.applyBrightness(adj.bri ?? 1);
    this.setMode(this.mode);
    this.pv.needsFrame = true;
  }

  onSceneRebuilt() { /* la pista se reconstruyó: nada que hacer, la pose se recalcula cada cuadro */ }

  pose(s) {
    const L = this.app.state.layout, E = this.app.state.result;
    const r = L.routes[0];
    const e = E.routes[0];
    const at = (sv) => {
      const p = evalAt(r, sv);
      const j = r.closed ? (p.i + 1) % r.n : Math.min(r.n - 1, p.i + 1);
      const z = e.z[p.i] + (e.z[j] - e.z[p.i]) * p.t;
      const roll = e.roll[p.i] + (e.roll[j] - e.roll[p.i]) * p.t;
      return { v: new THREE.Vector3(p.x, p.y, z), roll };
    };
    const c = at(s), a = at(s - 2.5), b = at(s + 2.5);
    const fwd = b.v.clone().sub(a.v).normalize();
    const left0 = new THREE.Vector3(0, 0, 1).cross(fwd).normalize();
    const up0 = fwd.clone().cross(left0).normalize();
    const cr = Math.cos(c.roll), sr = Math.sin(c.roll);
    const left = left0.clone().multiplyScalar(cr).addScaledVector(up0, sr);
    const up = fwd.clone().cross(left).normalize();
    return { pos: c.v, fwd, left, up, roll: c.roll };
  }

  update(dt) {
    const L = this.app.state.layout, E = this.app.state.result;
    if (!L || !E) return;
    const r = L.routes[0];
    const sp0 = this.app.state.game.speed;
    const v = (sp0 === undefined || sp0 === null ? 120 : sp0) / 3.6; // negativa = marcha atrás
    if (!this.paused && !this.dragging) { // mientras se arrastra el auto en el mapa, no avanza solo
      this.s += v * dt;
      this.lapTime += dt;
      if (this.s >= r.L) {
        this.s -= r.L;
        this.lastLap = this.lapTime;
        this.lapTime = 0;
        if (!r.closed) this.snapCamera = true;
      } else if (this.s < 0) {
        this.s += r.L;
        this.lastLap = this.lapTime;
        this.lapTime = 0;
        if (!r.closed) this.snapCamera = true;
      }
      this.wheelSpin += (v * dt) / 0.36;
    }
    const P = this.pose(this.s);
    const G0 = this.app.state.game || {};
    this.pv.triggerGroup.visible = G0.hideTriggers === false; // «Ocultar triggers»: nada, ni las cajas semitransparentes
    this.tick2d = (this.tick2d || 0) + dt;
    if (this.tick2d > 0.066 && this.app.onGameMove) { this.tick2d = 0; this.app.onGameMove(this.s); }
    const m = new THREE.Matrix4().makeBasis(P.fwd, P.left, P.up);
    this.car.quaternion.setFromRotationMatrix(m);
    this.car.position.copy(P.pos);
    // derrape (solo visual): la cola se abre hacia afuera de la curva según la aceleración lateral v²·curvatura
    {
      const G = this.app.state.game || {};
      const amt = Math.max(0, Math.min(100, G.drift ?? 50)) / 100;
      const a0 = this.pose(this.s - 3).fwd, a1 = this.pose(this.s + 3).fwd;
      const turn = Math.atan2(a0.x * a1.y - a0.y * a1.x, a0.x * a1.x + a0.y * a1.y); // + = a la izquierda
      const k = turn / 6; // curvatura (1/m)
      const lat = v * v * k; // aceleración lateral (m/s²)
      const target = amt ? Math.max(-0.65, Math.min(0.65, Math.sign(lat) * Math.pow(Math.abs(lat) / 9.81, 0.8) * 0.25 * amt * 2)) : 0;
      const kk = 1 - Math.exp(-dt * (Math.abs(target) > Math.abs(this.driftYaw || 0) ? 3 : 2));
      this.driftYaw = (this.driftYaw || 0) + (target - (this.driftYaw || 0)) * (this.paused ? 0 : kk);
      if (Math.abs(this.driftYaw) > 1e-4) {
        this.car.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(P.up, this.driftYaw));
        this.car.position.addScaledVector(P.left, -Math.sign(this.driftYaw) * Math.min(0.8, Math.abs(this.driftYaw) * 1.2)); // se abre un poco hacia afuera
      }
    }
    for (const w of this.car.userData.wheels) w.rotation.y = this.wheelSpin;
    // cámara
    let desiredPos, desiredLook, desiredUp;
    if (this.mode === 'first') {
      desiredPos = P.pos.clone().addScaledVector(P.up, 1.3).addScaledVector(P.fwd, -0.45);
      desiredLook = P.pos.clone().addScaledVector(P.fwd, 25).addScaledVector(P.up, 0.9);
      desiredUp = P.up.clone();
    } else {
      // detrás y un poco arriba, mirando por delante del auto
      const G = this.app.state.game || {};
      const dist = Math.max(0.5, G.camDist ?? 8.5), hgt = G.camHeight ?? 2.9;
      const ahead = this.pose(this.s + 12);
      desiredPos = P.pos.clone().addScaledVector(P.fwd, -dist).addScaledVector(P.up, hgt);
      desiredLook = ahead.pos.clone().addScaledVector(ahead.up, 1.3);
      desiredUp = new THREE.Vector3(0, 0, 1).lerp(P.up, 0.55).normalize();
    }
    // inclinación: baja (o sube) la mirada tantos grados
    {
      const tilt = ((this.app.state.game && this.app.state.game.camTilt) || 0) * Math.PI / 180;
      if (Math.abs(tilt) > 1e-4) {
        const d = desiredLook.clone().sub(desiredPos);
        const right = d.clone().cross(desiredUp).normalize();
        d.applyAxisAngle(right, -tilt);
        desiredLook = desiredPos.clone().add(d);
      }
    }
    // órbita (arrastrar con clic izquierdo): gira alrededor del auto; en primera persona, mira alrededor
    const orb = this.orbit.on;
    if (orb) {
      const yaw = this.orbit.yaw, pitch = this.orbit.pitch;
      if (this.mode === 'first') {
        const d = desiredLook.clone().sub(desiredPos);
        d.applyAxisAngle(P.up, yaw);
        d.applyAxisAngle(d.clone().cross(P.up).normalize(), -pitch);
        desiredLook = desiredPos.clone().add(d);
      } else {
        const G = this.app.state.game || {};
        const dist = Math.max(0.5, G.camDist ?? 8.5), hgt = G.camHeight ?? 2.9;
        const target = P.pos.clone().addScaledVector(P.up, 1.0);
        const R = Math.hypot(dist, hgt), el0 = Math.atan2(hgt, dist);
        const el = Math.max(-0.15, Math.min(1.5, el0 + pitch));
        const Z = new THREE.Vector3(0, 0, 1);
        const back = P.fwd.clone().multiplyScalar(-1).applyAxisAngle(Z, yaw);
        back.addScaledVector(Z, -back.dot(Z)).normalize();
        desiredPos = target.clone().addScaledVector(back, R * Math.cos(el)).addScaledVector(Z, R * Math.sin(el));
        desiredLook = target;
        desiredUp = Z.clone();
      }
    }
    // campo de visión
    {
      const fov = Math.max(20, Math.min(120, (this.app.state.game && this.app.state.game.fov) || 62));
      if (Math.abs(this.camera.fov - fov) > 1e-3) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
    }
    if (this.snapCamera) {
      this.camPos.copy(desiredPos); this.camLook.copy(desiredLook); this.camUp.copy(desiredUp);
      this.snapCamera = false;
    } else if (this.mode === 'first' || (orb && this.orbitDrag)) {
      this.camPos.copy(desiredPos); this.camLook.copy(desiredLook); this.camUp.copy(desiredUp);
    } else {
      const k = 1 - Math.exp(-dt * 7);
      this.camPos.lerp(desiredPos, k);
      this.camLook.lerp(desiredLook, 1 - Math.exp(-dt * 10));
      this.camUp.lerp(desiredUp, k).normalize();
    }
    this.camera.position.copy(this.camPos);
    this.camera.up.copy(this.camUp);
    this.camera.lookAt(this.camLook);
    // HUD
    const i = Math.min(r.n - 1, Math.floor(this.s / r.ds));
    const grade = E.routes[0].grade ? E.routes[0].grade[i] : 0;
    const bank = (-E.routes[0].roll[i] * 180) / Math.PI;
    const fmtT = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
    this.hud.innerHTML = `<div class="big">${Math.round(v * 3.6)} km/h</div>
      <div>${this.s.toFixed(0)} / ${r.L.toFixed(0)} m</div>
      <div>Pendiente ${(grade * 100).toFixed(1)} %</div>
      <div>Peralte ${bank.toFixed(1)}°</div>
      <div>Altura ${E.routes[0].z[i].toFixed(1)} m</div>
      <div>Vuelta ${fmtT(this.lapTime)}${this.lastLap ? ` · última ${fmtT(this.lastLap)}` : ''}</div>
      ${this.paused ? '<div><b>EN PAUSA</b></div>' : ''}
      <div class="hint">${orb ? 'Clic derecho: cámara normal' : 'Arrastra: orbitar el auto'}</div>`;
  }
}

/** Cielo de día por defecto: degradado azul con nubes, en formato equirectangular (2:1) sin costura. */
export function makeDefaultSky(doc = document) {
  const W = 2048, H = 1024;
  const cv = doc.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#1f5fb8');
  g.addColorStop(0.3, '#3f86d6');
  g.addColorStop(0.49, '#b9dbf6');
  g.addColorStop(0.5, '#d4e8f8');
  g.addColorStop(0.56, '#a9b8c2');
  g.addColorStop(1, '#6f7f76');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // nubes: grupos de manchas suaves, más achatadas cerca del horizonte
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const blob = (x, y, rx, ry, a) => {
    for (const dx of [-W, 0, W]) {
      const gr = ctx.createRadialGradient(x + dx, y, 0, x + dx, y, rx);
      gr.addColorStop(0, `rgba(255,255,255,${a})`);
      gr.addColorStop(0.6, `rgba(255,255,255,${a * 0.55})`);
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.save();
      ctx.translate(x + dx, y);
      ctx.scale(1, ry / rx);
      ctx.translate(-(x + dx), -y);
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.arc(x + dx, y, rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  };
  for (let c = 0; c < 38; c++) {
    const cy = 170 + rnd() * 320; // entre bastante arriba y el horizonte
    const flat = 0.25 + 0.5 * (1 - (cy - 170) / 320); // cerca del horizonte, más planas
    const cx = rnd() * W;
    const size = 40 + rnd() * 110 * (0.5 + flat);
    const n = 6 + Math.floor(rnd() * 10);
    for (let k = 0; k < n; k++) {
      blob(cx + (rnd() - 0.5) * size * 2.6, cy + (rnd() - 0.5) * size * 0.5 * flat, size * (0.5 + rnd() * 0.7), size * (0.5 + rnd() * 0.7) * flat, 0.35 + rnd() * 0.35);
    }
  }
  return cv;
}
