// Exportadores: Blender (.py), 3ds Max (.ms), JSON y OBJ.
// Convención: metros, Z arriba, X/Y en planta (Y positivo = "arriba" en la imagen original).

export const DEFAULT_EXPORT = {
  knotSpacing: 10, // m entre nudos Bézier (se reduce en curvas cerradas)
  edges: true, // exportar bordes izquierdo/derecho como splines aparte
  bankSign: 1, // 1 o -1 para invertir el signo del peralte en Blender
  blenderMesh: true, // el script de Blender crea un perfil y lo usa como bevel
};

const f3 = (v) => (Math.abs(v) < 5e-5 ? '0' : v.toFixed(4));

/** Datos 3D por muestra: posición, ancho, roll, pendiente. */
export function routeSamples(layout, elev, k) {
  const r = layout.routes[k];
  const e = elev.routes[k];
  const pts = [];
  for (let i = 0; i < r.n; i++) {
    pts.push({ x: r.x[i], y: r.y[i], z: e.z[i], w: r.w[i], roll: e.roll[i], s: r.s[i], grade: e.grade ? e.grade[i] : 0 });
  }
  return pts;
}

/** Bordes izquierdo/derecho con peralte aplicado. */
export function edgeSamples(layout, elev, k) {
  const r = layout.routes[k];
  const e = elev.routes[k];
  const left = [], right = [];
  for (let i = 0; i < r.n; i++) {
    const lx = -r.ty[i], ly = r.tx[i];
    const c = Math.cos(e.roll[i]), s = Math.sin(e.roll[i]);
    const hw = r.w[i] / 2;
    const ox = lx * c * hw, oy = ly * c * hw, oz = s * hw;
    left.push({ x: r.x[i] + ox, y: r.y[i] + oy, z: e.z[i] + oz });
    right.push({ x: r.x[i] - ox, y: r.y[i] - oy, z: e.z[i] - oz });
  }
  return { left, right };
}

/** Elige nudos (adaptativo a curvatura) y calcula handles Bézier desde muestras densas. */
export function bezierKnots(pts, closed, spacing, curv = null) {
  const n = pts.length;
  const idx = [0];
  let acc = 0;
  for (let i = 1; i < n; i++) {
    acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z);
    const k = curv ? Math.abs(curv[i]) : 0;
    const target = Math.max(spacing / 4, spacing / (1 + k * spacing * 2));
    if (acc >= target) { idx.push(i); acc = 0; }
  }
  if (closed) {
    // evita un último tramo demasiado corto
    const last = idx[idx.length - 1];
    const tail = Math.hypot(pts[0].x - pts[last].x, pts[0].y - pts[last].y);
    if (idx.length > 3 && tail < spacing * 0.35) idx.pop();
  } else if (idx[idx.length - 1] !== n - 1) {
    if (n - 1 - idx[idx.length - 1] < 2 && idx.length > 2) idx.pop();
    idx.push(n - 1);
  }
  const arc = (a, b) => {
    // longitud de arco entre índices a -> b (hacia adelante)
    let L = 0, i = a;
    while (i !== b) {
      const j = closed ? (i + 1) % n : i + 1;
      if (j >= n) break;
      L += Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y, pts[j].z - pts[i].z);
      i = j;
    }
    return L;
  };
  const deriv = (i) => {
    const a = closed ? (i - 1 + n) % n : Math.max(0, i - 1);
    const b = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
    const d = arc(a, b) || 1;
    return [(pts[b].x - pts[a].x) / d, (pts[b].y - pts[a].y) / d, (pts[b].z - pts[a].z) / d];
  };
  const m = idx.length;
  return idx.map((i, q) => {
    const p = pts[i];
    const t = deriv(i);
    const prev = q > 0 ? idx[q - 1] : closed ? idx[m - 1] : null;
    const next = q < m - 1 ? idx[q + 1] : closed ? idx[0] : null;
    const dl = prev !== null ? arc(prev, i) / 3 : arc(i, next) / 3;
    const dr = next !== null ? arc(i, next) / 3 : arc(prev, i) / 3;
    return {
      i, p,
      co: [p.x, p.y, p.z],
      hl: [p.x - t[0] * dl, p.y - t[1] * dl, p.z - t[2] * dl],
      hr: [p.x + t[0] * dr, p.y + t[1] * dr, p.z + t[2] * dr],
    };
  });
}

