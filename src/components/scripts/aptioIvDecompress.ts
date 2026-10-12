import { ConsoleStdout, File as WasiFile, OpenFile, PreopenDirectory, WASI } from "@bjorn3/browser_wasi_shim";

// Tags a decompression failure as continuable: nestedBuffers/locateSectionPayload
// catch only this class and keep walking the rest of the image (see
// tryDecodeEncapsulation), so one bad section never aborts an otherwise
// extractable firmware context. Any other thrown error still propagates.
export class SectionDecodeFailure extends Error {}

// The WebAssembly decompressors for compressed firmware sections (LZMA and
// EFI/Tiano) and the type of the function that calls them.
export const decompressorModules = new Map<string, Promise<WebAssembly.Module>>();


export function loadDecompressor(name: string) {
  let pending = decompressorModules.get(name);
  if (!pending) {
    pending = fetch(`${import.meta.env.BASE_URL}${name}`).then((response) => {
      if (!response.ok) {
        throw new Error(
          `Firmware decompressor WebAssembly could not be loaded (${String(response.status)}).`,
        );
      }
      return WebAssembly.compileStreaming(response);
    });
    decompressorModules.set(name, pending);
  }
  return pending;
}


export async function runFirmwareDecompress(
  input: Uint8Array,
  wasmName: string,
  mode: "lzma" | "tiano" | "efi",
) {
  const directory = new Map<string, WasiFile>();
  directory.set("input.bin", new WasiFile(input));
  const messages: string[] = [];
  const wasi = new WASI(
    [wasmName, "input.bin", "output.bin", mode],
    [],
    [
      new OpenFile(new WasiFile([])),
      ConsoleStdout.lineBuffered((line) => messages.push(line)),
      ConsoleStdout.lineBuffered((line) => messages.push(line)),
      new PreopenDirectory(".", directory),
    ],
  );
  const module = await loadDecompressor(wasmName);
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  const exitCode = wasi.start(
    instance as WebAssembly.Instance & {
      exports: { memory: WebAssembly.Memory; _start: () => unknown };
    },
  );
  const output = directory.get("output.bin");
  if (exitCode !== 0 || !output) {
    throw new Error(
      messages.join("\n") || `Firmware decompressor exited with ${String(exitCode)}.`,
    );
  }
  return output.data;
}


export async function firmwareDecompress(
  input: Uint8Array,
  mode: "lzma" | "standard",
) {
  if (mode === "lzma") {
    return runFirmwareDecompress(input, "firmware-decompress.wasm", "lzma");
  }

  const failures: string[] = [];
  for (const algorithm of ["tiano", "efi"] as const) {
    try {
      return await runFirmwareDecompress(
        input,
        "tiano-decompress.wasm",
        algorithm,
      );
    } catch (error) {
      failures.push(
        `${algorithm}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(`EFI/Tiano decompression failed (${failures.join("; ")}).`);
}


// Every buffer decoded so far, keyed by id, plus a cache so the same
// section is never decompressed twice (the BFS below and the per-file
// payload search can both reach it).
// Decodes one encapsulated payload. The browser build runs the WebAssembly
// decompressors; tests and tooling can inject their own.
export type FirmwareDecompressor = (
  input: Uint8Array,
  mode: "lzma" | "standard",
) => Promise<Uint8Array>;
