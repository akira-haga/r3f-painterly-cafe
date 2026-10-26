import * as THREE from "three/webgpu";
import {
  Fn,
  vec2,
  vec3,
  vec4,
  mix,
  clamp,
  step,
  max,
  uniform,
  screenUV,
  screenSize,
  texture,
  nodeObject,
  renderOutput,
} from "three/tsl";

// The standard hash for [0,1) white noise from a screen coordinate.
// No setLayout — it would pin the argument type and rule out passing a vec2.
const hash21 = Fn(([p]: [any]) => {
  return p.dot(vec2(12.9898, 78.233)).sin().mul(43758.5453).fract();
});

// ACES filmic tone map
const ACESFilm = Fn(([x]: [any]) => {
  const a = 2.51;
  const b = 0.03;
  const c = 2.43;
  const d = 0.59;
  const e = 0.14;
  const num = x.mul(x.mul(a).add(b)); // x * (a*x + b)
  const den = x.mul(x.mul(c).add(d)).add(e); // x * (c*x + d) + e
  return num.div(den).clamp(0.0, 1.0);
});

// Saturation (adjustment = 1 is neutral, > 1 boosts).
//
// towardWhite picks where desaturation goes: luminance grey (0) or V, the max
// channel (1), which pulls towards white. Blender's Hue/Saturation shrinks
// HSV's S, and scaling S by k is exactly mix(vec3(V), rgb, k) — same formula,
// different target. On warm colours the two targets are far apart (0.70 vs
// 0.23), so the same number gives a completely different picture.
const sat = Fn(([rgb, adjustment, towardWhite]: [any, any, any]) => {
  const W = vec3(0.2125, 0.7154, 0.0721); // luminance weights
  const intensity = vec3(rgb.dot(W));
  const v = vec3(max(max(rgb.r, rgb.g), rgb.b)); // V from HSV
  const target = mix(intensity, v, towardWhite);
  // Use the free mix() — the .mix method corrupts values.
  return mix(target, rgb, adjustment);
});

export class FinalNode extends THREE.TempNode {
  colorNode: THREE.Node; // colour from the previous stage (the outline)
  watercolorNode: any; // paper texture (a TextureNode; .value can be swapped)
  watercolorTile: any; // 0 = stretch over the screen, 1 = tile at native size
  watercolorScale: any; // tiling scale (1 = one texel per pixel)
  watercolorSize: any; // texture resolution in px, used to work out the repeat count

  // ---- Look uniforms -----------------------------------------------------
  // The defaults are the hard-coded values from the GLSL port, so leaving them
  // alone reproduces that picture exactly. All of them are live from leva.

  /** Quantisation steps; more means finer gradation. Blender's Posterize 16 is
   *  16 per channel, so the same number posterises far harder here when
   *  quantising by luma. 32-48 softens the bands. */
  quantizeLevels: any;

  /** Lower bound for qn. Further from 0.5 pulls the shadows harder towards
   *  black (0.1); nearer 0.5 keeps more of Kuwahara's colour. */
  clampLo: any;

  /** Upper bound for qn. Further from 0.5 pulls the highlights harder towards
   *  white. */
  clampHi: any;

  /** Saturation; 1.0 is neutral. With satTowardWhite on, Blender's preview
   *  takes the same value verbatim. */
  saturation: any;

  /** Noise added just before quantising, measured in steps. Blender posterises
   *  an image that still carries sampling noise, which dissolves the step
   *  boundaries into grain; a denoised bake gives hard lines instead.
   *  1.0 (±0.5 of a step) breaks up the boundaries without touching flat areas;
   *  past 2.0 it is just noise. */
  ditherAmount: any;

  /** Quantise per channel? 0 = by luma (the original), 1 = independent R/G/B,
   *  which is what Blender does.
   *
   *  1 raises apparent saturation, since the step boundaries land differently
   *  per channel and the hue jitters — which is why `saturation` has to come
   *  down to compensate. Use 0 or 1; values between mean nothing. */
  perChannel: any;

  /** Where desaturation goes. 0 = luminance grey, 1 = V (white), matching
   *  Blender's Hue/Saturation — see sat() above. */
  satTowardWhite: any;

