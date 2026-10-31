// Geometry and pose for the home page's schematic arm (TwinScene). Pure functions, no WebGL, so the
// pose maths is unit-tested. Matrices are column-major Float32Arrays, the layout WebGL expects.
// The arm is an illustration of the scenario's machine, not the twin's render: proportions are
// schematic, and only the vibration frequency and the residual ratio come from a recorded run.

export type Mat4 = Float32Array;
export type Vec3 = [number, number, number];

export function identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      o[c * 4 + r] = s;
    }
  }
  return o;
}

export const chain = (...ms: Mat4[]): Mat4 => ms.reduce((acc, m) => multiply(acc, m), identity());

export function translation(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

export function rotationX(a: number): Mat4 {
  const m = identity();
  const c = Math.cos(a);
  const s = Math.sin(a);
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
}

export function rotationY(a: number): Mat4 {
  const m = identity();
  const c = Math.cos(a);
  const s = Math.sin(a);
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}

export function rotationZ(a: number): Mat4 {
  const m = identity();
  const c = Math.cos(a);
  const s = Math.sin(a);
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
  return m;
}

export function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

export function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const z = norm(sub(eye, target));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  const m = identity();
  m[0] = x[0];
  m[4] = x[1];
  m[8] = x[2];
  m[1] = y[0];
  m[5] = y[1];
  m[9] = y[2];
  m[2] = z[0];
  m[6] = z[1];
  m[10] = z[2];
  m[12] = -dot(x, eye);
  m[13] = -dot(y, eye);
  m[14] = -dot(z, eye);
  return m;
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  const [x, y, z] = p;
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  return [(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w, (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w, (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) / w];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function norm(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Solid triangles (positions, normals, indices) plus the hard edges drawn as blueprint lines. */
export interface Mesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint16Array;
  edges: Float32Array;
}

/** An axis-aligned box of size (sx, sy, sz) centred at (ox, oy, oz). */
export function box(sx: number, sy: number, sz: number, ox = 0, oy = 0, oz = 0): Mesh {
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  // Each face: normal, then four corners counter-clockwise seen from outside.
  const faces: [Vec3, Vec3[]][] = [
    [[1, 0, 0], [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]]],
    [[-1, 0, 0], [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]]],
    [[0, 1, 0], [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]]],
    [[0, -1, 0], [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]]],
    [[0, 0, 1], [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]]],
    [[0, 0, -1], [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]]],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  faces.forEach(([n, quad], f) => {
    for (const p of quad) {
      positions.push(p[0] + ox, p[1] + oy, p[2] + oz);
      normals.push(...n);
    }
    const b = f * 4;
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const c = (x: number, y: number, z: number) => [x * hx + ox, y * hy + oy, z * hz + oz];
  const edges: number[] = [];
  for (const s of [-1, 1]) {
    for (const t of [-1, 1]) {
      edges.push(...c(-1, s, t), ...c(1, s, t));
      edges.push(...c(s, -1, t), ...c(s, 1, t));
      edges.push(...c(s, t, -1), ...c(s, t, 1));
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint16Array(indices), edges: new Float32Array(edges) };
}

/** A capped cylinder of radius r and length len along the Y or Z axis, centred at (ox, oy, oz). */
export function cylinder(r: number, len: number, seg: number, axis: "y" | "z", ox = 0, oy = 0, oz = 0): Mesh {
  const h = len / 2;
  // Build along Y, then swap Y and Z for a Z-axis cylinder.
  const place = (x: number, y: number, z: number): Vec3 => (axis === "y" ? [x + ox, y + oy, z + oz] : [x + ox, z + oy, y + oz]);
  const dir = (x: number, y: number, z: number): Vec3 => (axis === "y" ? [x, y, z] : [x, z, y]);
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const edges: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const x = Math.cos(a);
    const z = Math.sin(a);
    positions.push(...place(x * r, -h, z * r), ...place(x * r, h, z * r));
    normals.push(...dir(x, 0, z), ...dir(x, 0, z));
    if (i < seg) {
      const b = i * 2;
      indices.push(b, b + 1, b + 3, b, b + 3, b + 2);
    }
  }
  for (const side of [-1, 1]) {
    const centre = positions.length / 3;
    positions.push(...place(0, side * h, 0));
    normals.push(...dir(0, side, 0));
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      positions.push(...place(Math.cos(a) * r, side * h, Math.sin(a) * r));
      normals.push(...dir(0, side, 0));
      if (i < seg) indices.push(...(side > 0 ? [centre, centre + i + 2, centre + i + 1] : [centre, centre + i + 1, centre + i + 2]));
    }
  }
  for (const side of [-1, 1]) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      edges.push(...place(Math.cos(a0) * r, side * h, Math.sin(a0) * r), ...place(Math.cos(a1) * r, side * h, Math.sin(a1) * r));
    }
  }
  for (let q = 0; q < 4; q++) {
    const a = (q / 4) * Math.PI * 2 + Math.PI / 4;
    edges.push(...place(Math.cos(a) * r, -h, Math.sin(a) * r), ...place(Math.cos(a) * r, h, Math.sin(a) * r));
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint16Array(indices), edges: new Float32Array(edges) };
}

