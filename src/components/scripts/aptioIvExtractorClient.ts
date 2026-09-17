import type { AptioIvArtifacts } from "./aptioIvExtractor";
import type { AptioIvExtractorWorkerResult } from "./aptioIvExtractorWorker";

// Recursive nested-volume decompression + IFRExtractor both run as
// synchronous WASM inside the worker, so a genuinely pathological or
// deeply-nested image can run for a long time - or, if it hits a bug,
// effectively forever. Running it off the main thread means the UI stays
// responsive and a timeout can actually terminate it (a main-thread
// setTimeout can't preempt a synchronous computation that never yields).
export const EXTRACTION_TIMEOUT_MS = 90_000;

export function extractFirmwareInWorker(file: File): Promise<AptioIvArtifacts> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./aptioIvExtractorWorker.ts", import.meta.url),
      { type: "module" },
    );
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(
        new Error(
          `Extraction timed out after ${String(EXTRACTION_TIMEOUT_MS / 1000)}s. This image may be too deeply nested/compressed to process automatically - try the four-file compatibility mode below instead (extract Setup HII/SCT, the IFR Extractor TXT, AMITSE PE32, and SetupData BIN yourself, e.g. with UEFITool + IFRExtractor-RS).`,
        ),
      );
    }, EXTRACTION_TIMEOUT_MS);

    worker.onmessage = (event: MessageEvent<AptioIvExtractorWorkerResult>) => {
      clearTimeout(timeout);
      worker.terminate();
      if (event.data.ok) {
        resolve(event.data.artifacts);
      } else {
        reject(new Error(event.data.error));
      }
    };
    worker.onerror = (event) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(event.message || "The extraction worker crashed."));
    };
    worker.postMessage(file);
  });
}
