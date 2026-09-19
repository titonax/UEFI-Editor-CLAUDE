import { extractAptioIvArtifacts, type AptioIvExtractionOptions } from "./aptioIvExtractor";

export type AptioIvExtractorWorkerResult =
  | { ok: true; artifacts: Awaited<ReturnType<typeof extractAptioIvArtifacts>> }
  | { ok: false; error: string };

export interface AptioIvExtractorWorkerRequest {
  file: File;
  options?: AptioIvExtractionOptions;
}

onmessage = async (e: MessageEvent<AptioIvExtractorWorkerRequest>) => {
  try {
    const artifacts = await extractAptioIvArtifacts(e.data.file, e.data.options);
    postMessage({ ok: true, artifacts } satisfies AptioIvExtractorWorkerResult);
  } catch (error) {
    postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies AptioIvExtractorWorkerResult);
  }
};
