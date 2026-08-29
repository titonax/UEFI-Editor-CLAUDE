import { extractAptioIvArtifacts } from "./aptioIvExtractor";

export type AptioIvExtractorWorkerResult =
  | { ok: true; artifacts: Awaited<ReturnType<typeof extractAptioIvArtifacts>> }
  | { ok: false; error: string };

onmessage = async (e: MessageEvent<File>) => {
  try {
    const artifacts = await extractAptioIvArtifacts(e.data);
    postMessage({ ok: true, artifacts } satisfies AptioIvExtractorWorkerResult);
  } catch (error) {
    postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies AptioIvExtractorWorkerResult);
  }
};
