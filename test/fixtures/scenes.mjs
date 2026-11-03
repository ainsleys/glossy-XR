// Small scene files for the format tests, written by the tests themselves so
// no binaries sit in the repo. Each writer is a pure function returning a
// Buffer. Every fixture sits off the origin and above the floor, so auto-fit
// has something to move.

// ---- Gaussian splats ---------------------------------------------------------
// The same Gaussians in two encodings: a sphere of known centre and radius,
// points spread evenly over it (Fibonacci lattice) so one can be aimed at.

export const GAUSS = { centre: [0.5, 2, -0.3], radius: 0.5, count: 200, scale: 0.02 };

/** Centres of the Gaussians, in file coordinates. */
export function gaussCentres({ centre, radius, count } = GAUSS) {
  const out = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count, r = Math.sqrt(1 - y * y), a = golden * i;
    out.push([centre[0] + radius * r * Math.cos(a), centre[1] + radius * y, centre[2] + radius * r * Math.sin(a)]);
  }
  return out;
}

/** 3DGS PLY: binary little-endian, the fourteen float properties Spark reads. */
export function gaussianPly(g = GAUSS) {
  const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const header = ['ply', 'format binary_little_endian 1.0', `element vertex ${g.count}`, ...props.map((p) => `property float ${p}`), 'end_header', ''].join('\n');
  const body = Buffer.alloc(g.count * props.length * 4);
  const logScale = Math.log(g.scale);
  gaussCentres(g).forEach((c, i) => {
    // f_dc is the zeroth spherical-harmonic coefficient: colour = 0.5 + 0.282 * f_dc
    const row = [...c, 1.0, -0.5, -1.0, 4.0, logScale, logScale, logScale, 1, 0, 0, 0];   // opacity is a logit: sigmoid(4) ≈ 0.98
    row.forEach((v, k) => body.writeFloatLE(v, (i * props.length + k) * 4));
  });
  return Buffer.concat([Buffer.from(header, 'latin1'), body]);
}

/** .splat: 32 bytes per Gaussian: position f32×3, scale f32×3, RGBA u8×4, rotation u8×4 (w, x, y, z as q*128+128). */
export function splatFile(g = GAUSS) {
  const buf = Buffer.alloc(g.count * 32);
  gaussCentres(g).forEach((c, i) => {
    const o = i * 32;
    c.forEach((v, k) => buf.writeFloatLE(v, o + k * 4));
    for (let k = 0; k < 3; k++) buf.writeFloatLE(g.scale, o + 12 + k * 4);
    buf.set([230, 90, 40, 255], o + 24);
    buf.set([255, 128, 128, 128], o + 28);              // identity quaternion; 1*128+128 clamps to 255
  });
  return buf;
}

// ---- PLY mesh and point cloud -----------------------------------------------

export const CUBE = { centre: [3, 2, -1], size: 1 };

/** The eight corners of an axis-aligned cube. */
export function cubeCorners({ centre, size } = CUBE) {
  const h = size / 2, out = [];
  for (const x of [-h, h]) for (const y of [-h, h]) for (const z of [-h, h]) out.push([centre[0] + x, centre[1] + y, centre[2] + z]);
  return out;
}
// twelve triangles over cubeCorners' order (index = 4*x + 2*y + z, each 0 or 1)
const CUBE_TRIS = [[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1], [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]];

/** ASCII PLY cube; with faces it is a mesh, without them the same corners are a point cloud. */
export function cubePly({ faces = true, ...cube } = {}) {
  const v = cubeCorners({ ...CUBE, ...cube });
  const lines = ['ply', 'format ascii 1.0', `element vertex ${v.length}`, 'property float x', 'property float y', 'property float z'];
  if (faces) lines.push(`element face ${CUBE_TRIS.length}`, 'property list uchar int vertex_indices');
  lines.push('end_header', ...v.map((p) => p.join(' ')));
  if (faces) lines.push(...CUBE_TRIS.map((t) => `3 ${t.join(' ')}`));
  return Buffer.from(lines.join('\n') + '\n');
}

