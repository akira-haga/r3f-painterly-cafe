import { useTexture, useGLTF } from "@react-three/drei";
import { useThree, useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { float, uniform } from "three/tsl";
import { isMeshType } from "../lib/type-guards";
import { fixStemBase } from "../lib/stem-base";
import { useFoliageControls } from "./model-controls";
import { sway } from "../effects/sway";
import { useFrameRequest } from "../lib/render-ticker";
import * as THREE from "three/webgpu";

// Longest planter leaf in metres — the reference the bend is normalised
// against. The tree has differently sized leaves and measures its own value
// from the glb, so this constant is not used for it.
const PLANTER_LEAF_LENGTH = 0.2;

/** Base colour of a material. Colour decisions are made in Blender, so use
 *  whatever the glb carries rather than hard-coding anything here. */
function baseColor(mesh: THREE.Mesh | null) {
  const m = mesh?.material;
  const mat = Array.isArray(m) ? m[0] : m;
  return mat && "color" in mat
    ? (mat as THREE.MeshStandardMaterial).color
    : new THREE.Color("#ffffff");
}

/** @param lowQuality verdict from the quality probe (src/lib/auto-quality.ts).
 *  While true the sway stops. If it kept running it would keep requesting
 *  frames, and stopping the sky and the brush wouldn't cool anything down. */
export function Model({ lowQuality = false }: { lowQuality?: boolean }) {
  const {
    swayEnabled,
    swayAmount,
    swaySpeed,
    windScale,
    swayScatter,
    swayFps,
  } = useFoliageControls();

  const invalidate = useThree((s) => s.invalidate);

  const { nodes } = useGLTF("/models/Cafe.glb");
  // The 8K bake downscaled to 4K (the raw 8K Cafe_Bake.hdr lives in _3d_assets).
  // Kuwahara crushes away anything 8K carried, so the picture barely changes
  // while VRAM drops ~358MB → ~89MB (RGBA8 + mips). The download is ~15MB at
  // 4K; an 8K PNG was 49MB. VRAM is the one that
  // matters: integrated GPUs choke there first. The bake margin is 32px at 8K,
  // so 16px survives and the island edges don't bleed.
  //
  // Staying PNG is deliberate. JPEG cut the 2026-09-18 bake from 9.6MB to 2.3MB, but
  // Kuwahara amplifies block noise on flat walls and the outline Sobel picks it
  // up — jpeg 75% was tried and dropped for exactly that.
  // Revisit compression once the look is frozen.
  const bakedTexture = useTexture("/textures/Cafe_Bake.png", (texture) => {
    const t = Array.isArray(texture) ? texture[0] : texture;
    t.flipY = false;
    t.colorSpace = THREE.SRGBColorSpace;
  });

  const baked = isMeshType(nodes.baked) ? nodes.baked : null;
  const leaf = isMeshType(nodes.Foliage_Planter_Leaf)
    ? nodes.Foliage_Planter_Leaf
    : null;
  const flower = isMeshType(nodes.Foliage_Planter_Flower)
    ? nodes.Foliage_Planter_Flower
    : null;
  const treeLeaf = isMeshType(nodes.Foliage_Tree_Leaf)
    ? nodes.Foliage_Tree_Leaf
    : null;
  const treeFlower = isMeshType(nodes.Foliage_Tree_Flower)
    ? nodes.Foliage_Tree_Flower
    : null;

  const foliage = useMemo(
    () => ({
      leaf: fixStemBase(leaf),
      flower: fixStemBase(flower),
      treeLeaf: fixStemBase(treeLeaf),
      treeFlower: fixStemBase(treeFlower),
    }),
    [leaf, flower, treeLeaf, treeFlower],
  );

  // Leaf and flower materials. They aren't in the texture bake (colour comes from
  // vertex colours or the Base Colour, see build() below), and
  // the real things are thin, so DoubleSide. The sway goes on positionNode.
  // Every knob is applied by updating a uniform rather than rebuilding the
  // material — the same treatment as the outline and final passes in Scene.tsx.
  const {
    uniforms,
    leafMaterial,
    flowerMaterial,
    treeLeafMaterial,
    treeFlowerMaterial,
  } = useMemo(() => {
    const uniforms = {
      time: uniform(0),
      amount: uniform(0),
      speed: uniform(1.2),
      windScale: uniform(1.0),
      scatter: uniform(1.0),
    };
    // Flowers get the *leaf* length of the same plant, not their own, so that
    // being shorter makes them sway less (sway.ts, leafLength).
    const treeLength =
      foliage.treeLeaf?.geometry.userData.stemLength ?? PLANTER_LEAF_LENGTH;
    const build = (mesh: THREE.Mesh | null, leafLength: number) => {
      if (!mesh) return null;
      const m = new THREE.MeshBasicNodeMaterial();
      // Use vertex colours when present (a Cycles diffuse bake on the active
      // colour attribute). Albedo is baked in, so the material stays white.
      // Without them, fall back to the Base Colour — the pre-bake state.
      if (mesh.geometry.getAttribute("color")) {
        m.vertexColors = true;
        m.color.setRGB(1, 1, 1);
      } else {
        m.color.copy(baseColor(mesh));
      }
      m.side = THREE.DoubleSide;
      m.positionNode = sway(
        uniforms.time,
        uniforms.amount,
        uniforms.speed,
        uniforms.windScale,
        uniforms.scatter,
        float(leafLength),
      );
      return m;
    };
    return {
      uniforms,
      leafMaterial: build(foliage.leaf, PLANTER_LEAF_LENGTH),
      flowerMaterial: build(foliage.flower, PLANTER_LEAF_LENGTH),
      treeLeafMaterial: build(foliage.treeLeaf, treeLength),
      treeFlowerMaterial: build(foliage.treeFlower, treeLength),
    };
  }, [foliage]);

  // Sway off is expressed as amount=0, which stops it without rebuilding the
  // node graph (same trick as outlineEnabled → strength=0 in Scene.tsx).
  useEffect(() => {
    // Low quality means amount 0, i.e. the rest pose. Time would otherwise keep
    // advancing with no frames drawn and the leaves would jump the next time
    // something rendered, so stopping also resets the pose.
    uniforms.amount.value = swayEnabled && !lowQuality ? swayAmount : 0;
    uniforms.speed.value = swaySpeed;
    uniforms.windScale.value = windScale;
    uniforms.scatter.value = swayScatter;
    invalidate();
  }, [
    uniforms,
    swayEnabled,
    lowQuality,
    swayAmount,
    swaySpeed,
    windScale,
    swayScatter,
    invalidate,
  ]);

  // frameloop="demand", so frames have to be requested while this animates.
  // Calling invalidate from inside useFrame would run at the display's refresh
  // rate, and the post chain is expensive enough to heat the machine, so the
  // request is throttled by a timer instead. That timer lives in render-ticker
  // and is shared with the sky and the brush — separate timers drift out of
  // phase and multiply the redraws. Stop the sway and the request goes away;
  // with nothing else animating the picture goes still and the GPU idles.
  useFrameRequest("sway", swayEnabled && !lowQuality, swayFps, invalidate);

  // Time advances by real elapsed seconds, so a lower fps doesn't slow the sway.
  useFrame((_, delta) => {
    if (!swayEnabled || lowQuality) return;
    uniforms.time.value += delta;
  });

  // glTF nodes carry Blender's object transforms. `baked` and the foliage have
  // different origins and rotations, so all of position, rotation and scale
  // have to be passed on or the foliage alone lands in the wrong place. The
  // foliage objects are rotated 6.874° about X; dropping that displaces clumps
  // in proportion to their distance from the origin (~0.48m at 4m away), and
  // fixing only the position doesn't help.
  //
  // The rotation must NOT be applied in Blender. Ctrl+A rotates the vertices,
  // but _stembase is a plain vector attribute and doesn't rotate with them, so
  // the sway pivots get left behind. Leave object transforms unbaked and read
  // them here.
  const nodeTransform = (mesh: THREE.Mesh) => ({
    position: mesh.position,
    quaternion: mesh.quaternion,
    scale: mesh.scale,
  });

  // Then shift the whole group back by baked's offset to keep the framing.
  const recenter = useMemo(
    () => (baked ? baked.position.clone().negate() : new THREE.Vector3()),
    [baked],
  );

  return (
    <group position={recenter}>
      {baked && (
        <mesh geometry={baked.geometry} {...nodeTransform(baked)}>
          <meshBasicMaterial map={bakedTexture} />
        </mesh>
      )}
      {foliage.leaf && leafMaterial && (
        <mesh
          geometry={foliage.leaf.geometry}
          material={leafMaterial}
          {...nodeTransform(foliage.leaf)}
        />
      )}
      {foliage.flower && flowerMaterial && (
        <mesh
          geometry={foliage.flower.geometry}
          material={flowerMaterial}
          {...nodeTransform(foliage.flower)}
        />
      )}
      {foliage.treeLeaf && treeLeafMaterial && (
        <mesh
          geometry={foliage.treeLeaf.geometry}
          material={treeLeafMaterial}
          {...nodeTransform(foliage.treeLeaf)}
        />
      )}
      {foliage.treeFlower && treeFlowerMaterial && (
        <mesh
          geometry={foliage.treeFlower.geometry}
          material={treeFlowerMaterial}
          {...nodeTransform(foliage.treeFlower)}
        />
      )}
    </group>
  );
}
