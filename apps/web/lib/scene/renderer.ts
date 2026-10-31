// WebGL2 renderer for the home scene: a schematic 6-DOF arm on a blueprint floor. No library, no
// eval, no inline styles (the CSP allows none). It owns GL resources and the animation tweens; the
// React component owns the canvas, the loop and the lifecycle. All colours come from the page's CSS
// tokens (readPalette), so the scene cannot drift from the design system.

import {
  FORE_LEN,
  SHOULDER_Y,
  UPPER_LEN,
  approach,
  armPose,
  box,
  chain,
  cylinder,
  grid,
  identity,
  lookAt,
  multiply,
  perspective,
  ring,
  rotationX,
  transformPoint,
  translation,
  type Mat4,
  type Mesh,
  type Vec3,
} from "./arm.ts";
import { stageTargets, type HaloKind, type Stage } from "./stages.ts";

export type Rgb = [number, number, number];

export interface Palette {
  obj: [Rgb, Rgb, Rgb];
  fail: Rgb;
  pending: Rgb;
  pass: Rgb;
  text: Rgb;
  muted: Rgb;
  line: Rgb;
  neutral: Rgb;
}

const FALLBACK: Palette = {
  obj: [
    [0x56 / 255, 0xb4 / 255, 0xe9 / 255],
    [0x00 / 255, 0x72 / 255, 0xb2 / 255],
    [0xcc / 255, 0x79 / 255, 0xa7 / 255],
  ],
  fail: [0xd5 / 255, 0x5e / 255, 0x00 / 255],
  pending: [0xe6 / 255, 0x9f / 255, 0x00 / 255],
  pass: [0x00 / 255, 0x9e / 255, 0x73 / 255],
  text: [0xe8 / 255, 0xea / 255, 0xed / 255],
  muted: [0xa0 / 255, 0xa7 / 255, 0xb0 / 255],
  line: [0x26 / 255, 0x2c / 255, 0x33 / 255],
  neutral: [0x5b / 255, 0x66 / 255, 0x72 / 255],
};

export function parseHex(s: string, fallback: Rgb): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  if (m === null) return fallback;
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Reads the design tokens from an element's computed style. */
export function readPalette(el: Element): Palette {
  const css = getComputedStyle(el);
  const get = (name: string, fb: Rgb) => parseHex(css.getPropertyValue(name), fb);
  return {
    obj: [get("--obj-1", FALLBACK.obj[0]), get("--obj-2", FALLBACK.obj[1]), get("--obj-3", FALLBACK.obj[2])],
    fail: get("--fail", FALLBACK.fail),
    pending: get("--pending", FALLBACK.pending),
    pass: get("--pass", FALLBACK.pass),
    text: get("--text", FALLBACK.text),
    muted: get("--muted", FALLBACK.muted),
    line: get("--line", FALLBACK.line),
    neutral: get("--neutral", FALLBACK.neutral),
  };
}

const VERT_SOLID = `#version 300 es
in vec3 aPos;
in vec3 aNor;
uniform mat4 uModel;
uniform mat4 uVP;
out vec3 vN;
out vec3 vW;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vW = w.xyz;
  vN = mat3(uModel) * aNor;
  gl_Position = uVP * w;
}`;

const FRAG_SOLID = `#version 300 es
precision mediump float;
in vec3 vN;
in vec3 vW;
uniform vec3 uColor;
uniform vec3 uEye;
uniform float uScan;
uniform vec3 uScanCol;
uniform float uAlpha;
out vec4 o;
void main() {
  vec3 n = normalize(vN);
  vec3 L = normalize(vec3(-0.4, 0.9, 0.5));
  float d = max(dot(n, L), 0.0);
  vec3 V = normalize(uEye - vW);
  float rim = pow(1.0 - max(dot(n, V), 0.0), 2.5);
  vec3 c = uColor * (0.14 + 0.46 * d) + uColor * rim * 0.9;
  float s = 1.0 - smoothstep(0.0, 0.1, abs(vW.x - uScan));
  c += uScanCol * s * 0.8;
  o = vec4(c, uAlpha);
}`;

