import { useState } from "react";
import { useProgress } from "@react-three/drei";

// The final pass tiles the paper at scale 0.25 (paperTile / paperTexScale in
// scene-controls.ts), i.e. one copy every 2688x1920 / 4 device pixels. The
// canvas is pinned to dpr [1, 1] in App.tsx, so those are CSS pixels here.
// Change either of those and this has to follow.
const PAPER_TILE = "672px 480px";

// screenUV has its origin at the top-left (y=0 at the top, see Scene.tsx), so
// the tiling grid starts there, same as the CSS default.
const PAPER_ORIGIN = "left top";

// What the final pass turns the flat sky into, before it multiplies the paper
// in. #E7E7E7 is linear 0.8, which displays as 0.906; quantize 16 puts it at
// 14/15, clamp hi pins it to 0.7, the highlight lift takes it to 0.944 and
// ACES lands on 0.791 = 202 = #CACACA. Multiplying the paper by this reproduces
// the scene's background; with the paper's own average (234) it reads ~185.
// Recompute it if quantize, clamp hi or the sky colour move.
const PAPER_TINT = "#CACACA";

export function LoadingScreen({
  ready,
  onEntered,
}: {
  ready: boolean;
  onEntered: () => void;
}) {
  const { progress } = useProgress();
  const [leaving, setLeaving] = useState(false);

  return (
    <div
      // The bar's width transition bubbles up here too, hence the target check.
      onTransitionEnd={(e) => {
        if (leaving && e.target === e.currentTarget) onEntered();
      }}
      // 1200ms rather than a quick cut: the picture behind is already finished,
      // so the fade is the transition itself, not a cover for loading.
      className={`absolute inset-0 z-50 flex items-center justify-center transition-opacity duration-1200 ease-out ${
        leaving ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
      style={{
        backgroundImage: "url(/textures/paper.jpg)",
        backgroundSize: PAPER_TILE,
        backgroundPosition: PAPER_ORIGIN,
        backgroundRepeat: "repeat",
        backgroundColor: PAPER_TINT,
        backgroundBlendMode: "multiply",
      }}
    >
      {/* The text and the bar leave in 200ms while the paper takes the full
          1200ms. Fading them at the same rate leaves the button hanging over
          the scene as a ghost for most of a second. */}
      <div
        className={`flex flex-col items-center gap-6 transition-opacity duration-200 ease-out ${
          leaving ? "opacity-0" : "opacity-100"
        }`}
      >
        {/* Fixed height, so swapping the label for the button doesn't shift the
            bar underneath it. */}
        <div className="flex h-12 items-center">
          {ready ? (
            <button
              type="button"
              onClick={() => setLeaving(true)}
              className="rounded-md border border-[#4A2E20] px-10 py-3 text-xs tracking-[0.3em] text-[#4A2E20] transition-colors duration-200 hover:bg-[#4A2E20] hover:text-[#B9B9B9]"
            >
              ENTER
            </button>
          ) : (
            <p className="animate-pulse text-xs tracking-[0.3em] text-[#4A2E20]/70">
              LOADING {Math.round(progress)}%
            </p>
          )}
        </div>

        {/* three's LoadingManager counts files, not bytes, and the three files
            are very different sizes, so this moves in steps. The width
            transition is what makes it read as a bar rather than a jump. */}
        <div className="h-px w-40 bg-[#4A2E20]/20">
          <div
            className="h-full bg-[#4A2E20] transition-[width] duration-300 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  );
}