/** Desviación máxima entre la Bézier y las muestras (control de calidad). */
export function bezierError(pts, knots, closed) {
  let maxErr = 0;
  const m = knots.length;
  const segs = closed ? m : m - 1;
  for (let q = 0; q < segs; q++) {
    const A = knots[q], B = knots[(q + 1) % m];
    const n = pts.length;
    let i = A.i;
    const ids = [];
    while (i !== B.i) { ids.push(i); i = closed ? (i + 1) % n : i + 1; if (i >= n) break; }
    ids.push(B.i);
    const len = ids.length - 1;
    ids.forEach((id, k) => {
      const t = len ? k / len : 0;
      const u = 1 - t;
      const b = [0, 1, 2].map((c) => u * u * u * A.co[c] + 3 * u * u * t * A.hr[c] + 3 * u * t * t * B.hl[c] + t * t * t * B.co[c]);
      const p = pts[id];
      maxErr = Math.max(maxErr, Math.hypot(b[0] - p.x, b[1] - p.y, b[2] - p.z));
    });
  }
  return maxErr;
}

function collectCurves(layout, elev, opts) {
  const curves = [];
  layout.routes.forEach((r, k) => {
    const pts = routeSamples(layout, elev, k);
    const knots = bezierKnots(pts, r.closed, opts.knotSpacing, r.k);
    const err = bezierError(pts, knots, r.closed);
    curves.push({ name: r.name, closed: r.closed, knots, err, kind: r.kind, route: k });
    if (opts.edges) {
      const { left, right } = edgeSamples(layout, elev, k);
      for (const [side, arr] of [['izq', left], ['der', right]]) {
        const kn = bezierKnots(arr, r.closed, opts.knotSpacing, r.k);
        curves.push({ name: `${r.name}_borde_${side}`, closed: r.closed, knots: kn, err: bezierError(arr, kn, r.closed), kind: 'edge', route: k });
      }
    }
  });
  return curves;
}

