// Screen-space grain, standing in for the Cycles sampling noise the Blender
// reference has. Kuwahara organises existing variation rather than creating
// any, so a clean denoised bake collapses to flat colour; this puts the
// variation back. It has to be screen space — baked noise is averaged away by
// mipmapping before Kuwahara ever sees it.
//
// Three things matter: snap to the pixel grid (Blender samples whole pixels),
// keep the channels independent (that hue jitter is most of the effect), and
// **add a constant amount in display space**. Adding in linear hammers the
// shadows into black speckles; multiplying loses the shadow grain entirely.

import { Fn, vec2, vec3, screenSize } from "three/tsl";

// Same hash as FinalNode.
const hash = Fn(([p]: [any]) => {
  return p.dot(vec2(12.9898, 78.233)).sin().mul(43758.5453).fract();
});

/**
 * @param color  source colour (linear)
 * @param uv     per-tap sampling coordinate (screenUV space)
 * @param amount amplitude; 0 disables it
 */
export const grain = Fn(([color, uv, amount]: [any, any, any]) => {
  const px: any = uv.mul(screenSize).floor();
  // A different point per channel; one point would just give grey.
  const r = hash(px);
  const g = hash(px.add(vec2(37.0, 17.0)));
  const b = hash(px.add(vec2(11.0, 47.0)));

  // Display-space addition swings about twice as far in linear terms as the
  // old multiply, so halve it to keep the dialled-in highlight values.
  const scaled: any = amount.mul(0.5);
  const n = vec3(r, g, b).sub(0.5).mul(scaled);

  // linear → display (gamma 2.0 approximated with sqrt) → grain → linear.
  // Squaring on the way back guarantees ≥ 0, so nothing clips to black.
  const enc: any = color.max(0.0).sqrt();
  const perturbed: any = enc.add(n).max(0.0);
  return perturbed.mul(perturbed);
});
