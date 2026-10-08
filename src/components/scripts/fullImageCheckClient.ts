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

function isCrash(data: unknown): data is { crashed: string } {
  return typeof data === "object" && data !== null && "crashed" in data;
}

// Never throws: a worker that cannot even be started is a rejected `result`,
// so the caller has one place to learn why nothing was checked.
export function startFullImageCheck(request: FullImageRequest): FullImageCheckHandle {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./fullImageCheckWorker.ts", import.meta.url), { type: "module" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      result: Promise.reject(new Error(`The check worker could not be started: ${reason}`)),
      cancel: () => undefined,
    };
  }
  let settle: { reject: (error: Error) => void } | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (timeout !== undefined) clearTimeout(timeout);
    worker.terminate();
  };
  const result = new Promise<FullImageResult>((resolve, reject) => {
    settle = { reject };
    timeout = setTimeout(() => {
      finish();
      reject(new Error(`The check timed out after ${String(FULL_IMAGE_CHECK_TIMEOUT_MS / 60_000)} minutes. This image may be too large to check in the browser.`));
    }, FULL_IMAGE_CHECK_TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<FullImageCheckWorkerResult>) => {
      finish();
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null) reject(new Error("The check worker's answer could not be read."));
      else if (isCrash(data)) reject(new Error(data.crashed));
      else resolve(event.data as FullImageResult);
    };
    worker.onmessageerror = () => {
      finish();
      reject(new Error("The check worker's answer could not be read."));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "The check worker crashed."));
    };
    try {
      worker.postMessage(request);
    } catch (error) {
      finish();
      reject(new Error(`The image could not be sent to the check worker: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
  return {
    result,
    cancel: () => {
      finish();
      settle?.reject(new Error("The check was cancelled."));
    },
  };
}
