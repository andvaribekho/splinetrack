// Editor 2D: muestra la imagen, el trazado coloreado por altura, los cruces y permite dibujar.
import { edgeParams } from './tunnels.js';
import { taubinSmooth, resampleUniform } from './geometry.js';

/** Afín que lleva el triángulo src [[u,v]×3] al triángulo dst [[x,y]×3]: [a, b, c, d, e, f] para setTransform. */
function affine3(src, dst) {
  const [[u0, v0], [u1, v1], [u2, v2]] = src, [[x0, y0], [x1, y1], [x2, y2]] = dst;
  const du1 = u1 - u0, dv1 = v1 - v0, du2 = u2 - u0, dv2 = v2 - v0;
  const det = du1 * dv2 - du2 * dv1;
  if (Math.abs(det) < 1e-9) return null;
  const dx1 = x1 - x0, dy1 = y1 - y0, dx2 = x2 - x0, dy2 = y2 - y0;
  const a = (dx1 * dv2 - dx2 * dv1) / det, c = (dx2 * du1 - dx1 * du2) / det;
  const b = (dy1 * dv2 - dy2 * dv1) / det, d = (dy2 * du1 - dy1 * du2) / det;
  return [a, b, c, d, x0 - a * u0 - c * v0, y0 - b * u0 - d * v0];
}

