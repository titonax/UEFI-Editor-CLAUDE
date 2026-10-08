// EFI/Tiano streams as the firmware stores them inside a section: the 8-byte
// header (packed size, original size) then the Huffman-coded data. Re-encoding
// one has to produce a stream the firmware's own decoder reads back to the same
// bytes, so the variant (EFI or Tiano) is not assumed: it is the one that
// reads the ORIGINAL stream back to the original decoded bytes.

import { TianoDecodeError, decodeTiano, encodeTiano, readTianoHeader, type TianoVariant } from "./tianoCodec";

export interface TianoCodec {
  encode: (data: Uint8Array, variant: TianoVariant) => Uint8Array;
  decode: (stream: Uint8Array, variant: TianoVariant) => Uint8Array;
}

export const builtInTianoCodec: TianoCodec = { encode: encodeTiano, decode: decodeTiano };

export type TianoReencodeRefusalCode =
  | "tiano-header"
  | "tiano-trailing-bytes"
  | "tiano-size"
  | "tiano-variant"
  | "tiano-ambiguous"
  | "tiano-codec"
  | "tiano-roundtrip";

export type TianoReencodeResult =
  | { ok: true; stream: Uint8Array; variant: TianoVariant }
  | { ok: false; code: TianoReencodeRefusalCode; message: string };

const variants: TianoVariant[] = ["efi", "tiano"];

