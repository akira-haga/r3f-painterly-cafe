// Measure what the GPU can do at startup and step the quality down if it can't
// keep up. Device names tell you nothing, and the cost scales with window size
// anyway; nearly all of it is the Kuwahara pass, so the only useful question is
// how long one frame takes here.
//
// Uses GPU timestamps rather than wall-clock: redraws are throttled to 12fps,
// so frame intervals would only ever report 83ms.
//
// The trap: resolveTimestampsAsync() returns the SUM of every query since the
// last resolve, not one frame. A frame runs several passes, and frames drawn
// while the resolve is in flight land in the same sum, so used raw it reports
// more than double and demotes fast machines. Divide by the frames covered.
//
// No timestamp support means no verdict — downgrading on a guess would degrade
// machines that were running it fine.

import * as THREE from "three/webgpu";

/** Frames to drop, covering shader compilation. */
const WARMUP = 8;
/** Frames the verdict is based on. */
const SAMPLES = 30;
/** Extra frames to wait before giving up on a backend that only returns 0. */
const GIVE_UP = 20;
/** Median above this is "low": a machine that can't hold even 16fps. */
const LOW_MS = 60;

export type QualityLevel = "normal" | "low";

/** Returns a function to call once per rendered frame; `onResult` fires once.
 *  The renderer must be created with trackTimestamp: true. */
export function createQualityProbe(
  renderer: THREE.WebGPURenderer,
  onResult: (level: QualityLevel, medianMs: number) => void,
) {
  const samples: number[] = [];
  let frames = 0; // frames drawn
  let covered = 0; // frames the next resolve will account for
  let pending = false; // don't stack resolves
  let done = false;

  const finish = () => {
    done = true;
    // Stop paying for the queries.
    (
      renderer.backend as unknown as { trackTimestamp: boolean }
    ).trackTimestamp = false;
  };

  return () => {
    if (done) return;
    frames++;
    covered++;
    // Queries pile up while a resolve is in flight; `covered` counts them.
    if (pending) return;

    pending = true;
    // The query pool resets when the resolve starts, so this counter does too.
    const included = covered;
    covered = 0;

    renderer
      .resolveTimestampsAsync(THREE.TimestampQuery.RENDER)
      .then(() => {
        pending = false;

        const total = renderer.info.render.timestamp;
        // Resolve during warmup too, or the query pool overflows; it's the
        // samples that get dropped, not the resolves.
        if (frames > WARMUP && total > 0 && included > 0) {
          samples.push(total / included);
        }

        // Only ever 0: this backend can't measure.
        if (samples.length === 0 && frames > WARMUP + GIVE_UP) {
          finish();
          console.warn("auto-quality: no GPU timestamps, keeping full quality");
          return;
        }

        if (samples.length >= SAMPLES) {
          finish();
          const sorted = [...samples].sort((a, b) => a - b);
          const median = sorted[sorted.length >> 1];
          onResult(median > LOW_MS ? "low" : "normal", median);
        }
      })
      .catch(() => {
        pending = false;
        finish();
      });
  };
}
