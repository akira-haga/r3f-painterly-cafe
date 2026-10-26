/** Shown when the startup probe drops the quality (see src/lib/auto-quality.ts). */
export function QualityNotice({
  ms,
  onRestore,
  onDismiss,
}: {
  /** Measured GPU time per frame. 0 when the verdict was forced (?low). */
  ms: number;
  onRestore: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="absolute bottom-4 left-4 max-w-sm rounded-md bg-[#1a1512]/90 px-4 py-3 text-sm text-[#E7E7E7] shadow-lg">
      <p>
        Switched to a simplified view — rendering was slow here
        {ms > 0 && ` (GPU ${ms.toFixed(0)}ms/frame)`}.
      </p>
      <p className="mt-1 text-xs opacity-70">
        Another app may have been using the GPU. You can switch back.
      </p>
      <div className="mt-2 flex gap-3">
        <button
          type="button"
          className="underline underline-offset-2"
          onClick={onRestore}
        >
          Restore full quality
        </button>
        <button
          type="button"
          className="opacity-70 underline underline-offset-2"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
