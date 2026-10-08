import { describe, expect, it } from "vitest";
import { lzmaJsCodec } from "./lzmaJs";
import { readLzmaHeader, reencodeLzma, type LzmaCodec } from "./lzmaSection";
import { referenceLzmaDecode } from "./referenceLzma";
import { patternBytes } from "./firmwareImageFixtures";

// Text-like and binary-like payloads of a size where mode choice matters.
const decoded = Uint8Array.from({ length: 6000 }, (_, index) => (index % 17 === 0 ? 0xff : (index * 3) % 41));

// A stream made the way the firmware's own tool makes it: known size, no
// end-of-stream marker, a chosen dictionary size.
function originalStream(data: Uint8Array, mode = 8) {
  return lzmaJsCodec.encode(data, mode);
}

describe("readLzmaHeader", () => {
  it("reads the properties, the dictionary size and the declared size", () => {
    const header = readLzmaHeader(originalStream(decoded, 5));

    expect(header).toMatchObject({ propsByte: 0x5d, lc: 3, lp: 0, pb: 2, dictionarySize: 1 << 21, uncompressedSize: BigInt(decoded.length) });
  });

  it("reports an unknown size as null instead of a huge number", () => {
    const stream = originalStream(decoded).slice();
    stream.fill(0xff, 5, 13);

    expect(readLzmaHeader(stream)?.uncompressedSize).toBeNull();
  });

  it("rejects bytes that cannot be an LZMA header", () => {
    expect(readLzmaHeader(new Uint8Array(12))).toBeNull();
    const bad = originalStream(decoded).slice();
    bad[0] = 0xe1;
    expect(readLzmaHeader(bad)).toBeNull();
  });
});

describe("lzmaJsCodec", () => {
  it("writes no end marker and a known size, like EDK2's LzmaCompress", () => {
    const stream = originalStream(decoded, 5);

    expect(readLzmaHeader(stream)?.uncompressedSize).toBe(BigInt(decoded.length));
    // An end marker costs a few bytes: decode must work with the stream cut to
    // exactly what the size field asks for.
    expect(lzmaJsCodec.decode(stream)).toEqual(decoded);
  });

  it("round-trips bytes that look like UTF-8 text without turning them into a string", () => {
    const text = new TextEncoder().encode("plain ascii text ".repeat(200));
    const accented = new TextEncoder().encode("áéíóú ñ 日本語 ".repeat(100));

    expect(lzmaJsCodec.decode(lzmaJsCodec.encode(text, 5))).toEqual(text);
    expect(lzmaJsCodec.decode(lzmaJsCodec.encode(accented, 5))).toEqual(accented);
  });

  it("round-trips high bytes that the library reports as negative numbers", () => {
    const data = Uint8Array.from({ length: 3000 }, (_, index) => 0x80 + (index % 128));

    expect(lzmaJsCodec.decode(lzmaJsCodec.encode(data, 5))).toEqual(data);
  });

  it("reads what a reference decoder (xz) reads", async () => {
    const reference = await referenceLzmaDecode(originalStream(decoded, 5));
    if (reference === null) return; // xz is not installed here; CI has it
    expect(reference).toEqual(decoded);
  });
});

describe("reencodeLzma", () => {
  const edited = decoded.slice();
  edited[100] ^= 0xff;
  edited[2500] ^= 0x0f;

  it("re-encodes edited data with the original's properties and dictionary size", async () => {
    const original = originalStream(decoded, 8);

    const result = reencodeLzma(original, edited, lzmaJsCodec);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const header = readLzmaHeader(result.stream);
    const originalHeader = readLzmaHeader(original);
    expect(header?.propsByte).toBe(originalHeader?.propsByte);
    expect(header?.dictionarySize).toBe(originalHeader?.dictionarySize);
    expect(header?.uncompressedSize).toBe(BigInt(edited.length));
    expect(lzmaJsCodec.decode(result.stream)).toEqual(edited);
    const reference = await referenceLzmaDecode(result.stream);
    if (reference !== null) expect(reference).toEqual(edited);
  });

  it("never uses a dictionary larger than the original declared", () => {
    const original = originalStream(decoded, 4); // 2^20

    const result = reencodeLzma(original, edited, lzmaJsCodec);

    expect(result.ok && result.preset).toBeLessThanOrEqual(4);
    expect(result.ok && readLzmaHeader(result.stream)?.dictionarySize).toBe(1 << 20);
  });

  it("is deterministic", () => {
    const original = originalStream(decoded, 8);

    const a = reencodeLzma(original, edited, lzmaJsCodec);
    const b = reencodeLzma(original, edited, lzmaJsCodec);

    expect(a.ok && b.ok && a.stream).toEqual(a.ok && b.ok && b.stream);
  });

  it("refuses an original whose properties this encoder cannot reproduce", () => {
    const original = originalStream(decoded).slice();
    original[0] = 0x5e; // lc=4

    const result = reencodeLzma(original, edited, lzmaJsCodec);

    expect(result).toMatchObject({ ok: false, code: "lzma-properties" });
  });

  it("refuses an original with no declared size, which means it relies on an end marker", () => {
    const original = originalStream(decoded).slice();
    original.fill(0xff, 5, 13);

    expect(reencodeLzma(original, edited, lzmaJsCodec)).toMatchObject({ ok: false, code: "lzma-size" });
  });

  it("refuses data whose length is not what the original declared", () => {
    const original = originalStream(decoded);

    expect(reencodeLzma(original, edited.slice(0, -1), lzmaJsCodec)).toMatchObject({ ok: false, code: "lzma-size" });
  });

  it("refuses an original that is not LZMA at all", () => {
    expect(reencodeLzma(patternBytes(40, 1).fill(0xff, 0, 1), edited, lzmaJsCodec)).toMatchObject({ ok: false, code: "lzma-header" });
  });

  it("refuses to hand back a stream its own decoder cannot read back to the data", () => {
    const original = originalStream(decoded);
    const lying: LzmaCodec = { ...lzmaJsCodec, decode: (stream) => lzmaJsCodec.decode(stream).map((byte) => byte ^ 1) };

    expect(reencodeLzma(original, edited, lying)).toMatchObject({ ok: false, code: "lzma-roundtrip" });
  });
});
