import { useControls, folder } from "leva";

/** The leva panel for the foliage sway. */
export function useFoliageControls() {
  return useControls({
    foliage: folder({
      swayEnabled: { value: true, label: "sway" },
      // Tip displacement in metres. The longest leaf is 0.2m, so 0.1 moves the
      // tip by half a leaf.
      swayAmount: {
        value: 0.03,
        min: 0,
        max: 0.15,
        step: 0.005,
        label: "amount",
      },
      swaySpeed: { value: 3.0, min: 0, max: 5, step: 0.1, label: "speed" },
      // Spatial period of the wind. 1.0 is a ~6.3m wavelength, just under one
      // wave across the building.
      windScale: {
        value: 4.0,
        min: 0,
        max: 4,
        step: 0.05,
        label: "wind scale",
      },
      // Per-leaf spread. At 0, phase and direction line up and clumps move as
      // one. The bigger the crown the more this matters — planters are small
      // enough that it barely shows.
      swayScatter: {
        value: 1.0,
        min: 0,
        max: 1,
        step: 0.05,
        label: "scatter",
      },
      // Redraw rate while swaying. Cost scales directly with it, since every
      // frame runs the full-screen Kuwahara at 144 taps. It doesn't change the
      // picture, and a lower rate suits this look anyway — closer to drawing on
      // twos. OrbitControls invalidates separately, so lowering it doesn't make
      // camera movement feel sluggish.
      swayFps: { value: 12, min: 4, max: 60, step: 1, label: "fps" },
    }),
  });
}
