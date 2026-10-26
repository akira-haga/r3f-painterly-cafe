// Paint laid down along the cursor's path, composited into the scene colour
// before the Kuwahara pass so the strokes get the same flattening and outline
// as everything else — composited after, they would sit on top like a sticker.
// The result must be baked with rtt(), or Kuwahara expands it once per tap.
//
// No accumulation buffer: the last TRAIL_LENGTH points live in a uniform array
// and the whole trail is redrawn every frame, fading with age.
//
// Paint covers the segment between points, not the points themselves. Redraws
// are throttled, so dots alone would break into stepping stones when the cursor
// moves fast.
//
// Newest point first; Scene.tsx pushes from the JS side. z is the timestamp in
// seconds, and z < 0 means "empty, or cut the line here" — one gets inserted
// when the cursor leaves the canvas, so no stroke spans the gap.

import * as THREE from "three/webgpu";
import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  mix,
  uniform,
  uniformArray,
  Loop,
  nodeObject,
  screenUV,
  screenSize,
  mx_fractal_noise_float,
} from "three/tsl";

/** Points kept in the trail. A longer tail costs proportionally more loop iterations. */
export const TRAIL_LENGTH = 48;

export class BrushNode extends THREE.TempNode {
  colorNode: THREE.Node; // what to paint onto (the scene pass output texture)

  /** The trail. x,y are aspect-corrected screen coordinates, z the timestamp in seconds (negative = invalid). */
  trail: THREE.Vector3[];
  points: any; // the same array as a uniform

  now: any; // current time in seconds, on the same clock as trail z
  lifetime: any; // seconds until a point disappears
  size: any; // brush width, with screen height as the unit
  softness: any; // edge falloff 0..1
  strength: any; // paint opacity 0..1
  breakAmount: any; // dry-brush break-up, 0 solid .. 1 nearly gone
  breakScale: any; // how fine that break-up is
  color: any; // paint colour

  constructor(colorNode: THREE.Node) {
    super("vec4");
    this.colorNode = colorNode;

    this.trail = Array.from(
      { length: TRAIL_LENGTH },
      () => new THREE.Vector3(0, 0, -1),
    );
    this.points = uniformArray(this.trail, "vec3");

    this.now = uniform(0);
    this.lifetime = uniform(1.2);
    this.size = uniform(0.035);
    this.softness = uniform(0.6);
    this.strength = uniform(0.9);
    this.breakAmount = uniform(0.35);
    this.breakScale = uniform(60.0);
    this.color = uniform(new THREE.Color("#D9633F"));
  }

  setup() {
    const colorTex = this.colorNode as THREE.TextureNode;

    const main = Fn(() => {
      // Isotropic coordinate with height as the unit, or the brush squashes
      // horizontally.
      const aspect = screenSize.x.div(screenSize.y);
      const pix: any = vec2(screenUV.x.mul(aspect), screenUV.y);

      const alpha = float(0.0).toVar();

      Loop(TRAIL_LENGTH - 1, ({ i }: any) => {
        const p0: any = this.points.element(i);
        const p1: any = this.points.element(i.add(1));

        // Skip the segment if either end is invalid (z < 0 marks a cut).
        const valid: any = p0.z
          .greaterThan(0.0)
          .and(p1.z.greaterThan(0.0))
          .select(float(1.0), float(0.0));

        // Age measured from the newer end.
        const fade: any = this.now
          .sub(p0.z)
          .div(this.lifetime.max(0.0001))
          .oneMinus()
          .clamp(0.0, 1.0);

        // Distance to the segment, not to the point.
        const seg: any = p1.xy.sub(p0.xy);
        const t: any = pix
          .sub(p0.xy)
          .dot(seg)
          .div(seg.dot(seg).max(1e-6))
          .clamp(0.0, 1.0);
        const d: any = pix.sub(p0.xy.add(seg.mul(t))).length();

        // Older parts thin out, which reads as the tip of a brush.
        const w: any = this.size.mul(fade.mul(0.65).add(0.35));
        // At softness 0 the two smoothstep edges would coincide and the result
        // breaks, so keep the inner one strictly inside.
        const inner: any = w
          .mul(float(1.0).sub(this.softness))
          .min(w.sub(1e-5));
        const cov: any = d.smoothstep(inner, w).oneMinus();

        // Summing would darken wherever segments overlap and bead the stroke;
        // take the maximum instead.
        alpha.assign(alpha.max(cov.mul(fade).mul(valid)));
      });

      // Dry-brush break-up, in screen space (same idea as the outline's).
      const n: any = mx_fractal_noise_float(
        vec3(pix.x.mul(this.breakScale), pix.y.mul(this.breakScale), 0.0),
        3,
        2.0,
        0.5,
        1.0,
      )
        .mul(0.5)
        .add(0.5);
      const paper: any = mix(
        float(1.0),
        n.smoothstep(0.35, 0.75),
        this.breakAmount,
      );

      const a: any = alpha.mul(paper).mul(this.strength).clamp(0.0, 1.0);

      // Composite. Use the free mix() — the .mix method corrupts values.
      const base = colorTex.sample(screenUV).rgb;
      return vec4(mix(vec3(base), vec3(this.color), a), 1.0);
    });

    return main();
  }
}

// Returns a compute node. Bake it with rtt() before handing it to Kuwahara
// (see the note at the top).
export const brushPass = (colorNode: THREE.Node) =>
  nodeObject(new BrushNode(colorNode));
