import { describe, expect, it } from "vitest";
import { builtInTianoCodec, reencodeTiano, tianoStreamProblems, type TianoCodec } from "./tianoSection";
import { referenceTianoAvailable, referenceTianoDecode } from "./referenceTiano";
import { TianoDecodeError, decodeTiano, encodeTiano, type TianoVariant } from "./tianoCodec";

const hasReference = await referenceTianoAvailable();

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

// Incompressible data has no matches, so the EFI stream's position table is
// empty; the project's C decoder then reads it as a Tiano stream without
// complaint and returns other bytes, while this codec's stricter Tiano decoder
// throws. The data is the xorshift sequence that first showed it.
function unprovenEfiStreams() {
  const found: { bytes: Uint8Array; stream: Uint8Array }[] = [];
  let state = 99;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  for (let attempt = 0; attempt < 100; attempt++) {
    const length = 1 + (next() % 4000);
    const bytes = Uint8Array.from({ length }, (_, index) =>
      attempt % 3 === 0 ? next() & 255 : attempt % 3 === 1 ? (index * 7) & 255 : next() % 5 === 0 ? next() & 255 : 65 + (index % 11),
    );
    const stream = encodeTiano(bytes, "efi");
    try {
      decodeTiano(stream, "tiano");
    } catch (error) {
      if (error instanceof TianoDecodeError && !error.sharedWithReference) found.push({ bytes, stream });
    }
  }
  if (found.length === 0) throw new Error("no such stream was found");
  return found;
}

describe("an EFI stream the Tiano decoder of the extractor might accept", () => {
  it("is reported rather than passed when this codec cannot show the C decoder rejects it", () => {
    for (const { bytes, stream } of unprovenEfiStreams()) {
      const problems = tianoStreamProblems(stream, bytes, stream, bytes);

      expect(problems.join("\n")).toMatch(/cannot show that the project's decoder rejects/);
    }
  });

  it.skipIf(!hasReference)("really is read by the C Tiano decoder as other bytes, which is why", async () => {
    let misread = 0;
    for (const { bytes, stream } of unprovenEfiStreams()) {
      let read: Uint8Array;
      try {
        read = await referenceTianoDecode(stream, "tiano");
      } catch {
        continue; // this one the C decoder does reject
      }
      expect(read.length).toBe(bytes.length);
      if (read.some((byte, index) => byte !== bytes[index])) misread++;
    }

    expect(misread).toBeGreaterThan(0);
  });
});

describe("hostile headers and codec failures", () => {
  it("does not allocate what a header asks for", () => {
    const header = Uint8Array.of(0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff);

    expect(() => decodeTiano(header, "efi")).toThrow(TianoDecodeError);
    expect(() => decodeTiano(header, "efi")).toThrow(/more than/);
  });

  it("does not decode a rebuilt stream whose header already disagrees with the buffer", () => {
    const original = encodeTiano(data, "efi");
    const lying = encodeTiano(edited, "efi").slice();
    new DataView(lying.buffer).setUint32(4, 0xffffffff, true);
    let decodes = 0;
    const counting: TianoCodec = {
      encode: builtInTianoCodec.encode,
      decode: (bytes, variant) => {
        decodes++;
        return decodeTiano(bytes, variant);
      },
    };

    const problems = tianoStreamProblems(original, data, lying, edited, counting);

    expect(problems.join("\n")).toMatch(/declares/);
    expect(decodes).toBe(0);
  });

  it("names why neither variant read the original", () => {
    const original = encodeTiano(data, "efi");

    const result = reencodeTiano(original, edited, edited);

    expect(result).toMatchObject({ ok: false, code: "tiano-variant" });
    if (!result.ok) expect(result.message).toMatch(/efi: decodes to other bytes/);
  });

  it("reports a codec defect as a codec failure, not as an unknown variant", () => {
    const original = encodeTiano(data, "efi");
    const buggy: TianoCodec = {
      encode: builtInTianoCodec.encode,
      decode: () => {
        throw new TypeError("Cannot read properties of undefined");
      },
    };

    const result = reencodeTiano(original, data, edited, buggy);

    expect(result).toMatchObject({ ok: false, code: "tiano-codec" });
  });
});
