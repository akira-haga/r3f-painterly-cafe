// Wind motion for leaves and flowers, applied through a NodeMaterial's
// positionNode. It lives here because geometry-node animation doesn't survive
// glTF export.
//
// Realize Instances melts every leaf into one mesh, so each leaf's stem
// position is baked into a `_stembase` attribute in Blender (converted and
// renamed to `stemBase` in stem-base.ts); subtracting it from
// position gives the distance from that vertex to its own pivot, and hashing it
// gives a per-leaf random.
//
// The motion is deliberately split in two. A phase derived from position alone
// leaves neighbours nearly in step and whole clumps drift together — fine on a
// planter, broken on a 7m tree. So a slow spatial `gust` carries the wind
// across the scene while a fast per-leaf `phase` keeps neighbours out of step,
// and the direction is rotated per leaf as well.

import { Fn, attribute, positionLocal, vec3 } from "three/tsl";

const TAU = 6.2831853;

/**
 * Local position with the sway applied, for a NodeMaterial's positionNode.
 *
 * @param time       elapsed seconds
 * @param amount     tip displacement in metres; 0 holds everything still
 * @param speed      how fast it sways
 * @param windScale  spatial frequency of the gust; 1.0 is a ~6.3m wavelength
 * @param scatter    per-leaf spread 0..1; at 0 clumps move as one
 * @param leafLength longest leaf of that plant, in metres, used to normalise the
 *                   bend. Flowers take their plant's *leaf* length so that being
 *                   shorter makes them sway less. Too small a value pins the
 *                   outer half of each leaf at bend=1 and the clump slides
 *                   instead of bending.
 */
export const sway = Fn(
  ([time, amount, speed, windScale, scatter, leafLength]: [
    any,
    any,
    any,
    any,
    any,
    any,
  ]) => {
    const stem: any = attribute("stemBase", "vec3");

    // 0 at the stem, 1 at the tip
    const t: any = positionLocal
      .sub(stem)
      .length()
      .div(leafLength)
      .clamp(0.0, 1.0);
    // Squaring stiffens the base and loosens the tip
    const bend: any = t.mul(t);

    // Per-leaf random 0..1; the constants only need to be uncorrelated
    const rnd = (k: any): any => stem.dot(k).sin().mul(43758.5453).fract();
    const rPhase: any = rnd(vec3(12.9898, 78.233, 37.719));
    const rDir: any = rnd(vec3(39.3468, 11.135, 83.155));

    // Gust: a swell travelling through space, slower than the oscillation
    const gust: any = stem.x
      .add(stem.z.mul(0.7))
      .mul(windScale)
      .add(time.mul(speed).mul(0.35))
      .sin()
      .mul(0.5)
      .add(0.5);
    // Keep a floor; reaching 0 would freeze everything for an instant
    const gain: any = gust.mul(0.65).add(0.35);

    // Oscillation, offset per leaf
    const phase: any = time.mul(speed).add(rPhase.mul(TAU).mul(scatter));
    const w: any = phase.sin();
    // Second wave, so it isn't a plain back-and-forth
    const w2: any = phase.mul(1.7).add(1.3).sin();

    // Mostly horizontal (XZ), with a little vertical mixed in
    const dir: any = vec3(w.mul(0.8), w2.mul(0.2), w.mul(0.6));

    // Spin per leaf around Y, or every leaf rocks on the same axis
    const a: any = rDir.mul(TAU).mul(scatter);
    const ca: any = a.cos();
    const sa: any = a.sin();
    const spun: any = vec3(
      dir.x.mul(ca).sub(dir.z.mul(sa)),
      dir.y,
      dir.x.mul(sa).add(dir.z.mul(ca)),
    );

    return positionLocal.add(spun.mul(amount).mul(bend).mul(gain));
  },
);
