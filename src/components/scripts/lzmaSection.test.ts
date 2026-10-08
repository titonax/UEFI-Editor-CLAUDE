import { describe, expect, it } from "vitest";
import * as lzma from "lzma";
import { lzmaJsCodec } from "./lzmaJs";
import { readLzmaHeader, reencodeLzma, type LzmaCodec } from "./lzmaSection";
import { referenceLzmaAvailable, referenceLzmaDecode } from "./referenceLzma";

const hasXz = await referenceLzmaAvailable();
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

  it("writes less than the library's default, which adds an end marker", () => {
    lzma.LZMA().disableEndMark = undefined;
    const withMarker = Uint8Array.from(lzma.compress(decoded, 5), (value) => value & 0xff);

    const ours = originalStream(decoded, 5);

    expect(ours.length).toBeLessThan(withMarker.length);
    // The size field is the same in both: only the marker differs.
    expect(readLzmaHeader(withMarker)?.uncompressedSize).toBe(readLzmaHeader(ours)?.uncompressedSize);
  });

  it("does not leave the library's end-marker setting changed for anyone else", () => {
    lzma.LZMA().disableEndMark = undefined;

    originalStream(decoded, 5);

    expect(lzma.LZMA().disableEndMark).toBeUndefined();
  });

  it.skipIf(!hasXz)("reads what a reference decoder (xz) reads", async () => {
    expect(await referenceLzmaDecode(originalStream(decoded, 5))).toEqual(decoded);
  });
});

describe("reencodeLzma", () => {
  const edited = decoded.slice();
  edited[100] ^= 0xff;
  edited[2500] ^= 0x0f;

  it("re-encodes edited data with the original's properties and dictionary size", () => {
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
  });

  it.skipIf(!hasXz)("writes a stream a reference decoder (xz) reads back to the data", async () => {
    const result = reencodeLzma(originalStream(decoded, 8), edited, lzmaJsCodec);

    expect(result.ok && (await referenceLzmaDecode(result.stream))).toEqual(edited);
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

  it("refuses, with a reason, when the encoder or decoder throws", () => {
    const original = originalStream(decoded);
    const failingEncoder: LzmaCodec = { ...lzmaJsCodec, encode: () => { throw new Error("out of memory"); } };
    const failingDecoder: LzmaCodec = { ...lzmaJsCodec, decode: () => { throw new Error("corrupted input"); } };

    expect(reencodeLzma(original, edited, failingEncoder)).toMatchObject({ ok: false, code: "lzma-codec" });
    expect(reencodeLzma(original, edited, failingDecoder)).toMatchObject({ ok: false, code: "lzma-codec" });
    const result = reencodeLzma(original, edited, failingDecoder);
    expect(!result.ok && result.message).toMatch(/corrupted input/);
  });

  it("refuses a dictionary the codec's own decoder could not check", () => {
    const original = originalStream(decoded).slice();
    new DataView(original.buffer).setUint32(1, 0x08000000, true); // 128 MiB, legal LZMA

    const result = reencodeLzma(original, edited, lzmaJsCodec);

    expect(result).toMatchObject({ ok: false, code: "lzma-dictionary" });
  });

  it("refuses to compress nothing", () => {
    const original = originalStream(decoded).slice();
    new DataView(original.buffer).setBigUint64(5, 0n, true);

    expect(reencodeLzma(original, new Uint8Array(0), lzmaJsCodec)).toMatchObject({ ok: false, code: "lzma-size" });
  });

  it("refuses to hand back a stream its own decoder cannot read back to the data", () => {
    const original = originalStream(decoded);
    const lying: LzmaCodec = { ...lzmaJsCodec, decode: (stream) => lzmaJsCodec.decode(stream).map((byte) => byte ^ 1) };

    expect(reencodeLzma(original, edited, lying)).toMatchObject({ ok: false, code: "lzma-roundtrip" });
  });
});

describe("lzmaJs in a browser bundle", () => {
  it("bundles for the browser without needing Node's path or __dirname", async () => {
    // The package's own entry point resolves its engine with require(path) at
    // import time, which a browser cannot do; the adapter must use the engine
    // file directly. Bundling is the cheapest honest check short of a browser.
    const esbuild = await import("esbuild");
    const result = await esbuild.build({
      entryPoints: ["src/components/scripts/lzmaJs.ts"],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      logLevel: "silent",
    });
    const code = result.outputFiles.map((file) => file.text).join("\n");

    expect(result.errors).toEqual([]);
    expect(code).not.toMatch(/__dirname|require\(["']path["']\)/);
  });
});
