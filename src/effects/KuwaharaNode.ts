import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  Loop,
  float,
  vec2,
  vec3,
  vec4,
  uniform,
  screenUV,
  screenSize,
  nodeObject,
} from "three/tsl";
import { grain } from "./grain";

// Pull the dominant direction v(xy) and the eigenvalues lambda1(z), lambda2(w)
// out of the structure tensor.
const getDominantOrientation = Fn(([st]: [any]) => {
  const Jxx = st.r;
  const Jyy = st.g;
  const Jxy = st.b;

  const trace = Jxx.add(Jyy);
  const determinant = Jxx.mul(Jyy).sub(Jxy.mul(Jxy));
  const discriminant = trace
    .mul(trace)
    .mul(0.25)
    .sub(determinant)
    .max(0.0)
    .sqrt();
  const lambda1 = trace.mul(0.5).add(discriminant);
  const lambda2 = trace.mul(0.5).sub(discriminant);

  const v: any = vec2(0.0).toVar();
  If(Jxy.abs().greaterThan(1e-7), () => {
    v.assign(vec2(Jxy.negate(), Jxx.sub(lambda1)).normalize());
  }).Else(() => {
    // Jxy≈0: the gradient is axis-aligned
    v.assign(Jxx.greaterThanEqual(Jyy).select(vec2(1.0, 0.0), vec2(0.0, 1.0)));
  });

  return vec4(v, lambda1, lambda2);
});

// Polynomial weight
const polynomialWeight = Fn(([x, y, eta, lambda]: [any, any, any, any]) => {
  const polyValue = x.add(eta).sub(lambda.mul(y.mul(y)));
  return polyValue.mul(polyValue).max(0.0);
});

export class KuwaharaNode extends THREE.TempNode {
  colorNode: THREE.Node; // scene colour with the brush strokes, not yet flattened
  tensorNode: THREE.Node; // structure tensor
  radius: any;

  /** Amplitude of the screen-space grain added to the input (see grain.ts).
   *
   *  This is where it matters. On a flat surface every sector has variance 0,
   *  so whichever one wins returns the same mean and the output is perfectly
   *  uniform. Grain spreads the variances apart, neighbouring pixels pick
   *  different winners, and the inside of a surface breaks up — the same route
   *  it takes in Blender.
   *
   *  It adds a constant amount in display space, so the grain reads the same in
   *  highlights and shadows and the shadows don't sink to black. 0.03 is a good
   *  starting point; 0 disables it. */
  grainAmount: any;

  constructor(colorNode: THREE.Node, tensorNode: THREE.Node, radius = 6) {
    super("vec4");
    this.colorNode = colorNode;
    this.tensorNode = tensorNode;
    this.radius = uniform(radius);
    this.grainAmount = uniform(0.0);
  }

  setup() {
    const original = this.colorNode as THREE.TextureNode;
    const tensor = this.tensorNode;
    const uRadius = this.radius;
    const uGrain = this.grainAmount;

    const main = Fn(() => {
      const texel = vec2(1.0).div(screenSize);
      const uvCoord = screenUV;

      // Read the scene colour (same -y flip convention as TensorNode).
      // The grain is a function of the tap coordinate, so reading the same
      // pixel always yields the same value and this can't disagree with the
      // tensor pass. Effectively both read one noisy image.
      const sampleColor = (offset: any) => {
        const tapUV: any = uvCoord.add(offset.mul(vec2(1.0, -1.0)).mul(texel));
        return grain(original.sample(tapUV).rgb, tapUV, uGrain);
      };

      // Evaluate the tensor (a 9-tap Sobel) once and pin it to a var, or each
      // reference to st.r/.g/.b risks expanding the Sobel again.
      const tensorV = (nodeObject(tensor) as any).toVar();
      const oa = getDominantOrientation(tensorV);
      const orientation = oa.xy;
      const lambda1 = oa.z;
      const lambda2 = oa.w;
      const ox = orientation.x;
      const oy = orientation.y;

      const anisotropy = lambda1
        .sub(lambda2)
        .div(lambda1.add(lambda2).add(1e-7));
      const alpha = float(25.0);
      const scaleX = alpha.div(anisotropy.add(alpha));
      const scaleY = anisotropy.add(alpha).div(alpha);

      const eta = float(0.1);
      const lambda = float(0.5);

      // int version for the loop bound. It's a uniform, so the loop is dynamic
      // and changing the radius doesn't recompile.
      const uRadiusI = nodeObject(uRadius).toInt();

      const minVariance: any = float(10000.0).toVar();
      const finalColor: any = vec3(0.0).toVar();

      const wSum: any = vec3(0.0).toVar();
      const wSqSum: any = vec3(0.0).toVar();
      const totalW: any = float(0.0).toVar();

      // Name each loop variable; without names they all collide on i and the
      // coordinates come out wrong.
      Loop({ start: 0, end: 8, name: "si" } as any, ({ si }: any) => {
        const angle = float(si).mul((Math.PI * 2.0) / 8.0);

        // Reset the accumulators per sector — the whole point is picking the
        // lowest-variance one.
        wSum.assign(vec3(0.0));
        wSqSum.assign(vec3(0.0));
        totalW.assign(0.0);

        const rLoop = {
          start: 1,
          end: uRadiusI,
          condition: "<=",
          name: "sr",
        } as any;
        // Three sub-angles: -π/8, 0, +π/8. Sector width is unchanged.
        const aLoop = { start: 0, end: 3, name: "sa" } as any;
        Loop(rLoop, ({ sr }: any) => {
          Loop(aLoop, ({ sa }: any) => {
            const a = float(sa)
              .mul(Math.PI / 8.0)
              .sub(Math.PI / 8.0);
            const ang = angle.add(a);

            const d = vec2(ang.cos(), ang.sin()).mul(float(sr));
            const rotated = vec2(
              d.x.mul(ox).sub(d.y.mul(oy)),
              d.x.mul(oy).add(d.y.mul(ox)),
            );
            const sampleOffset = vec2(
              rotated.x.mul(scaleX),
              rotated.y.mul(scaleY),
            );

            const c = sampleColor(sampleOffset);
            const weight = polynomialWeight(
              sampleOffset.x,
              sampleOffset.y,
              eta,
              lambda,
            );

            wSum.addAssign(c.mul(weight));
            wSqSum.addAssign(c.mul(c).mul(weight));
            totalW.addAssign(weight);
          });
        });

        const avgColor = wSum.div(totalW);
        const varianceRes = wSqSum.div(totalW).sub(avgColor.mul(avgColor));
        const variance = varianceRes.dot(vec3(0.299, 0.587, 0.114)).toVar();

        If(variance.lessThan(minVariance), () => {
          minVariance.assign(variance);
          finalColor.assign(avgColor);
        });
      });

      return vec4(finalColor, 1.0);
    });

    return main();
  }
}

export const kuwaharaPass = (
  colorNode: THREE.Node,
  tensorNode: THREE.Node,
  radius = 6,
) => nodeObject(new KuwaharaNode(colorNode, tensorNode, radius));
