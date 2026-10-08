// A reference LZMA decoder for tests: the `xz` tool, which shares no code with
// the encoder under test. Returns null when it is not installed so a machine
// without it still runs everything else; CI images have it.

export async function referenceLzmaDecode(stream: Uint8Array): Promise<Uint8Array | null> {
  const { execFileSync } = await import("node:child_process");
  try {
    return new Uint8Array(
      execFileSync("xz", ["--format=lzma", "--decompress", "--stdout"], {
        input: stream,
        maxBuffer: 1 << 28,
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) return null;
    throw error;
  }
}

// Whether `xz` can be run here, so a test can say it was skipped instead of
// passing with nothing checked.
export async function referenceLzmaAvailable(): Promise<boolean> {
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("xz", ["--version"], {});
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) return false;
    throw error;
  }
}