/** Floor grid on y = 0 as line segments; major lines every `major` steps carry alpha 1, minor 0.45. */
export function grid(half: number, step: number, major: number): Float32Array {
  const out: number[] = [];
  const n = Math.round(half / step);
  for (let i = -n; i <= n; i++) {
    const v = i * step;
    const a = i % major === 0 ? 1 : 0.45;
    out.push(v, 0, -half, a, v, 0, half, a, -half, 0, v, a, half, 0, v, a);
  }
  return new Float32Array(out);
}

/** A closed ring of radius r in the local XY plane, as line segments. */
export function ring(r: number, seg: number): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    out.push(Math.cos(a0) * r, Math.sin(a0) * r, 0, Math.cos(a1) * r, Math.sin(a1) * r, 0);
  }
  return new Float32Array(out);
}

// Link lengths of the schematic arm, in scene units.
export const UPPER_LEN = 1.0;
export const FORE_LEN = 0.9;
export const SHOULDER_Y = 0.55;

export interface Pose {
  turret: Mat4;
  shoulder: Mat4;
  elbow: Mat4;
  wrist: Mat4;
  marker: Mat4;
}

/**
 * The arm at time t (s). `vib` is the elbow's oscillation amplitude in radians at `hz`; `sway`
 * adds the slow working motion. With sway off and vib 0 the pose is fixed, which is the
 * reduced-motion frame.
 */
export function armPose(t: number, vib: number, hz: number, sway: boolean): Pose {
  const yaw = sway ? 0.2 + 0.32 * Math.sin(2 * Math.PI * 0.05 * t) : 0.2;
  const pitch = 0.95 + (sway ? 0.07 * Math.sin(2 * Math.PI * 0.09 * t) : 0);
  const elbowAngle = -1.55 + (sway ? 0.06 * Math.sin(2 * Math.PI * 0.07 * t + 1) : 0) + vib * Math.sin(2 * Math.PI * hz * t);
  const turret = rotationY(yaw);
  const shoulder = chain(turret, translation(0, SHOULDER_Y, 0), rotationZ(pitch));
  const elbow = chain(shoulder, translation(UPPER_LEN, 0, 0), rotationZ(elbowAngle));
  const wrist = chain(elbow, translation(FORE_LEN, 0, 0), rotationZ(-0.6));
  const marker = chain(wrist, translation(0.11, 0, 0));
  return { turret, shoulder, elbow, wrist, marker };
}

/** Moves `cur` toward `target` with time constant `tau` seconds; frame-rate independent. */
export function approach(cur: number, target: number, dt: number, tau: number): number {
  if (tau <= 0) return target;
  return target + (cur - target) * Math.exp(-dt / tau);
}
