// Cirrus drifting across the background, assigned to scene.backgroundNode.
//
// Built as filaments rather than blobs: the noise is read through a
// horizontally squeezed coordinate (`stretch`), and displacing only y makes the
// streaks undulate into hooks (`warp`). Thinness comes from raising the
// threshold until only the dense cores survive (`coverage`) — washing out the
// colour instead just hangs an even haze over everything.
//
// Coordinates are screen space; orbiting the camera doesn't move the sky.

import {
  Fn,
  vec2,
  vec3,
  float,
  mix,
  screenUV,
  screenSize,
  mx_fractal_noise_float,
} from "three/tsl";

/**
 * Background colour (linear).
 *
 * @param time        elapsed seconds
 * @param skyColor    the sky itself; all you get at amount 0
 * @param cloudA      cloud colour at the start of the gradient
 * @param cloudB      cloud colour at the end of it
 * @param gradAngle   gradient direction in radians; 0 is left→right
 * @param amount      cloud density 0..1
 * @param scale       streak frequency, roughly how many fit the screen height
 * @param speed       drift speed
 * @param stretch     horizontal stretch; 1 gives blobs, higher gives streaks
 * @param angle       streak tilt in radians
 * @param coverage    how much sky is covered 0..1; lower leaves only the cores
 * @param levels      number of steps; fewer is flatter and more graphic
 * @param softness    width of a step edge 0..0.5; 0.5 is a smooth gradient
 * @param warp        undulation; 0 is straight, higher frays into hooks
 * @param horizon     lower edge of the clouds, as a height from the bottom 0..1
 * @param horizonSoft softness of that edge; 0 cuts a straight line
 */
export const sky = Fn(
  ([
    time,
    skyColor,
    cloudA,
    cloudB,
    gradAngle,
    amount,
    scale,
    speed,
    stretch,
    angle,
    coverage,
    levels,
    softness,
    warp,
    horizon,
    horizonSoft,
  ]: [
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
  ]) => {
    // Isotropic coordinate with height as the unit, or the tilt changes with
    // the window's aspect ratio.
    const aspect = screenSize.x.div(screenSize.y);
    const uv: any = vec2(screenUV.x.mul(aspect), screenUV.y);

    // Tilt the streaks.
    const ca: any = angle.cos();
    const sa: any = angle.sin();
    const rot: any = vec2(
      uv.x.mul(ca).sub(uv.y.mul(sa)),
      uv.x.mul(sa).add(uv.y.mul(ca)),
    );

    // Squeezing x before reading the noise is where all the anisotropy comes
    // from.
    const q: any = vec2(rot.x.div(stretch), rot.y).mul(scale);
    const t: any = time.mul(speed);

    // Drift runs along the streaks (x); z morphs the shapes so they come apart
    // as they cross rather than sliding through unchanged.
    const p: any = vec3(q.x.sub(t), q.y.sub(t.mul(0.05)), t.mul(0.12));

    // Displace y only. Displacing x as well chops the streaks back into blobs.
    const wn: any = mx_fractal_noise_float(
      vec3(p.x.mul(0.8), p.y.mul(0.8), p.z.add(19.0)),
      2,
      2.0,
      0.5,
      1.0,
    );
    const pw: any = vec3(p.x, p.y.add(wn.mul(warp)), p.z);

    // The clouds. More octaves raises finer filaments. fbm doesn't reach ±1
    // (about ±0.3 at five octaves), so scale by 1.6 and centre on 0.5.
    const d: any = mx_fractal_noise_float(pw, 5, 2.3, 0.55, 1.0)
      .mul(1.6)
      .add(0.5);

    // Large-scale swell deciding where clouds appear at all; an even covering
    // doesn't read as thin cloud. Built from the pre-scale coordinate on
    // purpose — tied to q, raising "detail" would shrink these patches too and
    // nothing about the apparent scale would change.
    const qp: any = vec2(rot.x.div(stretch), rot.y).mul(0.8);
    const patch: any = mx_fractal_noise_float(
      vec3(qp.x.sub(t.mul(0.15)), qp.y, t.mul(0.06)),
      2,
      2.0,
      0.5,
      1.0,
    )
      .mul(0.5)
      .add(0.5);

    // Cut the clouds off towards the bottom of the frame. screenUV has y=0 at
    // the top (WGSL convention), so flip it to read as a height from the bottom.
    const heightFromBottom: any = float(1.0).sub(screenUV.y);
    const sky01: any = heightFromBottom.smoothstep(
      horizon.sub(horizonSoft),
      horizon.add(horizonSoft),
    );

    // Sweep the threshold from 1.0 (nothing) to 0.0 (everything). A fixed range
    // drifts out of step with the noise's real spread and either erases the
    // clouds or fills the sky — the first version thresholded at 0.57 against
    // values that never passed 0.55.
    //
    // The swell and the horizon shift the threshold rather than scaling the
    // density; scaling only thins everything evenly instead of splitting the
    // sky into cloudy and clear.
    const th: any = mix(float(1.0), float(0.0), coverage)
      .add(patch.sub(0.5).mul(0.4))
      .add(float(1.0).sub(sky01).mul(1.2));
    const density: any = d.smoothstep(th, th.add(0.18));

    // Quantise: floor to the step below, then smoothstep the edge back in.
    // `softness` is literally the width of that edge.
    const s: any = density.mul(levels);
    const edge: any = s
      .fract()
      .smoothstep(float(0.5).sub(softness), float(0.5).add(softness));
    const banded: any = s.floor().add(edge).div(levels);

    // Cloud colour comes from position on screen. It used to blend by `patch`,
    // the same noise that decides where clouds appear — so wherever there were
    // clouds that noise was high and only one colour ever showed. The variable
    // picking the colour has to be independent of the one placing the cloud.
    //
    // Normalised by projecting the screen onto the chosen direction, so any
    // angle uses the full 0..1 range.
    const gc: any = gradAngle.cos();
    const gs: any = gradAngle.sin();
    const proj: any = uv.x.mul(gc).add(heightFromBottom.mul(gs));
    const gMin: any = gc.min(0.0).mul(aspect).add(gs.min(0.0));
    const gRange: any = gc.abs().mul(aspect).add(gs.abs()).max(0.0001);
    const grad: any = proj.sub(gMin).div(gRange).clamp(0.0, 1.0);

    const cloud = mix(cloudA, cloudB, grad);
    return mix(skyColor, cloud, banded.mul(amount));
  },
);
