import { describe, expect, it } from "vitest";
import { builtInTianoCodec, reencodeTiano, tianoStreamProblems, type TianoCodec } from "./tianoSection";
import { decodeTiano, encodeTiano, type TianoVariant } from "./tianoCodec";

function text(length: number) {
  return Uint8Array.from({ length }, (_, index) => 0x20 + ((index * index + index) % 61));
}

const data = text(3000);
const edited = data.map((byte, index) => (index === 100 ? byte ^ 0xff : byte));

describe("reencodeTiano", () => {
  for (const variant of ["efi", "tiano"] as TianoVariant[]) {
    it(`finds the ${variant} variant of the original and writes a stream it reads back`, () => {
      const original = encodeTiano(data, variant);

      const result = reencodeTiano(original, data, edited);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.variant).toBe(variant);
      expect(decodeTiano(result.stream, variant)).toEqual(edited);
      expect(tianoStreamProblems(original, data, result.stream, edited)).toEqual([]);
    });
  }

  it("refuses an original without a header", () => {
    const result = reencodeTiano(Uint8Array.of(1, 2, 3), data, edited);

    expect(result).toMatchObject({ ok: false, code: "tiano-header" });
  });

  it("refuses an original with bytes after its packed data", () => {
    const original = Uint8Array.from([...encodeTiano(data, "efi"), 0, 0, 0, 0]);

    expect(reencodeTiano(original, data, edited)).toMatchObject({ ok: false, code: "tiano-trailing-bytes" });
  });

  it("refuses data of another length than the original's", () => {
    const original = encodeTiano(data, "efi");

    expect(reencodeTiano(original, data, edited.subarray(0, 2999))).toMatchObject({ ok: false, code: "tiano-size" });
  });

  it("refuses an original that does not decode to the bytes the image holds", () => {
    const original = encodeTiano(data, "efi");

    expect(reencodeTiano(original, edited, edited)).toMatchObject({ ok: false, code: "tiano-variant" });
  });

  it("refuses when both variants read the original, because the firmware's cannot be told", () => {
    const original = encodeTiano(data, "efi");
    const readsAnyVariant: TianoCodec = { encode: builtInTianoCodec.encode, decode: (stream) => decodeTiano(stream, "efi") };

    expect(reencodeTiano(original, data, edited, readsAnyVariant)).toMatchObject({ ok: false, code: "tiano-ambiguous" });
  });

  it("names a codec that throws", () => {
    const original = encodeTiano(data, "efi");
    const broken: TianoCodec = { decode: builtInTianoCodec.decode, encode: () => { throw new Error("boom"); } };

    const result = reencodeTiano(original, data, edited, broken);

    expect(result).toMatchObject({ ok: false, code: "tiano-codec" });
    if (!result.ok) expect(result.message).toMatch(/boom/);
  });

  it("refuses data a codec cannot read back", () => {
    const original = encodeTiano(data, "efi");
    const lying: TianoCodec = { decode: builtInTianoCodec.decode, encode: (bytes, variant) => encodeTiano(bytes.map((byte) => byte ^ 1), variant) };

    expect(reencodeTiano(original, data, edited, lying)).toMatchObject({ ok: false, code: "tiano-roundtrip" });
  });

  it("refuses empty data", () => {
    const original = encodeTiano(Uint8Array.of(1), "efi");

    expect(reencodeTiano(original, Uint8Array.of(1), new Uint8Array(0))).toMatchObject({ ok: false });
  });
});

describe("tianoStreamProblems", () => {
  const original = encodeTiano(data, "efi");
  const stream = encodeTiano(edited, "efi");

  it("accepts the canonical stream", () => {
    expect(tianoStreamProblems(original, data, stream, edited)).toEqual([]);
  });

  it("rejects a stream that decodes to other bytes", () => {
    expect(tianoStreamProblems(original, data, encodeTiano(data, "efi"), edited).join("\n")).toMatch(/does not decode/);
  });

  it("rejects a stream in the other variant", () => {
    const problems = tianoStreamProblems(original, data, encodeTiano(edited, "tiano"), edited);

    expect(problems.join("\n")).toMatch(/variant \(efi\)/);
  });

  it("rejects a header that lies about the packed size", () => {
    const lying = stream.slice();
    lying[0] ^= 1;

    expect(tianoStreamProblems(original, data, lying, edited).join("\n")).toMatch(/declares/);
  });

  it("rejects extra bytes after the stream", () => {
    expect(tianoStreamProblems(original, data, Uint8Array.from([...stream, 7]), edited).length).toBeGreaterThan(0);
  });

  it("rejects an EFI stream the extractor would read as Tiano with other bytes", () => {
    const tianoMisreads: TianoCodec = {
      encode: builtInTianoCodec.encode,
      decode: (bytes, variant) => (variant === "tiano" ? new Uint8Array(edited.length) : decodeTiano(bytes, variant)),
    };

    expect(tianoStreamProblems(original, data, stream, edited, tianoMisreads).join("\n")).toMatch(/Tiano decoder first/);
  });

  it("rejects a stream not in the shape the encoder writes", () => {
    const other: TianoCodec = { decode: decodeTiano, encode: (bytes, variant) => encodeTiano(bytes, variant, { blockSymbols: 300 }) };
    const noisy = Uint8Array.from({ length: 3000 }, (_, index) => (index * 2654435761) >>> 24);
    const noisyOriginal = encodeTiano(noisy, "efi");
    const noisyEdited = noisy.map((byte, index) => (index === 5 ? byte ^ 1 : byte));

    const problems = tianoStreamProblems(noisyOriginal, noisy, encodeTiano(noisyEdited, "efi"), noisyEdited, other);

    expect(problems.join("\n")).toMatch(/canonical/);
  });
});