const VERT_LINE = `#version 300 es
in vec4 aPA;
uniform mat4 uModel;
uniform mat4 uVP;
out float vA;
out vec3 vW;
void main() {
  vec4 w = uModel * vec4(aPA.xyz, 1.0);
  vW = w.xyz;
  vA = aPA.w;
  gl_Position = uVP * w;
}`;

const FRAG_LINE = `#version 300 es
precision mediump float;
in float vA;
in vec3 vW;
uniform vec4 uColor;
uniform float uScan;
uniform vec3 uScanCol;
uniform float uFadeR;
out vec4 o;
void main() {
  float fade = 1.0 - smoothstep(uFadeR * 0.5, uFadeR, length(vW.xz));
  float s = 1.0 - smoothstep(0.0, 0.1, abs(vW.x - uScan));
  vec3 c = mix(uColor.rgb, uScanCol, s);
  o = vec4(c, uColor.a * vA * fade);
}`;

// Dust motes drifting around the machine. Each point's drift is computed in the vertex shader from its
// seed, so the field costs one draw call and no per-frame upload.
const VERT_DUST = `#version 300 es
in vec4 aSeed;
uniform mat4 uVP;
uniform float uT;
uniform float uSize;
out float vTw;
void main() {
  float p = aSeed.w;
  vec3 pos = aSeed.xyz + 0.14 * vec3(sin(uT * 0.4 + p), sin(uT * 0.3 + p * 1.7), cos(uT * 0.35 + p * 0.6));
  vTw = 0.5 + 0.5 * sin(uT * 0.9 + p * 3.0);
  gl_Position = uVP * vec4(pos, 1.0);
  gl_PointSize = uSize * (0.7 + 0.6 * fract(p * 7.31));
}`;

const FRAG_DUST = `#version 300 es
precision mediump float;
in float vTw;
uniform vec3 uColor;
out vec4 o;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = (1.0 - smoothstep(0.35, 1.0, d)) * (0.25 + 0.4 * vTw);
  o = vec4(uColor, a);
}`;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fixed, seeded field of points in a cylinder around the arm: xyz and a phase in the fourth slot. */
export function dustSeeds(count: number): Float32Array {
  const rnd = mulberry32(0x5eed);
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const r = 0.9 + Math.sqrt(rnd()) * 2.6;
    out[i * 4] = Math.cos(a) * r;
    out[i * 4 + 1] = 0.05 + rnd() * 2.7;
    out[i * 4 + 2] = Math.sin(a) * r;
    out[i * 4 + 3] = rnd() * 40;
  }
  return out;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (sh === null) throw new Error("createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (gl.getShaderParameter(sh, gl.COMPILE_STATUS) !== true) throw new Error(`shader: ${gl.getShaderInfoLog(sh) ?? "compile failed"}`);
  return sh;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string, attribs: string[]): WebGLProgram {
  const p = gl.createProgram();
  if (p === null) throw new Error("createProgram failed");
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  attribs.forEach((a, i) => gl.bindAttribLocation(p, i, a));
  gl.linkProgram(p);
  if (gl.getProgramParameter(p, gl.LINK_STATUS) !== true) throw new Error(`program: ${gl.getProgramInfoLog(p) ?? "link failed"}`);
  return p;
}

interface SolidMesh {
  vao: WebGLVertexArrayObject;
  count: number;
}
interface LineMesh {
  vao: WebGLVertexArrayObject;
  buf: WebGLBuffer;
  count: number;
}

type PartName = "base" | "turret" | "upper" | "shoulderJ" | "elbowJ" | "fore" | "wrist" | "marker";

/** xyz triples to xyzw with a constant w. */
function toPA(xyz: Float32Array, a: number): Float32Array {
  const out = new Float32Array((xyz.length / 3) * 4);
  for (let i = 0, j = 0; i < xyz.length; i += 3, j += 4) {
    out[j] = xyz[i]!;
    out[j + 1] = xyz[i + 1]!;
    out[j + 2] = xyz[i + 2]!;
    out[j + 3] = a;
  }
  return out;
}

function scaleUniform(s: number): Mat4 {
  const m = identity();
  m[0] = m[5] = m[10] = s;
  return m;
}

export interface Anchor {
  x: number;
  y: number;
  visible: boolean;
}

