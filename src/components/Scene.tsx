import { useTexture } from "@react-three/drei";
import { useThree, useFrame } from "@react-three/fiber";
import { useMemo, useEffect, useRef } from "react";
import * as THREE from "three/webgpu";
import { pass, rtt, uniform } from "three/tsl";
import { tensorPass } from "../effects/TensorNode";
import { kuwaharaPass } from "../effects/KuwaharaNode";
import { outlinePass } from "../effects/OutlineNode";
import { finalPass } from "../effects/FinalNode";
import { sky } from "../effects/sky";
import { createQualityProbe } from "../lib/auto-quality";
import { brushPass, type BrushNode } from "../effects/BrushNode";
import {
  requestFrames,
  stopFrames,
  useFrameRequest,
} from "../lib/render-ticker";
import { Model } from "./Model";
import { useSceneControls } from "./scene-controls";

// Redraw rate while the sky animates. Same reasoning as the leaf sway in
// Model.tsx: throttled to keep the cost down, and low rates suit a hand-drawn
// look anyway. render-ticker funnels the sway, sky and brush requests into one
// timer, so running all three still caps at the fastest one.
const BG_FPS = 12;

// Redraw rate while the brush moves, and until the trail has faded. Higher
// tracks the cursor more closely and runs Kuwahara that much more often. The
// gaps between points are filled with segments, so a low rate still draws a
// continuous line.
const BRUSH_FPS = 20;

/** @param onAutoLow called when the probe drops quality to "low", so the page
 *  can say so. restore() puts it back to "normal"; measuring is already over,
 *  so nothing will demote it again.
 *  @param onReady called once the first frame has actually been drawn. The
 *  loading overlay waits for this rather than for the downloads, because the
 *  post chain compiles on that first render. */
