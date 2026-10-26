// The leva schema for the whole look. Kept out of Scene.tsx, which is already
// busy wiring the node graph; this is just the panel and its defaults.
//
// Returns [values, set]. `set` is how the quality probe writes its verdict back
// into the panel, so the control stays the single source of truth.

import { useControls, folder } from "leva";

export function useSceneControls() {
  return useControls(() => ({
    // Decided by measuring the GPU at startup (src/lib/auto-quality.ts).
    // "auto" means still measuring; it settles on normal or low. Choosing a
    // value by hand wins and stops the measurement.
    // "low" drops radius to 4 and stops the sky, the brush and the sway.
    quality: {
      value: "auto",
      options: { auto: "auto", normal: "normal", low: "low" },
      label: "quality",
    },
    passes: folder({
      tensorEnabled: { value: true, label: "tensor" },
      kuwaharaEnabled: { value: true, label: "kuwahara" },
      outlineEnabled: { value: true, label: "outline" },
      finalEnabled: { value: true, label: "final" },
    }),
    // radius is in pixels, so a higher canvas resolution weakens it in relative
    // terms; matching Blender's viewport means scaling it with the resolution
    // ratio. Taps are 8 sectors × radius × 3 = 24×radius, so it gets expensive
    // fast.
    // Compensating for dpr [1, 1] would give 4, but 6 won on looks: bigger
    // pixels make 6 bite harder and coarsen the brushwork, which reads as more
    // painterly. So 6 is a look decision, not a correction. It costs 1.5x the
    // taps of 4 (144 vs 96).
    radius: { value: 6, min: 1, max: 20, step: 1 },
    // Screen-space grain added to the Kuwahara input (details in grain.ts).
    // Blender feeds it a denoise-off Cycles render, which is grainy, and that
    // grain shifts the sector choice and mottles the inside of a surface. Here
    // the input is a denoised bake, perfectly clean, so it collapses to flat
    // colour. This puts the difference back. The same value goes to both the
    // tensor and the Kuwahara pass; 0 reproduces the original picture.
    // It adds a constant amount in display space, so the grain reads the same in
    // highlights and shadows without sinking to black.
    // The grain is always 1px, so at dpr [1, 1] it looks larger on screen than
    // it used to. Compensating would mean 0.02, but 0.03 won on looks.
    grainAmount: { value: 0.03, min: 0, max: 0.3, step: 0.005, label: "grain" },
    outline: folder({
      // In px, so at dpr [1, 1] the line comes out heavier than before.
      // Compensating would mean 0.7, but 1.0 won on looks.
      thickness: { value: 1.0, min: 0.5, max: 6, step: 0.1 },
      strength: { value: 0.7, min: 0, max: 1, step: 0.01 },
      depthWeight: { value: 1.0, min: 0, max: 4, step: 0.05, label: "depth" },
      lumaWeight: { value: 0.16, min: 0, max: 2, step: 0.05, label: "luma" },
      threshold: { value: 0.08, min: 0, max: 0.5, step: 0.005 },
      softness: { value: 0.1, min: 0.001, max: 0.5, step: 0.005 },
      wobbleAmount: { value: 1.8, min: 0, max: 8, step: 0.1, label: "wobble" },
      wobbleScale: {
        value: 6.0,
        min: 0.5,
        max: 40,
        step: 0.5,
        label: "wobble freq",
      },
      inkColor: { value: "#1a1512", label: "ink" },
    }),
    "line break-up": folder({
      breakAmount: { value: 0.45, min: 0, max: 1, step: 0.01, label: "amount" },
      breakScale: { value: 38, min: 4, max: 200, step: 1, label: "density" },
      breakAniso: {
        value: 0.12,
        min: 0.01,
        max: 1,
        step: 0.01,
        label: "aniso",
      },
      breakBias: { value: 0.7, min: 0, max: 1, step: 0.01, label: "bias" },
      paperAmount: { value: 0, min: 0, max: 1, step: 0.01, label: "paper" },
      paperThreshold: {
        value: 0.5,
        min: 0,
        max: 1,
        step: 0.01,
        label: "paper th",
      },
    }),
    // How the paper texture is mapped. Shared by the final multiply and the
    // outline break-up.
    paper: folder({
      // off: one copy over screenUV (skews with the window's aspect — the
      //      original behaviour)
      // on : repeats by screen resolution ÷ texture resolution (no skew)
      paperTile: { value: true, label: "tile" },
      // Scale when tiling. 1 means one texel per device pixel; on a DPR 2
      // display, 2 gives one texel per CSS pixel.
      paperTexScale: {
        value: 0.25,
        min: 0,
        max: 8,
        step: 0.25,
        label: "tile scale",
      },
    }),
    // The final look. These defaults are the tuned values and are what the
    // picture is now; FinalNode.ts explains each one in detail.
    final: folder({
      // Steps. More means finer gradation and less visible banding.
      quantizeLevels: {
        value: 16,
        min: 4,
        max: 64,
        step: 1,
        label: "quantize",
      },
      // The closer to 0.5, the less the shadows are pulled towards black.
      clampLo: { value: 0.2, min: 0, max: 0.5, step: 0.01, label: "clamp lo" },
      // The closer to 0.5, the less the highlights are pulled towards white.
      clampHi: { value: 0.7, min: 0.5, max: 1, step: 0.01, label: "clamp hi" },
      // 1.0 is neutral. With sat-toward-white on, this matches Blender's
      // Hue/Saturation.
      saturation: { value: 0.75, min: 0, max: 2, step: 0.05, label: "sat" },
      // Noise added before quantising; 1.0 is ±0.5 of a step. Reproduces the
      // way Cycles noise dissolves the step boundaries in Blender.
      ditherAmount: {
        value: 1,
        min: 0,
        max: 2,
        step: 0.05,
        label: "dither",
      },
      // Quantise R/G/B independently. Same structure as Blender's Posterize:
      // a dark channel can rise on its own, so shadows stop crushing to black.
      // It raises apparent saturation, which is why sat sits at 0.75. Off
      // restores the picture as it was right after the port.
      perChannel: { value: true, label: "per channel" },
      // Where desaturation goes: luminance grey (off) or V, i.e. white (on).
      // On matches Blender's Hue/Saturation, so the Blender preview takes this
      // sat value verbatim. This is what "Blender looks like it
      // has a translucent white over it" was.
      satTowardWhite: { value: true, label: "sat toward white" },
    }),
    // Cirrus drifting behind the subject (details in sky.ts). It's a backdrop,
    // so the defaults stay restrained. It goes on scene.backgroundNode, which
    // supersedes the <color attach="background"> in App.tsx — the sky colour
    // here matches that value, so amount 0 reproduces the old flat background
    // exactly.
    sky: folder({
      bgEnabled: { value: true, label: "animate" },
      // Cloud density, i.e. how much of it is mixed over the sky.
      bgAmount: { value: 0.65, min: 0, max: 1, step: 0.01, label: "density" },
      // How much sky is covered — close to a literal fraction. At 1.0 the whole
      // frame turns cloud colour, which is the quickest way to check the
      // background is alive at all when nothing shows up.
      bgCoverage: {
        value: 0.37,
        min: 0,
        max: 1,
        step: 0.01,
        label: "coverage",
      },
      // Horizontal stretch. 1 gives blobs; higher gives the thin streaks that
      // make it read as cirrus.
      bgStretch: { value: 6, min: 1, max: 20, step: 0.5, label: "stretch" },
      // Streak frequency — roughly how many fit the screen height, so 6 spaces
      // them a sixth of the height apart. The old ceiling of 8 wasn't enough,
      // hence 40.
      bgScale: { value: 20.0, min: 0.2, max: 40, step: 0.2, label: "detail" },
      // Streak tilt in degrees. Cirrus reads best near horizontal, and beyond
      // ±20° it turns into a diagonal pattern that stops looking like sky.
      bgAngle: { value: 5, min: -20, max: 20, step: 0.5, label: "tilt" },
      // Undulation. 0 is straight; higher frays the streaks into hooks.
      bgWarp: { value: 0.35, min: 0, max: 2, step: 0.05, label: "warp" },
      // Drift speed. At stretch 6 and detail 2.0, 0.005 crosses the screen in
      // about two minutes. Changing stretch or detail changes how fast the same
      // number looks.
      bgSpeed: { value: 0.03, min: 0, max: 0.05, step: 0.001, label: "speed" },
      // Steps. Fewer makes the shapes flatter and more graphic.
      bgLevels: { value: 3, min: 2, max: 12, step: 1, label: "levels" },
      // Width of a step edge. At 0.5 the steps vanish into a gradient.
      bgSoftness: {
        value: 0.12,
        min: 0.01,
        max: 0.5,
        step: 0.01,
        label: "softness",
      },
      // Lower edge of the clouds, as a height from the bottom of the screen —
      // they stay out of the lower half where the building sits. The background
      // doesn't move with the camera, so this line is fixed on screen.
      bgHorizon: { value: 0.7, min: 0, max: 1, step: 0.01, label: "horizon" },
      // Softness of that edge; 0 cuts a straight line.
      bgHorizonSoft: {
        value: 0.5,
        min: 0,
        max: 0.5,
        step: 0.01,
        label: "horizon soft",
      },
      bgBase: { value: "#E7E7E7", label: "sky" },
      // Cloud colour is a gradient over screen position, unrelated to the shape
      // of the clouds. The defaults are deliberately far apart and fairly
      // strong, allowing for the final pass pulling them towards white at
      // sat 0.75.
      bgColorA: { value: "#AAAAAA", label: "cloud 1" },
      bgColorB: { value: "#DF7454", label: "cloud 2" },
      // Gradient direction in degrees. 0 is left→right, 90 bottom→top.
      bgGradAngle: { value: 0, min: 0, max: 360, step: 5, label: "gradient" },
    }),
    // Paint along the cursor's path (details in BrushNode.ts). It is composited
    // before the Kuwahara pass, so the strokes get the same flattening and
    // outline as everything else.
    brush: folder({
      brushEnabled: { value: true, label: "enabled" },
      brushColor: { value: "#D9633F", label: "color" },
      // Width, with screen height as the unit: 0.035 is 3.5% of the height.
      brushSize: {
        value: 0.035,
        min: 0.005,
        max: 0.2,
        step: 0.005,
        label: "size",
      },
      // Edge falloff. Towards 1 only the centre stays dense, like a bleed.
      brushSoft: { value: 0.6, min: 0, max: 1, step: 0.05, label: "softness" },
      // Seconds until a stroke disappears. Longer means a longer tail, but only
      // 48 points are kept, so moving fast hits that limit first.
      brushLife: { value: 0.6, min: 0.2, max: 5, step: 0.1, label: "lifetime" },
      brushStrength: {
        value: 0.9,
        min: 0,
        max: 1,
        step: 0.05,
        label: "strength",
      },
      // Break-up, as if the brush were dragging dry across the paper.
      brushBreak: {
        value: 0.35,
        min: 0,
        max: 1,
        step: 0.05,
        label: "break-up",
      },
      brushBreakScale: {
        value: 60,
        min: 10,
        max: 200,
        step: 5,
        label: "break scale",
      },
    }),
  }));
}
