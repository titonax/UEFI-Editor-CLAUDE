// A reference EFI/Tiano decoder for tests: the project's own C decoder
// (tools/tiano-wasi, EDK2's Decompress.c), compiled natively with gcc. It shares
// no code with the TypeScript codec under test. Returns null when gcc is not
// installed so a machine without it still runs everything else; CI images have
// it, and the tests that need it are reported as skipped, not passed.

import type { TianoVariant } from "./tianoCodec";

let compiled: Promise<string | null> | undefined;

async function compile(): Promise<string | null> {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "tiano-reference-"));
  const binary = join(directory, "tiano-decompress");
  try {
    execFileSync(
      "gcc",
      [
        "-O2",
        "-I",
        "tools/tiano-wasi",
        "tools/tiano-wasi/main.c",
        "tools/tiano-wasi/Decompress.c",
        "-o",
        binary,
      ],
      { maxBuffer: 1 << 24, timeout: 60000 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) return null;
    throw error;
  }
  return binary;
}

export function referenceTianoAvailable(): Promise<boolean> {
  compiled ??= compile();
  return compiled.then((binary) => binary !== null);
}

// Decodes with the C decoder; throws with its message when it rejects the
// stream, which is what a test of an invalid stream wants to see.
export async function referenceTianoDecode(stream: Uint8Array, variant: TianoVariant): Promise<Uint8Array> {
  compiled ??= compile();
  const binary = await compiled;
  if (binary === null) throw new Error("gcc is not installed");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "tiano-case-"));
  try {
    const input = join(directory, "input.bin");
    const output = join(directory, "output.bin");
    writeFileSync(input, stream);
    try {
      execFileSync(binary, [input, output, variant], { maxBuffer: 1 << 24, timeout: 60000 });
    } catch (error) {
      throw new Error(`the C decoder rejected the stream: ${error instanceof Error ? error.message : String(error)}`);
    }
    return new Uint8Array(readFileSync(output));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