export function exportBlender(layout, elev, optsIn = {}) {
  const opts = { ...DEFAULT_EXPORT, ...optsIn };
  const curves = collectCurves(layout, elev, opts);
  const lines = [];
  lines.push('# Track Spline Generator: script para Blender 3.x / 4.x');
  lines.push('# Uso: Scripting > Open > este archivo > Run Script.');
  lines.push('# Crea la colección "Track Spline" con curvas Bézier 3D (metros, Z arriba).');
  lines.push('# Ruta principal y atajos: radius = semiancho (m), tilt = peralte (rad).');
  lines.push('# Con CREAR_MALLA = True se asigna un perfil como bevel: la pista aparece con su ancho y peralte.');
  lines.push('import bpy');
  lines.push('');
  lines.push(`CREAR_MALLA = ${opts.blenderMesh ? 'True' : 'False'}`);
  lines.push(`SIGNO_PERALTE = ${opts.bankSign >= 0 ? '1.0' : '-1.0'}`);
  lines.push('');
  lines.push('# nombre: (cíclica, tipo, [(co, handle_izq, handle_der, radius, tilt), ...])');
  lines.push('CURVAS = {');
  for (const c of curves) {
    const withW = c.kind !== 'edge';
    lines.push(`    "${c.name}": (${c.closed ? 'True' : 'False'}, "${c.kind}", [`);
    for (const kn of c.knots) {
      const rad = withW ? kn.p.w / 2 : 1;
      const tilt = withW ? kn.p.roll : 0;
      lines.push(`        ((${kn.co.map(f3).join(', ')}), (${kn.hl.map(f3).join(', ')}), (${kn.hr.map(f3).join(', ')}), ${f3(rad)}, ${f3(tilt)}),`);
    }
    lines.push('    ]),');
  }
  lines.push('}');
  lines.push('');
  lines.push(`BLENDER_SCRIPT_BODY`);
  const body = `
def _escala():
    sl = bpy.context.scene.unit_settings.scale_length
    return 1.0 / sl if sl else 1.0


def crear_perfil(col):
    cu = bpy.data.curves.new("TSG_perfil_pista", "CURVE")
    cu.dimensions = "2D"
    sp = cu.splines.new("POLY")
    sp.points.add(1)
    sp.points[0].co = (-1.0, 0.0, 0.0, 1.0)
    sp.points[1].co = (1.0, 0.0, 0.0, 1.0)
    ob = bpy.data.objects.new("TSG_perfil_pista", cu)
    col.objects.link(ob)
    ob.hide_viewport = True
    ob.hide_render = True
    return ob


def crear_curva(col, nombre, ciclica, tipo, puntos, perfil, k):
    cu = bpy.data.curves.new(nombre, "CURVE")
    cu.dimensions = "3D"
    cu.twist_mode = "Z_UP"
    cu.resolution_u = 8
    sp = cu.splines.new("BEZIER")
    sp.bezier_points.add(len(puntos) - 1)
    for bp, (co, hl, hr, rad, tilt) in zip(sp.bezier_points, puntos):
        bp.co = tuple(v * k for v in co)
        bp.handle_left_type = "FREE"
        bp.handle_right_type = "FREE"
        bp.handle_left = tuple(v * k for v in hl)
        bp.handle_right = tuple(v * k for v in hr)
        bp.radius = rad * k
        bp.tilt = tilt * SIGNO_PERALTE
    sp.use_cyclic_u = ciclica
    if perfil is not None and tipo != "edge":
        cu.bevel_mode = "OBJECT"
        cu.bevel_object = perfil
        cu.use_fill_caps = False
    ob = bpy.data.objects.new(nombre, cu)
    col.objects.link(ob)
    return ob


def main():
    k = _escala()
    col = bpy.data.collections.get("Track Spline")
    if col is None:
        col = bpy.data.collections.new("Track Spline")
        bpy.context.scene.collection.children.link(col)
    perfil = crear_perfil(col) if CREAR_MALLA else None
    for nombre, (ciclica, tipo, puntos) in CURVAS.items():
        crear_curva(col, nombre, ciclica, tipo, puntos, perfil, k)
    print("Track Spline Generator: %d curvas creadas" % len(CURVAS))


main()
`;
  return lines.join('\n').replace('BLENDER_SCRIPT_BODY', body.trimStart());
}

