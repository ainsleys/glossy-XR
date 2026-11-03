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
