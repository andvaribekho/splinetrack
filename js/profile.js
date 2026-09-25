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
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerleave', () => { if (!this.drag) { this.tip.hidden = true; this.app.setHover(null, 'profile'); } });
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    const up = () => {
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

  onDown(e) {
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
      const s0 = ((x - sc.f.x0) / (sc.f.x1 - sc.f.x0)) * sc.Lm;
      if (s0 >= 0 && s0 <= sc.Lm && this.app.enterEditAtS) this.app.enterEditAtS(0, s0);
      return;
    }
    if (this.hit(x, y)) return;
    const s = ((x - sc.f.x0) / (sc.f.x1 - sc.f.x0)) * sc.Lm;
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
    let zmin = v.zMin, zmax = v.zMax;
    const need = Math.max(4, (zmax - zmin) * 1.15);
    const mid = (zmax + zmin) / 2;
    zmin = mid - need / 2; zmax = mid + need / 2;
    const sx = (s) => f.x0 + (s / Lm) * (f.x1 - f.x0);
    const sy = (z) => f.y1 - ((z - zmin) / (zmax - zmin)) * (f.y1 - f.y0);
    const zAt = (y) => zmin + ((f.y1 - y) / (f.y1 - f.y0)) * (zmax - zmin);
    return { f, Lm, zmin, zmax, sx, sy, zAt };
  }

  onMove(e) {
    const sc = this.scales();
    if (!sc) return;
    const r = this.cv.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (this.box) { this.box.x1 = x; this.box.y1 = e.clientY - r.top; this.draw(); return; }
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
    const s = ((x - sc.f.x0) / (sc.f.x1 - sc.f.x0)) * sc.Lm;
    if (s < 0 || s > sc.Lm) { this.tip.hidden = true; this.app.setHover(null, 'profile'); return; }
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
    const { f, sx, sy, zmin, zmax, Lm } = sc;
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
    const sStep = niceStep(Lm / 8);
    for (let s = 0; s <= Lm; s += sStep) {
      const x = sx(s);
      ctx.beginPath(); ctx.moveTo(x, f.y0); ctx.lineTo(x, f.y1); ctx.stroke();
      ctx.fillText(`${s.toFixed(0)}`, x - 8, f.H - 6);
    }
    // zonas planas y meta
    ctx.fillStyle = 'rgba(120,230,255,0.07)';
    for (const [a, b] of this.app.flatZonesS()) ctx.fillRect(sx(a), f.y0, sx(b) - sx(a), f.y1 - f.y0);
    const sf = E.ep.startFlat;
    if (sf > 0 && L.routes[0].closed) {
      ctx.fillRect(sx(0), f.y0, sx(sf) - sx(0), f.y1 - f.y0);
      ctx.fillRect(sx(Lm - sf), f.y0, sx(Lm) - sx(Lm - sf), f.y1 - f.y0);
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
        this.handles.push({ x, y, key: pt.key, idx: pt.idx });
        const ms = this.app.state.selSet;
        const isSel = (sel && sel.key === pt.key && sel.idx === pt.idx) || (ms && ms.key === pt.key && ms.idxs.has(pt.idx));
        ctx.lineWidth = 2;
        if (pt.pin !== null) {
          ctx.fillStyle = isSel ? '#ffe066' : '#f2a93b';
          ctx.strokeStyle = '#3a2400';
          ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y); ctx.closePath();
          ctx.fill(); ctx.stroke();
        } else {
          ctx.fillStyle = isSel ? '#ffe066' : '#0e1117';
          ctx.strokeStyle = pt.k > 0 ? '#4fb3ff' : '#ffffff';
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
    // hover
    const hv = this.app.state.hover;
    if (hv !== null && hv !== undefined) {
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
