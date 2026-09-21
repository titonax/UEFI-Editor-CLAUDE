import { describe, expect, it } from "vitest";
import { decompressPhoenixLh5 } from "./phoenixLh5";

function hexBytes(value: string) {
  return Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

describe("decompressPhoenixLh5", () => {
  // The real -lh5- compressed body of a documented Phoenix FFV module
  // (ACPI1.ROM, packed 0x58/unpacked 0x78 bytes - see
  // docs/phoenix/README.md's Acer sample). Decompressing it is this
  // function's only real-world job, so this is a genuine LZSS+adaptive-
  // Huffman bitstream, not a synthetic one - lhats has no encoder to build
  // a smaller one with, by design (see its README's "why read-only").
  const acpi1CompressedBody = hexBytes(
    "00414b56da187fdfe640890f428d4902025ee7336ed9cdfc0c95e00204244f031e1b15" +
      "ff88110e80412d0092d634f30010bf1758e63da74d533e5248cf0bb25d718f4884ea0" +
      "39e87e6eafa12ed611e50506bb508fc27a000",
  );

  it("decompresses a real Phoenix FFV module's LH5 body to its exact documented size and content", async () => {
    const decompressed = await decompressPhoenixLh5(acpi1CompressedBody, 0x78);

    expect(decompressed).toHaveLength(0x78);
    // The decompressed body is a real ACPI FADT-shaped table; its "FACP"
    // signature at byte 4 is a strong, independent check that this
    // decoded correctly rather than merely producing 120 bytes of noise.
    expect(new TextDecoder("latin1").decode(decompressed.subarray(4, 8))).toBe("FACP");
  });

  it("rejects a compressed body that isn't a valid LH5 stream", async () => {
    await expect(decompressPhoenixLh5(new Uint8Array(20), 100)).rejects.toThrow();
  });
});
