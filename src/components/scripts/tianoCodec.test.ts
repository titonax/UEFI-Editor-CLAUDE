import { describe, expect, it } from "vitest";
import { patternBytes } from "./firmwareImageFixtures";
import { referenceTianoAvailable, referenceTianoDecode } from "./referenceTiano";
import { TianoDecodeError, decodeTiano, encodeTiano, readTianoHeader, type TianoVariant } from "./tianoCodec";

const hasReference = await referenceTianoAvailable();
const variants: TianoVariant[] = ["efi", "tiano"];

function randomBytes(length: number, seed: number) {
  let state = seed >>> 0 || 1;
  return Uint8Array.from({ length }, () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state & 0xff;
  });
}

// Text-like data with repeats at assorted distances, the shape of real code.
function structured(length: number) {
  const words = ["setup", "advanced", "suppress", "boot", "chipset", "PCI", "SATA", "USB", "memory", "CPU"];
  const encoder = new TextEncoder();
  const parts: number[] = [];
  let state = 7;
  while (parts.length < length) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    parts.push(...encoder.encode(`${words[state % words.length]}${String(state % 97)} `));
  }
  return Uint8Array.from(parts.slice(0, length));
}

// vitest's toEqual spends minutes diffing two large mismatching byte arrays;
// this fails at once and names the first byte that differs.
function expectSameBytes(actual: Uint8Array, expected: Uint8Array) {
  expect(actual.length).toBe(expected.length);
  const first = actual.findIndex((value, index) => value !== expected[index]);
  expect(first, `first differing byte`).toBe(-1);
}

const samples: [string, () => Uint8Array][] = [
  ["a single byte", () => Uint8Array.of(0x41)],
  ["two bytes", () => Uint8Array.of(1, 2)],
  ["one repeated byte", () => new Uint8Array(5000).fill(0x41)],
  ["zeros", () => new Uint8Array(70000)],
  ["a short periodic pattern", () => patternBytes(3000, 3)],
  ["incompressible bytes", () => randomBytes(4000, 11)],
  ["structured text", () => structured(30000)],
  ["a long run then noise", () => Uint8Array.from([...new Uint8Array(600).fill(7), ...randomBytes(200, 5)])],
  ["every byte value in order", () => Uint8Array.from({ length: 512 }, (_, index) => index & 0xff)],
];

describe("the reference decoder", () => {
  it("is available wherever CI runs, so the independent checks cannot vanish unnoticed", () => {
    // Locally a machine without gcc skips the C-decoder tests, visibly; in CI
    // (GitHub sets CI=true) a skip would hide the only independent oracle.
    if (process.env.CI) expect(hasReference).toBe(true);
  });
});

// Fixed streams: the encoder is deterministic, and a change to what it writes
// (which moves the rebuild and its own "canonical" check together) must be a
// decision, not an accident. Each is also read by the C decoder when present.
const golden: Record<TianoVariant, string> = {
  efi: "1c0000002900000000153b8a86150310b01ca36791f18a0026dc6517936d38576e849904",
  tiano: "1c0000002900000000153b8a86150310b01ca36791f18500136e328bc9b69c2bb7424c82",
};
const goldenText = new TextEncoder().encode("setup setup setup advanced advanced boot ");
const hexOf = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