export function exportMax(layout, elev, optsIn = {}) {
  const opts = { ...DEFAULT_EXPORT, ...optsIn };
  const curves = collectCurves(layout, elev, opts);
  const p3 = (v) => `[${v.map(f3).join(',')}]`;
  const L = [];
  L.push('-- Track Spline Generator: script para 3ds Max');
  L.push('-- Uso: Scripting > Run Script > este archivo.');
  L.push('-- Crea SplineShapes Bézier 3D. Las coordenadas vienen en metros y se convierten a las unidades del sistema.');
  L.push('-- Como Max no guarda ancho ni peralte por nudo, se exportan también los bordes izquierdo/derecho (si se activó)');
  L.push('-- y los valores por nudo quedan en las User Properties del objeto (anchos / peraltes, en metros y grados).');
  L.push('(');
  L.push('\tlocal esc = units.decodeValue "1m"');
  L.push('\tfn crearSpline nombre knots cerrada esc = (');
  L.push('\t\tlocal s = SplineShape name:nombre');
  L.push('\t\tlocal idx = addNewSpline s');
  L.push('\t\tfor k in knots do addKnot s idx #bezier #curve (k[1]*esc) (k[2]*esc) (k[3]*esc)');
  L.push('\t\tif cerrada do close s idx');
  L.push('\t\tupdateShape s');
  L.push('\t\ts');
  L.push('\t)');
  L.push('\tlocal capa = LayerManager.getLayerFromName "Track Spline"');
  L.push('\tif capa == undefined do capa = LayerManager.newLayerFromName "Track Spline"');
  curves.forEach((c, ci) => {
    L.push(`\t-- ${c.name}`);
    L.push(`\tlocal k${ci} = #(`);
    c.knots.forEach((kn, q) => {
      L.push(`\t\t#(${p3(kn.co)},${p3(kn.hl)},${p3(kn.hr)})${q < c.knots.length - 1 ? ',' : ''}`);
    });
    L.push('\t)');
    L.push(`\tlocal s${ci} = crearSpline "${c.name}" k${ci} ${c.closed ? 'true' : 'false'} esc`);
    L.push(`\tcapa.addNode s${ci}`);
    if (c.kind !== 'edge') {
      const ws = c.knots.map((kn) => kn.p.w.toFixed(2)).join(' ');
      const bs = c.knots.map((kn) => ((kn.p.roll * 180) / Math.PI).toFixed(2)).join(' ');
      L.push(`\tsetUserProp s${ci} "anchos_m" "${ws}"`);
      L.push(`\tsetUserProp s${ci} "peraltes_grados" "${bs}"`);
    }
  });
  L.push('\tformat "Track Spline Generator: % splines creadas\\n" ' + curves.length);
  L.push(')');
  return L.join('\n');
}

export function exportJSON(layout, elev, project, params) {
  const routes = layout.routes.map((r, k) => ({
    name: r.name,
    kind: r.kind,
    closed: r.closed,
    length_m: +r.L.toFixed(3),
    fork_s: r.kind === 'alt' ? +r.forkS.toFixed(3) : undefined,
    merge_s: r.kind === 'alt' ? +r.mergeS.toFixed(3) : undefined,
    points: routeSamples(layout, elev, k).map((p) => ({
      s: +p.s.toFixed(3), x: +p.x.toFixed(4), y: +p.y.toFixed(4), z: +p.z.toFixed(4),
      width: +p.w.toFixed(3), roll_rad: +p.roll.toFixed(5), grade: +p.grade.toFixed(5),
    })),
  }));
  return JSON.stringify({
    generator: 'Track Spline Generator',
    units: 'meters',
    up_axis: 'Z',
    routes,
    crossings: elev.crossings.map((c) => ({
      id: c.id,
      upper: { route: layout.routes[c.up === 'a' ? c.ra : c.rb].name, s: +(c.up === 'a' ? c.sa : c.sb).toFixed(3) },
      lower: { route: layout.routes[c.up === 'a' ? c.rb : c.ra].name, s: +(c.up === 'a' ? c.sb : c.sa).toFixed(3) },
      type: c.type,
      clearance_m: +c.clearance.toFixed(3),
    })),
    params,
    project,
  }, null, 1);
}

export function exportOBJ(layout, elev, optsIn = {}) {
  const opts = { ...DEFAULT_EXPORT, ...optsIn };
  const L = ['# Track Spline Generator: polilíneas 3D', '# Escrito en Y arriba (convención OBJ): importar con ejes por defecto en Blender / 3ds Max deja Z arriba.', '# Unidades: metros'];
  let base = 1;
  const emit = (name, arr, closed) => {
    L.push(`o ${name}`);
    for (const p of arr) L.push(`v ${f3(p.x)} ${f3(p.z)} ${f3(-p.y)}`);
    const ids = arr.map((_, i) => base + i);
    if (closed) ids.push(base);
    L.push('l ' + ids.join(' '));
    base += arr.length;
  };
  layout.routes.forEach((r, k) => {
    emit(r.name, routeSamples(layout, elev, k), r.closed);
    if (opts.edges) {
      const { left, right } = edgeSamples(layout, elev, k);
      emit(`${r.name}_borde_izq`, left, r.closed);
      emit(`${r.name}_borde_der`, right, r.closed);
    }
  });
  return L.join('\n') + '\n';
}
