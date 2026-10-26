import * as THREE from "three/webgpu";
import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  mix,
  uniform,
  texture,
  screenUV,
  screenSize,
  nodeObject,
  cameraNear,
  cameraFar,
  perspectiveDepthToViewZ,
  mx_fractal_noise_float,
  mx_fractal_noise_vec3,
} from "three/tsl";

// 3x3 Sobel. Given an s(dx, dy) that returns a scalar, returns the gradient
// vector (Gx, Gy): its length is how sharp the change is, its direction is the
// edge normal. The direction is needed to run the break-up along the line, so
// this returns the vector rather than just the magnitude. The -dy (flipped V)
// convention from TensorNode is absorbed in the tap coordinates.
const sobelGradient = (s: (dx: number, dy: number) => any) => {
  const p00 = s(-1, -1),
    p01 = s(-1, 0),
    p02 = s(-1, 1);
  const p10 = s(0, -1),
    p12 = s(0, 1);
  const p20 = s(1, -1),
    p21 = s(1, 0),
    p22 = s(1, 1);

  // Gx = -p00 + p20 - 2*p01 + 2*p21 - p02 + p22
  const gx = p00
    .mul(-1.0)
    .add(p20)
    .add(p01.mul(-2.0))
    .add(p21.mul(2.0))
    .add(p02.mul(-1.0))
    .add(p22);

  // Gy = -p00 - 2*p10 - p20 + p02 + 2*p12 + p22
  const gy = p00
    .mul(-1.0)
    .add(p10.mul(-2.0))
    .add(p20.mul(-1.0))
    .add(p02)
    .add(p12.mul(2.0))
    .add(p22);

  return vec2(gx, gy);
};

export class OutlineNode extends THREE.TempNode {
  // The previous stage (Kuwahara) baked to a texture with rtt(). Used both for
  // the centre colour and the luminance edges.
  // Reading the *flattened* image rather than the raw scene is the key part.
  // The raw scene carries AO, shadows, texture detail and JPEG noise, and Sobel
  // fires on all of it. Kuwahara is a denoiser that crushes the image into
  // colour patches, so a Sobel of its output returns only the patch boundaries
  // — which is exactly what should become a line.
  colorNode: THREE.Node;
  depthNode: THREE.Node; // depth texture from scenePass
  paperNode: any; // paper texture for the break-up (optional)

  thickness: any; // tap distance in px, i.e. line weight
  strength: any; // line opacity 0..1
  depthWeight: any; // contribution of depth edges (silhouettes)
  lumaWeight: any; // contribution of luminance edges (markings, creases)
  threshold: any; // lower bound for calling something an edge
  softness: any; // width of that threshold; higher is softer
  wobbleAmount: any; // how much the line wobbles, in px
  wobbleScale: any; // frequency of the wobble noise
  inkColor: any; // ink colour

  // --- Break-up (the gaps in a pen line) ---
  breakAmount: any; // 0 solid .. 1 almost gone
  breakScale: any; // how fine the break-up is along the line
  breakAniso: any; // squash across the line; smaller stretches further along it
  breakBias: any; // how much strong lines resist breaking up
  paperAmount: any; // how much the paper contributes to the break-up (0 = off)
  paperThreshold: any; // paper brightness below which ink stops sticking
  paperTile: any; // 0 = stretch over the screen, 1 = tile at native size
  paperScale: any; // tiling scale (1 = one texel per pixel)
  paperSize: any; // texture resolution in px

  constructor(
    colorNode: THREE.Node,
    depthNode: THREE.Node,
    paperTexture: THREE.Texture | null = null,
  ) {
    super("vec4");
    this.colorNode = colorNode;
    this.depthNode = depthNode;
    this.paperNode = texture(paperTexture as any);

    this.thickness = uniform(1.5);
    this.strength = uniform(0.9);
    this.depthWeight = uniform(1.0);
    this.lumaWeight = uniform(0.06);
    this.threshold = uniform(0.06);
    this.softness = uniform(0.08);
    this.wobbleAmount = uniform(1.8);
    this.wobbleScale = uniform(6.0);
    this.inkColor = uniform(new THREE.Color(0x1a1512));

    this.breakAmount = uniform(0.45);
    this.breakScale = uniform(38.0);
    this.breakAniso = uniform(0.12);
    this.breakBias = uniform(0.7);
    this.paperAmount = uniform(0.0);
    this.paperThreshold = uniform(0.5);
    // Matches how the final pass maps it (see FinalNode.watercolorTile).
    this.paperTile = uniform(0.0);
    this.paperScale = uniform(1.0);
    this.paperSize = uniform(new THREE.Vector2(1024, 512));
  }