export interface FrameInput {
  stage: Stage;
  hz: number;
  residual: number | null;
  /** Seconds since the loop started; ignored when `animate` is false. */
  t: number;
  /** Frame delta in seconds, already clamped. */
  dt: number;
  /** False draws the fixed reduced-motion frame: no sway, no vibration, no trail, tweens snap. */
  animate: boolean;
  /** Pointer offset from the canvas centre in -1..1, for the camera parallax. */
  px: number;
  py: number;
}

// Schematic fault amplitude at the elbow, in radians. Illustration only: the recorded amplitude in
// millimetres is shown as text next to the scene, never derived from this number.
const FAULT_RAD = 0.1;
const HALO_FADE_S = 0.4;
const TRAIL_S = 1;
const MAX_TRAIL = 120;

export class TwinRenderer {
  static create(canvas: HTMLCanvasElement, palette: Palette): TwinRenderer | null {
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: true, depth: true, powerPreference: "low-power", preserveDrawingBuffer: false });
    if (gl === null) return null;
    try {
      return new TwinRenderer(gl, palette);
    } catch {
      return null;
    }
  }

  private readonly gl: WebGL2RenderingContext;
  private palette: Palette;
  private solidProg!: WebGLProgram;
  private lineProg!: WebGLProgram;
  private dustProg!: WebGLProgram;
  private dust!: { vao: WebGLVertexArrayObject; count: number };
  private dpr = 1;
  private parts!: Record<PartName, { solid: SolidMesh; edges: LineMesh }>;
  private floor!: LineMesh;
  private ringA!: LineMesh;
  private ringB!: LineMesh;
  private scanPlane!: LineMesh;
  private trailMesh!: LineMesh;
  private readonly locs = new WeakMap<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private width = 1;
  private height = 1;

  // Tweens.
  private amp = 1;
  private haloAlpha = 0;
  private haloColor: Rgb;
  private scanAlpha = 0;
  private trailAlpha = 0;
  private chipAlpha = 0;
  private trail: { p: Vec3; t: number }[] = [];
  /** 0..1 progress of the scan sweep. */
  private scanPhase = 0;

  private constructor(gl: WebGL2RenderingContext, palette: Palette) {
    this.gl = gl;
    this.palette = palette;
    this.haloColor = palette.fail;
    this.init();
  }

  setPalette(p: Palette): void {
    this.palette = p;
  }

  /** (Re)creates every GL resource; also the context-restore path. */
  init(): void {
    const gl = this.gl;
    this.solidProg = program(gl, VERT_SOLID, FRAG_SOLID, ["aPos", "aNor"]);
    this.lineProg = program(gl, VERT_LINE, FRAG_LINE, ["aPA"]);
    this.dustProg = program(gl, VERT_DUST, FRAG_DUST, ["aSeed"]);
    const seeds = dustSeeds(260);
    const dv = gl.createVertexArray();
    gl.bindVertexArray(dv);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.dust = { vao: dv!, count: seeds.length / 4 };
    const mk = (m: Mesh) => ({ solid: this.solid(m), edges: this.lines(toPA(m.edges, 1), false) });
    this.parts = {
      base: mk(cylinder(0.62, 0.18, 28, "y", 0, 0.09, 0)),
      turret: mk(box(0.5, SHOULDER_Y - 0.18, 0.5, 0, 0.18 + (SHOULDER_Y - 0.18) / 2, 0)),
      upper: mk(box(UPPER_LEN, 0.2, 0.22, UPPER_LEN / 2, 0, 0)),
      shoulderJ: mk(cylinder(0.17, 0.34, 18, "z")),
      elbowJ: mk(cylinder(0.15, 0.34, 18, "z")),
      fore: mk(box(FORE_LEN, 0.16, 0.18, FORE_LEN / 2, 0, 0)),
      wrist: mk(box(0.2, 0.13, 0.13, 0.1, 0, 0)),
      marker: mk(box(0.1, 0.1, 0.1)),
    };
    this.floor = this.lines(grid(7, 0.5, 4), false);
    this.ringA = this.lines(toPA(ring(1.5, 64), 1), false);
    this.ringB = this.lines(toPA(ring(2.5, 64), 0.7), false);
    this.scanPlane = this.lines(this.scanGeometry(), false);
    this.trailMesh = this.lines(new Float32Array(MAX_TRAIL * 4), true);
  }

  private loc(prog: WebGLProgram, name: string): WebGLUniformLocation | null {
    let m = this.locs.get(prog);
    if (m === undefined) {
      m = new Map();
      this.locs.set(prog, m);
    }
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(prog, name));
    return m.get(name) ?? null;
  }

  private solid(m: Mesh): SolidMesh {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const pos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(gl.ARRAY_BUFFER, m.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const nor = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, nor);
    gl.bufferData(gl.ARRAY_BUFFER, m.normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    const idx = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao: vao!, count: m.indices.length };
  }

  private lines(pa: Float32Array, dynamic: boolean): LineMesh {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, pa, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return { vao: vao!, buf, count: pa.length / 4 };
  }

  /** The scan plane: a rectangle in the YZ plane with hatch lines, as xyzw. */
  private scanGeometry(): Float32Array {
    const out: number[] = [];
    const seg = (y0: number, z0: number, y1: number, z1: number, a: number) => out.push(0, y0, z0, a, 0, y1, z1, a);
    seg(0, -1.3, 2.4, -1.3, 1);
    seg(2.4, -1.3, 2.4, 1.3, 1);
    seg(2.4, 1.3, 0, 1.3, 1);
    seg(0, 1.3, 0, -1.3, 1);
    for (let i = 1; i < 8; i++) seg((i / 8) * 2.4, -1.3, (i / 8) * 2.4, 1.3, 0.28);
    for (let i = 1; i < 6; i++) seg(0, -1.3 + (i / 6) * 2.6, 2.4, -1.3 + (i / 6) * 2.6, 0.28);
    return new Float32Array(out);
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    const d = Math.min(2, Math.max(1, dpr));
    this.dpr = d;
    this.width = Math.max(1, Math.round(cssW * d));
    this.height = Math.max(1, Math.round(cssH * d));
    const c = this.gl.canvas as HTMLCanvasElement;
    if (c.width !== this.width) c.width = this.width;
    if (c.height !== this.height) c.height = this.height;
  }

  /** Draws one frame and returns the screen positions (CSS px) of the three tracked parts. */
  frame(inp: FrameInput, cssW: number, cssH: number): Anchor[] {
    const gl = this.gl;
    const pal = this.palette;
    const tg = stageTargets(inp.stage, inp.residual);
    const animate = inp.animate;
    const tau = (s: number) => (animate ? s : 0);

    // Tweens: amplitude eases, the halo colour crossfades over 400 ms (the verdict moment), the rest fade quickly.
    this.amp = approach(this.amp, tg.ampScale, inp.dt, tau(0.55));
    const haloTarget = this.haloRgb(tg.halo);
    const k = animate ? Math.min(1, inp.dt / HALO_FADE_S) : 1;
    if (haloTarget !== null) this.haloColor = [0, 1, 2].map((i) => this.haloColor[i]! + (haloTarget[i]! - this.haloColor[i]!) * k) as Rgb;
    this.haloAlpha = approach(this.haloAlpha, tg.halo === "none" ? 0 : 1, inp.dt, tau(0.15));
    this.scanAlpha = approach(this.scanAlpha, tg.scan ? 1 : 0, inp.dt, tau(0.2));
    this.trailAlpha = approach(this.trailAlpha, tg.trail && animate ? 1 : 0, inp.dt, tau(0.2));
    this.chipAlpha = approach(this.chipAlpha, tg.chips ? 1 : 0, inp.dt, tau(0.15));
    if (animate) this.scanPhase = (this.scanPhase + inp.dt * 0.32) % 1;

    const t = animate ? inp.t : 0;
    const pose = armPose(t, FAULT_RAD * this.amp, inp.hz, animate);
    const aspect = this.width / this.height;

    // Camera: slow orbit plus pointer parallax; both are zero in the reduced-motion frame.
    const az = 0.62 + (animate ? 0.1 * Math.sin(t * 0.11) + inp.px * 0.18 : 0);
    const el = 0.4 + (animate ? -inp.py * 0.08 : 0);
    const dist = 3.7 * Math.min(2, Math.max(1, 1.3 / aspect));
    const target: Vec3 = [0.45, 0.9, 0];
    const eye: Vec3 = [target[0] + dist * Math.cos(el) * Math.sin(az), target[1] + dist * Math.sin(el), target[2] + dist * Math.cos(el) * Math.cos(az)];
    const vp = multiply(perspective((38 * Math.PI) / 180, aspect, 0.1, 60), lookAt(eye, target, [0, 1, 0]));

    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const scanX = this.scanAlpha > 0.02 ? -1.6 + this.scanPhase * 4.4 : -100;
    const idm = identity();

    // Floor and rings.
    gl.useProgram(this.lineProg);
    this.setLineCommon(vp, scanX);
    gl.depthMask(false);
    this.drawLines(this.floor, idm, pal.line, 0.9, 7, gl.LINES, 1);
    const flat = rotationX(Math.PI / 2);
    this.drawLines(this.ringA, flat, pal.muted, 0.28, 1e4, gl.LINES, 1);
    this.drawLines(this.ringB, flat, pal.muted, 0.16, 1e4, gl.LINES, 1);
    gl.depthMask(true);

    // Dust motes behind and around the machine; frozen in the reduced-motion frame.
    gl.useProgram(this.dustProg);
    gl.uniformMatrix4fv(this.loc(this.dustProg, "uVP"), false, vp);
    gl.uniform1f(this.loc(this.dustProg, "uT"), t);
    gl.uniform1f(this.loc(this.dustProg, "uSize"), 2.4 * this.dpr);
    gl.uniform3fv(this.loc(this.dustProg, "uColor"), pal.text);
    gl.depthMask(false);
    gl.bindVertexArray(this.dust.vao);
    gl.drawArrays(gl.POINTS, 0, this.dust.count);
    gl.depthMask(true);

    // Solids.
    gl.useProgram(this.solidProg);
    gl.uniformMatrix4fv(this.loc(this.solidProg, "uVP"), false, vp);
    gl.uniform3f(this.loc(this.solidProg, "uEye"), eye[0], eye[1], eye[2]);
    gl.uniform1f(this.loc(this.solidProg, "uScan"), scanX);
    gl.uniform3fv(this.loc(this.solidProg, "uScanCol"), pal.text);
    gl.uniform1f(this.loc(this.solidProg, "uAlpha"), 0.88);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);
    const draws: [PartName, Mat4, Rgb][] = [
      ["base", idm, pal.neutral],
      ["turret", pose.turret, pal.neutral],
      ["upper", pose.shoulder, pal.neutral],
      ["shoulderJ", pose.shoulder, pal.neutral],
      ["elbowJ", pose.elbow, pal.obj[1]],
      ["fore", pose.elbow, pal.obj[0]],
      ["wrist", pose.wrist, pal.neutral],
      ["marker", pose.marker, pal.obj[2]],
    ];
    for (const [name, model, col] of draws) {
      gl.uniformMatrix4fv(this.loc(this.solidProg, "uModel"), false, model);
      gl.uniform3fv(this.loc(this.solidProg, "uColor"), col);
      gl.bindVertexArray(this.parts[name].solid.vao);
      gl.drawElements(gl.TRIANGLES, this.parts[name].solid.count, gl.UNSIGNED_SHORT, 0);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);

    // Hard edges: the three tracked parts in their identity hue, the rest in the muted blueprint tone.
    gl.useProgram(this.lineProg);
    this.setLineCommon(vp, scanX);
    const tracked = new Set<PartName>(["elbowJ", "fore", "marker"]);
    for (const [name, model, col] of draws) {
      this.drawLines(this.parts[name].edges, model, tracked.has(name) ? col : pal.muted, 0.95, 1e4, gl.LINES, 1);
    }

    // Echoes of the forearm a few milliseconds back make the vibration legible as motion.
    if (animate && this.amp > 0.04) {
      for (const [lag, a] of [[0.022, 0.3], [0.046, 0.14]] as const) {
        const ghost = armPose(t - lag, FAULT_RAD * this.amp, inp.hz, true);
        this.drawLines(this.parts.fore.edges, ghost.elbow, pal.obj[0], a * Math.min(1, this.amp * 1.6), 1e4, gl.LINES, 1);
      }
    }

    // Tracked-centroid trail of the marker over the last second.
    const m = transformPoint(pose.marker, [0, 0, 0]);
    if (animate) {
      this.trail.push({ p: m, t });
      while (this.trail.length > 0 && t - this.trail[0]!.t > TRAIL_S) this.trail.shift();
      if (this.trail.length > MAX_TRAIL) this.trail.splice(0, this.trail.length - MAX_TRAIL);
    } else {
      this.trail.length = 0;
    }
    if (this.trail.length > 1 && this.trailAlpha > 0.02) {
      const data = new Float32Array(this.trail.length * 4);
      this.trail.forEach((e, i) => {
        data[i * 4] = e.p[0];
        data[i * 4 + 1] = e.p[1];
        data[i * 4 + 2] = e.p[2];
        data[i * 4 + 3] = Math.max(0, 1 - (t - e.t) / TRAIL_S);
      });
      gl.bindBuffer(gl.ARRAY_BUFFER, this.trailMesh.buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
      gl.disable(gl.DEPTH_TEST);
      this.drawLines(this.trailMesh, idm, pal.obj[2], this.trailAlpha, 1e4, gl.LINE_STRIP, this.trail.length);
      gl.enable(gl.DEPTH_TEST);
    }

    // Scan plane sweeping across the arm.
    if (this.scanAlpha > 0.02) {
      gl.disable(gl.DEPTH_TEST);
      this.drawLines(this.scanPlane, translation(scanX, 0, 0), pal.text, 0.7 * this.scanAlpha, 1e4, gl.LINES, 1);
      gl.enable(gl.DEPTH_TEST);
    }

    // Hinge halo: a state colour; the DOM badge beside the canvas carries the glyph and the word.
    if (this.haloAlpha > 0.02) {
      gl.disable(gl.DEPTH_TEST);
      const pulse = animate ? 0.5 + 0.5 * Math.sin(t * 5) : 1;
      const col = this.haloColor;
      this.drawLines(this.ringA, chain(pose.elbow, scaleUniform(0.2)), col, this.haloAlpha, 1e4, gl.LINES, 1);
      this.drawLines(this.ringA, chain(pose.elbow, scaleUniform(0.27 + 0.05 * pulse)), col, this.haloAlpha * (0.45 + 0.4 * pulse), 1e4, gl.LINES, 1);
      gl.enable(gl.DEPTH_TEST);
    }

    // Anchors for the DOM chips: forearm (above its bar), elbow, marker.
    const project = (p: Vec3): Anchor => {
      const [x, y, z] = transformPoint(vp, p);
      return { x: (x * 0.5 + 0.5) * cssW, y: (1 - (y * 0.5 + 0.5)) * cssH, visible: z > -1 && z < 1 && this.chipAlpha > 0.05 };
    };
    return [
      project(transformPoint(pose.elbow, [FORE_LEN * 0.55, 0.19, 0])),
      project(transformPoint(pose.elbow, [0, 0.3, 0])),
      project(transformPoint(pose.marker, [0.05, 0.12, 0])),
    ];
  }

  private haloRgb(kind: HaloKind): Rgb | null {
    switch (kind) {
      case "fail":
        return this.palette.fail;
      case "pending":
        return this.palette.pending;
      case "pass":
        return this.palette.pass;
      case "none":
        return null;
    }
  }

  private setLineCommon(vp: Mat4, scanX: number): void {
    const gl = this.gl;
    gl.uniformMatrix4fv(this.loc(this.lineProg, "uVP"), false, vp);
    gl.uniform1f(this.loc(this.lineProg, "uScan"), scanX);
    gl.uniform3fv(this.loc(this.lineProg, "uScanCol"), this.palette.text);
  }

  private drawLines(mesh: LineMesh, model: Mat4, col: Rgb, alpha: number, fadeR: number, mode: number, count: number): void {
    const gl = this.gl;
    gl.uniformMatrix4fv(this.loc(this.lineProg, "uModel"), false, model);
    gl.uniform4f(this.loc(this.lineProg, "uColor"), col[0], col[1], col[2], alpha);
    gl.uniform1f(this.loc(this.lineProg, "uFadeR"), fadeR);
    gl.bindVertexArray(mesh.vao);
    gl.drawArrays(mode, 0, mode === gl.LINE_STRIP ? count : mesh.count);
  }

  /** Frees the GPU context now rather than at garbage collection, so route changes do not pile up contexts. */
  dispose(): void {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
