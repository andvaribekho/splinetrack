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
    // primera persona: solo capó y tablero a la vista
    for (const part of [u.cabin, u.roof, u.body, u.spoiler, ...u.wheels]) part.visible = !first;
    u.dash.visible = first;
    this.snapCamera = true;
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
    this.tick2d = (this.tick2d || 0) + dt;
    if (this.tick2d > 0.066 && this.app.onGameMove) { this.tick2d = 0; this.app.onGameMove(this.s); }
    const m = new THREE.Matrix4().makeBasis(P.fwd, P.left, P.up);
    this.car.quaternion.setFromRotationMatrix(m);
    this.car.position.copy(P.pos);
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
    // campo de visión
    {
      const fov = Math.max(20, Math.min(120, (this.app.state.game && this.app.state.game.fov) || 62));
      if (Math.abs(this.camera.fov - fov) > 1e-3) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
    }
    if (this.snapCamera) {
      this.camPos.copy(desiredPos); this.camLook.copy(desiredLook); this.camUp.copy(desiredUp);
      this.snapCamera = false;
    } else if (this.mode === 'first') {
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
      ${this.paused ? '<div><b>EN PAUSA</b></div>' : ''}`;
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
