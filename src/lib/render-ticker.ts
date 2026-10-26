// One shared timer driving redraws for frameloop="demand".
//
// Each animated thing used to own a setInterval. Unsynced timers don't merge:
// two at 12fps redraw somewhere between 12 and 24 times a second, three of them
// up to 40, for the same 12fps picture — and the post chain is expensive enough
// that it shows. One timer caps the rate at the fastest active request.
//
// Declarative (follows a knob):  useFrameRequest("sway", on, 12, invalidate)
// Imperative (expires on its own): requestFrames("brush", 20, invalidate, 1.2)

import { useEffect } from "react";

type Reason = {
  fps: number;
  /** performance.now() ms after which this request drops itself. Infinity = never */
  until: number;
};

const reasons = new Map<string, Reason>();
let timer: number | undefined;
let request: (() => void) | null = null;

/** Fastest rate currently asked for. 0 means nothing is animating. */
function topFps() {
  let fps = 0;
  for (const r of reasons.values()) if (r.fps > fps) fps = r.fps;
  return fps;
}

function sync() {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
  const fps = topFps();
  if (fps <= 0 || request === null) return;

  timer = window.setInterval(() => {
    request?.();

    // Drop expired requests; rebuilding on a rate change is also how it stops.
    const now = performance.now();
    let changed = false;
    for (const [name, r] of reasons) {
      if (r.until <= now) {
        reasons.delete(name);
        changed = true;
      }
    }
    if (changed && topFps() !== fps) sync();
  }, 1000 / fps);
}

/**
 * Ask for redraws. Calling again with the same name extends the deadline.
 *
 * @param seconds how long this request lives. Omit for "until stopped".
 */
export function requestFrames(
  name: string,
  fps: number,
  invalidate: () => void,
  seconds = Infinity,
) {
  request = invalidate;
  const until =
    seconds === Infinity ? Infinity : performance.now() + seconds * 1000;
  const prev = reasons.get(name);
  reasons.set(name, { fps, until });

  // A deadline extension must not rebuild the timer — clearInterval on every
  // pointermove would keep resetting it and no frame would ever fire.
  if (prev === undefined || prev.fps !== fps || timer === undefined) sync();
}

export function stopFrames(name: string) {
  if (reasons.delete(name)) sync();
}

/** For requests whose on/off state comes straight from a control. */
export function useFrameRequest(
  name: string,
  active: boolean,
  fps: number,
  invalidate: () => void,
) {
  useEffect(() => {
    if (!active || fps <= 0) {
      stopFrames(name);
      return;
    }
    requestFrames(name, fps, invalidate);
    return () => stopFrames(name);
  }, [name, active, fps, invalidate]);
}