export function Scene({
  onAutoLow,
  onReady,
}: {
  onAutoLow?: (info: { ms: number; restore: () => void }) => void;
  onReady?: () => void;
}) {
  const [
    {
      tensorEnabled,
      kuwaharaEnabled,
      outlineEnabled,
      finalEnabled,
      radius,
      grainAmount,
      thickness,
      strength,
      depthWeight,
      lumaWeight,
      threshold,
      softness,
      wobbleAmount,
      wobbleScale,
      inkColor,
      breakAmount,
      breakScale,
      breakAniso,
      breakBias,
      paperAmount,
      paperThreshold,
      paperTile,
      paperTexScale,
      quantizeLevels,
      clampLo,
      clampHi,
      saturation,
      ditherAmount,
      perChannel,
      satTowardWhite,
      bgEnabled,
      bgAmount,
      bgScale,
      bgSpeed,
      bgStretch,
      bgAngle,
      bgCoverage,
      bgLevels,
      bgSoftness,
      bgWarp,
      bgHorizon,
      bgHorizonSoft,
      bgBase,
      bgColorA,
      bgColorB,
      bgGradAngle,
      brushEnabled,
      brushColor,
      brushSize,
      brushSoft,
      brushLife,
      brushStrength,
      brushBreak,
      brushBreakScale,
      quality,
    },
    setControls,
  ] = useSceneControls();

  // Only used for the low verdict. Rather than rewriting each knob, the whole
  // look steps down here.
  const lowQuality = quality === "low";

  const gl = useThree((s) => s.gl) as unknown as THREE.WebGPURenderer;
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate); // request a redraw (demand mode)

  // Paper for the final multiply. It is tiled over the screen in screenUV (or
  // stretched with tile off) and multiplied, so any near-white grey paper works (this one averages 234,
  // with 1-99% between 220 and 246).
  // https://unsplash.com/ja/%E5%86%99%E7%9C%9F/%E7%99%BD%E3%81%84%E8%B3%AA%E6%84%9F%E3%81%AE%E7%B4%99%E3%82%84%E6%BC%86%E5%96%B0%E3%81%AE%E8%A1%A8%E9%9D%A2-vS3idIiYxX0
  const watercolor = useTexture("/textures/paper.jpg", (t) => {
    const tex = Array.isArray(t) ? t[0] : t;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    // The GLSL version multiplied raw bytes through a plain sampler2D. Set
    // NoColorSpace so TSL's sample() doesn't decode sRGB→linear and the two
    // behave the same.
    tex.colorSpace = THREE.NoColorSpace;
    // Tiling takes uv past 1, so it has to repeat. With tile off only 0..1 is
    // used and this makes no difference.
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
  });

  // The scene pass and every node are built once.
  const {
    renderPipeline,
    painted,
    brushNode,
    tensorNode,
    kuwaharaNode,
    outlineNode,
    finalNode,
  } = useMemo(() => {
    const scenePass = pass(scene, camera);
    const color = scenePass.getTextureNode("output");
    const depth = scenePass.getTextureNode("depth"); // for the outline silhouettes
    // Composite the cursor's paint into the scene colour before flattening, so
    // the strokes go through Kuwahara and the outline and end up part of the
    // same picture as the building and the sky. The result is baked with rtt()
    // — left as a compute node it would be expanded once per tap, 144 times.
    // The fields (trail, uniforms) are reached through the nodeObject wrapper,
    // so it is only typed as BrushNode; same as outlineNode and the rest.
    const brushNode = brushPass(color) as unknown as BrushNode;
    const painted = rtt(brushNode);
    const tensorNode = tensorPass(painted);
    const kuwaharaNode = kuwaharaPass(painted, tensorNode, radius);
    // Bake the Kuwahara result to a render target. The outline reads a 3x3
    // neighbourhood, so a compute node would expand Kuwahara nine times; behind
    // an rtt() it runs once and is an ordinary texture from there on.
    // The side effect matters more than the saving: the outline gets to see the
    // *flattened* image. Against the raw scene it picks up noise and turns into
    // lines everywhere.
    const kuwaharaTex = rtt(kuwaharaNode);
    // The outline reuses the same paper as the final pass, so the break-up and
    // the paper texture agree.
    const outlineNode = outlinePass(kuwaharaTex, depth, watercolor);
    const finalNode = finalPass(outlineNode, watercolor);

    const renderPipeline = new THREE.RenderPipeline(gl);
    renderPipeline.outputNode = painted; // initial value; the effect below rewires it
    return {
      renderPipeline,
      painted,
      brushNode,
      tensorNode,
      kuwaharaNode,
      outlineNode,
      finalNode,
    };
    // gl / scene / camera are assumed constant from mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every sky knob is a uniform; the node is built once and never swapped
  // (off is amount=0, the same trick as outlineEnabled → strength=0).
  const bgUniforms = useMemo(
    () => ({
      time: uniform(0),
      sky: uniform(new THREE.Color("#E7E7E7")),
      cloudA: uniform(new THREE.Color("#7FA9D6")),
      cloudB: uniform(new THREE.Color("#E8A86A")),
      gradAngle: uniform(0),
      amount: uniform(0),
      scale: uniform(6.0),
      speed: uniform(0.005),
      stretch: uniform(6.0),
      angle: uniform(0),
      coverage: uniform(0.55),
      levels: uniform(3),
      softness: uniform(0.12),
      warp: uniform(0.35),
      horizon: uniform(0.5),
      horizonSoft: uniform(0.18),
    }),
    [],
  );

  // Assigned to the scene once. It takes precedence over scene.background (the
  // <color> in App.tsx), so from here on this decides the background.
  useEffect(() => {
    scene.backgroundNode = sky(
      bgUniforms.time,
      bgUniforms.sky,
      bgUniforms.cloudA,
      bgUniforms.cloudB,
      bgUniforms.gradAngle,
      bgUniforms.amount,
      bgUniforms.scale,
      bgUniforms.speed,
      bgUniforms.stretch,
      bgUniforms.angle,
      bgUniforms.coverage,
      bgUniforms.levels,
      bgUniforms.softness,
      bgUniforms.warp,
      bgUniforms.horizon,
      bgUniforms.horizonSoft,
    );
    invalidate();
    return () => {
      scene.backgroundNode = null;
    };
  }, [scene, bgUniforms, invalidate]);

  useEffect(() => {
    bgUniforms.amount.value = bgAmount;
    bgUniforms.scale.value = bgScale;
    bgUniforms.speed.value = bgSpeed;
    bgUniforms.stretch.value = bgStretch;
    bgUniforms.angle.value = THREE.MathUtils.degToRad(bgAngle);
    bgUniforms.coverage.value = bgCoverage;
    bgUniforms.levels.value = bgLevels;
    bgUniforms.softness.value = bgSoftness;
    bgUniforms.warp.value = bgWarp;
    bgUniforms.horizon.value = bgHorizon;
    bgUniforms.horizonSoft.value = bgHorizonSoft;
    bgUniforms.sky.value.set(bgBase);
    bgUniforms.cloudA.value.set(bgColorA);
    bgUniforms.cloudB.value.set(bgColorB);
    bgUniforms.gradAngle.value = THREE.MathUtils.degToRad(bgGradAngle);
    invalidate();
  }, [
    bgUniforms,
    bgAmount,
    bgScale,
    bgSpeed,
    bgStretch,
    bgAngle,
    bgCoverage,
    bgLevels,
    bgSoftness,
    bgWarp,
    bgHorizon,
    bgHorizonSoft,
    bgBase,
    bgColorA,
    bgColorB,
    bgGradAngle,
    invalidate,
  ]);

  // Request frames while it animates. Stop it and the request goes away; with
  // nothing else moving the timer stops too and the picture goes still.
  // Low quality stops the sky, and once nothing is animating the redraw rate
  // drops to zero and the GPU does nothing at all while idle — which is what
  // actually keeps the machine cool.
  useFrameRequest(
    "bg",
    bgEnabled && bgSpeed > 0 && !lowQuality,
    BG_FPS,
    invalidate,
  );

  // Brush knobs are uniforms too. Off is strength 0.
  useEffect(() => {
    brushNode.strength.value = brushEnabled && !lowQuality ? brushStrength : 0;
    brushNode.size.value = brushSize;
    brushNode.softness.value = brushSoft;
    brushNode.lifetime.value = brushLife;
    brushNode.breakAmount.value = brushBreak;
    brushNode.breakScale.value = brushBreakScale;
    brushNode.color.value.set(brushColor);
    invalidate();
  }, [
    brushNode,
    brushEnabled,
    lowQuality,
    brushStrength,
    brushSize,
    brushSoft,
    brushLife,
    brushBreak,
    brushBreakScale,
    brushColor,
    invalidate,
  ]);

  // When the cursor last moved, in seconds. Used to keep drawing until the
  // trail has faded.
  const lastMove = useRef(-Infinity);

  // Whether anything has been drawn yet, so onReady only fires once.
  const drawn = useRef(false);

  // Record the cursor's path.
  //
  // Points are captured at the pointer event rate (60-120Hz) while redraws are
  // throttled to BRUSH_FPS. The shader fills the gaps with segments, so a lower
  // redraw rate still gives a continuous line.
  //
  // Coordinates are converted to the same isotropic, height-as-unit space
  // BrushNode.ts uses: uv.x × aspect is (clientX - left) / height, so dividing
  // both by the height is enough. screenUV has y=0 at the top, so clientY goes
  // in unchanged.
  useEffect(() => {
    if (!brushEnabled || lowQuality) return;
    const el = gl.domElement;
    const trail = brushNode.trail;

    // How far the cursor must travel before a new point is recorded, relative
    // to the screen height. Sampling more finely fills all 48 slots quickly and
    // shortens the tail.
    const MIN_STEP = 0.012;

    const push = (x: number, y: number, t: number) => {
      const v = trail.pop()!;
      v.set(x, y, t);
      trail.unshift(v);
    };

    const onMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.height;
      const y = (e.clientY - rect.top) / rect.height;
      const t = performance.now() / 1000;
      const head = trail[0];
      // z<0 is a cut; always record after one instead of measuring a distance.
      if (head.z > 0 && Math.hypot(x - head.x, y - head.y) < MIN_STEP) return;
      push(x, y, t);
      lastMove.current = t;
      // Ask for frames until the trail has faded. The request expires on its
      // own, so stopping the cursor is enough to end it.
      requestFrames("brush", BRUSH_FPS, invalidate, brushNode.lifetime.value);
    };

    // Insert a cut when the cursor leaves, or a stroke gets drawn between where
    // it left and where it came back.
    const onLeave = () => push(0, 0, -1);

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      stopFrames("brush");
    };
  }, [brushEnabled, lowQuality, brushNode, gl, invalidate]);

  // radius is applied as a uniform; the node is not rebuilt.
  useEffect(() => {
    // Low quality caps it at 4. Taps are 24×radius, so 6→4 is 1.5x cheaper.
    kuwaharaNode.radius.value = lowQuality ? Math.min(radius, 4) : radius;
    invalidate(); // demand mode, so ask for a frame explicitly
  }, [kuwaharaNode, radius, lowQuality, invalidate]);

  // The same grain value goes to both passes. With only one of them, the image
  // the direction is measured from and the image being averaged disagree.
  useEffect(() => {
    tensorNode.grainAmount.value = grainAmount;
    kuwaharaNode.grainAmount.value = grainAmount;
    invalidate();
  }, [tensorNode, kuwaharaNode, grainAmount, invalidate]);

  // Swapping the paper texture is also a value update; the outline shares it.
  useEffect(() => {
    finalNode.watercolorNode.value = watercolor;
    outlineNode.paperNode.value = watercolor;
    // The repeat count depends on the texture's resolution, so update it here too.
    const img = watercolor.image as { width: number; height: number };
    finalNode.watercolorSize.value.set(img.width, img.height);
    outlineNode.paperSize.value.set(img.width, img.height);
    invalidate();
  }, [finalNode, outlineNode, watercolor, invalidate]);

  // Every outline parameter is a uniform update; the graph is never rebuilt.
  // outlineEnabled=false becomes strength=0, i.e. a pass-through — the final
  // pass always takes outlineNode as its input, so there is no other way to
  // turn the lines off while final is showing.
  useEffect(() => {
    outlineNode.thickness.value = thickness;
    outlineNode.strength.value = outlineEnabled ? strength : 0;
    outlineNode.depthWeight.value = depthWeight;
    outlineNode.lumaWeight.value = lumaWeight;
    outlineNode.threshold.value = threshold;
    outlineNode.softness.value = softness;
    outlineNode.wobbleAmount.value = wobbleAmount;
    outlineNode.wobbleScale.value = wobbleScale;
    outlineNode.inkColor.value.set(inkColor);
    outlineNode.breakAmount.value = breakAmount;
    outlineNode.breakScale.value = breakScale;
    outlineNode.breakAniso.value = breakAniso;
    outlineNode.breakBias.value = breakBias;
    outlineNode.paperAmount.value = paperAmount;
    outlineNode.paperThreshold.value = paperThreshold;
    outlineNode.paperTile.value = paperTile ? 1.0 : 0.0;
    outlineNode.paperScale.value = paperTexScale;
    invalidate();
  }, [
    outlineNode,
    outlineEnabled,
    thickness,
    strength,
    depthWeight,
    lumaWeight,
    threshold,
    softness,
    wobbleAmount,
    wobbleScale,
    inkColor,
    breakAmount,
    breakScale,
    breakAniso,
    breakBias,
    paperAmount,
    paperThreshold,
    paperTile,
    paperTexScale,
    invalidate,
  ]);

  // The final look parameters are uniform updates as well.
  useEffect(() => {
    finalNode.quantizeLevels.value = quantizeLevels;
    finalNode.clampLo.value = clampLo;
    finalNode.clampHi.value = clampHi;
    finalNode.saturation.value = saturation;
    finalNode.ditherAmount.value = ditherAmount;
    finalNode.perChannel.value = perChannel ? 1.0 : 0.0;
    finalNode.satTowardWhite.value = satTowardWhite ? 1.0 : 0.0;
    finalNode.watercolorTile.value = paperTile ? 1.0 : 0.0;
    finalNode.watercolorScale.value = paperTexScale;
    invalidate();
  }, [
    finalNode,
    quantizeLevels,
    clampLo,
    clampHi,
    saturation,
    ditherAmount,
    perChannel,
    satTowardWhite,
    paperTile,
    paperTexScale,
    invalidate,
  ]);

  // Standing in for the old pass.enabled: swap outputNode to match the toggles.
  useEffect(() => {
    let node: THREE.Node = painted;
    if (tensorEnabled) node = tensorNode;
    if (kuwaharaEnabled) node = kuwaharaNode;
    if (outlineEnabled) node = outlineNode;
    if (finalEnabled) node = finalNode;

    renderPipeline.outputNode = node;
    // The final node does its own ACES + sRGB and terminates the chain, so the
    // renderer's own output transform is switched off for it — otherwise tone
    // mapping and sRGB would be applied twice.
    renderPipeline.outputColorTransform = !finalEnabled;
    renderPipeline.needsUpdate = true; // triggers the rebuild
    invalidate(); // demand mode, so ask for a frame explicitly
  }, [
    renderPipeline,
    painted,
    tensorNode,
    kuwaharaNode,
    outlineNode,
    finalNode,
    tensorEnabled,
    kuwaharaEnabled,
    outlineEnabled,
    finalEnabled,
    invalidate,
  ]);

  // ?low in the URL reproduces the low verdict without waiting for the probe,
  // to check both the reduced look and the notice (same idea as ?webgl).
  useEffect(() => {
    if (!new URLSearchParams(location.search).has("low")) return;
    setControls({ quality: "low" });
    onAutoLow?.({ ms: 0, restore: () => setControls({ quality: "normal" }) });
  }, [setControls, onAutoLow]);

  // The startup measurement. The verdict is written back to the quality knob,
  // so it stays adjustable by hand afterwards.
  const probe = useMemo(
    () =>
      createQualityProbe(gl, (level, ms) => {
        console.warn(`auto-quality: GPU ${ms.toFixed(1)}ms/frame → ${level}`);
        setControls({ quality: level });
        // Never demote silently — another app may simply have been using the
        // GPU at that moment, so the viewer gets a way back.
        if (level === "low") {
          onAutoLow?.({
            ms,
            restore: () => setControls({ quality: "normal" }),
          });
        }
      }),
    [gl, setControls, onAutoLow],
  );

  // renderPriority 1 takes over from R3F's own rendering and runs the pipeline
  // instead. Time advances by real elapsed seconds, so lowering BG_FPS doesn't
  // slow the drift.
  useFrame((_, delta) => {
    if (bgEnabled && !lowQuality) bgUniforms.time.value += delta;
    // The brush clock has to be the one the trail timestamps came from.
    brushNode.now.value = performance.now() / 1000;
    renderPipeline.render();
    // Report the first frame after render() returns, not before: this is the
    // call that compiles the post chain and blocks the main thread, so telling
    // the overlay any earlier would move that stall to after the ENTER click.
    // React re-renders on the next tick, by which time this frame is on screen.
    if (!drawn.current) {
      drawn.current = true;
      onReady?.();
    }
    // Measure after drawing, and only while quality is still on auto.
    if (quality === "auto") probe();
  }, 1);

  return <Model lowQuality={lowQuality} />;
}
