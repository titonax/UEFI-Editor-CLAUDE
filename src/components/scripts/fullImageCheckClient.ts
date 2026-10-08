import type { FullImageRequest, FullImageResult } from "./fullImageExport";
import type { FullImageCheckWorkerResult } from "./fullImageCheckWorker";

// Re-encoding LZMA/Tiano sections and reading the whole image back is slow on
// a big image, but a check that never ends is worse than none.
export const FULL_IMAGE_CHECK_TIMEOUT_MS = 10 * 60_000;

export interface FullImageCheckHandle {
  result: Promise<FullImageResult>;
  // Ends the check at once; `result` then rejects.
  cancel: () => void;
}

export function startFullImageCheck(request: FullImageRequest): FullImageCheckHandle {
  const worker = new Worker(new URL("./fullImageCheckWorker.ts", import.meta.url), { type: "module" });
  let settle: { resolve: (result: FullImageResult) => void; reject: (error: Error) => void } | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (timeout !== undefined) clearTimeout(timeout);
    worker.terminate();
  };
  const result = new Promise<FullImageResult>((resolve, reject) => {
    settle = { resolve, reject };
    timeout = setTimeout(() => {
      finish();
      reject(new Error(`The check timed out after ${String(FULL_IMAGE_CHECK_TIMEOUT_MS / 60_000)} minutes. This image may be too large to check in the browser.`));
    }, FULL_IMAGE_CHECK_TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<FullImageCheckWorkerResult>) => {
      finish();
      if ("crashed" in event.data) reject(new Error(event.data.crashed));
      else resolve(event.data);
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "The check worker crashed."));
    };
    worker.postMessage(request);
  });
  return {
    result,
    cancel: () => {
      finish();
      settle?.reject(new Error("The check was cancelled."));
    },
  };
}
