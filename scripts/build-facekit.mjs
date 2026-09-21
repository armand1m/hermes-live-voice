#!/usr/bin/env node

/**
 * Build the browser geometry module from USC ICT-FaceKit.
 *
 * Upstream: https://github.com/USC-ICT/ICT-FaceKit
 * Revision: da5f95a607f5e6b37755b38d3385d7f2853732e5 (intentionally pinned)
 * License: MIT; see clients/browser/FACEKIT-LICENSE.txt.
 * Credits: Kalle Bladin, Owen Ingraham, Yajie Zhao, Pratusha Prasad,
 * Xinglei Ren, Bipin Kishore, Marcel Ramos, Yuka Murata, Tal Rastopchin,
 * and Xiang Li.
 *
 * Rebuild from the repository root with:
 *   node scripts/build-facekit.mjs
 *
 * Source OBJs are fetched individually into /tmp/ict-facekit-da5f95a. This
 * deliberately avoids cloning the repository's large identity-model data.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REVISION = "da5f95a607f5e6b37755b38d3385d7f2853732e5";
const BASE = `https://raw.githubusercontent.com/USC-ICT/ICT-FaceKit/${REVISION}/FaceXModel`;
const CACHE = "/tmp/ict-facekit-da5f95a";
const HEAD_VERTEX_COUNT = 11_248;
const EYEBALL_SOURCE_START = 21_451;
const EYEBALL_SOURCE_END = 24_590;
const EYEBALL_START = HEAD_VERTEX_COUNT;
const SOURCE_VERTEX_COUNT = 26_719;
const selectedSourceIndices = [
  ...Array.from({ length: HEAD_VERTEX_COUNT }, (_, index) => index),
  ...Array.from(
    { length: EYEBALL_SOURCE_END - EYEBALL_SOURCE_START + 1 },
    (_, index) => EYEBALL_SOURCE_START + index,
  ),
];
const VERTEX_COUNT = selectedSourceIndices.length;
const remappedIndex = new Map(
  selectedSourceIndices.map((sourceIndex, index) => [sourceIndex, index]),
);
// 0.05% of the normalized crown-to-chin height: visually negligible, but
// omitting these registration-noise deltas keeps the browser module compact.
const DELTA_EPSILON = 0.001;
const NEUTRAL = "generic_neutral_mesh";
const MORPHS = [
  "jawOpen",
  "mouthFunnel",
  "mouthPucker",
  "mouthSmile_L",
  "mouthSmile_R",
  "mouthFrown_L",
  "mouthFrown_R",
  "eyeBlink_L",
  "eyeBlink_R",
  "browInnerUp_L",
  "browInnerUp_R",
  "browDown_L",
  "browDown_R",
];

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "clients/browser/facekit-data.js");

async function cachedObj(name) {
  await mkdir(CACHE, { recursive: true });
  const path = join(CACHE, `${name}.obj`);
  try {
    const existing = await readFile(path, "utf8");
    if (existing.length > 1_000_000) return existing;
  } catch {}

  const response = await fetch(`${BASE}/${name}.obj`);
  if (!response.ok)
    throw new Error(`Download failed for ${name}: ${response.status}`);
  const source = await response.text();
  if (source.length < 1_000_000)
    throw new Error(`Downloaded ${name} is unexpectedly small`);
  await writeFile(path, source);
  return source;
}

function parseObj(source, includeFaces = false) {
  const sourceVertices = [];
  const faces = [];
  for (const line of source.split(/\r?\n/)) {
    if (line.startsWith("v ")) {
      if (sourceVertices.length < SOURCE_VERTEX_COUNT) {
        const [, x, y, z] = line.trim().split(/\s+/);
        sourceVertices.push([Number(x), Number(y), Number(z)]);
      }
    } else if (includeFaces && line.startsWith("f ")) {
      const polygon = line
        .trim()
        .split(/\s+/)
        .slice(1)
        .map((part) => Number(part.split("/")[0]) - 1);
      if (polygon.every((index) => remappedIndex.has(index))) {
        const remapped = polygon.map((index) => remappedIndex.get(index));
        for (let i = 1; i < polygon.length - 1; i += 1) {
          faces.push(remapped[0], remapped[i], remapped[i + 1]);
        }
      }
    }
  }
  if (sourceVertices.length !== SOURCE_VERTEX_COUNT) {
    throw new Error(
      `Expected ${SOURCE_VERTEX_COUNT} source vertices, received ${sourceVertices.length}`,
    );
  }
  const vertices = selectedSourceIndices.map((index) => sourceVertices[index]);
  return { vertices, faces };
}

const round = (value) => {
  const result = Number(value.toFixed(5));
  return Object.is(result, -0) ? 0 : result;
};

const neutralObj = parseObj(await cachedObj(NEUTRAL), true);

// Multi-PIE eye contours from upstream README. X/Z center on their midpoint.
const eyeIndices = [
  1507, 1542, 1537, 1528, 1518, 1511, 3742, 3751, 3756, 3721, 3725, 3732,
];
const eyeCenter = [0, 0, 0];
for (const index of eyeIndices) {
  for (let axis = 0; axis < 3; axis += 1)
    eyeCenter[axis] += neutralObj.vertices[index][axis];
}
for (let axis = 0; axis < 3; axis += 1) eyeCenter[axis] /= eyeIndices.length;

const chinY = neutralObj.vertices[966][1];
const crownY = Math.max(
  ...neutralObj.vertices.slice(0, HEAD_VERTEX_COUNT).map((vertex) => vertex[1]),
);
const scale = 2 / (crownY - chinY);
const center = [eyeCenter[0], (crownY + chinY) / 2, eyeCenter[2]];

// Sanity-check the documented coordinate convention before emitting data.
const noseTip = neutralObj.vertices[4857];
if (noseTip[2] <= eyeCenter[2] || crownY <= chinY) {
  throw new Error("Unexpected upstream axes: expected +Z forward and +Y up");
}

const positions = neutralObj.vertices.flatMap((vertex) =>
  vertex.map((value, axis) => round((value - center[axis]) * scale)),
);

const morphs = {};
for (const name of MORPHS) {
  const target = parseObj(await cachedObj(name)).vertices;
  const indices = [];
  const deltas = [];
  for (let index = 0; index < VERTEX_COUNT; index += 1) {
    const delta = target[index].map((value, axis) =>
      round((value - neutralObj.vertices[index][axis]) * scale),
    );
    if (Math.hypot(...delta) >= DELTA_EPSILON) {
      indices.push(index);
      deltas.push(...delta);
    }
  }
  morphs[name] = { indices, deltas };
}

const header =
  `/* Generated by scripts/build-facekit.mjs; do not edit.\n` +
  ` * Source: USC ICT-FaceKit @ ${REVISION} (MIT).\n` +
  ` * Attribution/license: ./FACEKIT-LICENSE.txt\n` +
  ` * Contract: +X viewer-right, +Y up, +Z toward viewer. Crown/chin are\n` +
  ` * approximately +1/-1 Y; X/Z use the eye-contour midpoint as origin.\n` +
  ` * positions: flat xyz array. triangles: flat zero-based triangle indices.\n` +
  ` * Vertices [metadata.eyeballStart..] are left then right eyeball geometry.\n` +
  ` * morphs[name]: { indices:[vertexIndex,...], deltas:[dx,dy,dz,...] }.\n` +
  ` * For each indices[i], apply deltas[i*3..i*3+2] times morph weight.\n` +
  ` */\n`;

const metadata = {
  source: "USC-ICT/ICT-FaceKit",
  revision: REVISION,
  vertexCount: VERTEX_COUNT,
  triangleCount: neutralObj.faces.length / 3,
  eyeballStart: EYEBALL_START,
  deltaEpsilon: DELTA_EPSILON,
  normalization: { center: center.map(round), scale: round(scale) },
};
const moduleText = `${header}export const FACEKIT=${JSON.stringify({ metadata, positions, triangles: neutralObj.faces, morphs })};\n`;
await writeFile(output, moduleText);

const bytes = Buffer.byteLength(moduleText);
console.log(`Wrote ${output}`);
console.log(
  `${VERTEX_COUNT} vertices, ${metadata.triangleCount} triangles, ${MORPHS.length} morphs, ${bytes} bytes`,
);
if (bytes > 2_500_000)
  throw new Error("Generated module exceeds the 2.5 MB target");
