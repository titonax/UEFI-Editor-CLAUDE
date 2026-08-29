import {
  ConsoleStdout,
  File as WasiFile,
  OpenFile,
  PreopenDirectory,
  WASI,
} from "@bjorn3/browser_wasi_shim";

const setupGuid = "899407D7-99FE-43D8-9A21-79EC328CAC21";
const amitseGuid = "B1DA0ADF-4F77-4070-A88E-BFFE1C60529A";
const hiiGuid = "97E409E6-4CC1-11D9-81F6-000000000000";
const setupDataGuid = "FE612B72-203C-47B1-8560-A66D946EB371";

export interface AptioIvArtifacts {
  hii: Uint8Array;
  ifrText: string;
  amitse?: Uint8Array;
  setupData?: Uint8Array;
  formPackageCount: number;
  extractionDepth: number;
}

function u24(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function u16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
    true,
  );
}

function u64(bytes: Uint8Array, offset: number) {
  const value = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getBigUint64(offset, true);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : 0;
}

function align(value: number, alignment: number) {
  return Math.ceil(value / alignment) * alignment;
}

function hex(value: number, width: number) {
  return value.toString(16).toUpperCase().padStart(width, "0");
}

function guid(bytes: Uint8Array, offset: number) {
  return `${hex(u32(bytes, offset), 8)}-${hex(u16(bytes, offset + 4), 4)}-${hex(
    u16(bytes, offset + 6),
    4,
  )}-${hex(bytes[offset + 8], 2)}${hex(bytes[offset + 9], 2)}-${Array.from(
    bytes.slice(offset + 10, offset + 16),
    (byte) => hex(byte, 2),
  ).join("")}`;
}

const decompressorModules = new Map<string, Promise<WebAssembly.Module>>();