  constructor(colorNode: THREE.Node, watercolorTexture: THREE.Texture | null) {
    super("vec4");
    this.colorNode = colorNode;
    this.watercolorNode = texture(watercolorTexture as any);

    this.quantizeLevels = uniform(16.0);
    this.clampLo = uniform(0.2);
    this.clampHi = uniform(0.7);
    this.saturation = uniform(1.5);
    this.ditherAmount = uniform(0.0);
    this.perChannel = uniform(0.0);
    this.satTowardWhite = uniform(0.0);

    // How the paper is mapped. Stretching (tile=0, the original) skews the
    // texture with the window's aspect ratio, which thickens a directional
    // weave until it reads as cloth. Tiling at native size doesn't.
    this.watercolorTile = uniform(0.0);
    this.watercolorScale = uniform(1.0);
    this.watercolorSize = uniform(new THREE.Vector2(1024, 512));
  }

  setup() {
    const input: any = nodeObject(this.colorNode);
    const watercolorTex = this.watercolorNode;

    const main = Fn(() => {
      // The GLSL version worked on a display-encoded (tone-mapped + sRGB)
      // Kuwahara result, so reproduce that with renderOutput. Scene.tsx sets
      // outputColorTransform=false, so this is the only one applied.
      const disp: any = renderOutput(vec4(input.rgb, 1.0));
      const color: any = vec3(disp.rgb).toVar();

      // tile=0 is one copy over screenUV; tile=1 repeats by screen resolution ÷
      // texture resolution. Needs RepeatWrapping, set in Scene.tsx.
      const repeat: any = screenSize.div(
        this.watercolorSize.mul(this.watercolorScale),
      );
      const paperUv: any = mix(
        screenUV,
        screenUV.mul(repeat),
        this.watercolorTile,
      );
      const watercolorColor = watercolorTex.sample(paperUv);

      // The luma-vs-per-channel fork. Everything downstream is component-wise
      // vec3 maths, so it works either way unchanged.
      //
      // Why it matters: with a shared qn, `darker` below pushes a channel that
      // is already under 0.1 further down. Measured on the roof tiles, B fell to
      // 0.029 against Blender's 0.323, which lifts low channels on their own.
      const luma = color.dot(vec3(0.299, 0.587, 0.114));
      const qBasis: any = mix(vec3(luma), color, this.perChannel);

      // Quantise. The step count is a uniform, so n-1 is a node too.
      const nm1: any = this.quantizeLevels.sub(1.0);

      // After .mul(nm1) one step equals 1.0, so ±0.5 here is ±0.5 of a step.
      // Drawn in screen coordinates, so the grain stays 1px at any resolution
      // and crawls when the camera moves — same as the outline's break-up.
      const px: any = screenUV.mul(screenSize);
      const dither: any = hash21(px).sub(0.5).mul(this.ditherAmount);

      const stepped: any = qBasis
        .mul(nm1)
        .add(0.5)
        .add(dither)
        .floor()
        .div(nm1);
      const qn: any = clamp(
        stepped,
        vec3(this.clampLo),
        vec3(this.clampHi),
      ).toVar();

      // qn < 0.5 pulls towards 0.1 to firm up the shadows, qn >= 0.5 towards
      // white to open the highlights; only 0.5 passes through untouched. The
      // clamp range is literally the strength of the flattening.
      const darker = mix(vec3(0.1), color, qn.mul(2.0));
      const lighter = mix(color, vec3(1.0), qn.sub(0.5).mul(2.0));
      // step + mix rather than qn.lessThan(0.5).select(...): once qn is a vec3
      // the condition is a bvec3 and component-wise select isn't guaranteed.
      color.assign(mix(darker, lighter, step(0.5, qn)));

      color.assign(sat(color, this.saturation, this.satTowardWhite));
      color.assign(ACESFilm(color));

      // Multiply by the paper. This node ends the chain, so it outputs sRGB.
      const outSRGB = color.mul(watercolorColor.rgb);
      return vec4(outSRGB, watercolorColor.a);
    });

    return main();
  }
}

export const finalPass = (
  colorNode: THREE.Node,
  watercolorTexture: THREE.Texture | null,
) => nodeObject(new FinalNode(colorNode, watercolorTexture));
