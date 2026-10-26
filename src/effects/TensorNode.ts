import * as THREE from "three/webgpu";
import {
  Fn,
  vec2,
  vec4,
  uniform,
  screenUV,
  screenSize,
  nodeObject,
} from "three/tsl";
import { grain } from "./grain";

export class TensorNode extends THREE.TempNode {
  inputNode: THREE.Node;

  /** Amplitude of the screen-space grain added to the input (see grain.ts).
   *  Must match KuwaharaNode's value. In Blender the Cycles noise runs through
   *  the whole chain, so the direction detection sees the same grain. Here that
   *  means the Sobel result wobbles slightly, i.e. the sector rotation varies
   *  per pixel. 0 disables it. */
  grainAmount: any;

  constructor(inputNode: THREE.Node) {
    super("vec4");
    this.inputNode = inputNode;
    this.grainAmount = uniform(0.0);
  }

  setup() {
    // Narrowed to TextureNode for .sample() (the rtt() of the brush pass).
    const inputNode = this.inputNode as THREE.TextureNode;
    const uGrain = this.grainAmount;

    const computeStructureTensor = Fn(() => {
      // Texel size, the old resolution.zw.
      const texel = vec2(1.0).div(screenSize);
      const uvCoord = screenUV;

      // 3x3 neighbourhood; s(dx, dy) maps to tx{i}y{j} in the original GLSL.
      // Note the -dy: V is flipped relative to that code. The grain uses the
      // same function and the same tap coordinates as the Kuwahara pass, so
      // both see identical values.
      const s = (dx: number, dy: number) => {
        const tapUV: any = uvCoord.add(vec2(dx, -dy).mul(texel));
        return grain(inputNode.sample(tapUV).rgb, tapUV, uGrain);
      };

      const tx0y0 = s(-1, -1),
        tx0y1 = s(-1, 0),
        tx0y2 = s(-1, 1);
      const tx1y0 = s(0, -1),
        tx1y2 = s(0, 1);
      const tx2y0 = s(1, -1),
        tx2y1 = s(1, 0),
        tx2y2 = s(1, 1);

      // Sobel Gx: -tx0y0 + tx2y0 - 2·tx0y1 + 2·tx2y1 - tx0y2 + tx2y2
      const Sx = tx0y0
        .mul(-1.0)
        .add(tx2y0)
        .add(tx0y1.mul(-2.0))
        .add(tx2y1.mul(2.0))
        .add(tx0y2.mul(-1.0))
        .add(tx2y2);

      // Sobel Gy: -tx0y0 - 2·tx1y0 - tx2y0 + tx0y2 + 2·tx1y2 + tx2y2
      const Sy = tx0y0
        .mul(-1.0)
        .add(tx1y0.mul(-2.0))
        .add(tx2y0.mul(-1.0))
        .add(tx0y2)
        .add(tx1y2.mul(2.0))
        .add(tx2y2);

      // vec4(dot(Sx,Sx), dot(Sy,Sy), dot(Sx,Sy), 1.0)
      return vec4(Sx.dot(Sx), Sy.dot(Sy), Sx.dot(Sy), 1.0);
    });

    return computeStructureTensor();
  }
}

// Leave the return type to inference (it gets wrapped internally).
export const tensorPass = (node: THREE.Node) =>
  nodeObject(new TensorNode(node));
