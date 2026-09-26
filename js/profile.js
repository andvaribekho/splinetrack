// Gráfico del perfil de elevación z(s) con cruces, zonas planas y pendientes fuera de rango.

export class ProfileView {
  constructor(canvas, app) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.app = app;
    this.tip = document.createElement('div');
    this.tip.className = 'tooltip';
    this.tip.hidden = true;
    document.body.appendChild(this.tip);
    this.pad = { l: 44, r: 12, t: 10, b: 22 };
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.handles = [];
    this.drag = null;
    this.frozen = null;
    this.view = null; // zoom / pan: {s0, s1, z0, z1} o null = encuadre automático
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // sin autodesplazamiento del navegador
    // rueda = zoom horizontal en el cursor; Shift + rueda = zoom vertical; botón medio = desplazar en X e Y
    canvas.addEventListener('wheel', (e) => {
      const sc = this.scales();
      if (!sc) return;
      e.preventDefault();
      const [x, y] = this.localPos(e);
      const d = e.deltaY || e.deltaX;
      const k = Math.exp(d * 0.0015);
      const v = this.view || { s0: sc.s0, s1: sc.s1, z0: sc.zmin, z1: sc.zmax };
      if (e.shiftKey) {
        const zc = sc.zAt(y), z0 = zc - (zc - v.z0) * k, z1 = zc + (v.z1 - zc) * k;
        if (z1 - z0 < 0.5 || z1 - z0 > 5000) return;
        this.view = { ...v, z0, z1 };
      } else {
        const sv = sc.sAt(x);
        let s0 = sv - (sv - v.s0) * k, s1 = sv + (v.s1 - sv) * k;
        const span = Math.min(sc.Lm * 1.1, Math.max(15, s1 - s0));
        if (s1 - s0 !== span) { const c = (s0 + s1) / 2; s0 = c - span / 2; s1 = c + span / 2; }
        this.view = this.clampS({ ...v, s0, s1 }, sc.Lm);
      }
      this.draw();
    }, { passive: false });
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerleave', () => { if (!this.drag) { this.tip.hidden = true; this.app.setHover(null, 'profile'); } });
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    const up = () => {
      if (this.pan) { this.pan = null; this.cv.style.cursor = 'default'; return; }
      if (this.selDrag) { // Perfil de tramo + Shift: elige el tramo
        const d = this.selDrag;
        this.selDrag = null; this.frozen = null;
        if (Math.abs(d.s1 - d.s0) >= 3) this.app.setProfileSelS(d.s0, d.s1); else this.app.setProfileSel(null);
        this.draw();
        return;
      }
      if (this.drawStroke) { // Perfil de tramo: aplica la forma dibujada
        const st = this.drawStroke;
        this.drawStroke = null; this.frozen = null;
        if (st.length >= 2) this.app.applyDrawnProfile(st);
        this.draw();
        return;
      }
      if (this.box) {
        const b = this.box;
        this.box = null;
        if (Math.abs(b.x1 - b.x0) + Math.abs(b.y1 - b.y0) > 4) {
          const [ax, bx] = [Math.min(b.x0, b.x1), Math.max(b.x0, b.x1)], [ay, by] = [Math.min(b.y0, b.y1), Math.max(b.y0, b.y1)];
          const inside = this.handles.filter((q) => q.x >= ax && q.x <= bx && q.y >= ay && q.y <= by);
          if (b.sub) this.app.subtractMultiSel(this.app.pickBest(inside)); else this.app.setMultiSel(this.app.pickBest(inside), b.add);
        } else if (b.hit) { if (b.sub) this.app.unpin(b.hit.key, b.hit.idx); else this.app.toggleMultiSel(b.hit); }
        this.draw();
        return;
      }
      if (this.drag) {
        const grp = this.group;
        this.drag = null; this.frozen = null; this.group = null;
        if (grp) this.app.endGroupDrag(); else this.app.endCtrlDrag();
        this.draw();
      }
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('dblclick', (e) => this.onDbl(e));
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.cv.width = Math.max(1, Math.round(r.width * this.dpr));
    this.cv.height = Math.max(1, Math.round(r.height * this.dpr));
    this.draw();
  }

