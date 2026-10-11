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

// A progress note has no `ok`: a result that happens to carry a `progress` key
// is still a result.
function isProgress(data: unknown): data is { progress: string } {
  return typeof data === "object" && data !== null && !("ok" in data) && "progress" in data && typeof (data as { progress: unknown }).progress === "string";
}

// Only an answer of the shape checkFullImageOutput returns is one; anything
// else (a malformed note, an empty object) must not reach the dialog as a result.
function isResult(data: unknown): data is FullImageResult {
  if (typeof data !== "object" || data === null) return false;
  const answer = data as Record<string, unknown>;
  if (answer.ok === true) {
    return answer.image instanceof Uint8Array && typeof answer.changelog === "string" && typeof answer.summary === "object" && answer.summary !== null;
  }
  return answer.ok === false && typeof answer.stage === "string" && Array.isArray(answer.messages) && answer.messages.every((message) => typeof message === "string");
}

// Never throws: a worker that cannot even be started is a rejected `result`,
// so the caller has one place to learn why nothing was checked.
export function startFullImageCheck(request: FullImageRequest, onProgress?: (message: string) => void): FullImageCheckHandle {
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
  // Once the check has ended (answer, crash, timeout or cancel) nothing the
  // worker still delivers is acted on.
  let ended = false;
  const finish = () => {
    ended = true;
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
      if (ended) return;
      const data: unknown = event.data;
      // A crash report outranks anything else in the same message.
      if (isCrash(data)) {
        finish();
        reject(new Error(data.crashed));
        return;
      }
      // A progress note is not an answer: the check is still running.
      if (isProgress(data)) {
        onProgress?.(data.progress);
        return;
      }
      finish();
      if (isResult(data)) resolve(data);
      else reject(new Error("The check worker's answer could not be read."));
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