function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function reason(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type Decoding =
  | { ok: true; bytes: Uint8Array }
  // `defect`: the codec failed in a way that is not "this is not a stream of
  // this variant" (a bug, an exhausted resource), so nothing can be concluded.
  | { ok: false; message: string; sharedWithReference: boolean; defect: boolean };

// A decode attempt as a typed result: a stream one variant cannot parse is the
// ordinary outcome of asking the wrong variant, not an exception to hide.
function decodeWith(codec: TianoCodec, stream: Uint8Array, variant: TianoVariant): Decoding {
  try {
    return { ok: true, bytes: codec.decode(stream, variant) };
  } catch (error) {
    if (error instanceof TianoDecodeError) {
      return { ok: false, message: error.message, sharedWithReference: error.sharedWithReference, defect: false };
    }
    return { ok: false, message: reason(error), sharedWithReference: false, defect: true };
  }
}

interface Reading {
  variant: TianoVariant;
  decoding: Decoding;
  // Whether it decoded to exactly the expected bytes.
  matches: boolean;
}

function readingsOf(stream: Uint8Array, decoded: Uint8Array, codec: TianoCodec): Reading[] {
  return variants.map((variant) => {
    const decoding = decodeWith(codec, stream, variant);
    return { variant, decoding, matches: decoding.ok && sameBytes(decoding.bytes, decoded) };
  });
}

type VariantResult =
  | { ok: true; variant: TianoVariant }
  | { ok: false; code: TianoReencodeRefusalCode; message: string };

// The variant of an original stream: the one that reads it back to the bytes
// the image holds, when exactly one does.
function variantOfOriginal(originalStream: Uint8Array, originalDecoded: Uint8Array, codec: TianoCodec): VariantResult {
  const header = readTianoHeader(originalStream);
  if (!header) {
    return { ok: false, code: "tiano-header", message: "The original section does not start with an EFI/Tiano header." };
  }
  if (header.packedSize + 8 !== originalStream.length) {
    return {
      ok: false,
      code: "tiano-trailing-bytes",
      message: `The original stream declares ${String(header.packedSize + 8)} bytes in the section's ${String(originalStream.length)}, so bytes after it would move or be lost.`,
    };
  }
  if (header.originalSize !== originalDecoded.length) {
    return {
      ok: false,
      code: "tiano-size",
      message: `The original declares ${String(header.originalSize)} bytes; the image holds ${String(originalDecoded.length)}.`,
    };
  }
  const readings = readingsOf(originalStream, originalDecoded, codec);
  const defect = readings.find((one) => !one.decoding.ok && one.decoding.defect);
  if (defect && !defect.decoding.ok) {
    return { ok: false, code: "tiano-codec", message: `The EFI/Tiano codec failed on the original stream (${defect.variant}): ${defect.decoding.message}` };
  }
  const reading = readings.filter((one) => one.matches).map((one) => one.variant);
  if (reading.length === 0) {
    const why = readings.map((one) => `${one.variant}: ${one.decoding.ok ? "decodes to other bytes" : one.decoding.message}`).join("; ");
    return {
      ok: false,
      code: "tiano-variant",
      message: `Neither the EFI nor the Tiano decoder of this codec reads the original stream back to the bytes the image holds, so the variant the firmware uses is unknown (${why}).`,
    };
  }
  if (reading.length > 1) {
    return {
      ok: false,
      code: "tiano-ambiguous",
      message: "The original stream reads back correctly as both EFI and Tiano, so the variant the firmware uses cannot be told from the data.",
    };
  }
  return { ok: true, variant: reading[0] };
}

// Re-encodes `decoded` so it can replace `originalStream` in the firmware.
// `originalDecoded` is what the original stream decodes to; it identifies the
// variant. Refuses anything it cannot show the firmware reads back the same
// way: a stream with bytes after its packed data, a size that differs from the
// data, a stream neither variant reads back to the original, or one both do.
export function reencodeTiano(
  originalStream: Uint8Array,
  originalDecoded: Uint8Array,
  decoded: Uint8Array,
  codec: TianoCodec = builtInTianoCodec,
): TianoReencodeResult {
  const found = variantOfOriginal(originalStream, originalDecoded, codec);
  if (!found.ok) return found;
  if (originalDecoded.length !== decoded.length) {
    return {
      ok: false,
      code: "tiano-size",
      message: `The original declares ${String(originalDecoded.length)} bytes; the data to compress has ${String(decoded.length)}.`,
    };
  }
  if (decoded.length === 0) {
    return { ok: false, code: "tiano-size", message: "There is nothing to compress: an empty buffer has no EFI/Tiano stream to rebuild." };
  }
  const variant = found.variant;
  let stream: Uint8Array;
  try {
    stream = codec.encode(decoded, variant).slice();
  } catch (error) {
    return { ok: false, code: "tiano-codec", message: `The EFI/Tiano codec failed to encode: ${reason(error)}` };
  }
  const readBack = decodeWith(codec, stream, variant);
  if (!readBack.ok) {
    return { ok: false, code: "tiano-codec", message: `The EFI/Tiano codec failed to decode its own stream: ${readBack.message}` };
  }
  if (!sameBytes(readBack.bytes, decoded)) {
    return { ok: false, code: "tiano-roundtrip", message: "The re-encoded EFI/Tiano stream does not decode back to the data it was made from." };
  }
  return { ok: true, stream, variant };
}

// What an independent look at a rebuilt stream finds wrong with it. `stream`
// is what the rebuilt image holds, `decoded` the buffer it must carry.
export function tianoStreamProblems(
  originalStream: Uint8Array,
  originalDecoded: Uint8Array,
  stream: Uint8Array,
  decoded: Uint8Array,
  codec: TianoCodec = builtInTianoCodec,
): string[] {
  const problems: string[] = [];
  const header = readTianoHeader(stream);
  if (!header) return ["The section does not start with an EFI/Tiano header."];
  if (header.packedSize + 8 !== stream.length) {
    problems.push(`The stream declares ${String(header.packedSize + 8)} bytes but occupies ${String(stream.length)}.`);
  }
  if (header.originalSize !== decoded.length) {
    problems.push(`The stream declares ${String(header.originalSize)} bytes of data; the buffer it carries has ${String(decoded.length)}.`);
  }
  // A header that already disagrees is not worth decoding: its sizes would
  // drive the allocation.
  if (problems.length > 0) return problems;
  const readings = readingsOf(stream, decoded, codec);
  const reading = readings.filter((one) => one.matches).map((one) => one.variant);
  if (reading.length === 0) {
    const why = readings.map((one) => `${one.variant}: ${one.decoding.ok ? "decodes to other bytes" : one.decoding.message}`).join("; ");
    problems.push(`The stream does not decode to the buffer it is meant to carry (${why}).`);
  }
  const original = variantOfOriginal(originalStream, originalDecoded, codec);
  if (!original.ok) {
    problems.push(`The original stream cannot serve as the reference: ${original.message}`);
    return problems;
  }
  if (!reading.includes(original.variant)) {
    problems.push(`The stream does not decode in the variant (${original.variant}) of the stream it replaces.`);
  }
  const canonical = reencodeTiano(originalStream, originalDecoded, decoded, codec);
  if (!canonical.ok) {
    problems.push(`The stream cannot be re-derived from its buffer: ${canonical.message}`);
  } else if (!sameBytes(stream, canonical.stream)) {
    problems.push("The stream is not the canonical re-encoding of its buffer (it holds extra or altered bytes).");
  }
  // The project's extractor tries the Tiano decoder first and keeps the first
  // stream that parses. An EFI stream the Tiano decoder also accepts, to other
  // bytes, would be misread there. This codec's Tiano decoder may reject a
  // stream the project's C decoder accepts, so only a rejection both share
  // counts as proof; anything else is left unproven and reported, to be settled
  // by reading the image back with the real decoder.
  if (original.variant === "efi") {
    const misread = decodeWith(codec, stream, "tiano");
    if (misread.ok) {
      if (!sameBytes(misread.bytes, decoded)) {
        problems.push("The extractor tries the Tiano decoder first, and it would read this EFI stream as different bytes.");
      }
    } else if (!misread.sharedWithReference) {
      problems.push(
        `The extractor tries the Tiano decoder first, and this codec cannot show that the project's decoder rejects this EFI stream (${misread.message}); it may read it as other bytes.`,
      );
    }
  }
  return problems;
}