  frame() {
    const r = this.cv.getBoundingClientRect();
    const { l, r: pr, t, b } = this.pad;
    return { x0: l, x1: r.width - pr, y0: t, y1: r.height - b, W: r.width, H: r.height };
  }

  localPos(e) {
    const r = this.cv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  hit(x, y) {
    let best = null, bd = 9;
    for (const h of this.handles) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }

  /** Mantiene la ventana horizontal dentro de la pista (con un pequeño margen). */
  clampS(v, Lm) {
    const m = Lm * 0.05, span = v.s1 - v.s0;
    let s0 = v.s0;
    if (s0 < -m) s0 = -m;
    if (s0 + span > Lm + m) s0 = Lm + m - span;
    return { ...v, s0, s1: s0 + span };
  }
  /** Vuelve al encuadre automático (todo el perfil y todos los puntos a la vista). */
  resetView() { this.view = null; this.frozen = null; this.draw(); }

  onDown(e) {
    if (e.button === 1) {
      // botón medio: desplazar la vista del perfil
      const sc = this.scales();
      if (!sc) return;
      e.preventDefault();
      const [x, y] = this.localPos(e);
      this.cv.setPointerCapture(e.pointerId);
      this.pan = { x, y, v: this.view || { s0: sc.s0, s1: sc.s1, z0: sc.zmin, z1: sc.zmax }, f: sc.f, Lm: sc.Lm };
      this.cv.style.cursor = 'grabbing';
      return;
    }
    if (this.app.state.tool === 'profile' && e.button === 0) {
      const sc = this.scales();
      if (!sc) return;
      const [x, y] = this.localPos(e);
      const sv = Math.max(0, Math.min(sc.Lm, sc.sAt(x)));
      this.cv.setPointerCapture(e.pointerId);
      this.frozen = sc; // la escala no cambia mientras se dibuja
      if (e.shiftKey) this.selDrag = { s0: sv, s1: sv };
      else this.drawStroke = [[sv, sc.zAt(y)]];
      this.draw();
      return;
    }
    if (this.app.state.tool !== 'edit') return;
    const [x, y] = this.localPos(e);
    const h = this.hit(x, y);
    if (e.button === 0 && e.altKey) {
      // Alt: arrastrar = caja que quita puntos de la selección; clic sobre un punto = altura automática
      this.cv.setPointerCapture(e.pointerId);
      this.box = { x0: x, y0: y, x1: x, y1: y, hit: h, sub: true };
      return;
    }
    if (e.button === 0 && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      // Shift: clic = sumar/quitar punto, arrastrar = caja de selección
      this.cv.setPointerCapture(e.pointerId);
      this.box = { x0: x, y0: y, x1: x, y1: y, hit: h, add: e.ctrlKey || e.metaKey };
      return;
    }
    // clic derecho con varios puntos seleccionados (sobre uno de ellos o en el vacío): todos vuelven a altura automática
    const ms = this.app.state.selSet;
    if (e.button === 2 && ms && ms.idxs.size > 1 && (!h || this.app.isMultiSelected(h.key, h.idx))) { this.app.unpinMany(ms.key, [...ms.idxs]); return; }
    if (!h) { if (e.button === 0 && this.app.state.selSet) this.app.clearMultiSel(); return; }
    if (e.button === 2 || e.altKey) { this.app.unpin(h.key, h.idx); return; }
    if (e.button !== 0) return;
    this.cv.setPointerCapture(e.pointerId);
    this.frozen = this.scales();
    if (this.app.isMultiSelected(h.key, h.idx) && this.app.beginGroupDrag()) {
      this.group = { y0: y };
      this.drag = h;
      return;
    }
    if (this.app.state.selSet) this.app.clearMultiSel();
    this.drag = h;
    this.app.beginPinDrag(h.key, h.idx);
  }

  onDbl(e) {
    const sc = this.scales();
    if (!sc) return;
    const [x, y] = this.localPos(e);
    if (this.app.state.tool !== 'edit') {
      // doble clic fuera de «Editar puntos»: entra al modo edición con el punto más cercano a esa posición
      const s0 = sc.sAt(x);
      if (s0 >= 0 && s0 <= sc.Lm && this.app.enterEditAtS) this.app.enterEditAtS(0, s0);
      return;
    }
    if (this.hit(x, y)) return;
    const s = sc.sAt(x);
    if (s < 0 || s > sc.Lm) return;
    this.app.insertCtrlAtS(0, s, sc.zAt(y));
  }

  scales() {
    if (this.frozen) return this.frozen;
    const L = this.app.state.layout, E = this.app.state.result;
    if (!L || !E) return null;
    const f = this.frame();
    const Lm = L.routes[0].L;
    const v = E.validation;
    let zmin = v.zMin, zmax = v.zMax, s0 = 0, s1 = Lm;
    if (this.view) { s0 = this.view.s0; s1 = this.view.s1; zmin = this.view.z0; zmax = this.view.z1; }
    else {
      const GL = this.app.state.groundLine; // el nivel del suelo también entra en la escala (se ve la zanja)
      if (GL && GL.z.length) for (const z of GL.z) { if (Number.isFinite(z)) { zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); } }
      // y las alturas pedidas en los puntos (aunque la pista no las alcance): ningún punto queda fuera
      if (this.app.state.tool === 'edit') for (const pt of this.app.ctrlPoints()) { const z = pt.pin !== null ? pt.pin : pt.z; if (Number.isFinite(z)) { zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); } }
      const need = Math.max(4, (zmax - zmin) * 1.15);
      const mid = (zmax + zmin) / 2;
      zmin = mid - need / 2; zmax = mid + need / 2;
    }
    const sx = (s) => f.x0 + ((s - s0) / (s1 - s0)) * (f.x1 - f.x0);
    const sAt = (x) => s0 + ((x - f.x0) / (f.x1 - f.x0)) * (s1 - s0);
    const sy = (z) => f.y1 - ((z - zmin) / (zmax - zmin)) * (f.y1 - f.y0);
    const zAt = (y) => zmin + ((f.y1 - y) / (f.y1 - f.y0)) * (zmax - zmin);
    return { f, Lm, s0, s1, zmin, zmax, sx, sAt, sy, zAt };
  }

  onMove(e) {
    const sc = this.scales();
    if (!sc) return;
    const r = this.cv.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (this.pan) {
      const P = this.pan, y = e.clientY - r.top;
      const ds = ((x - P.x) / (P.f.x1 - P.f.x0)) * (P.v.s1 - P.v.s0), dz = ((y - P.y) / (P.f.y1 - P.f.y0)) * (P.v.z1 - P.v.z0);
      this.view = this.clampS({ s0: P.v.s0 - ds, s1: P.v.s1 - ds, z0: P.v.z0 + dz, z1: P.v.z1 + dz }, P.Lm);
      this.draw();
      return;
    }
    if (this.box) { this.box.x1 = x; this.box.y1 = e.clientY - r.top; this.draw(); return; }
    if (this.selDrag || this.drawStroke) {
      const sv = Math.max(0, Math.min(sc.Lm, sc.sAt(x)));
      if (this.selDrag) this.selDrag.s1 = sv;
      else { const last = this.drawStroke[this.drawStroke.length - 1]; if (Math.abs(sc.sx(sv) - sc.sx(last[0])) + Math.abs(sc.sy(sc.zAt(e.clientY - r.top)) - sc.sy(last[1])) > 1.5) this.drawStroke.push([sv, sc.zAt(e.clientY - r.top)]); }
      this.tip.hidden = false;
      this.tip.style.left = `${e.clientX + 12}px`;
      this.tip.style.top = `${e.clientY - 30}px`;
      this.tip.textContent = this.selDrag ? `tramo s ${Math.min(this.selDrag.s0, this.selDrag.s1).toFixed(0)}–${Math.max(this.selDrag.s0, this.selDrag.s1).toFixed(0)} m` : `s ${sv.toFixed(0)} m · z ${sc.zAt(e.clientY - r.top).toFixed(2)} m`;
      this.draw();
      return;
    }
    if (this.app.state.tool === 'profile') this.cv.style.cursor = 'crosshair';
    if (this.drag && this.group) {
      const dz = sc.zAt(e.clientY - r.top) - sc.zAt(this.group.y0);
      this.app.applyGroupDelta(0, 0, dz);
      this.tip.hidden = false;
      this.tip.style.left = `${e.clientX + 12}px`;
      this.tip.style.top = `${e.clientY - 30}px`;
      this.tip.textContent = `${dz >= 0 ? '+' : ''}${dz.toFixed(2)} m a ${this.app.state.selSet ? this.app.state.selSet.idxs.size : 0} puntos`;
      return;
    }
    if (this.drag) {
      const z = sc.zAt(e.clientY - r.top);
      this.app.setPin(this.drag.key, this.drag.idx, z);
      this.tip.hidden = false;
      this.tip.style.left = `${e.clientX + 12}px`;
      this.tip.style.top = `${e.clientY - 30}px`;
      this.tip.textContent = `altura fijada ${z.toFixed(2)} m`;
      return;
    }
    if (this.app.state.tool === 'edit') this.cv.style.cursor = this.hit(x, e.clientY - r.top) ? 'ns-resize' : 'default';
    const s = sc.sAt(x);
    if (s < 0 || s > sc.Lm || x < sc.f.x0 || x > sc.f.x1) { this.tip.hidden = true; this.app.setHover(null, 'profile'); return; }
    this.app.setHover(s, 'profile');
    const L = this.app.state.layout, E = this.app.state.result;
    const rt = L.routes[0];
    const i = Math.min(rt.n - 1, Math.round(s / rt.ds));
    const z = E.routes[0].z[i];
    const g = E.routes[0].grade ? E.routes[0].grade[i] : 0;
    this.tip.hidden = false;
    this.tip.style.left = `${e.clientX + 12}px`;
    this.tip.style.top = `${e.clientY - 30}px`;
    this.tip.textContent = `s ${s.toFixed(0)} m · z ${z.toFixed(2)} m · ${(g * 100).toFixed(1)} %`;
  }

  draw() {
    const { ctx, cv } = this;
    const dpr = this.dpr || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0e1117';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sc = this.scales();
    if (!sc) return;
    const { f, sx, sy, zmin, zmax, Lm, s0: vs0, s1: vs1 } = sc;
    const L = this.app.state.layout, E = this.app.state.result;
    // ejes
    ctx.font = '10px Inter, sans-serif';
    ctx.fillStyle = '#8b95a8';
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    const zStep = niceStep((zmax - zmin) / 4);
    for (let z = Math.ceil(zmin / zStep) * zStep; z <= zmax; z += zStep) {
      const y = sy(z);
      ctx.beginPath(); ctx.moveTo(f.x0, y); ctx.lineTo(f.x1, y); ctx.stroke();
      ctx.fillText(`${z.toFixed(zStep < 1 ? 1 : 0)} m`, 4, y + 3);
    }
    const sStep = niceStep((vs1 - vs0) / 8);
    for (let s = Math.max(0, Math.ceil(vs0 / sStep) * sStep); s <= Math.min(Lm, vs1); s += sStep) {
      const x = sx(s);
      ctx.beginPath(); ctx.moveTo(x, f.y0); ctx.lineTo(x, f.y1); ctx.stroke();
      ctx.fillText(`${s.toFixed(0)}`, x - 8, f.H - 6);
    }
    if (this.view) { ctx.fillStyle = 'rgba(255,224,102,0.8)'; ctx.fillText('zoom · «Encuadrar» vuelve a ver todo', f.x1 - 190, f.y0 + 10); ctx.fillStyle = '#8b95a8'; }
    // lo que sigue se dibuja solo dentro del área del gráfico (con zoom no invade los ejes)
    ctx.save();
    ctx.beginPath(); ctx.rect(f.x0 - 7, f.y0 - 7, f.x1 - f.x0 + 14, f.y1 - f.y0 + 14); ctx.clip();
    // zonas planas y meta
    ctx.fillStyle = 'rgba(120,230,255,0.07)';
    for (const [a, b] of this.app.flatZonesS()) ctx.fillRect(sx(a), f.y0, sx(b) - sx(a), f.y1 - f.y0);
    const sf = E.ep.startFlat;
    if (sf > 0 && L.routes[0].closed) {
      ctx.fillRect(sx(0), f.y0, sx(sf) - sx(0), f.y1 - f.y0);
      ctx.fillRect(sx(Lm - sf), f.y0, sx(Lm) - sx(Lm - sf), f.y1 - f.y0);
    }
    // nivel natural del suelo (café): bajo esta línea la pista va socavada
    const GL = this.app.state.groundLine;
    if (GL && GL.s.length > 1) {
      ctx.beginPath();
      GL.s.forEach((sv, k) => { const x = sx(sv), y = sy(Math.max(zmin, Math.min(zmax, GL.z[k]))); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.lineTo(sx(GL.s[GL.s.length - 1]), f.y1); ctx.lineTo(sx(GL.s[0]), f.y1); ctx.closePath();
      ctx.fillStyle = 'rgba(141,90,43,0.12)'; ctx.fill();
      ctx.beginPath();
      GL.s.forEach((sv, k) => { const x = sx(sv), y = sy(Math.max(zmin, Math.min(zmax, GL.z[k]))); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.strokeStyle = 'rgba(176,118,60,0.85)'; ctx.lineWidth = 1.2; ctx.stroke();
    }
    // tramos suspendidos: banda celeste
    for (const c of this.app.state.scene.suspRanges || []) { ctx.fillStyle = 'rgba(90,216,255,0.07)'; ctx.fillRect(sx(c.s0), f.y0, sx(c.s1) - sx(c.s0), f.y1 - f.y0); }
    // secciones socavadas: banda café
    for (const c of this.app.state.scene.cutRanges || []) { ctx.fillStyle = 'rgba(141,90,43,0.10)'; ctx.fillRect(sx(c.s0), f.y0, sx(c.s1) - sx(c.s0), f.y1 - f.y0); }
    // túneles (ruta principal): banda gris, techo del túnel sobre la calzada y su nombre
    {
      const TI = (this.app.state.tunnelInfo || []).filter((t) => t.k === 0 && Number.isFinite(t.s0) && Number.isFinite(t.s1));
      const r0t = L.routes[0], z0t = E.routes[0].z, hT = Math.max(2, (this.app.state.scene.tunnelHeight ?? 6));
      for (const t of TI) {
        const segs = t.s0 < 0 ? [[t.s0 + Lm, Lm], [0, t.s1]] : t.s1 > Lm ? [[t.s0, Lm], [0, t.s1 - Lm]] : [[t.s0, t.s1]];
        for (const [a, b] of segs) {
          ctx.fillStyle = 'rgba(150,160,185,0.10)';
          ctx.fillRect(sx(a), f.y0, sx(b) - sx(a), f.y1 - f.y0);
          // interior del túnel: de la calzada al techo (calzada + altura libre); si el techo queda fuera del gráfico
          // se recorta arriba
          const i0 = Math.max(0, Math.floor(a / r0t.ds)), i1 = Math.min(r0t.n - 1, Math.ceil(b / r0t.ds));
          const top = (i) => sy(Math.min(zmax, z0t[i] + hT));
          ctx.beginPath();
          for (let i = i0; i <= i1; i++) { const x = sx(r0t.s[i]); if (i === i0) ctx.moveTo(x, top(i)); else ctx.lineTo(x, top(i)); }
          for (let i = i1; i >= i0; i--) ctx.lineTo(sx(r0t.s[i]), sy(z0t[i]));
          ctx.closePath();
          ctx.fillStyle = 'rgba(160,170,195,0.16)'; ctx.fill();
          ctx.strokeStyle = 'rgba(190,200,220,0.75)'; ctx.lineWidth = 1.4; ctx.setLineDash([5, 3]);
          ctx.beginPath();
          let pen = false;
          for (let i = i0; i <= i1; i++) {
            const zr = z0t[i] + hT;
            if (zr > zmax) { pen = false; continue; } // techo fuera del gráfico: no se dibuja la línea
            const x = sx(r0t.s[i]), y = sy(zr);
            if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
          }
          ctx.stroke(); ctx.setLineDash([]);
          // bocas
          ctx.strokeStyle = 'rgba(190,200,220,0.55)'; ctx.lineWidth = 1;
          for (const sv of [a, b]) { if ((sv === 0 && t.s0 < 0) || (sv === Lm && t.s1 > Lm)) continue; const i = Math.min(r0t.n - 1, Math.max(0, Math.round(sv / r0t.ds))); ctx.beginPath(); ctx.moveTo(sx(sv), sy(z0t[i])); ctx.lineTo(sx(sv), sy(Math.min(zmax, z0t[i] + hT))); ctx.stroke(); }
        }
        const mid = ((t.s0 + t.s1) / 2 + Lm) % Lm;
        ctx.fillStyle = 'rgba(200,210,230,0.85)'; ctx.font = '10px Inter, sans-serif';
        const lbl = `${t.name || `túnel ${t.id + 1}`} · ${hT} m`;
        ctx.fillText(lbl, sx(mid) - ctx.measureText(lbl).width / 2, f.y0 + 22);
      }
    }
    // perfiles dibujados (violeta) y tramo elegido para dibujar (amarillo suave)
    for (const Z of this.app.profileZonesS ? this.app.profileZonesS() : []) {
      ctx.fillStyle = 'rgba(186,120,255,0.08)';
      ctx.fillRect(sx(Z.s0), f.y0, sx(Z.s1) - sx(Z.s0), f.y1 - f.y0);
      ctx.strokeStyle = 'rgba(186,120,255,0.75)'; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]);
      ctx.beginPath();
      Z.pts.forEach(([t, z], k) => { const x = sx(Z.s0 + t * (Z.s1 - Z.s0)), y = sy(z); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke(); ctx.setLineDash([]);
    }
    const selT = this.selDrag ? [Math.min(this.selDrag.s0, this.selDrag.s1), Math.max(this.selDrag.s0, this.selDrag.s1)] : this.app.profileSelS ? this.app.profileSelS() : null;
    if (selT) {
      ctx.fillStyle = 'rgba(255,224,102,0.07)';
      ctx.fillRect(sx(selT[0]), f.y0, sx(selT[1]) - sx(selT[0]), f.y1 - f.y0);
      ctx.strokeStyle = 'rgba(255,224,102,0.5)'; ctx.lineWidth = 1;
      for (const sv of selT) { ctx.beginPath(); ctx.moveTo(sx(sv), f.y0); ctx.lineTo(sx(sv), f.y1); ctx.stroke(); }
    }
    // cruces
    ctx.lineWidth = 1;
    E.crossings.forEach((c, idx) => {
      const marks = [];
      if (c.ra === 0) marks.push([c.sa, c.up === 'a' ? '↑' : '↓']);
      if (c.rb === 0) marks.push([c.sb, c.up === 'b' ? '↑' : '↓']);
      for (const [s, arrow] of marks) {
        const x = sx(s);
        ctx.strokeStyle = 'rgba(242,169,59,0.45)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x, f.y0); ctx.lineTo(x, f.y1); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#f2a93b';
        ctx.fillText(`${idx + 1}${arrow}`, x + 3, f.y0 + 10);
      }
    });
    // rutas alternativas (sobre el eje de la principal, desde la bifurcación)
    L.routes.forEach((r, k) => {
      if (k === 0) return;
      const z = E.routes[k].z;
      ctx.strokeStyle = 'rgba(79,179,255,0.8)';
      ctx.setLineDash([5, 3]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const span = ((r.mergeS - r.forkS + Lm) % Lm) || r.L;
      let prevS = null;
      for (let i = 0; i < r.n; i++) {
        let s = r.forkS + (r.s[i] / r.L) * span;
        if (s > Lm) s -= Lm;
        const x = sx(s), y = sy(z[i]);
        if (prevS === null || Math.abs(s - prevS) > Lm / 2) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        prevS = s;
      }
      ctx.stroke();
      ctx.setLineDash([]);
    });
    // ruta principal, roja donde excede pendiente
    const r0 = L.routes[0], e0 = E.routes[0];
    const gmax = E.ep.maxGrade / 100;
    ctx.lineWidth = 2;
    for (let i = 0; i < r0.n - 1; i++) {
      const bad = e0.grade && Math.abs(e0.grade[i]) > gmax * 1.05;
      ctx.strokeStyle = bad ? '#ff6b6b' : '#f2a93b';
      ctx.beginPath();
      ctx.moveTo(sx(r0.s[i]), sy(e0.z[i]));
      ctx.lineTo(sx(r0.s[i + 1]), sy(e0.z[i + 1]));
      ctx.stroke();
    }
    if (r0.closed) {
      ctx.beginPath(); ctx.moveTo(sx(r0.s[r0.n - 1]), sy(e0.z[r0.n - 1])); ctx.lineTo(sx(Lm), sy(e0.z[0])); ctx.stroke();
    }
    // puntos de control (herramienta Editar puntos)
    this.handles = [];
    if (this.app.state.tool === 'edit') {
      const sel = this.app.state.sel;
      for (const pt of this.app.ctrlPoints()) {
        let s = pt.s;
        if (pt.k > 0) {
          const r = L.routes[pt.k];
          const span = ((r.mergeS - r.forkS + Lm) % Lm) || r.L;
          s = r.forkS + (pt.s / r.L) * span;
          if (s > Lm) s -= Lm;
        }
        const x = sx(s), y = sy(pt.pin !== null ? pt.pin : pt.z);
        if (x < f.x0 - 7 || x > f.x1 + 7 || y < f.y0 - 7 || y > f.y1 + 7) continue; // fuera de la vista (zoom)
        this.handles.push({ x, y, key: pt.key, idx: pt.idx });
        const ms = this.app.state.selSet;
        const isSel = (sel && sel.key === pt.key && sel.idx === pt.idx) || (ms && ms.key === pt.key && ms.idxs.has(pt.idx));
        ctx.lineWidth = 2;
        const cut = pt.k === 0 && this.app.ctrlInCut && this.app.ctrlInCut(pt.key, pt.idx); // sección socavada: café
        const susp = !cut && pt.k === 0 && this.app.ctrlInSusp && this.app.ctrlInSusp(pt.key, pt.idx); // tramo suspendido: celeste
        if (pt.pin !== null) {
          // generada (modo directo): rombo con borde naranjo y relleno oscuro; editada a mano: rombo naranjo lleno
          ctx.fillStyle = isSel ? '#ffe066' : cut ? '#8d5a2b' : susp ? '#5ad8ff' : pt.gen ? '#4a3414' : '#f2a93b';
          ctx.strokeStyle = cut || susp || pt.gen ? '#f2a93b' : '#3a2400';
          ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y); ctx.closePath();
          ctx.fill(); ctx.stroke();
        } else {
          ctx.fillStyle = isSel ? '#ffe066' : cut ? '#8d5a2b' : susp ? '#5ad8ff' : '#0e1117';
          ctx.strokeStyle = pt.k > 0 ? '#4fb3ff' : cut ? '#c89060' : susp ? '#bff0ff' : '#ffffff';
          ctx.beginPath(); ctx.arc(x, y, isSel ? 5 : 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
      }
    }
    if (this.box && Math.abs(this.box.x1 - this.box.x0) + Math.abs(this.box.y1 - this.box.y0) > 4) {
      const b = this.box;
      ctx.strokeStyle = 'rgba(255,224,102,0.9)';
      ctx.fillStyle = 'rgba(255,224,102,0.08)';
      ctx.setLineDash([5, 4]);
      ctx.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      ctx.strokeRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      ctx.setLineDash([]);
    }
    // trazo del perfil que se está dibujando
    if (this.drawStroke && this.drawStroke.length > 1) {
      ctx.strokeStyle = '#c792ff'; ctx.lineWidth = 2.5;
      ctx.beginPath();
      this.drawStroke.forEach(([sv, z], k) => { const x = sx(sv), y = sy(z); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke();
    }
    ctx.restore();
    // hover
    const hv = this.app.state.hover;
    if (hv !== null && hv !== undefined && sx(hv) >= f.x0 && sx(hv) <= f.x1) {
      const x = sx(hv);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.beginPath(); ctx.moveTo(x, f.y0); ctx.lineTo(x, f.y1); ctx.stroke();
      const i = Math.min(r0.n - 1, Math.round(hv / r0.ds));
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(x, sy(e0.z[i]), 4, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
