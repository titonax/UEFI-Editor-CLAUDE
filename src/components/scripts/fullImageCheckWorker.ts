import { firmwareDecompress } from "./aptioIvExtractor";
import { checkFullImageOutput, type FullImageRequest, type FullImageResult } from "./fullImageExport";
import { lzmaJsCodec } from "./lzmaJs";

// The check encodes sections and reads the whole image back; both are
// synchronous and can take a long time on a large image, so it runs here, off
// the main thread, where a timeout or a cancel can end it.
export type FullImageCheckWorkerResult = FullImageResult | { crashed: string };

onmessage = async (e: MessageEvent<FullImageRequest>) => {
  try {
    const result = await checkFullImageOutput(e.data, {
      codecs: { lzma: lzmaJsCodec },
      decompress: firmwareDecompress,
    });
    postMessage(result satisfies FullImageCheckWorkerResult);
  } catch (error) {
    postMessage({
      crashed: error instanceof Error ? error.message : String(error),
    } satisfies FullImageCheckWorkerResult);
  }
};