describe("golden streams", () => {
  for (const variant of variants) {
    it(`writes the same ${variant} bytes as before`, () => {
      expect(hexOf(encodeTiano(goldenText, variant))).toBe(golden[variant]);
    });

    it.skipIf(!hasReference)(`has its ${variant} golden stream read by the C decoder`, async () => {
      const stream = Uint8Array.from(golden[variant].match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

      expectSameBytes(await referenceTianoDecode(stream, variant), goldenText);
    });
  }
});

describe("encodeTiano / decodeTiano", () => {
  for (const variant of variants) {
    for (const [name, make] of samples) {
      it(`round-trips ${name} as ${variant}`, () => {
        const data = make();

        const stream = encodeTiano(data, variant);

        expectSameBytes(decodeTiano(stream, variant), data);
      });
    }
  }

  it("writes the 8-byte header the firmware reads: packed size without the header, then the original size", () => {
    const data = structured(5000);

    const stream = encodeTiano(data, "efi");
    const header = readTianoHeader(stream);

    expect(header).toEqual({ packedSize: stream.length - 8, originalSize: 5000 });
  });

  it("actually compresses repetitive data", () => {
    expect(encodeTiano(new Uint8Array(50000).fill(0), "efi").length).toBeLessThan(500);
    expect(encodeTiano(structured(30000), "tiano").length).toBeLessThan(15000);
  });

  it("is deterministic", () => {
    const data = structured(20000);

    expectSameBytes(encodeTiano(data, "tiano"), encodeTiano(data, "tiano"));
  });

  it("splits large inputs into several blocks and still round-trips", () => {
    const data = structured(40000);

    const stream = encodeTiano(data, "efi", { blockSymbols: 700 });

    expectSameBytes(decodeTiano(stream, "efi"), data);
  });

  it("uses the farther window of the Tiano variant where it helps", () => {
    const block = randomBytes(2000, 9);
    const gap = randomBytes(60000, 13);
    const data = Uint8Array.from([...block, ...gap, ...block]);

    const efi = encodeTiano(data, "efi");
    const tiano = encodeTiano(data, "tiano");

    expect(tiano.length).toBeLessThan(efi.length - 1000);
    expectSameBytes(decodeTiano(tiano, "tiano"), data);
    expectSameBytes(decodeTiano(efi, "efi"), data);
  });

  it("refuses to encode nothing", () => {
    expect(() => encodeTiano(new Uint8Array(0), "efi")).toThrow(/empty/);
  });
});

describe("decodeTiano on bad streams", () => {
  const data = structured(4000);

  it("rejects a stream shorter than its header says", () => {
    const stream = encodeTiano(data, "efi");

    expect(() => decodeTiano(stream.slice(0, stream.length - 3), "efi")).toThrow(/shorter|truncated/);
    expect(() => decodeTiano(new Uint8Array(5), "efi")).toThrow(/header/);
  });

  it("does not read the wrong variant as the right data", () => {
    const stream = encodeTiano(data, "tiano");

    let result: Uint8Array | null = null;
    try {
      result = decodeTiano(stream, "efi");
    } catch {
      result = null;
    }
    const intact = result !== null && result.length === data.length && result.every((byte, index) => byte === data[index]);
    expect(intact).toBe(false);
  });

  it("refuses a block size that cannot advance", () => {
    for (const blockSymbols of [0, -1, Number.NaN, 1.5]) {
      expect(() => encodeTiano(Uint8Array.of(1, 2, 3), "efi", { blockSymbols })).toThrow(/blockSymbols/);
    }
  });

  it("tells a rejection the C decoder shares from one it does not", () => {
    const stream = encodeTiano(structured(2000), "efi").slice();
    const header = new DataView(stream.buffer);
    header.setUint32(0, stream.length, true); // packed size beyond the data
    const shared = (bytes: Uint8Array) => {
      try {
        decodeTiano(bytes, "efi");
      } catch (error) {
        return error instanceof TianoDecodeError ? error.sharedWithReference : undefined;
      }
      return undefined;
    };

    expect(shared(stream)).toBe(true); // truncated: the C decoder rejects it too
    expect(shared(Uint8Array.of(1, 2))).toBe(true); // shorter than the header
  });

  it("rejects a corrupted code table instead of looping or reading past the end", () => {
    const stream = encodeTiano(data, "efi").slice();
    stream.fill(0xff, 12, 40);

    expect(() => decodeTiano(stream, "efi")).toThrow();
  });
});

describe("the project's own C decoder reads what encodeTiano writes", () => {
  for (const variant of variants) {
    for (const [name, make] of samples) {
      it.skipIf(!hasReference)(`${name} as ${variant}`, async () => {
        const data = make();

        expectSameBytes(await referenceTianoDecode(encodeTiano(data, variant), variant), data);
      });
    }
  }

  it.skipIf(!hasReference)("reads multi-block streams, which exercise the table re-reading", async () => {
    const data = structured(60000);

    for (const variant of variants) {
      expectSameBytes(await referenceTianoDecode(encodeTiano(data, variant, { blockSymbols: 900 }), variant), data);
    }
  });

  it.skipIf(!hasReference)("agrees with decodeTiano on every sample, both ways", async () => {
    for (const [, make] of samples) {
      const data = make();
      const stream = encodeTiano(data, "efi");
      expectSameBytes(decodeTiano(stream, "efi"), await referenceTianoDecode(stream, "efi"));
    }
  });
});