function loadDecompressor(name: string) {
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

async function runFirmwareDecompress(
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

async function firmwareDecompress(
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

function validVolume(bytes: Uint8Array, start: number) {
  if (start + 0x38 > bytes.length) return false;
  const length = u64(bytes, start + 0x20);
  const headerLength = u16(bytes, start + 0x30);
  return (
    bytes[start + 0x28] === 0x5f &&
    bytes[start + 0x29] === 0x46 &&
    bytes[start + 0x2a] === 0x56 &&
    bytes[start + 0x2b] === 0x48 &&
    length >= headerLength &&
    start + length <= bytes.length
  );
}

function findVolumes(bytes: Uint8Array) {
  const volumes: number[] = [];
  for (let signature = 0x28; signature + 4 <= bytes.length; signature += 4) {
    const start = signature - 0x28;
    if (validVolume(bytes, start)) volumes.push(start);
  }
  return volumes;
}

interface LocatedFile {
  bytes: Uint8Array;
  bodyStart: number;
  end: number;
  depth: number;
}

function findFile(bytes: Uint8Array, wantedGuid: string, depth: number) {
  for (const volumeStart of findVolumes(bytes)) {
    const volumeEnd = volumeStart + u64(bytes, volumeStart + 0x20);
    let fileStart = volumeStart + align(u16(bytes, volumeStart + 0x30), 8);
    while (fileStart + 24 <= volumeEnd) {
      if (bytes.slice(fileStart, fileStart + 24).every((byte) => byte === 0xff)) break;
      const size = u24(bytes, fileStart + 20);
      if (size < 24 || fileStart + size > volumeEnd) break;
      if (guid(bytes, fileStart) === wantedGuid) {
        return { bytes, bodyStart: fileStart + 24, end: fileStart + size, depth };
      }
      fileStart = volumeStart + align(fileStart - volumeStart + size, 8);
    }
  }
  return null;
}

async function nestedBuffers(bytes: Uint8Array) {
  const nested: Uint8Array[] = [];
  for (const volumeStart of findVolumes(bytes)) {
    const volumeEnd = volumeStart + u64(bytes, volumeStart + 0x20);
    let fileStart = volumeStart + align(u16(bytes, volumeStart + 0x30), 8);
    while (fileStart + 24 <= volumeEnd) {
      if (bytes.slice(fileStart, fileStart + 24).every((byte) => byte === 0xff)) break;
      const size = u24(bytes, fileStart + 20);
      if (size < 24 || fileStart + size > volumeEnd) break;
      let section = fileStart + 24;
      const fileEnd = fileStart + size;
      while (section + 4 <= fileEnd) {
        const sectionSize = u24(bytes, section);
        const type = bytes[section + 3];
        if (sectionSize < 4 || section + sectionSize > fileEnd) break;
        if (type === 0x01 && sectionSize >= 9) {
          const compressionType = bytes[section + 8];
          const body = bytes.slice(section + 9, section + sectionSize);
          if (compressionType === 0) nested.push(body);
          if (compressionType === 1) {
            nested.push(await firmwareDecompress(body, "standard"));
          }
          if (compressionType === 2) {
            nested.push(await firmwareDecompress(body, "lzma"));
          }
        }
        section = align(section + sectionSize, 4);
      }
      fileStart = volumeStart + align(fileStart - volumeStart + size, 8);
    }
  }
  return nested;
}

async function locateFirmwareFile(bytes: Uint8Array, wantedGuid: string) {
  const queue = [{ bytes, depth: 0 }];
  for (let index = 0; index < queue.length && index < 64; index++) {
    const current = queue[index];
    const found = findFile(current.bytes, wantedGuid, current.depth);
    if (found) return found;
    const children = await nestedBuffers(current.bytes);
    queue.push(...children.map((child) => ({ bytes: child, depth: current.depth + 1 })));
  }
  return null;
}

async function locateHii(file: LocatedFile): Promise<Uint8Array | null> {
  let section = file.bodyStart;
  while (section + 4 <= file.end) {
    const size = u24(file.bytes, section);
    const type = file.bytes[section + 3];
    if (size < 4 || section + size > file.end) break;
    if (type === 0x01 && size >= 9) {
      const compressionType = file.bytes[section + 8];
      const body = file.bytes.slice(section + 9, section + size);
      const nested =
        compressionType === 0
          ? body
          : await firmwareDecompress(
              body,
              compressionType === 2 ? "lzma" : "standard",
            );
      const nestedFile = { bytes: nested, bodyStart: 0, end: nested.length, depth: file.depth };
      const result = await locateHii(nestedFile);
      if (result) return result;
    }
    if (type === 0x18 && size >= 20 && guid(file.bytes, section + 4) === hiiGuid) {
      return file.bytes.slice(section + 20, section + size);
    }
    section = align(section + size, 4);
  }
  return null;
}

async function locateFreeformSection(
  file: LocatedFile,
  wantedGuid: string,
): Promise<Uint8Array | null> {
  let section = file.bodyStart;
  while (section + 4 <= file.end) {
    const size = u24(file.bytes, section);
    const type = file.bytes[section + 3];
    if (size < 4 || section + size > file.end) break;
    if (type === 0x01 && size >= 9) {
      const compressionType = file.bytes[section + 8];
      const body = file.bytes.slice(section + 9, section + size);
      const nested =
        compressionType === 0
          ? body
          : await firmwareDecompress(
              body,
              compressionType === 2 ? "lzma" : "standard",
            );
      const result = await locateFreeformSection(
        {
          bytes: nested,
          bodyStart: 0,
          end: nested.length,
          depth: file.depth,
        },
        wantedGuid,
      );
      if (result) return result;
    }
    if (
      type === 0x18 &&
      size >= 20 &&
      guid(file.bytes, section + 4) === wantedGuid
    ) {
      return file.bytes.slice(section + 20, section + size);
    }
    section = align(section + size, 4);
  }
  return null;
}

async function locatePe32(file: LocatedFile): Promise<Uint8Array | null> {
  let section = file.bodyStart;
  while (section + 4 <= file.end) {
    const size = u24(file.bytes, section);
    const type = file.bytes[section + 3];
    if (size < 4 || section + size > file.end) break;
    if (type === 0x01 && size >= 9) {
      const compressionType = file.bytes[section + 8];
      const body = file.bytes.slice(section + 9, section + size);
      const nested =
        compressionType === 0
          ? body
          : await firmwareDecompress(
              body,
              compressionType === 2 ? "lzma" : "standard",
            );
      const result = await locatePe32({
        bytes: nested,
        bodyStart: 0,
        end: nested.length,
        depth: file.depth,
      });
      if (result) return result;
    }
    if (type === 0x10) {
      return file.bytes.slice(section + 4, section + size);
    }
    section = align(section + size, 4);
  }
  return null;
}

async function runIfrExtractor(hii: Uint8Array) {
  const directory = new Map<string, WasiFile>();
  directory.set("setup.bin", new WasiFile(hii));
  const stdout: string[] = [];
  const wasi = new WASI(
    ["ifrextractor", "setup.bin", "verbose"],
    [],
    [
      new OpenFile(new WasiFile([])),
      ConsoleStdout.lineBuffered((line) => stdout.push(line)),
      ConsoleStdout.lineBuffered((line) => stdout.push(line)),
      new PreopenDirectory(".", directory),
    ],
  );
  const url = `${import.meta.env.BASE_URL}ifrextractor.wasm`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("IFRExtractor WebAssembly is not available.");
  const module = await WebAssembly.compileStreaming(response);
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  const exitCode = wasi.start(instance as WebAssembly.Instance & { exports: { memory: WebAssembly.Memory; _start: () => unknown } });
  if (exitCode !== 0) throw new Error(stdout.join("\n") || `IFRExtractor exited with ${String(exitCode)}.`);
  const outputs = [...directory.entries()].filter(([name]) => name.endsWith(".ifr.txt"));
  if (outputs.length === 0) throw new Error("IFRExtractor did not generate a verbose IFR file.");
  return outputs.map(([, output]) => new TextDecoder().decode(output.data)).join("\n");
}

export async function extractAptioIvArtifacts(file: File): Promise<AptioIvArtifacts> {
  const image = new Uint8Array(await file.arrayBuffer());
  const setup = await locateFirmwareFile(image, setupGuid);
  if (!setup) {
    throw new Error("Setup FFS was not found after recursive decompression.");
  }
  const hii = await locateHii(setup);
  if (!hii) throw new Error("The Setup HII package was not found.");
  const amitseFile = await locateFirmwareFile(image, amitseGuid);
  const [amitse, setupData] = amitseFile
    ? await Promise.all([
        locatePe32(amitseFile),
        locateFreeformSection(amitseFile, setupDataGuid),
      ])
    : [null, null];
  const ifrText = await runIfrExtractor(hii);
  const formPackageCount = (ifrText.match(/FormSet Guid:/g) ?? []).length;
  return {
    hii,
    ifrText,
    amitse: amitse ?? undefined,
    setupData: setupData ?? undefined,
    formPackageCount,
    extractionDepth: setup.depth,
  };
}