  setup() {
    const colorTex = this.colorNode as THREE.TextureNode;
    const depthTex = this.depthNode as THREE.TextureNode;

    const main = Fn(() => {
      const texel = vec2(1.0).div(screenSize);
      const uvCoord = screenUV;

      // --- What sells the hand-drawn look: offset the sample position with
      // fbm noise so the line wavers ---
      // mx_fractal_noise_vec3 has its input pinned to vec3 by setLayout, so a
      // vec2 produces a type mismatch in the generated shader. Widen it first.
      const nUv: any = uvCoord.mul(this.wobbleScale);
      const wobble = mx_fractal_noise_vec3(
        vec3(nUv.x, nUv.y, 0.0),
        3,
        2.0,
        0.5,
        1.0,
      )
        .xy.mul(this.wobbleAmount)
        .mul(texel);

      const baseUv = uvCoord.add(wobble).toVar();

      // Tap coordinates, same -y convention as TensorNode / KuwaharaNode.
      const tapUv = (dx: number, dy: number) =>
        baseUv.add(vec2(dx, -dy).mul(this.thickness).mul(texel));

      // --- Depth edges ---
      // Raw depth is non-linear, so convert back to viewZ to get distance from
      // the camera.
      const dist = (dx: number, dy: number) =>
        perspectiveDepthToViewZ(
          depthTex.sample(tapUv(dx, dy)).r,
          cameraNear,
          cameraFar,
        ).negate();

      const centerDist = dist(0, 0).toVar();
      // Normalise by the centre distance so one threshold works near and far.
      const depthGrad = sobelGradient(dist).div(centerDist.max(1e-4));

      // --- Luminance edges ---
      // Taken from the flattened (post-Kuwahara) image, so this only fires on
      // patch boundaries. From the raw scene it would be lines everywhere.
      const luma = (dx: number, dy: number) =>
        colorTex.sample(tapUv(dx, dy)).rgb.dot(vec3(0.299, 0.587, 0.114));
      const lumaGrad = sobelGradient(luma);

      // Strength is the sum of both magnitudes — either one can draw a line.
      // Direction comes from the vector sum, and is what tells us which way the
      // line runs.
      // The uniforms are `any`, so TS resolves .mul() to the vec3 overload;
      // these are really float / vec2, hence the `any` annotations (same style
      // as the other nodes).
      const edge: any = depthGrad
        .length()
        .mul(this.depthWeight)
        .add(lumaGrad.length().mul(this.lumaWeight));

      const gSum: any = depthGrad
        .mul(this.depthWeight)
        .add(lumaGrad.mul(this.lumaWeight));

      // Threshold into a smooth 0..1 line mask.
      const line = edge
        .smoothstep(this.threshold, this.threshold.add(this.softness))
        .mul(this.strength)
        .clamp(0.0, 1.0)
        .toVar();

      // --- Break-up (the gaps in a pen line) ---
      // Punching holes with isotropic noise gives a dotted, moth-eaten line
      // that reads as "a line with noise on it". A real pen drops out in
      // segments along its length, so the noise has to be stretched along the
      // line — and the perpendicular of the gradient is that direction.
      const gLen = gSum.length();
      const gDir = gSum.div(gLen.max(1e-6)); // line normal (gradient direction)
      const tangent = vec2(gDir.y.negate(), gDir.x); // direction the line runs

      // Measure in aspect-corrected coordinates, or the break-up skews on a
      // wide window.
      const aspect = screenSize.x.div(screenSize.y);
      const uvA = vec2(uvCoord.x.mul(aspect), uvCoord.y);

      // s (along the line) stays fine-grained; p (across it) is squashed by
      // breakAniso. That makes the full width of the line drop out together,
      // which is what a pen lifting off the paper leaves behind.
      const s: any = uvA.dot(tangent).mul(this.breakScale);
      const p: any = uvA.dot(gDir).mul(this.breakScale).mul(this.breakAniso);
      const breakNoise: any = mx_fractal_noise_float(
        vec3(s, p, 0.0),
        3,
        2.0,
        0.5,
        1.0,
      );

      // breakAmount 0 → threshold -1 (everything stays), 1 → 0.9 (almost nothing does)
      const breakTh = mix(float(-1.0), float(0.9), this.breakAmount);
      const dropout = breakNoise
        .smoothstep(breakTh.sub(0.12), breakTh.add(0.12))
        .toVar();

      // Break it up with the paper as well — a stand-in for ink not reaching
      // the valleys (the dark parts) of the sheet.
      const paperRepeat: any = screenSize.div(
        this.paperSize.mul(this.paperScale),
      );
      const paperUv: any = mix(
        uvCoord,
        uvCoord.mul(paperRepeat),
        this.paperTile,
      );
      const paperLuma = this.paperNode
        .sample(paperUv)
        .rgb.dot(vec3(0.299, 0.587, 0.114));
      const paperMask = paperLuma.smoothstep(
        this.paperThreshold.sub(0.15),
        this.paperThreshold.add(0.15),
      );
      dropout.mulAssign(mix(float(1.0), paperMask, this.paperAmount));

      // Let strong lines resist. `line` is already a normalised 0..1 line
      // strength, so it can be used directly: major contours stay solid and
      // the faint ones break up.
      const resist = line.mul(this.breakBias).clamp(0.0, 1.0);
      line.mulAssign(mix(dropout, float(1.0), resist));

      // Read the base colour from the un-wobbled coordinate. The wobble only
      // moves where lines are detected; it must not distort the image.
      const base = colorTex.sample(uvCoord).rgb;

      // Lay the ink down. Use the free mix() — the .mix method corrupts values.
      const color = mix(vec3(base), vec3(this.inkColor), line);

      return vec4(color, 1.0);
    });

    return main();
  }
}

// colorNode must already be a texture (rtt()). Passing a compute node re-runs
// the previous stage once per neighbourhood tap, nine times over.
export const outlinePass = (
  colorNode: THREE.Node,
  depthNode: THREE.Node,
  paperTexture: THREE.Texture | null = null,
) => nodeObject(new OutlineNode(colorNode, depthNode, paperTexture));