export function zColor(t) {
  // azul -> verde azulado -> amarillo -> naranja
  const stops = [
    [0, [58, 110, 220]],
    [0.35, [40, 180, 170]],
    [0.65, [220, 210, 90]],
    [1, [245, 140, 50]],
  ];
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, a] = stops[i - 1], [t1, b] = stops[i];
      const u = (t - t0) / (t1 - t0);
      return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * u)).join(',')})`;
    }
  }
  return 'rgb(245,140,50)';
}

export class Editor2D {
  constructor(canvas, app) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.app = app;
    this.view = { ox: 0, oy: 0, zoom: 1 };
    this.stroke = null;
    this.dragFlat = null;
    this.panning = null;
    this.hoverS = null;
    this.markers = []; // posiciones en pantalla de los marcadores de cruce
    this.dpr = window.devicePixelRatio || 1;
    this.bind();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.cv.width = Math.max(1, Math.round(r.width * this.dpr));
    this.cv.height = Math.max(1, Math.round(r.height * this.dpr));
    this.draw();
  }

  toScreen(x, y) { return [x * this.view.zoom + this.view.ox, y * this.view.zoom + this.view.oy]; }
  toLayout(sx, sy) { return [(sx - this.view.ox) / this.view.zoom, (sy - this.view.oy) / this.view.zoom]; }

  eventPos(e) {
    const r = this.cv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  fit() {
    const b = this.app.contentBounds();
    const r = this.cv.getBoundingClientRect();
    if (!b || r.width < 10) { this.view = { ox: 0, oy: 0, zoom: 1 }; this.draw(); return; }
    const pad = 30;
    const zoom = Math.min((r.width - pad * 2) / Math.max(b.w, 1), (r.height - pad * 2) / Math.max(b.h, 1));
    this.view.zoom = zoom;
    this.view.ox = r.width / 2 - (b.x + b.w / 2) * zoom;
    this.view.oy = r.height / 2 - (b.y + b.h / 2) * zoom;
    this.draw();
  }

  bind() {
    const cv = this.cv;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [sx, sy] = this.eventPos(e);
      const f = Math.exp(-e.deltaY * 0.0015);
      const [lx, ly] = this.toLayout(sx, sy);
      this.view.zoom = Math.max(0.02, Math.min(50, this.view.zoom * f));
      this.view.ox = sx - lx * this.view.zoom;
      this.view.oy = sy - ly * this.view.zoom;
      this.draw();
    }, { passive: false });

    cv.addEventListener('pointerdown', (e) => {
      const [sx, sy] = this.eventPos(e);
      cv.setPointerCapture(e.pointerId);
      const tool = this.app.state.tool;
      // auto de la cámara de juego: se arrastra a lo largo de la pista
      if (e.button === 0 && this.hitCar(sx, sy)) { this.carDrag = true; this.app.beginCarDrag(); cv.style.cursor = 'grabbing'; return; }
      if ((tool === 'paint' || tool === 'hill' || tool === 'itemPaint' || tool === 'sculpt' || tool === 'river') && (e.button === 0 || e.button === 2)) {
        this.painting = { kind: tool, erase: e.button === 2 || e.altKey || (tool !== 'sculpt' && this.app.state.paintErase), ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, last: null };
        const p0 = this.toLayout(sx, sy);
        this.app.beginPaint(tool, this.painting, p0);
        this.addPaint(p0);
        return;
      }
      if (tool === 'ref' && e.button === 0 && this.app.state.ref) {
        const r = this.app.state.ref;
        const [x0, y0] = this.toScreen(r.x, r.y);
        const [x1, y1] = this.toScreen(r.x + r.w * r.scale, r.y + r.h * r.scale);
        const p0 = this.toLayout(sx, sy);
        if (Math.hypot(sx - x1, sy - y1) < 14) { this.app.refBeginDrag(); this.refDrag = { mode: 'scale', ax: r.x, ay: r.y }; return; }
        if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) { this.app.refBeginDrag(); this.refDrag = { mode: 'move', last: p0 }; return; }
      }
      if (tool === 'edit') {
        const hit = this.hitCtrl(sx, sy);
        // gizmo de traslación (X, Y o libre) sobre el punto o grupo seleccionado
        const gz = e.button === 0 && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey ? this.hitGizmo(sx, sy) : null;
        if (gz) {
          const st = this.app.state, p0 = this.toLayout(sx, sy);
          if (st.selSet && st.selSet.idxs.size > 1 && this.app.beginGroupDrag()) { this.groupDrag = { start: p0, axis: gz }; return; }
          if (st.sel) {
            const arr = this.app.ctrlRoutes().find((r) => r.key === st.sel.key);
            const q = arr && arr.pts[st.sel.idx];
            if (q) { this.dragCtrl = { ...st.sel, axis: gz, start: p0, orig: [q[0], q[1]] }; this.app.beginCtrlDrag(st.sel.key, st.sel.idx); return; }
          }
        }
        if (e.button === 0 && e.altKey) {
          // Alt: arrastrar = caja que QUITA puntos de la selección; clic sobre un punto = borrarlo
          this.box = { x0: sx, y0: sy, x1: sx, y1: sy, hit, sub: true };
          this.draw();
          return;
        }
        if (e.button === 0 && (e.shiftKey || e.ctrlKey || e.metaKey)) {
          // Shift: arrastrar = caja de selección; clic sin mover sobre un punto = sumar/quitar ese punto
          this.box = { x0: sx, y0: sy, x1: sx, y1: sy, hit };
          this.draw();
          return;
        }
        if (hit && (e.button === 2 || (e.button === 0 && e.altKey))) { this.app.deleteCtrl(hit.key, hit.idx); return; }
        if (hit && e.button === 0) {
          if (this.app.isMultiSelected(hit.key, hit.idx) && this.app.beginGroupDrag()) {
            this.groupDrag = { start: this.toLayout(sx, sy) };
            return;
          }
          if (this.app.state.selSet) this.app.clearMultiSel();
          this.dragCtrl = hit;
          this.app.beginCtrlDrag(hit.key, hit.idx);
          this.draw();
          return;
        }
        if (e.button === 0) {
          const m = this.hitMarker(sx, sy);
          if (m) { this.app.selectCrossing(m.id); return; }
          this.app.selectCtrl(null);
          if (this.app.state.selSet) this.app.clearMultiSel();
        }
        this.panning = { sx, sy, ox: this.view.ox, oy: this.view.oy };
        return;
      }
      if (e.button === 1 || e.button === 2 || tool === 'pan') {
        // clic en marcador de cruce con herramienta navegar
        if (e.button === 0) {
          const m = this.hitMarker(sx, sy);
          if (m) { this.app.selectCrossing(m.id); return; }
          // elemento de pista: seleccionar y arrastrar
          const pl = this.toLayout(sx, sy);
          const ref = this.app.itemAtLayout(pl, 6 / this.view.zoom);
          if (ref) { this.app.beginItemDrag(ref); this.itemDrag = { start: pl }; return; }
          // modelo de referencia seleccionado: arrastrar lo mueve en planta
          if (tool === 'pan' && this.app.state.ref3d && this.app.state.ref3d.sel && !this.app.state.ref3d.locked && this.hitRef3d(pl)) { this.ref3dDrag = { last: pl }; return; }
          // puente: clic lo selecciona; arrastrar lo desplaza hacia la izquierda o la derecha
          const bi = tool === 'pan' ? this.app.bridgeAtLayout(pl, 3 / this.view.zoom) : null;
          if (bi != null) { this.app.beginBridgeDrag(bi); this.bridgeDrag = { last: pl }; return; }
        }
        this.panning = { sx, sy, ox: this.view.ox, oy: this.view.oy, click: tool === 'pan' && e.button === 0 };
        return;
      }
      const m = this.hitMarker(sx, sy);
      if (m && tool !== 'draw' && tool !== 'alt' && tool !== 'extend') { this.app.selectCrossing(m.id); return; }
      const p = this.toLayout(sx, sy);
      if (tool === 'draw' || tool === 'alt' || tool === 'extend') this.stroke = { kind: tool, pts: [p] };
      else if (tool === 'start') this.app.setStart(p);
      else if (tool === 'flat') this.dragFlat = { a: p, b: p };
      else if (tool === 'profile') this.dragProfile = { a: p, b: p }; // tramo para dibujar su perfil
      else if (tool === 'susp') this.dragSusp = { a: p, b: p }; // tramo suspendido
      this.draw();
    });

    cv.addEventListener('pointermove', (e) => {
      const [sx, sy] = this.eventPos(e);
      if (this.panning) {
        this.view.ox = this.panning.ox + (sx - this.panning.sx);
        this.view.oy = this.panning.oy + (sy - this.panning.sy);
        this.draw();
        return;
      }
      const p = this.toLayout(sx, sy);
      if (this.carDrag) { const sv = this.app.nearestMainS(p, Infinity); if (sv !== null) this.app.moveCarTo(sv); return; }
      if (this.painting) { this.addPaint(p); return; }
      if (this.itemDrag) { this.app.dragItemToLayout(this.itemDrag.start, p); return; }
      if (this.bridgeDrag) { this.app.dragBridgeLayout(this.bridgeDrag.last, p); this.bridgeDrag.last = p; return; }
      if (this.ref3dDrag) { this.app.moveRef3dLayout(this.ref3dDrag.last, p); this.ref3dDrag.last = p; return; }
      if (this.box) { this.box.x1 = sx; this.box.y1 = sy; this.draw(); return; }
      if (this.groupDrag) {
        const ax = this.groupDrag.axis;
        const dx = ax === 'y' ? 0 : p[0] - this.groupDrag.start[0], dy = ax === 'x' ? 0 : p[1] - this.groupDrag.start[1];
        this.app.applyGroupDelta(dx, dy, null);
        return;
      }
      if (this.refDrag) {
        const r = this.app.state.ref;
        if (this.refDrag.mode === 'move') {
          this.app.refMove(p[0] - this.refDrag.last[0], p[1] - this.refDrag.last[1]);
          this.refDrag.last = p;
        } else {
          const sc = Math.max((p[0] - this.refDrag.ax) / r.w, (p[1] - this.refDrag.ay) / r.h);
          this.app.refScaleTo(sc);
        }
        return;
      }
      if (this.dragCtrl) {
        const d = this.dragCtrl;
        if (d.axis) {
          const dx = d.axis === 'y' ? 0 : p[0] - d.start[0], dy = d.axis === 'x' ? 0 : p[1] - d.start[1];
          this.app.moveCtrl(d.key, d.idx, [d.orig[0] + dx, d.orig[1] + dy]);
        } else this.app.moveCtrl(d.key, d.idx, p);
        return;
      }
      if (this.stroke) {
        const last = this.stroke.pts[this.stroke.pts.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) * this.view.zoom > 2) this.stroke.pts.push(p);
        this.draw();
        return;
      }
      if (this.dragFlat) { this.dragFlat.b = p; this.draw(); return; }
      if (this.dragProfile) { this.dragProfile.b = p; this.draw(); return; }
      if (this.dragSusp) { this.dragSusp.b = p; this.draw(); return; }
      // hover sobre la ruta principal
      const s = this.app.nearestMainS(p, 25 / this.view.zoom);
 const tl = this.app.state.tool;
      if (this.hitCar(sx, sy)) { cv.style.cursor = 'grab'; return; }
      if (tl === 'paint' || tl === 'hill' || tl === 'itemPaint' || tl === 'sculpt' || tl === 'river') { this.paintCursor = p; cv.style.cursor = 'none'; this.draw(); return; }
      if (tl === 'pan' && this.app.itemAtLayout(p, 6 / this.view.zoom)) { cv.style.cursor = 'move'; return; }
      if (tl === 'pan' && this.app.state.ref3d && this.app.state.ref3d.sel && !this.app.state.ref3d.locked && this.hitRef3d(p)) { cv.style.cursor = 'move'; return; }
      if (tl === 'pan' && this.app.bridgeAtLayout(p, 3 / this.view.zoom) != null) { cv.style.cursor = 'ew-resize'; if (s !== this.hoverS) { this.hoverS = s; this.app.setHover(s, 'map'); } return; }
      if (tl === 'ref' && this.app.state.ref) {
        const r = this.app.state.ref;
        const [x0, y0] = this.toScreen(r.x, r.y), [x1, y1] = this.toScreen(r.x + r.w * r.scale, r.y + r.h * r.scale);
        cv.style.cursor = Math.hypot(sx - x1, sy - y1) < 14 ? 'nwse-resize' : sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1 ? 'move' : 'grab';
        return;
      }
      if (tl === 'edit') { const gh = this.hitGizmo(sx, sy); if (gh !== this.gizmoHover) { this.gizmoHover = gh; this.draw(); } if (gh) { cv.style.cursor = gh === 'x' ? 'ew-resize' : gh === 'y' ? 'ns-resize' : 'move'; return; } }
      cv.style.cursor = tl === 'edit' && this.hitCtrl(sx, sy) ? 'move' : this.hitMarker(sx, sy) ? 'pointer' : tl === 'pan' || tl === 'edit' ? 'grab' : 'crosshair';
      if (s !== this.hoverS) { this.hoverS = s; this.app.setHover(s, 'map'); }
    });

    const end = (e) => {
      if (this.carDrag) { this.carDrag = false; this.app.endCarDrag(); cv.style.cursor = 'grab'; return; }
      if (this.painting) { const ses = this.painting; this.painting = null; this.app.endPaint(ses.kind, ses); this.draw(); return; }
      if (this.itemDrag) { this.itemDrag = null; this.app.endItemDrag(); return; }
      if (this.bridgeDrag) { this.bridgeDrag = null; this.app.endBridgeDrag(); return; }
      if (this.ref3dDrag) { this.ref3dDrag = null; this.app.endRef3dMove(); return; }
      if (this.box) {
        const b = this.box;
        this.box = null;
        const [ax, ay] = this.toLayout(b.x0, b.y0), [bx, by] = this.toLayout(b.x1, b.y1);
        const moved = Math.abs(b.x1 - b.x0) + Math.abs(b.y1 - b.y0) > 4;
        if (b.sub) { if (moved) this.app.boxSelect(ax, ay, bx, by, 'sub'); else if (b.hit) this.app.deleteCtrl(b.hit.key, b.hit.idx); }
        else if (moved) this.app.boxSelect(ax, ay, bx, by, e && e.ctrlKey);
        else if (b.hit) this.app.toggleMultiSel(b.hit);
        this.draw();
        return;
      }
      if (this.refDrag) { this.refDrag = null; this.draw(); return; }
      if (this.groupDrag) { this.groupDrag = null; this.app.endGroupDrag(); return; }
      if (this.dragCtrl) { this.dragCtrl = null; this.app.endCtrlDrag(); return; }
      if (this.panning) {
        const pn = this.panning;
        this.panning = null;
        // clic sin arrastrar con Navegar: selecciona el cerro bajo el cursor (o deselecciona)
        if (pn.click && e) {
          const [ex, ey] = this.eventPos(e);
          if (Math.hypot(ex - pn.sx, ey - pn.sy) < 4) this.app.selectHillAt(this.toLayout(ex, ey), 6 / this.view.zoom);
        }
        return;
      }
      if (this.stroke) {
        const st = this.stroke;
        this.stroke = null;
        if (st.pts.length >= 4) this.app.commitStroke(st.kind, this.smoothStroke(st.pts, st.kind), this.view.zoom);
        this.draw();
      }
      if (this.dragFlat) {
        const d = this.dragFlat;
        this.dragFlat = null;
        this.app.addFlatZone(d.a, d.b);
        this.draw();
      }
      if (this.dragSusp) {
        const d = this.dragSusp;
        this.dragSusp = null;
        this.app.addSuspZone(d.a, d.b);
        this.draw();
      }
      if (this.dragProfile) {
        const d = this.dragProfile;
        this.dragProfile = null;
        this.app.setProfileSel(d.a, d.b); // un clic sin arrastrar quita el tramo
        this.draw();
      }
    };
    cv.addEventListener('dblclick', (e) => {
      const [sx0, sy0] = this.eventPos(e);
      if (this.app.state.tool === 'pan') { this.app.enterEditAt(this.toLayout(sx0, sy0), 40 / this.view.zoom); return; }
      if (this.app.state.tool !== 'edit') return;
      const [sx, sy] = this.eventPos(e);
      if (this.hitCtrl(sx, sy)) return;
      this.app.insertCtrl(this.toLayout(sx, sy), 14 / this.view.zoom);
    });
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { if (this.hoverS !== null && !this.stroke) { this.hoverS = null; this.app.setHover(null, 'map'); } });
  }

  /** Remuestrea el trazo a paso de pantalla uniforme y aplica el suavizado del dibujo. */
  smoothStroke(pts, kind) {
    const lvl = this.app.state.drawSmooth || 0;
    let p = resampleUniform(pts, 3 / this.view.zoom, false);
    if (lvl > 0 && p.length > 4) p = taubinSmooth(p, Math.round(lvl * lvl * 3), false);
    void kind;
    return p;
  }

  drawSnapTargets() {
    const { ctx } = this;
    const m = this.app.state.project.main;
    if (!m) return;
    const arr = m.ctrl || m.pts;
    if (!arr || arr.length < 2 || m.closed !== false) return;
    for (const q of [arr[0], arr[arr.length - 1]]) {
      const [x, y] = this.toScreen(q[0], q[1]);
      ctx.strokeStyle = 'rgb(140,230,140)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = 'rgb(140,230,140)'; ctx.fill();
    }
  }

  /** Puente seleccionado: tramo iluminado en amarillo. */
  drawSelectedBridge(L) {
    const r = L.routes[0], b = r.bridges && r.bridges.find((q) => q.idx === this.app.state.selBridge);
    if (!b) return;
    const { ctx } = this;
    const i0 = Math.round(b.s0 / r.ds), i1 = Math.round(b.s1 / r.ds);
    const toS = (x, y) => { const [lx, ly] = L.toLayout(x, y); return this.toScreen(lx, ly); };
    const side = (sg) => { const out = []; for (let i = i0; i <= i1; i++) { const j = ((i % r.n) + r.n) % r.n, hw = (r.w[j] / 2) * sg; out.push(toS(r.x[j] - r.ty[j] * hw, r.y[j] + r.tx[j] * hw)); } return out; };
    const A = side(1), B = side(-1);
    ctx.save();
    // relleno suave + bordes amarillos (deja ver la textura del tablero)
    ctx.fillStyle = 'rgba(255,224,102,0.08)';
    ctx.beginPath(); A.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); for (let k = B.length - 1; k >= 0; k--) ctx.lineTo(B[k][0], B[k][1]); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(255,224,102,0.6)'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
    for (const E of [A, B]) { ctx.beginPath(); E.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); }
    // flecha doble a lo ancho: se arrastra para desplazar el puente hacia un borde
    const jm = (((Math.round((i0 + i1) / 2)) % r.n) + r.n) % r.n;
    const [x, y] = this.routeScreen(L, r, jm);
    const nxw = -r.ty[jm], nyw = r.tx[jm];
    const [qx, qy] = toS(r.x[jm] + nxw, r.y[jm] + nyw);
    let dx = qx - x, dy = qy - y; const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
    const hl = Math.max(14, (r.w[jm] / 2) * (this.view.zoom / L.scale) + 10);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x - dx * hl, y - dy * hl); ctx.lineTo(x + dx * hl, y + dy * hl); ctx.stroke();
    for (const sg of [1, -1]) {
      const tx = x + dx * hl * sg, ty = y + dy * hl * sg;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx - dx * 8 * sg - dy * 5, ty - dy * 8 * sg + dx * 5); ctx.lineTo(tx - dx * 8 * sg + dy * 5, ty - dy * 8 * sg - dx * 5); ctx.closePath(); ctx.fillStyle = '#ffe066'; ctx.fill();
    }
    ctx.fillStyle = '#ffe066'; ctx.font = '12px system-ui, sans-serif';
    const off = b.off || 0;
    ctx.fillText(`Puente ${this.app.state.selBridge + 1}${Math.abs(off) > 0.005 ? ` · ${off < 0 ? 'izq' : 'der'} ${Math.round(Math.abs(off) * 100)}%` : ''}`, x + dx * hl + 10, y + dy * hl - 6);
    ctx.restore();
  }

  /** Atajo seleccionado: iluminado en amarillo (halo, relleno translúcido y bordes). */
  drawSelectedAlt(L) {
    const r = L.routes.find((q) => q.kind === 'alt' && q.altIndex === this.app.state.selAlt);
    if (!r) return;
    const { ctx } = this;
    ctx.save();
    const wpx = Math.max(3, (r.w[0] / L.scale) * this.view.zoom);
    const path = () => { ctx.beginPath(); for (let i = 0; i < r.n; i++) { const [lx, ly] = L.toLayout(r.x[i], r.y[i]); const [x, y] = this.toScreen(lx, ly); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); } };
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // halo
    ctx.shadowColor = 'rgba(255,224,102,0.5)'; ctx.shadowBlur = 8;
    ctx.strokeStyle = 'rgba(255,224,102,0.17)'; ctx.lineWidth = wpx + 10;
    path(); ctx.stroke();
    ctx.shadowBlur = 0;
    // calzada iluminada
    ctx.strokeStyle = 'rgba(255,224,102,0.28)'; ctx.lineWidth = wpx;
    path(); ctx.stroke();
    // bordes
    const { left, right } = this.app.edgeSamplesFor ? this.app.edgeSamplesFor(r) : { left: null, right: null };
    if (left && right) {
      ctx.strokeStyle = 'rgba(255,224,102,0.6)'; ctx.lineWidth = 2;
      for (const arr of [left, right]) { ctx.beginPath(); arr.forEach((p, i) => { const [lx, ly] = L.toLayout(p.x, p.y); const [x, y] = this.toScreen(lx, ly); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke(); }
    }
    ctx.restore(); // (la etiqueta con el nombre se dibuja junto a las de los demás atajos, en amarillo)
  }

  /** ¿(sx, sy) cae sobre el auto de la cámara de juego dibujado en el mapa? */
  hitCar(sx, sy) {
    const c = this.carScreen;
    return !!(c && this.app.state.gameActive && this.gameS != null && Math.hypot(sx - c.x, sy - c.y) < c.k * 1.35);
  }

  /** Auto de la cámara de juego sobre el mapa (flecha en el sentido de marcha). Se puede arrastrar. */
  drawGameCar(L) {
    const r = L.routes[0];
    const s = ((this.gameS % r.L) + r.L) % r.L;
    const i = Math.min(r.n - 1, Math.round(s / r.ds));
    const { ctx } = this;
    const [lx, ly] = L.toLayout(r.x[i], r.y[i]);
    const [x, y] = this.toScreen(lx, ly);
    const ang = Math.atan2(-r.ty[i], r.tx[i]); // Y del lienzo hacia abajo
    const k = Math.max(9, Math.min(22, (6 / L.scale) * this.view.zoom * 1.4));
    this.carScreen = { x, y, k };
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.arc(0, 0, k * 1.25, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e53935'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(k, 0); ctx.lineTo(-k * 0.7, k * 0.62); ctx.lineTo(-k * 0.35, 0); ctx.lineTo(-k * 0.7, -k * 0.62); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  /** Elementos de pista: charcos (círculos), turbo pads (rectángulos con flecha) y nitro strips (franjas). */
  drawItems(L) {
    const inst = this.app.itemInstances();
    if (!inst.length) return;
    const { ctx } = this;
    const z = this.view.zoom;
    const sel = this.app.state.selItem;
    const toS = (x, y) => { const [lx, ly] = L.toLayout(x, y); return this.toScreen(lx, ly); };
    const col = { puddle: 'rgba(58,143,232,0.85)', pad: 'rgba(255,210,31,0.95)', strip: 'rgba(34,197,94,0.9)' };
    ctx.save();
    for (const g of inst) for (const it of g.items) {
      const isSel = sel && sel.type === it.type && sel.gid === it.gid && sel.idx === it.idx;
      ctx.fillStyle = col[it.type];
      ctx.strokeStyle = isSel ? '#ffe066' : 'rgba(0,0,0,0.55)';
      ctx.lineWidth = isSel ? 2.5 : 1;
      const [cx, cy] = toS(it.origin[0], it.origin[1]);
      const px = z / L.scale; // píxeles por metro
      if (it.footprint.kind === 'circle') {
        ctx.beginPath(); ctx.arc(cx, cy, Math.max(2, it.footprint.r * px), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      } else if (it.footprint.kind === 'rect') {
        const [T, Lt] = it.basis;
        const { hl, hw } = it.footprint;
        const c = [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]].map(([a, b]) => toS(it.origin[0] + T[0] * a + Lt[0] * b, it.origin[1] + T[1] * a + Lt[1] * b));
        ctx.beginPath(); c.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.closePath(); ctx.fill(); ctx.stroke();
        // flecha hacia adelante
        const tip = toS(it.origin[0] + T[0] * hl * 0.8, it.origin[1] + T[1] * hl * 0.8);
        const l1 = toS(it.origin[0] - T[0] * hl * 0.2 + Lt[0] * hw * 0.6, it.origin[1] - T[1] * hl * 0.2 + Lt[1] * hw * 0.6);
        const l2 = toS(it.origin[0] - T[0] * hl * 0.2 - Lt[0] * hw * 0.6, it.origin[1] - T[1] * hl * 0.2 - Lt[1] * hw * 0.6);
        ctx.fillStyle = '#111'; ctx.beginPath(); ctx.moveTo(tip[0], tip[1]); ctx.lineTo(l1[0], l1[1]); ctx.lineTo(l2[0], l2[1]); ctx.closePath(); ctx.fill();
      } else {
        const P = it.footprint.pts.map((q) => toS(q[0], q[1]));
        ctx.lineCap = 'round';
        if (isSel) { ctx.strokeStyle = '#ffe066'; ctx.lineWidth = Math.max(3, it.footprint.hw * 2 * px) + 4; ctx.beginPath(); P.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.stroke(); }
        ctx.strokeStyle = col.strip; ctx.lineWidth = Math.max(2, it.footprint.hw * 2 * px);
        ctx.beginPath(); P.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.stroke();
      }
      if (isSel) { ctx.fillStyle = '#ffe066'; ctx.font = '11px system-ui, sans-serif'; ctx.fillText(it.name, cx + 8, cy - 8); }
    }
    ctx.restore();
  }

  addPaint(p) {
    this.app.addStroke(this.painting, p);
    this.paintCursor = p;
    this.draw();
  }

  /** Capa de pintura (densidad en magenta, cerros en marrón según altura). */
  drawStrokeLayer(list, color, alpha, heightColor) {
    if (!list.length) return;
    const { ctx, cv } = this;
    if (!this.paintLayer) this.paintLayer = document.createElement('canvas');
    const pl = this.paintLayer;
    if (pl.width !== cv.width || pl.height !== cv.height) { pl.width = cv.width; pl.height = cv.height; }
    const pc = pl.getContext('2d');
    pc.setTransform(1, 0, 0, 1, 0, 0);
    pc.clearRect(0, 0, pl.width, pl.height);
    pc.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    for (const q of list) {
      const [x, y] = this.toScreen(q.x, q.y);
      pc.globalCompositeOperation = q.e ? 'destination-out' : 'source-over';
      pc.fillStyle = heightColor ? heightColor(q) : color;
      pc.beginPath(); pc.arc(x, y, q.r * this.view.zoom, 0, Math.PI * 2); pc.fill();
    }
    pc.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.drawImage(pl, 0, 0);
    ctx.restore();
  }

  drawPaint() {
    const st = this.app.state;
    const tool = st.tool;
    const hillCol = (q) => {
      const t = Math.min(1, q.h / 60);
      return q.hard ? `rgb(${150 - 50 * t},${110 - 40 * t},${90 - 30 * t})` : `rgb(${200 - 60 * t},${150 - 40 * t},${70 - 20 * t})`;
    };
    for (const h of st.hills || []) {
      const sel = h.id === st.selHill;
      const col = sel ? '#ffd54f' : hillCol({ h: h.height, hard: h.hard });
      this.drawStrokeLayer(h.strokes, col, sel ? 0.4 : tool === 'hill' ? 0.45 : 0.28);
    }
    // nombres de los cerros
    if (st.hills && st.hills.length && (tool === 'hill' || tool === 'pan' || st.selHill != null)) {
      const ctx = this.ctx;
      ctx.save();
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      for (const h of st.hills) {
        const adds = h.strokes.filter((q) => !q.e);
        if (!adds.length) continue;
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const q of adds) { x0 = Math.min(x0, q.x - q.r); x1 = Math.max(x1, q.x + q.r); y0 = Math.min(y0, q.y - q.r); y1 = Math.max(y1, q.y + q.r); }
        const [x, y] = this.toScreen((x0 + x1) / 2, (y0 + y1) / 2);
        const sel = h.id === st.selHill;
        ctx.fillStyle = sel ? '#ffe082' : 'rgba(255,235,200,0.75)';
        ctx.fillText(`${h.name} · ${h.height} m`, x, y);
      }
      ctx.restore();
    }
    this.drawStrokeLayer(st.densityPaint, '#e040fb', tool === 'paint' && st.selHill == null ? 0.35 : 0.16);
    // subdivisión pintada sobre el cerro seleccionado
    if (tool === 'paint' && st.selHill != null) { const h = st.hills.find((q) => q.id === st.selHill); if (h && h.subdiv && h.subdiv.length) this.drawStrokeLayer(h.subdiv, '#e040fb', 0.45); }
    // ríos (azul) y cascadas (celeste)
    for (const rv of st.rivers || []) {
      const sel = rv.id === st.selRiver;
      this.drawStrokeLayer(rv.strokes, rv.kind === 'fall' ? '#bfe8ff' : '#3fa7ff', tool === 'river' ? (sel ? 0.6 : 0.45) : sel ? 0.5 : 0.3);
    }
    if (st.terrainSculpt && st.terrainSculpt.length && (tool === 'sculpt' || st.scene.terrain)) this.drawStrokeLayer(st.terrainSculpt, null, tool === 'sculpt' ? 0.4 : 0.14, (q) => (q.h > 0 ? 'rgb(255,160,70)' : 'rgb(80,160,255)'));
    if (tool === 'itemPaint') this.drawStrokeLayer(this.app.itemPaintStrokes(), this.app.itemPaintColor(), 0.4);
    // cursor del pincel
    if ((tool === 'paint' || tool === 'hill' || tool === 'itemPaint' || tool === 'sculpt' || tool === 'river') && this.paintCursor && st.layout) {
      const [x, y] = this.toScreen(this.paintCursor[0], this.paintCursor[1]);
      const erase = (this.painting && this.painting.erase) || st.paintErase;
      ctx_stroke: {
        const ctx = this.ctx;
        ctx.strokeStyle = tool === 'sculpt' ? (this.painting ? (this.painting.erase ? '#ffa046' : '#50a0ff') : '#7ec8ff') : erase ? '#ff8a80' : tool === 'hill' ? '#e0a050' : tool === 'river' ? '#3fa7ff' : tool === 'itemPaint' ? this.app.itemPaintColor() : '#e040fb';
        ctx.lineWidth = 1.5;
        const rm = tool === 'hill' ? st.scene.hillBrush : tool === 'sculpt' ? st.scene.sculptBrush : tool === 'river' ? st.scene.riverBrush : st.scene.paintBrush;
        ctx.beginPath(); ctx.arc(x, y, (rm / st.layout.scale) * this.view.zoom, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }

  /** Camino de tierra en planta (color arena). */
  drawDirt2D(L, list) {
    const { ctx } = this;
    const S = (P, v) => { const [lx, ly] = L.toLayout(P[v * 3], P[v * 3 + 1]); return this.toScreen(lx, ly); };
    ctx.save();
    ctx.fillStyle = 'rgba(201,168,119,0.9)';
    ctx.strokeStyle = 'rgba(201,168,119,0.9)'; ctx.lineWidth = 1;
    for (const m of list) {
      const P = m.positions, per = m.per || 2;
      ctx.beginPath();
      for (const a of m.segs) {
        const A = S(P, a * per), B = S(P, a * per + 1), C = S(P, (a + 1) * per + 1), D = S(P, (a + 1) * per);
        ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.lineTo(C[0], C[1]); ctx.lineTo(D[0], D[1]); ctx.closePath();
      }
      ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  /** Barreras en planta: línea roja y blanca según el largo de repetición. */
  drawBarriers2D(L, list, pxPerM) {
    const { ctx } = this;
    const sc = this.app.state.scene;
    const PE = (m) => edgeParams(sc, L.routes[m.k]); // cada atajo con sus propios parámetros
    const halfOf = (m) => Math.max(0.25, (PE(m).barrierTile || 4) / 2);
    const S = (P, v) => { const x = (P[v * 3] + P[v * 3 + 9]) / 2, y = (P[v * 3 + 1] + P[v * 3 + 10]) / 2; const [lx, ly] = L.toLayout(x, y); return this.toScreen(lx, ly); };
    ctx.save();
    ctx.lineCap = 'butt';
    for (const m of list) {
      const P = m.positions, half = halfOf(m);
      ctx.lineWidth = Math.max(2, Math.max(0.08, PE(m).barrierThick ?? 0.25) * pxPerM * 1.4);
      for (const col of [0, 1]) {
        ctx.strokeStyle = col ? '#f2f2f2' : '#d42a2a';
        ctx.beginPath();
        for (const a of m.segs) {
          // el tramo se parte en los cambios de color (así coincide con la textura aunque las secciones sean largas)
          const s0 = m.s[a], s1 = m.s[a + 1];
          if (!(s1 > s0)) continue;
          const A = S(P, a * 6), B = S(P, (a + 1) * 6);
          let t0 = 0;
          while (t0 < 1) {
            const sv = s0 + (s1 - s0) * t0;
            const cell = Math.floor(sv / half + 1e-9);
            const t1 = Math.min(1, ((cell + 1) * half - s0) / (s1 - s0));
            if ((cell & 1) === col) { ctx.moveTo(A[0] + (B[0] - A[0]) * t0, A[1] + (B[1] - A[1]) * t0); ctx.lineTo(A[0] + (B[0] - A[0]) * t1, A[1] + (B[1] - A[1]) * t1); }
            if (t1 <= t0) break;
            t0 = t1;
          }
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Transformación local del modelo de referencia (u, v en m) -> pantalla. */
  ref3dToScreen(L, R) {
    const th = ((R.rotZ || 0) * Math.PI) / 180, c = Math.cos(th), sn = Math.sin(th), k = R.scale || 1;
    return (u, v) => {
      const x = R.pos[0] + k * (u * c - v * sn), y = R.pos[1] + k * (u * sn + v * c);
      const [lx, ly] = L.toLayout(x, y);
      return this.toScreen(lx, ly);
    };
  }

  /** Silueta en planta del modelo de referencia 3D (debajo de la pista nueva). */
  drawRef3d(L, R) {
    const fp = R.fp;
    if (!R.fpTint || R.fpTint.color !== R.color) {
      const t = document.createElement('canvas');
      t.width = fp.canvas.width; t.height = fp.canvas.height;
      const g = t.getContext('2d');
      g.drawImage(fp.canvas, 0, 0);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = R.color || '#4fc3f7';
      g.fillRect(0, 0, t.width, t.height);
      R.fpTint = { color: R.color, canvas: t };
    }
    const T = this.ref3dToScreen(L, R);
    const O = T(fp.u0, fp.v1), U = T(fp.u0 + fp.res, fp.v1), V = T(fp.u0, fp.v1 - fp.res);
    const { ctx } = this, d = this.dpr;
    ctx.save();
    ctx.globalAlpha = Math.max(0.12, Math.min(1, (R.opacity ?? 0.6) * 0.8));
    ctx.imageSmoothingEnabled = true;
    ctx.setTransform(d * (U[0] - O[0]), d * (U[1] - O[1]), d * (V[0] - O[0]), d * (V[1] - O[1]), d * O[0], d * O[1]);
    ctx.drawImage(R.fpTint.canvas, 0, 0);
    ctx.restore();
    if (R.sel) {
      const P = [T(fp.u0, fp.v0), T(fp.u1, fp.v0), T(fp.u1, fp.v1), T(fp.u0, fp.v1)];
      ctx.save();
      ctx.strokeStyle = '#ffe066'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.beginPath(); P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffe066'; ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(`${R.name} · arrastra para mover`, P[3][0] + 4, P[3][1] - 6);
      ctx.restore();
    }
  }

  /** ¿El punto del lienzo cae sobre la silueta del modelo de referencia? */
  hitRef3d(p) {
    const st = this.app.state, R = st.ref3d, L = st.layout;
    if (!R || !R.fp || !L || R.visible === false) return false;
    const [x, y] = L.toWorld(p[0], p[1]);
    const th = ((R.rotZ || 0) * Math.PI) / 180, c = Math.cos(th), sn = Math.sin(th), k = R.scale || 1;
    const dx = (x - R.pos[0]) / k, dy = (y - R.pos[1]) / k;
    const u = dx * c + dy * sn, v = -dx * sn + dy * c;
    const fp = R.fp;
    if (u < fp.u0 || u > fp.u1 || v < fp.v0 || v > fp.v1) return false;
    if (!fp.data) fp.data = fp.canvas.getContext('2d').getImageData(0, 0, fp.canvas.width, fp.canvas.height).data;
    const i = Math.floor((u - fp.u0) / fp.res), j = Math.floor((fp.v1 - v) / fp.res);
    // un poco de tolerancia: cualquier píxel lleno en 5×5
    for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) {
      const ii = i + a, jj = j + b;
      if (ii < 0 || jj < 0 || ii >= fp.canvas.width || jj >= fp.canvas.height) continue;
      if (fp.data[(jj * fp.canvas.width + ii) * 4 + 3] > 20) return true;
    }
    return false;
  }

  drawRef(r) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = r.opacity;
    const [x, y] = this.toScreen(r.x, r.y);
    ctx.drawImage(r.canvas, x, y, r.w * r.scale * this.view.zoom, r.h * r.scale * this.view.zoom);
    ctx.restore();
  }

  drawRefFrame(r) {
    const { ctx } = this;
    const [x0, y0] = this.toScreen(r.x, r.y), [x1, y1] = this.toScreen(r.x + r.w * r.scale, r.y + r.h * r.scale);
    ctx.strokeStyle = 'rgba(200,140,255,0.9)';
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.setLineDash([]);
    ctx.fillStyle = '#c88cff';
    ctx.fillRect(x1 - 6, y1 - 6, 12, 12);
  }

  hitCtrl(sx, sy) {
    let best = null, bd = 9;
    for (const r of this.app.ctrlRoutes()) {
      r.pts.forEach((p, idx) => {
        const [x, y] = this.toScreen(p[0], p[1]);
        const d = Math.hypot(x - sx, y - sy);
        if (d < bd) { bd = d; best = { key: r.key, idx }; }
      });
    }
    return best;
  }

  /** Centro del gizmo 2D (punto seleccionado o centro de la selección múltiple), en pantalla. */
  gizmoCenter() {
    const st = this.app.state;
    const routes = this.app.ctrlRoutes();
    if (st.selSet && st.selSet.idxs.size > 1) {
      const r = routes.find((q) => q.key === st.selSet.key);
      if (!r) return null;
      let x = 0, y = 0, n = 0;
      for (const i of st.selSet.idxs) { const q = r.pts[i]; if (!q) continue; x += q[0]; y += q[1]; n++; }
      return n ? this.toScreen(x / n, y / n) : null;
    }
    if (st.sel) {
      const r = routes.find((q) => q.key === st.sel.key);
      const q = r && r.pts[st.sel.idx];
      return q ? this.toScreen(q[0], q[1]) : null;
    }
    return null;
  }

  drawGizmo2D() {
    const c = this.gizmoCenter();
    this.gizmo2d = c ? { cx: c[0], cy: c[1] } : null;
    if (!c) return;
    const { ctx } = this;
    const [cx, cy] = c, L = 52, hv = this.gizmoHover;
    const arrow = (dx, dy, col, label, on) => {
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = on ? 4 : 2.5;
      ctx.beginPath(); ctx.moveTo(cx + dx * 12, cy + dy * 12); ctx.lineTo(cx + dx * (L - 8), cy + dy * (L - 8)); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + dx * L, cy + dy * L);
      ctx.lineTo(cx + dx * (L - 11) - dy * 6, cy + dy * (L - 11) + dx * 6);
      ctx.lineTo(cx + dx * (L - 11) + dy * 6, cy + dy * (L - 11) - dx * 6);
      ctx.closePath(); ctx.fill();
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.fillText(label, cx + dx * (L + 6) - 4 + (dy ? 6 : 0), cy + dy * (L + 8) + 4);
    };
    ctx.save();
    arrow(1, 0, '#ff5a5a', 'X', hv === 'x');
    arrow(0, -1, '#4ade80', 'Y', hv === 'y');
    ctx.fillStyle = hv === 'xy' ? 'rgba(255,224,102,0.55)' : 'rgba(255,224,102,0.28)';
    ctx.strokeStyle = '#ffe066'; ctx.lineWidth = 1.5;
    ctx.fillRect(cx + 10, cy - 24, 14, 14); ctx.strokeRect(cx + 10, cy - 24, 14, 14);
    ctx.restore();
  }

  /** 'x' | 'y' | 'xy' | null según el lugar del gizmo bajo el cursor. */
  hitGizmo(sx, sy) {
    const g = this.gizmo2d;
    if (!g) return null;
    const dx = sx - g.cx, dy = sy - g.cy;
    if (dx >= 8 && dx <= 26 && dy >= -26 && dy <= -8) return 'xy';
    if (dx >= 12 && dx <= 56 && Math.abs(dy) <= 7) return 'x';
    if (-dy >= 12 && -dy <= 56 && Math.abs(dx) <= 7) return 'y';
    return null;
  }

  drawCtrl() {
    const { ctx } = this;
    const sel = this.app.state.sel;
    const ap = this.app.state.arcPreview;
    if (ap) {
      const [cx, cy] = this.toScreen(ap.cx, ap.cy);
      ctx.strokeStyle = 'rgba(255,224,102,0.45)';
      ctx.setLineDash([4, 5]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, ap.r * this.view.zoom, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,224,102,0.8)';
      ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, Math.PI * 2); ctx.fill();
    }
    for (const r of this.app.ctrlRoutes()) {
      const alt = r.key !== 'main';
      ctx.strokeStyle = alt ? 'rgba(79,179,255,0.45)' : 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      r.pts.forEach((p, i) => { const [x, y] = this.toScreen(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      if (r.closed) ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      r.pts.forEach((p, i) => {
        const [x, y] = this.toScreen(p[0], p[1]);
        const ms = this.app.state.selSet;
        const isSel = (sel && sel.key === r.key && sel.idx === i) || (ms && ms.key === r.key && ms.idxs.has(i));
        const pinned = r.zs && r.zs[i] !== null && r.zs[i] !== undefined;
        ctx.beginPath();
        if (pinned) { const q = isSel ? 6.5 : 5; ctx.rect(x - q, y - q, q * 2, q * 2); }
        else ctx.arc(x, y, isSel ? 6.5 : 4.5, 0, Math.PI * 2);
        ctx.fillStyle = isSel ? '#ffe066' : pinned ? '#f2a93b' : alt ? '#cfe9ff' : '#ffffff';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = isSel ? '#8a5a00' : alt ? '#1d6fb8' : '#b8741a';
        ctx.stroke();
      });
    }
  }

  hitMarker(sx, sy) {
    return this.markers.find((m) => Math.hypot(m.sx - sx, m.sy - sy) < 13) || null;
  }

  draw() {
    const { ctx, cv, dpr } = this;
    const st = this.app.state;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0e1117';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const z = this.view.zoom;
    // imagen
    if (st.image && st.imageOpacity > 0) {
      ctx.save();
      ctx.globalAlpha = st.imageOpacity;
      ctx.imageSmoothingEnabled = z < 2;
      ctx.drawImage(st.image.canvas, this.view.ox, this.view.oy, st.image.w * z, st.image.h * z);
      ctx.restore();
    }
    const ref = st.ref;
    if (ref && ref.visible && !ref.above) this.drawRef(ref);
    // grilla sutil
    this.drawGrid();
    const L = st.layout, E = st.result;
    // trazo crudo
    if (st.showRaw || !L) this.drawRaw();
    if (st.scene && (st.tool === 'paint' || st.tool === 'hill' || st.tool === 'itemPaint' || st.tool === 'sculpt' || st.tool === 'river' || (st.rivers && st.rivers.length) || st.scene.terrain || (st.hills && st.hills.length))) this.drawPaint();
    if (L && st.ref3d && st.ref3d.fp && st.ref3d.visible !== false && st.ref3d.show2d !== false) this.drawRef3d(L, st.ref3d);
    if (L) this.drawLayout(L, E);
    if (L && E) this.drawItems(L);
    if (L && st.selAlt != null) this.drawSelectedAlt(L);
    if (L && st.selBridge != null) this.drawSelectedBridge(L);
    if (L && this.app.state.gameActive && this.gameS != null) this.drawGameCar(L);
    if (ref && ref.visible && ref.above) this.drawRef(ref);
    if (ref && st.tool === 'ref') this.drawRefFrame(ref);
    if (st.tool === 'edit') { this.drawCtrl(); this.drawGizmo2D(); } else this.gizmo2d = null;
    if (this.box && Math.abs(this.box.x1 - this.box.x0) + Math.abs(this.box.y1 - this.box.y0) > 4) {
      ctx.strokeStyle = this.box.sub ? 'rgba(255,120,120,0.95)' : 'rgba(255,224,102,0.9)';
      ctx.fillStyle = 'rgba(255,224,102,0.08)';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      const bx = Math.min(this.box.x0, this.box.x1), by = Math.min(this.box.y0, this.box.y1);
      ctx.fillRect(bx, by, Math.abs(this.box.x1 - this.box.x0), Math.abs(this.box.y1 - this.box.y0));
      ctx.strokeRect(bx, by, Math.abs(this.box.x1 - this.box.x0), Math.abs(this.box.y1 - this.box.y0));
      ctx.setLineDash([]);
    }
    // trazo en curso: crudo tenue + versión suavizada
    if (this.stroke) {
      const col = this.stroke.kind === 'alt' ? '79,179,255' : this.stroke.kind === 'extend' ? '140,230,140' : '242,169,59';
      const line = (pts, style, w) => {
        ctx.strokeStyle = style; ctx.lineWidth = w;
        ctx.beginPath();
        pts.forEach((p, i) => { const [x, y] = this.toScreen(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.stroke();
      };
      line(this.stroke.pts, `rgba(${col},0.35)`, 1.5);
      if (this.stroke.pts.length > 3) line(this.smoothStroke(this.stroke.pts, this.stroke.kind), `rgb(${col})`, 3);
      // extremos a los que se puede enganchar (herramienta Extender)
      if (this.stroke.kind === 'extend') this.drawSnapTargets();
    } else if (st.tool === 'extend') this.drawSnapTargets();
    if (this.dragFlat && L) {
      const s0 = this.app.nearestMainS(this.dragFlat.a, Infinity);
      const s1 = this.app.nearestMainS(this.dragFlat.b, Infinity);
      if (s0 !== null && s1 !== null) this.strokeRange(L, 0, Math.min(s0, s1), Math.max(s0, s1), 'rgba(120,230,255,0.9)', 5);
    }
    // tramos suspendidos: línea discontinua celeste (más marcada con su herramienta)
    if (L && st.suspZones && st.suspZones.length) {
      const ctx = this.ctx;
      ctx.save();
      ctx.setLineDash([8, 6]);
      for (const Z of this.app.suspZonesS()) this.strokeRange(L, 0, Z.s0, Z.s1, st.tool === 'susp' ? 'rgba(90,220,255,0.95)' : 'rgba(90,220,255,0.55)', st.tool === 'susp' ? 5 : 3);
      ctx.restore();
    }
    if (this.dragSusp && L) {
      const s0 = this.app.nearestMainS(this.dragSusp.a, Infinity), s1 = this.app.nearestMainS(this.dragSusp.b, Infinity);
      if (s0 !== null && s1 !== null) this.strokeRange(L, 0, Math.min(s0, s1), Math.max(s0, s1), 'rgba(90,220,255,0.9)', 6);
    }
    // perfiles dibujados (violeta) y tramo elegido para dibujar su perfil (amarillo)
    if (L && (st.tool === 'profile' || st.tool === 'flat' || this.dragProfile)) {
      for (const Z of this.app.profileZonesS()) this.strokeRange(L, 0, Z.s0, Z.s1, 'rgba(186,120,255,0.75)', 4);
      let selT = this.app.profileSelS();
      if (this.dragProfile) { const s0 = this.app.nearestMainS(this.dragProfile.a, Infinity), s1 = this.app.nearestMainS(this.dragProfile.b, Infinity); selT = s0 !== null && s1 !== null ? [Math.min(s0, s1), Math.max(s0, s1)] : null; }
      if (selT) this.strokeRange(L, 0, selT[0], selT[1], 'rgba(255,224,102,0.6)', 6);
    }
  }

  drawGrid() {
    const { ctx } = this;
    const r = this.cv.getBoundingClientRect();
    const z = this.view.zoom;
    let step = 50;
    while (step * z < 40) step *= 2;
    while (step * z > 160) step /= 2;
    const [x0, y0] = this.toLayout(0, 0);
    const [x1, y1] = this.toLayout(r.width, r.height);
    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) { const [sx] = this.toScreen(x, 0); ctx.moveTo(sx, 0); ctx.lineTo(sx, r.height); }
    for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) { const [, sy] = this.toScreen(0, y); ctx.moveTo(0, sy); ctx.lineTo(r.width, sy); }
    ctx.stroke();
  }

  drawRaw() {
    const { ctx } = this;
    const p = this.app.state.project;
    const line = (pts, closed, color) => {
      if (!pts || pts.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      pts.forEach((q, i) => { const [x, y] = this.toScreen(q[0], q[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      if (closed) ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (p.main) line(p.main.pts, p.main.closed !== false, 'rgba(242,169,59,0.8)');
    (p.alts || []).forEach((a) => line(a.pts, false, a.keep === false ? 'rgba(150,150,150,0.5)' : 'rgba(79,179,255,0.8)'));
  }

  routeScreen(L, r, i) {
    const [lx, ly] = L.toLayout(r.x[i], r.y[i]);
    return this.toScreen(lx, ly);
  }

  /** Textura (repetida tres veces a lo largo) lista para el mapeo afín; se guarda por lienzo de origen. */
  texStrip(src, dir) {
    this.texCache2d = this.texCache2d || new Map();
    const key = dir;
    let c = this.texCache2d.get(src);
    if (c && c.key === key) return c;
    const W0 = dir === 'vertical' ? src.width : src.height, H0 = dir === 'vertical' ? src.height : src.width;
    const k = Math.min(1, 512 / Math.max(W0, H0));
    const W = Math.max(8, Math.round(W0 * k)), H = Math.max(8, Math.round(H0 * k));
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = 3 * H;
    const g = cv.getContext('2d');
    for (const oy of [0, H, 2 * H]) {
      g.save();
      if (dir === 'vertical') g.drawImage(src, 0, oy, W, H);
      else { g.translate(0, oy + H); g.rotate(-Math.PI / 2); g.drawImage(src, 0, 0, H, W); }
      g.restore();
    }
    c = { key, cv, W, H };
    this.texCache2d.set(src, c);
    return c;
  }

  /**
   * Textura de la pista sobre los colores por altura, con la opacidad elegida. Los cuadros se dibujan opacos y
   * solapados en una capa aparte (sin costuras ni parpadeo entre cuadros vecinos) y la capa se compone de una vez.
   * El tablero de los puentes usa su propia textura.
   */
  drawRouteTex(L, r, segs, pxPerM) {
    const st = this.app.state, sc = st.scene;
    const op = Math.max(0, Math.min(1, sc.trackTexOpacity ?? 1));
    if (op < 0.01 || !segs.length || r.w[0] * pxPerM < 4) return;
    const src = this.app.trackTexCanvas ? this.app.trackTexCanvas() : null;
    if (!src) return;
    const bsrc = this.app.bridgeTexCanvas ? this.app.bridgeTexCanvas() : src;
    const dir = sc.trackTexDir || 'vertical';
    const isAltR = r.kind === 'alt';
    const TT = this.texStrip(isAltR && this.app.altTexCanvas ? this.app.altTexCanvas(r) : src, dir), TB = r.bridges && r.bridges.length ? this.texStrip(bsrc, dir) : TT;
    const cov = st.coveredRanges || [], k = L.routes.indexOf(r);
    const TC = cov.some((c) => c.k === k) && this.app.coveredTexCanvas ? this.texStrip(this.app.coveredTexCanvas(), dir) : TT;
    const sus = (st.scene && st.scene.suspRanges) || [];
    const suspTex = this.app.suspTexCanvas ? this.app.suspTexCanvas() : null;
    const TS = suspTex && sus.some((c) => c.k === k) ? this.texStrip(suspTex, dir) : TT;
    const suspAt = (sv) => { for (const c of sus) { if (c.k !== k) continue; let d = sv - c.s0; if (r.closed) d = ((d % r.L) + r.L) % r.L; if (d >= 0 && d <= c.s1 - c.s0) return true; } return false; };
    const coveredAt = (sv) => { for (const c of cov) { if (c.k !== k) continue; let ss = sv; if (r.closed) { while (ss < c.s0) ss += r.L; while (ss > c.s1 + r.L) ss -= r.L; } if (ss >= c.s0 && ss <= c.s1) return true; } return false; };
    const inBridge = (sv) => {
      if (!r.bridges) return false;
      for (const b of r.bridges) { const d = r.closed ? (((sv - b.s0) % r.L) + r.L) % r.L : sv - b.s0; if (d >= -1e-6 && d <= b.s1 - b.s0 + 1e-6) return true; }
      return false;
    };
    const repLen = Math.max(0.5, L.routes[0].L / Math.max(1, sc.trackTexReps));
    const maxStep = Math.max(1, Math.min(Math.ceil(6 / (r.ds * pxPerM)), Math.floor((repLen * 0.9) / r.ds) || 1));
    const toS = (x, y) => { const [lx, ly] = L.toLayout(x, y); return this.toScreen(lx, ly); };
    // capa auxiliar del tamaño del lienzo
    const cvm = this.ctx.canvas;
    if (!this.texLayer) this.texLayer = document.createElement('canvas');
    const lay = this.texLayer;
    if (lay.width !== cvm.width || lay.height !== cvm.height) { lay.width = cvm.width; lay.height = cvm.height; }
    const ctx = lay.getContext('2d');
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, lay.width, lay.height);
    ctx.imageSmoothingEnabled = true;
    const edge = (i) => {
      const hw = r.w[i] / 2, lx = -r.ty[i], ly = r.tx[i];
      return [toS(r.x[i] + lx * hw, r.y[i] + ly * hw), toS(r.x[i] - lx * hw, r.y[i] - ly * hw)];
    };
    // agrupa segmentos consecutivos del mismo tipo (pista / puente), hasta maxStep por cuadro
    const groups = [];
    // tipo de cada segmento: 'b' tablero de puente, 'c' cubierto (túnel / bajo cruce), 'n' normal
    const kindOf = (sg) => {
      const sa = r.s[sg[0]], sb = sg[1] === 0 && r.closed ? r.L : r.s[sg[1]];
      if (inBridge(sa) && inBridge(sb === r.L ? 0 : sb)) return 'b';
      return coveredAt((sa + sb) / 2) ? 'c' : suspAt((sa + sb) / 2) ? 's' : 'n';
    };
    for (let q = 0; q < segs.length;) {
      const a = segs[q][0];
      const br = kindOf(segs[q]);
      let e = q;
      while (e + 1 < segs.length && e + 1 - q < maxStep && segs[e + 1][0] === segs[e][1]) {
        if (kindOf(segs[e + 1]) !== br) break;
        e++;
      }
      groups.push([a, segs[e][1], br]);
      q = e + 1;
    }
    const GROW_ALONG = 1.2, GROW_SIDE = 0.5; // px: solape entre cuadros y cobertura del borde de la base
    for (const [a, b, br] of groups) {
      const T = br === 'b' ? TB : br === 'c' ? TC : br === 's' ? TS : TT;
      const { cv: tex, W, H } = T;
      const sa = r.s[a], sb = b === 0 && r.closed ? r.L : r.s[b];
      if (sb <= sa) continue;
      const va = sa / repLen, vb = sb / repLen;
      const y0 = (1 + va - Math.floor(va)) * H, y1 = y0 + (vb - va) * H; // copia central de la tira (margen a ambos lados)
      const [P0, P1] = edge(a), [P2, P3] = edge(b);
      // cuadrilátero ampliado: a lo largo (solape con el vecino) y hacia los costados
      const ax0 = (P2[0] + P3[0] - P0[0] - P1[0]) / 2, ay0 = (P2[1] + P3[1] - P0[1] - P1[1]) / 2;
      const al = Math.hypot(ax0, ay0) || 1, tx = ax0 / al, ty = ay0 / al;
      const side = (P, Q, sgn) => { const dx = P[0] - Q[0], dy = P[1] - Q[1], l = Math.hypot(dx, dy) || 1; return [P[0] + (dx / l) * GROW_SIDE + tx * GROW_ALONG * sgn, P[1] + (dy / l) * GROW_SIDE + ty * GROW_ALONG * sgn]; };
      const G0 = side(P0, P1, -1), G1 = side(P1, P0, -1), G3 = side(P3, P2, 1), G2 = side(P2, P3, 1);
      // dos triángulos, cada uno con su propio mapeo afín (en curva el cuadro es un trapecio: un solo afín dejaría huecos)
      const m0 = Math.max(0, y0 - 4 - (y1 - y0)), m1 = Math.min(3 * H, y1 + 4 + (y1 - y0));
      // 1) todo el cuadro ampliado con el afín del primer triángulo; 2) encima, el segundo triángulo con su afín,
      //    con la diagonal corrida 1 px hacia el primero (así la diagonal no deja costura: debajo ya hay imagen)
      const nx = -(G2[1] - G1[1]), ny = G2[0] - G1[0], nl = Math.hypot(nx, ny) || 1;
      const sgn = ((P0[0] - G1[0]) * nx + (P0[1] - G1[1]) * ny) > 0 ? 1 : -1;
      const push = (Q) => [Q[0] + (nx / nl) * sgn, Q[1] + (ny / nl) * sgn];
      const passes = [
        [[G0, G1, G3, G2], [[0, y0], [W, y0], [0, y1]], [P0, P1, P2]],
        [[push(G1), G3, push(G2)], [[W, y0], [W, y1], [0, y1]], [P1, P3, P2]],
      ];
      for (const [clipP, srcT, dstT] of passes) {
        const M = affine3(srcT, dstT);
        if (!M) continue;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.save();
        ctx.beginPath(); ctx.moveTo(clipP[0][0], clipP[0][1]); for (let k = 1; k < clipP.length; k++) ctx.lineTo(clipP[k][0], clipP[k][1]); ctx.closePath();
        ctx.clip();
        ctx.setTransform(dpr * M[0], dpr * M[1], dpr * M[2], dpr * M[3], dpr * M[4], dpr * M[5]);
        ctx.drawImage(tex, 0, m0, W, m1 - m0, 0, m0, W, m1 - m0);
        ctx.restore();
      }
    }
    const main = this.ctx;
    main.save();
    main.setTransform(1, 0, 0, 1, 0, 0);
    main.globalAlpha = op;
    main.drawImage(lay, 0, 0);
    main.restore();
  }

  drawLayout(L, E) {
    const { ctx } = this;
    const z = this.view.zoom;
    const zr = E ? E.validation : null;
    const zmin = zr ? zr.zMin : 0, zmax = zr ? zr.zMax : 1;
    const span = Math.max(zmax - zmin, 0.5);
    const pxPerM = z / L.scale;
    const drawRoute = (k, i0, i1, outline) => {
      const r = L.routes[k];
      const zs = E ? E.routes[k].z : null;
      const n = r.n;
      const segs = [];
      for (let i = i0; i < i1; i++) {
        const a = ((i % n) + n) % n, b = (a + 1) % n;
        if (!r.closed && (i < 0 || i >= n - 1)) continue;
        segs.push([a, b]);
      }
      if (outline) {
        ctx.strokeStyle = '#0b0d12';
        ctx.lineCap = 'butt';
        for (const [a, b] of segs) {
          ctx.lineWidth = Math.max(3, r.w[a] * pxPerM) + 5;
          const [x0, y0] = this.routeScreen(L, r, a), [x1, y1] = this.routeScreen(L, r, b);
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        }
      }
      if (r.w[0] * pxPerM < 4) {
        // de lejos: trazos redondeados (siempre visibles)
        ctx.lineCap = 'round';
        for (const [a, b] of segs) {
          const t = zs ? (zs[a] - zmin) / span : 0.4;
          ctx.strokeStyle = zColor(t);
          ctx.lineWidth = Math.max(3, r.w[a] * pxPerM);
          const [x0, y0] = this.routeScreen(L, r, a), [x1, y1] = this.routeScreen(L, r, b);
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        }
      } else {
        // de cerca: la calzada exacta (cuadros entre los bordes), la misma forma que cubre la textura
        const toS = (x, y) => { const [lx, ly] = L.toLayout(x, y); return this.toScreen(lx, ly); };
        const edge = (i) => { const hw = r.w[i] / 2, lx = -r.ty[i], ly = r.tx[i]; return [toS(r.x[i] + lx * hw, r.y[i] + ly * hw), toS(r.x[i] - lx * hw, r.y[i] - ly * hw)]; };
        let prev = null;
        for (const [a, b] of segs) {
          const t = zs ? (zs[a] - zmin) / span : 0.4;
          const E0 = prev && prev.i === a ? prev.e : edge(a), E1 = edge(b);
          prev = { i: b, e: E1 };
          ctx.fillStyle = zColor(t);
          ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 1; ctx.lineJoin = 'round';
          ctx.beginPath(); ctx.moveTo(E0[0][0], E0[0][1]); ctx.lineTo(E0[1][0], E0[1][1]); ctx.lineTo(E1[1][0], E1[1][1]); ctx.lineTo(E1[0][0], E1[0][1]); ctx.closePath();
          ctx.fill(); ctx.stroke(); // el trazo fino tapa las costuras entre cuadros
        }
      }
      this.drawRouteTex(L, r, segs, pxPerM);
    };
    // camino de tierra (debajo de las calzadas)
    const EM = this.app.state.edgeMeshes;
    if (EM && EM.dirt.length) this.drawDirt2D(L, EM.dirt);
    // rutas completas
    L.routes.forEach((r, k) => drawRoute(k, 0, r.closed ? r.n : r.n - 1, false));
    // tramos superiores de cada cruce, encima y con borde
    if (E) {
      E.crossings.forEach((c) => {
        const upR = c.up === 'a' ? c.ra : c.rb;
        const upS = c.up === 'a' ? c.sa : c.sb;
        const r = L.routes[upR];
        const lc = L.crossings[c.id];
        const half = Math.ceil(((lc && lc.window) || 20) * 1.6 / r.ds);
        const ic = Math.round(upS / r.ds);
        drawRoute(upR, ic - half, ic + half, true);
      });
    }
    if (EM && EM.barriers.length) this.drawBarriers2D(L, EM.barriers, pxPerM);
    // línea central
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    L.routes.forEach((r) => {
      ctx.beginPath();
      for (let i = 0; i < r.n; i++) { const [x, y] = this.routeScreen(L, r, i); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      if (r.closed) ctx.closePath();
      ctx.stroke();
    });
    // zonas planas
    for (const zr2 of this.app.flatZonesS()) this.strokeRange(L, 0, zr2[0], zr2[1], 'rgba(120,230,255,0.75)', 3);
    // meta
    this.drawStart(L);
    // etiquetas de rutas alternativas
    ctx.font = '11px Inter, sans-serif';
    L.routes.forEach((r) => {
      if (r.kind !== 'alt') return;
      const i = Math.floor(r.n / 2);
      const [x, y] = this.routeScreen(L, r, i);
      ctx.fillStyle = 'rgba(14,17,23,0.85)';
      const t = r.name;
      const w = ctx.measureText(t).width + 8;
      ctx.fillRect(x - w / 2, y - 22, w, 16);
      ctx.fillStyle = r.altIndex === this.app.state.selAlt ? '#ffe066' : '#9fd4ff';
      ctx.fillText(t, x - w / 2 + 4, y - 10);
    });
    // marcadores de cruce
    this.markers = [];
    if (E) {
      E.crossings.forEach((c, idx) => {
        const [lx, ly] = L.toLayout(c.x, c.y);
        const [sx, sy] = this.toScreen(lx, ly);
        const mx = sx + 16, my = sy - 16;
        this.markers.push({ id: c.id, sx: mx, sy: my });
        const bad = !c.pinned && c.clearance < (c.hreq ?? (E.ep.clearance + E.ep.deck)) - 0.25;
        const selC = this.app.state.selCross === c.id;
        ctx.fillStyle = bad ? '#ff6b6b' : c.pinned ? '#c792ea' : c.autoUp ? '#f2a93b' : '#4fb3ff';
        ctx.beginPath(); ctx.arc(mx, my, selC ? 12 : 10, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = selC ? '#ffe066' : '#0b0d12'; ctx.lineWidth = selC ? 3 : 2; ctx.stroke();
        ctx.fillStyle = '#111';
        ctx.font = 'bold 11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(String(idx + 1), mx, my + 4);
        ctx.textAlign = 'left';
      });
    }
    // hover
    if (this.app.state.hover !== null && this.app.state.hover !== undefined) {
      const hv = this.app.state.hover;
      const r = L.routes[0];
      const i = Math.round(hv / r.ds) % r.n;
      if (i >= 0 && i < r.n) {
        const [x, y] = this.routeScreen(L, r, i);
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
  }

  strokeRange(L, k, s0, s1, color, width) {
    const { ctx } = this;
    const r = L.routes[k];
    const i0 = Math.floor(s0 / r.ds), i1 = Math.ceil(s1 / r.ds);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) {
      const ii = ((i % r.n) + r.n) % r.n;
      const [x, y] = this.routeScreen(L, r, ii);
      i === i0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  drawStart(L) {
    const { ctx } = this;
    const r = L.routes[0];
    const [x, y] = this.routeScreen(L, r, 0);
    // dirección en pantalla (y invertida entre mundo y lienzo)
    const tx = r.tx[0], ty = -r.ty[0];
    const nx = -ty, ny = tx;
    const hw = Math.max(8, (r.w[0] / L.scale) * this.view.zoom * 0.6);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(x - nx * hw, y - ny * hw); ctx.lineTo(x + nx * hw, y + ny * hw); ctx.stroke();
    ctx.strokeStyle = '#111';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(x - nx * hw, y - ny * hw); ctx.lineTo(x + nx * hw, y + ny * hw); ctx.stroke();
    ctx.setLineDash([]);
    // flecha
    const ax = x + tx * (hw + 18), ay = y + ty * (hw + 18);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x + tx * 8, y + ty * 8); ctx.lineTo(ax, ay);
    ctx.moveTo(ax, ay); ctx.lineTo(ax - tx * 8 + nx * 6, ay - ty * 8 + ny * 6);
    ctx.moveTo(ax, ay); ctx.lineTo(ax - tx * 8 - nx * 6, ay - ty * 8 - ny * 6);
    ctx.stroke();
  }
}
