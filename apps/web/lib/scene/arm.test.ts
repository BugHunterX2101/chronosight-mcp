import { describe, expect, it } from "vitest";
import { UPPER_LEN, approach, armPose, box, chain, cylinder, grid, identity, lookAt, multiply, perspective, ring, rotationY, rotationZ, transformPoint, translation } from "./arm.ts";

const close = (a: number, b: number, eps = 1e-5) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("matrix maths", () => {
  it("identity is neutral under multiply", () => {
    const m = chain(translation(1, 2, 3), rotationY(0.4), rotationZ(-0.2));
    const out = multiply(identity(), m);
    for (let i = 0; i < 16; i++) close(out[i]!, m[i]!);
  });

  it("rotationZ turns +X into +Y and rotationY turns +X into -Z", () => {
    const z = transformPoint(rotationZ(Math.PI / 2), [1, 0, 0]);
    close(z[0], 0);
    close(z[1], 1);
    const y = transformPoint(rotationY(Math.PI / 2), [1, 0, 0]);
    close(y[0], 0);
    close(y[2], -1);
  });

  it("composes parent-first: translate then rotate moves the rotated point", () => {
    const p = transformPoint(chain(translation(2, 0, 0), rotationZ(Math.PI / 2)), [1, 0, 0]);
    close(p[0], 2);
    close(p[1], 1);
  });

  it("lookAt puts the target on the -Z axis at the eye distance", () => {
    const p = transformPoint(lookAt([3, 2, 5], [0, 0, 0], [0, 1, 0]), [0, 0, 0]);
    close(p[0], 0);
    close(p[1], 0);
    close(p[2], -Math.hypot(3, 2, 5));
  });

  it("perspective maps the near and far planes to -1 and 1", () => {
    const m = perspective(Math.PI / 3, 1.5, 0.1, 50);
    close(transformPoint(m, [0, 0, -0.1])[2], -1, 1e-4);
    close(transformPoint(m, [0, 0, -50])[2], 1, 1e-4);
  });
});

describe("meshes", () => {
  it("a box has 6 faces, 36 indices and 12 edges", () => {
    const b = box(1, 2, 3);
    expect(b.positions.length / 3).toBe(24);
    expect(b.indices.length).toBe(36);
    expect(b.edges.length / 6).toBe(12);
    expect(Math.max(...b.indices)).toBeLessThan(b.positions.length / 3);
  });

  it("a box honours its offset", () => {
    const b = box(2, 2, 2, 5, 0, 0);
    expect(Math.min(...b.positions.filter((_, i) => i % 3 === 0))).toBe(4);
  });

  it("cylinder indices stay inside the vertex buffer and normals are unit length", () => {
    for (const axis of ["y", "z"] as const) {
      const c = cylinder(0.5, 1, 12, axis);
      const n = c.positions.length / 3;
      expect(Math.max(...c.indices)).toBeLessThan(n);
      expect(c.normals.length).toBe(c.positions.length);
      for (let i = 0; i < n; i++) close(Math.hypot(c.normals[i * 3]!, c.normals[i * 3 + 1]!, c.normals[i * 3 + 2]!), 1, 1e-4);
    }
  });

  it("a Z-axis cylinder spans its length on Z", () => {
    const c = cylinder(0.5, 2, 8, "z");
    const zs = c.positions.filter((_, i) => i % 3 === 2);
    close(Math.max(...zs) - Math.min(...zs), 2);
  });

  it("grid lines carry major and minor alpha and ring points sit on the radius", () => {
    const g = grid(2, 0.5, 2);
    const alphas = new Set(Array.from({ length: g.length / 4 }, (_, i) => g[i * 4 + 3]));
    expect([...alphas].sort()).toEqual([Math.fround(0.45), 1]);
    const r = ring(1.5, 16);
    for (let i = 0; i < r.length; i += 3) close(Math.hypot(r[i]!, r[i + 1]!), 1.5, 1e-5);
  });
});

describe("armPose", () => {
  const origin = (m: Float32Array) => transformPoint(m, [0, 0, 0]);

  it("is fixed when sway and vibration are off", () => {
    const a = armPose(0, 0, 4, false);
    const b = armPose(7.3, 0, 4, false);
    for (let i = 0; i < 16; i++) {
      close(a.marker[i]!, b.marker[i]!);
      close(a.elbow[i]!, b.elbow[i]!);
    }
  });

  it("keeps the elbow joint UPPER_LEN from the shoulder", () => {
    const p = armPose(1.7, 0.1, 4, true);
    const s = origin(p.shoulder);
    const e = origin(p.elbow);
    close(Math.hypot(e[0] - s[0], e[1] - s[1], e[2] - s[2]), UPPER_LEN, 1e-4);
  });

  it("vibration moves the marker at the requested frequency and not when amplitude is 0", () => {
    const hz = 4;
    // At t = 0 and t = 1/hz the sine term is 0, so the vibrating pose matches the still one; at the
    // quarter period it is at its peak and the marker has moved.
    const still = origin(armPose(0.25 / hz, 0, hz, false).marker);
    const shake = origin(armPose(0.25 / hz, 0.08, hz, false).marker);
    expect(Math.hypot(shake[0] - still[0], shake[1] - still[1], shake[2] - still[2])).toBeGreaterThan(0.01);
    const full = origin(armPose(1 / hz, 0.08, hz, false).marker);
    const base = origin(armPose(1 / hz, 0, hz, false).marker);
    close(Math.hypot(full[0] - base[0], full[1] - base[1], full[2] - base[2]), 0, 1e-4);
  });
});

describe("approach", () => {
  it("is frame-rate independent: one 0.2 s step equals two 0.1 s steps", () => {
    const one = approach(0, 1, 0.2, 0.3);
    const two = approach(approach(0, 1, 0.1, 0.3), 1, 0.1, 0.3);
    close(one, two, 1e-9);
  });

  it("snaps when tau is 0 and never overshoots", () => {
    expect(approach(0, 1, 0.016, 0)).toBe(1);
    expect(approach(0, 1, 0.016, 0.4)).toBeLessThan(1);
    expect(approach(0, 1, 100, 0.4)).toBeLessThanOrEqual(1);
  });
});
