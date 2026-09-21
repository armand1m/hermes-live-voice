import { describe, expect, it, vi } from "vitest";
// Browser-only module intentionally ships as plain ESM JavaScript.
// @ts-expect-error No declaration file is emitted for browser assets.
import { PointField, mat4 } from "../clients/browser/entity-gl.js";

function fakeRenderer() {
  let nextBuffer = 0;
  const gl = {
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    DYNAMIC_DRAW: 0x88e8,
    STATIC_DRAW: 0x88e4,
    TRIANGLES: 0x0004,
    createBuffer: vi.fn(() => ({ id: nextBuffer++ })),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    bufferSubData: vi.fn(),
  };
  return {
    gl,
    width: 800,
    height: 600,
    time: 1,
    viewProjection: mat4.create(),
    drawCalls: 0,
    program: vi.fn(() => ({ program: {}, uniforms: new Map(), attributes: new Map() })),
  };
}

describe("PointField", () => {
  it("repeats every sprite attribute across its four indexed quad vertices", () => {
    const renderer = fakeRenderer();
    const field = new PointField(renderer as never, 2);

    field.push(1, 2, 3, 4, 0.1, 0.2, 0.3, 0.4, 0.5);
    field.push(6, 7, 8, 9, 0.6, 0.7, 0.8, 0.9, 1);

    expect(Array.from(field.centers)).toEqual([
      1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3,
      6, 7, 8, 6, 7, 8, 6, 7, 8, 6, 7, 8,
    ]);
    expect(Array.from(field.sizes)).toEqual([4, 4, 4, 4, 9, 9, 9, 9]);
    expect(Array.from(field.phases)).toEqual([0.5, 0.5, 0.5, 0.5, 1, 1, 1, 1]);
    expect(Array.from(field.colors.slice(0, 4))).toEqual([
      expect.closeTo(0.1), expect.closeTo(0.2), expect.closeTo(0.3), expect.closeTo(0.4),
    ]);
    expect(Array.from(field.colors.slice(12, 20))).toEqual([
      expect.closeTo(0.1), expect.closeTo(0.2), expect.closeTo(0.3), expect.closeTo(0.4),
      expect.closeTo(0.6), expect.closeTo(0.7), expect.closeTo(0.8), expect.closeTo(0.9),
    ]);
  });

  it("uploads all active quad vertices, including dynamic phase data", () => {
    const renderer = fakeRenderer();
    const field = new PointField(renderer as never, 3);
    field.push(1, 2, 3, 4, 0.1, 0.2, 0.3, 0.4, 0.75);
    const upload = vi.spyOn(field.mesh, "subupdate");
    let drawnIndexCount = 0;
    vi.spyOn(field.mesh, "draw").mockImplementation(() => {
      drawnIndexCount = field.mesh.index?.count ?? 0;
      return field.mesh;
    });

    field.draw(renderer as never);

    expect(upload.mock.calls.map((call: [string, Float32Array]) => [call[0], call[1].length])).toEqual([
      ["aCenter", 12],
      ["aSize", 4],
      ["aColor", 16],
      ["aPhase", 4],
    ]);
    expect(Array.from(upload.mock.calls[3][1])).toEqual([0.75, 0.75, 0.75, 0.75]);
    expect(drawnIndexCount).toBe(6);
    expect(field.mesh.index?.count).toBe(18);
  });
});
