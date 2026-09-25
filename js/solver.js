// Solver QP tipo OSQP (ADMM) especializado:
//   min ½ xᵀPx + qᵀx   s.a.  l ≤ Ax ≤ u
// P y AᵀρA se arman como "banda pentadiagonal + bajo rango" y se resuelven con Cholesky en banda + Woodbury.
// Suficiente para perfiles de elevación de miles de muestras en decenas de milisegundos.

const BIG = 1e20;

/**
 * n: nº de variables
 * blocks: [{offset, n}] — la banda no cruza bloques
 * objRows: [{idx:[], coef:[], w}]  (término w·(a·x)² en ½xᵀPx → aporta w·a aᵀ a P)
 * diag: Float64Array(n) diagonal adicional de P
 * q: Float64Array(n)
 * cons: [{idx:[], coef:[], l, u}]
 */
export function solveQP({ n, blocks, objRows, diag, q, cons, x0, maxIter = 4000, epsAbs = 1e-3, epsRel = 1e-4 }) {
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  const blockOf = new Int32Array(n);
  for (let b = 0; b < blocks.length; b++) for (let i = 0; i < blocks[b].n; i++) blockOf[blocks[b].offset + i] = b;
  const isLocal = (row) => {
    let mn = Infinity, mx = -Infinity;
    for (const i of row.idx) { if (i < mn) mn = i; if (i > mx) mx = i; }
    return mx - mn <= 2 && blockOf[mn] === blockOf[mx];
  };
  const m = cons.length;
  const l = new Float64Array(m), u = new Float64Array(m);
  const rho = new Float64Array(m);
  let rhoBase = 0.4;
  const setRho = () => {
    for (let k = 0; k < m; k++) {
      l[k] = cons[k].l ?? -BIG;
      u[k] = cons[k].u ?? BIG;
      const eq = Math.abs(u[k] - l[k]) < 1e-9;
      rho[k] = eq ? rhoBase * 1e3 : rhoBase;
    }
  };
  setRho();
  const sigma = 1e-6;
  const alpha = 1.6;
  const objLocal = objRows.filter(isLocal), objFar = objRows.filter((r) => !isLocal(r));
  const conLocal = [], conFar = [];
  cons.forEach((c, k) => (isLocal(c) ? conLocal : conFar).push(k));

  let fac = null;
  const factor = () => {
    const d0 = new Float64Array(n), d1 = new Float64Array(n), d2 = new Float64Array(n);
    for (let i = 0; i < n; i++) d0[i] = diag[i] + sigma;
    const addBand = (row, w) => {
      const { idx, coef } = row;
      for (let a = 0; a < idx.length; a++) for (let b = 0; b < idx.length; b++) {
        const i = idx[a], j = idx[b];
        if (j < i) continue;
        const v = w * coef[a] * coef[b] * (i === j ? 1 : 1);
        if (i === j) d0[i] += v; else if (j - i === 1) d1[i] += v; else if (j - i === 2) d2[i] += v;
      }
    };
    for (const r of objLocal) addBand(r, r.w);
    for (const k of conLocal) addBand(cons[k], rho[k]);
    // Cholesky en banda (ancho 2)
    const l0 = new Float64Array(n), l1 = new Float64Array(n), l2 = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      const a1 = j >= 1 ? l1[j - 1] : 0, a2 = j >= 2 ? l2[j - 2] : 0;
      const v = d0[j] - a1 * a1 - a2 * a2;
      l0[j] = Math.sqrt(Math.max(v, 1e-12));
      l1[j] = (d1[j] - (j >= 1 ? l2[j - 1] * l1[j - 1] : 0)) / l0[j];
      l2[j] = d2[j] / l0[j];
    }
    const bandSolve = (b, out) => {
      const y = out;
      for (let j = 0; j < n; j++) {
        let v = b[j];
        if (j >= 1) v -= l1[j - 1] * y[j - 1];
        if (j >= 2) v -= l2[j - 2] * y[j - 2];
        y[j] = v / l0[j];
      }
      for (let j = n - 1; j >= 0; j--) {
        let v = y[j];
        if (j + 1 < n) v -= l1[j] * y[j + 1];
        if (j + 2 < n) v -= l2[j] * y[j + 2];
        y[j] = v / l0[j];
      }
      return y;
    };
    // Columnas de bajo rango
    const U = [];
    for (const r of objFar) U.push({ idx: r.idx, coef: r.coef.map((c) => c * Math.sqrt(r.w)) });
    for (const k of conFar) U.push({ idx: cons[k].idx, coef: cons[k].coef.map((c) => c * Math.sqrt(rho[k])) });
    const r = U.length;
    const Y = new Float64Array(r * n);
    const tmp = new Float64Array(n);
    for (let c = 0; c < r; c++) {
      tmp.fill(0);
      U[c].idx.forEach((i, a) => (tmp[i] += U[c].coef[a]));
      const col = Y.subarray(c * n, (c + 1) * n);
      bandSolve(tmp, col);
    }
    const S = new Float64Array(r * r);
    for (let a = 0; a < r; a++) {
      for (let b = 0; b < r; b++) {
        let v = a === b ? 1 : 0;
        const col = Y.subarray(b * n, (b + 1) * n);
        U[a].idx.forEach((i, t) => (v += U[a].coef[t] * col[i]));
        S[a * r + b] = v;
      }
    }
    // Cholesky denso de S
    const Ls = new Float64Array(r * r);
    for (let i = 0; i < r; i++) {
      for (let j = 0; j <= i; j++) {
        let s = S[i * r + j];
        for (let k = 0; k < j; k++) s -= Ls[i * r + k] * Ls[j * r + k];
        if (i === j) Ls[i * r + i] = Math.sqrt(Math.max(s, 1e-12));
        else Ls[i * r + j] = s / Ls[j * r + j];
      }
    }
    const tv = new Float64Array(r);
    const solve = (b, out) => {
      bandSolve(b, out);
      if (r === 0) return out;
      for (let c = 0; c < r; c++) {
        let v = 0;
        U[c].idx.forEach((i, a) => (v += U[c].coef[a] * out[i]));
        tv[c] = v;
      }
      for (let i = 0; i < r; i++) {
        let s = tv[i];
        for (let k = 0; k < i; k++) s -= Ls[i * r + k] * tv[k];
        tv[i] = s / Ls[i * r + i];
      }
      for (let i = r - 1; i >= 0; i--) {
        let s = tv[i];
        for (let k = i + 1; k < r; k++) s -= Ls[k * r + i] * tv[k];
        tv[i] = s / Ls[i * r + i];
      }
      for (let c = 0; c < r; c++) {
        const v = tv[c];
        if (v === 0) continue;
        const col = Y.subarray(c * n, (c + 1) * n);
        for (let i = 0; i < n; i++) out[i] -= col[i] * v;
      }
      return out;
    };
    fac = { solve, rank: r };
  };

  const Ax = (x, out) => {
    for (let k = 0; k < m; k++) {
      const { idx, coef } = cons[k];
      let v = 0;
      for (let a = 0; a < idx.length; a++) v += coef[a] * x[idx[a]];
      out[k] = v;
    }
    return out;
  };
  const ATy = (y, out) => {
    out.fill(0);
    for (let k = 0; k < m; k++) {
      const { idx, coef } = cons[k];
      const yk = y[k];
      if (yk === 0) continue;
      for (let a = 0; a < idx.length; a++) out[idx[a]] += coef[a] * yk;
    }
    return out;
  };
  const Px = (x, out) => {
    for (let i = 0; i < n; i++) out[i] = diag[i] * x[i];
    for (const r of objRows) {
      let v = 0;
      for (let a = 0; a < r.idx.length; a++) v += r.coef[a] * x[r.idx[a]];
      v *= r.w;
      for (let a = 0; a < r.idx.length; a++) out[r.idx[a]] += r.coef[a] * v;
    }
    return out;
  };

  factor();
  const x = x0 ? Float64Array.from(x0) : new Float64Array(n);
  const z = new Float64Array(m), y = new Float64Array(m);
  Ax(x, z);
  for (let k = 0; k < m; k++) z[k] = Math.min(u[k], Math.max(l[k], z[k]));
  const rhs = new Float64Array(n), xt = new Float64Array(n), zt = new Float64Array(m);
  const tmpN = new Float64Array(n), tmpM = new Float64Array(m), tmpN2 = new Float64Array(n);
  let status = 'max_iter', it = 0, rp = 0, rd = 0, refactors = 0;
  for (it = 1; it <= maxIter; it++) {
    for (let k = 0; k < m; k++) tmpM[k] = rho[k] * z[k] - y[k];
    ATy(tmpM, tmpN);
    for (let i = 0; i < n; i++) rhs[i] = sigma * x[i] - q[i] + tmpN[i];
    fac.solve(rhs, xt);
    Ax(xt, zt);
    for (let i = 0; i < n; i++) x[i] = alpha * xt[i] + (1 - alpha) * x[i];
    for (let k = 0; k < m; k++) {
      const zr = alpha * zt[k] + (1 - alpha) * z[k];
      const zn = Math.min(u[k], Math.max(l[k], zr + y[k] / rho[k]));
      y[k] += rho[k] * (zr - zn);
      z[k] = zn;
    }
    if (it % 10 === 0 || it === maxIter) {
      Ax(x, tmpM);
      let axn = 0, zn = 0;
      rp = 0;
      for (let k = 0; k < m; k++) {
        rp = Math.max(rp, Math.abs(tmpM[k] - z[k]));
        axn = Math.max(axn, Math.abs(tmpM[k]));
        zn = Math.max(zn, Math.abs(z[k]));
      }
      Px(x, tmpN);
      ATy(y, tmpN2);
      let pxn = 0, atyn = 0, qn = 0;
      rd = 0;
      for (let i = 0; i < n; i++) {
        rd = Math.max(rd, Math.abs(tmpN[i] + q[i] + tmpN2[i]));
        pxn = Math.max(pxn, Math.abs(tmpN[i]));
        atyn = Math.max(atyn, Math.abs(tmpN2[i]));
        qn = Math.max(qn, Math.abs(q[i]));
      }
      const epsP = epsAbs + epsRel * Math.max(axn, zn);
      const epsD = epsAbs + epsRel * Math.max(pxn, atyn, qn);
      if (rp <= epsP && rd <= epsD) { status = 'solved'; break; }
      // rho adaptativo
      if (it % 100 === 0 && refactors < 8) {
        const ratio = Math.sqrt((rp / Math.max(axn, zn, 1e-9)) / Math.max(rd / Math.max(pxn, atyn, qn, 1e-9), 1e-12));
        if (ratio > 5 || ratio < 0.2) {
          const nb = Math.min(1e6, Math.max(1e-6, rhoBase * ratio));
          const scale = nb / rhoBase;
          rhoBase = nb;
          for (let k = 0; k < m; k++) rho[k] *= scale;
          factor();
          refactors++;
        }
      }
    }
  }
  const now = (typeof performance !== 'undefined' ? performance : Date).now();
  return { x, status, iter: Math.min(it, maxIter), primalRes: rp, dualRes: rd, ms: now - t0, rank: fac.rank };
}