// ---- PCD -------------------------------------------------------------------
// 500 coloured points in a box, and one more standing proud of its +Z face so a
// ray from +Z meets it before anything else.

export const CLOUD = { centre: [-1, 2.5, 2], size: 1.2, count: 500 };
export const CLOUD_TARGET = [CLOUD.centre[0], CLOUD.centre[1], CLOUD.centre[2] + CLOUD.size / 2 + 0.4];

export function cloudPcd({ centre, size, count } = CLOUD) {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);   // deterministic
  const pts = [];
  for (let i = 0; i < count - 1; i++) pts.push([0, 1, 2].map((k) => centre[k] + (rand() - 0.5) * size));
  pts.push(CLOUD_TARGET);
  const rows = pts.map((p, i) => `${p.map((v) => v.toFixed(5)).join(' ')} ${((i * 37) % 256 << 16) | (128 << 8) | 200}`);
  return Buffer.from([
    '# .PCD v0.7', 'VERSION 0.7', 'FIELDS x y z rgb', 'SIZE 4 4 4 4', 'TYPE F F F U', 'COUNT 1 1 1 1',
    `WIDTH ${pts.length}`, 'HEIGHT 1', 'VIEWPOINT 0 0 0 1 0 0 0', `POINTS ${pts.length}`, 'DATA ascii', ...rows, '',
  ].join('\n'));
}

// ---- glTF ------------------------------------------------------------------
// The large one: 50 units across, so auto-fit has to scale it down.

export const BIG_CUBE = { centre: [10, 40, -5], size: 50, name: 'crate' };

/** .gltf with its buffer embedded as a data URI: one indexed cube mesh. */
export function cubeGltf({ centre, size, name } = BIG_CUBE) {
  const v = cubeCorners({ centre, size });
  const idx = CUBE_TRIS.flat();
  const bin = Buffer.alloc(v.length * 12 + idx.length * 2);
  v.flat().forEach((x, i) => bin.writeFloatLE(x, i * 4));
  idx.forEach((x, i) => bin.writeUInt16LE(x, v.length * 12 + i * 2));
  const min = [0, 1, 2].map((k) => Math.min(...v.map((p) => p[k]))), max = [0, 1, 2].map((k) => Math.max(...v.map((p) => p[k])));
  return Buffer.from(JSON.stringify({
    asset: { version: '2.0' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.length, uri: 'data:application/octet-stream;base64,' + bin.toString('base64') }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: v.length * 12, target: 34962 }, { buffer: 0, byteOffset: v.length * 12, byteLength: idx.length * 2, target: 34963 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: v.length, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5123, count: idx.length, type: 'SCALAR' },
    ],
  }));
}

// ---- OBJ + MTL -------------------------------------------------------------

export const OBJ_CUBE = { centre: [-2, 1.5, 1], size: 0.8, name: 'box', kd: [0.8, 0.2, 0.1] };

/** An OBJ cube that names its material; pair it with objMtl() under the same base name. */
export function cubeObj({ centre, size, name } = OBJ_CUBE) {
  const v = cubeCorners({ centre, size });
  return Buffer.from(['mtllib box.mtl', `o ${name}`, ...v.map((p) => `v ${p.join(' ')}`), 'usemtl rust', ...CUBE_TRIS.map((t) => `f ${t.map((i) => i + 1).join(' ')}`), ''].join('\n'));
}
export const objMtl = ({ kd } = OBJ_CUBE) => Buffer.from(`newmtl rust\nKd ${kd.join(' ')}\n`);

// ---- PNG -------------------------------------------------------------------

/** An RGB PNG of a horizontal gradient, w×h, encoded by hand. */
export async function png(w, h) {
  const zlib = await import('node:zlib');
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([Math.round(255 * x / w), 120, Math.round(255 * y / h)], y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
