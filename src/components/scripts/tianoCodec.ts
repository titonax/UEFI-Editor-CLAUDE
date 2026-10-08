// EFI and Tiano compression, as the firmware's own decoder reads it
// (tools/tiano-wasi/Decompress.c, EDK2's Decompress.c): an LZ77 stream with
// canonical Huffman codes, in blocks that each carry three code tables.
//
// Layout of a stream
//   u32 packed size (without this 8-byte header), u32 original size, then bits
//   packed most significant bit first. The decoder pads with zero bits past the
//   end, so the last byte needs no marker.
// Layout of a block
//   16 bits   number of symbols in the block
//   T table   code lengths of the 19 "extra" symbols (5-bit count)
//   C table   code lengths of the 510 character/length symbols, coded with the
//             T table (9-bit count)
//   P table   code lengths of the position symbols (4-bit count for EFI, 5 for
//             Tiano)
//   symbols   a C symbol, then for a match a P symbol and its extra bits
// C symbols 0..255 are literals; 256.. are matches of length symbol - 253 (3 to
// 256). A P symbol v is the distance - 1: v itself for 0 and 1, else v - 1 extra
// bits added to 2^(v-1).
// The two variants differ in the width of the P table's count (4 or 5 bits) and,
// in practice, in the window the encoder uses (2^13 or 2^19).

export type TianoVariant = "efi" | "tiano";

const maxMatch = 256;
const minMatch = 3;
const characterSymbols = 255 + maxMatch + 2 - minMatch; // 510
const extraSymbols = 19;
const positionSymbols = 31;
const maxCodeLength = 16;
const characterCountBits = 9;
const extraCountBits = 5;
const headerBytes = 8;
const defaultBlockSymbols = 32768;
const maxChain = 128;

const variants: Record<TianoVariant, { positionCountBits: number; windowBits: number }> = {
  efi: { positionCountBits: 4, windowBits: 13 },
  tiano: { positionCountBits: 5, windowBits: 19 },
};

// Largest output the project's decoder wrapper (tools/tiano-wasi/main.c) will
// produce; this codec refuses the same, so a header cannot ask for gigabytes.
export const maxTianoOutput = 64 * 1024 * 1024;

// A stream this codec cannot read. `sharedWithReference` says whether the
// project's C decoder rejects the same input at the same point. This decoder
// is stricter than that one in places (an all-zero length table, a block that
// declares no symbols, running past the end of the data), where the C decoder
// goes on and returns bytes: a rejection that is not shared proves nothing
// about what the C decoder would do.
export class TianoDecodeError extends Error {
  readonly sharedWithReference: boolean;

  constructor(message: string, sharedWithReference: boolean) {
    super(message);
    this.name = "TianoDecodeError";
    this.sharedWithReference = sharedWithReference;
  }
}

export interface TianoHeader {
  // Bytes after the header that belong to the stream.
  packedSize: number;
  originalSize: number;
}

export function readTianoHeader(bytes: Uint8Array): TianoHeader | null {
  if (bytes.length < headerBytes) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { packedSize: view.getUint32(0, true), originalSize: view.getUint32(4, true) };
}

// ---------------------------------------------------------------- decoding

class BitReader {
  private position = 0;
  private readonly limit: number;

  constructor(private readonly bytes: Uint8Array) {
    // The decoder pads with zeros past the end, but a stream that keeps asking
    // for more than a few bytes of that is not a stream.
    this.limit = (bytes.length + 8) * 8;
  }

  private byteAt(index: number) {
    return index < this.bytes.length ? this.bytes[index] : 0;
  }

  // Up to 16 bits without consuming them.
  peek(count: number) {
    const index = this.position >>> 3;
    const window = (this.byteAt(index) << 16) | (this.byteAt(index + 1) << 8) | this.byteAt(index + 2);
    return (window >>> (24 - (this.position & 7) - count)) & ((1 << count) - 1);
  }

  skip(count: number) {
    this.position += count;
    if (this.position > this.limit) throw new TianoDecodeError("The compressed data ends before the stream does.", false);
  }

  read(count: number): number {
    if (count > 16) {
      const high = this.read(count - 16);
      return high * 65536 + this.read(16);
    }
    const value = this.peek(count);
    this.skip(count);
    return value;
  }
}

interface CodeDecoder {
  decode(reader: BitReader): number;
}

// A canonical Huffman code over `lengths`. The code must be complete: the
// decoder this mirrors rejects one that leaves codes unused or oversubscribed.
function makeDecoder(lengths: number[]): CodeDecoder {
  const counts = new Array<number>(maxCodeLength + 1).fill(0);
  for (const length of lengths) {
    if (length > maxCodeLength) throw new TianoDecodeError("A code length is longer than 16 bits.", true);
    counts[length]++;
  }
  counts[0] = 0;
  let kraft = 0;
  for (let length = 1; length <= maxCodeLength; length++) kraft += counts[length] * 2 ** (maxCodeLength - length);
  if (kraft !== 2 ** maxCodeLength) {
    // The C decoder only rejects a table whose code space does not add up to a
    // multiple of 2^16; an empty table, for one, it accepts.
    throw new TianoDecodeError("A code table is not a complete prefix code.", kraft % 2 ** maxCodeLength !== 0);
  }
  const first = new Array<number>(maxCodeLength + 1).fill(0);
  const offset = new Array<number>(maxCodeLength + 1).fill(0);
  let code = 0;
  let index = 0;
  for (let length = 1; length <= maxCodeLength; length++) {
    first[length] = code;
    offset[length] = index;
    code = (code + counts[length]) << 1;
    index += counts[length];
  }
  const sorted: number[] = [];
  for (let length = 1; length <= maxCodeLength; length++) {
    for (const [symbol, symbolLength] of lengths.entries()) if (symbolLength === length) sorted.push(symbol);
  }
  return {
    decode(reader) {
      const bits = reader.peek(maxCodeLength);
      for (let length = 1; length <= maxCodeLength; length++) {
        const delta = (bits >>> (maxCodeLength - length)) - first[length];
        if (delta >= 0 && delta < counts[length]) {
          reader.skip(length);
          return sorted[offset[length] + delta];
        }
      }
      throw new TianoDecodeError("The compressed data holds a code that is in no table.", false);
    },
  };
}

// A table with a single symbol uses no bits at all.
function singleSymbol(symbol: number): CodeDecoder {
  return { decode: () => symbol };
}

function readLengthTable(reader: BitReader, symbols: number, countBits: number, special: number): CodeDecoder {
  const count = reader.read(countBits);
  if (count === 0) {
    const symbol = reader.read(countBits);
    if (symbol >= symbols) throw new TianoDecodeError("A single-symbol table names a symbol that does not exist.", false);
    return singleSymbol(symbol);
  }
  const lengths = new Array<number>(Math.max(symbols, positionSymbols)).fill(0);
  let index = 0;
  while (index < count && index < lengths.length) {
    let length = reader.read(3);
    if (length === 7) {
      while (reader.read(1) === 1) {
        length++;
        if (length > maxCodeLength) throw new TianoDecodeError("A code length is longer than 16 bits.", true);
      }
    }
    lengths[index++] = length;
    if (index === special) index += reader.read(2);
  }
  return makeDecoder(lengths.slice(0, symbols));
}

function readCharacterTable(reader: BitReader, extra: CodeDecoder): CodeDecoder {
  const count = reader.read(characterCountBits);
  if (count === 0) {
    const symbol = reader.read(characterCountBits);
    if (symbol >= characterSymbols) throw new TianoDecodeError("A single-symbol table names a symbol that does not exist.", false);
    return singleSymbol(symbol);
  }
  const lengths = new Array<number>(characterSymbols).fill(0);
  let index = 0;
  while (index < count && index < characterSymbols) {
    const symbol = extra.decode(reader);
    if (symbol <= 2) {
      const run = symbol === 0 ? 1 : symbol === 1 ? reader.read(4) + 3 : reader.read(characterCountBits) + 20;
      index += run;
    } else {
      lengths[index++] = symbol - 2;
    }
  }
  return makeDecoder(lengths);
}

export function decodeTiano(stream: Uint8Array, variant: TianoVariant): Uint8Array {
  const header = readTianoHeader(stream);
  if (!header) throw new TianoDecodeError("The stream is shorter than its 8-byte header.", true);
  if (stream.length < header.packedSize + headerBytes) {
    throw new TianoDecodeError("The stream is shorter than its header says (truncated).", true);
  }
  const { originalSize } = header;
  if (originalSize > maxTianoOutput) {
    throw new TianoDecodeError(`The header declares ${String(originalSize)} bytes, more than the ${String(maxTianoOutput)} the decoder produces.`, true);
  }
  const output = new Uint8Array(originalSize);
  if (originalSize === 0) return output;
  const reader = new BitReader(stream.subarray(headerBytes, headerBytes + header.packedSize));
  const { positionCountBits } = variants[variant];
  let position = 0;
  let blockLeft = 0;
  let characters: CodeDecoder | undefined;
  let positions: CodeDecoder | undefined;
  while (position < originalSize) {
    if (blockLeft === 0) {
      blockLeft = reader.read(16);
      if (blockLeft === 0) throw new TianoDecodeError("A block declares no symbols.", false);
      const extra = readLengthTable(reader, extraSymbols, extraCountBits, 3);
      characters = readCharacterTable(reader, extra);
      positions = readLengthTable(reader, positionSymbols, positionCountBits, -1);
    }
    blockLeft--;
    if (!characters || !positions) throw new TianoDecodeError("A block has no tables.", false);
    const symbol = characters.decode(reader);
    if (symbol < 256) {
      output[position++] = symbol;
      continue;
    }
    const length = symbol - (255 + 1 - minMatch);
    const positionSymbol = positions.decode(reader);
    const back = positionSymbol > 1 ? 2 ** (positionSymbol - 1) + reader.read(positionSymbol - 1) : positionSymbol;
    let source = position - back - 1;
    if (source < 0) throw new TianoDecodeError("A match points before the start of the data.", true);
    for (let copied = 0; copied < length && position < originalSize; copied++) output[position++] = output[source++];
  }
  return output;
}

// ---------------------------------------------------------------- encoding

class BitWriter {
  private readonly bytes: number[] = [];
  private current = 0;
  private used = 0;

  put(count: number, value: number) {
    for (let remaining = count; remaining > 0; ) {
      const take = Math.min(remaining, 8 - this.used);
      const chunk = Math.floor(value / 2 ** (remaining - take)) % 2 ** take;
      this.current = (this.current << take) | chunk;
      this.used += take;
      remaining -= take;
      if (this.used === 8) {
        this.bytes.push(this.current);
        this.current = 0;
        this.used = 0;
      }
    }
  }

  finish() {
    if (this.used > 0) this.bytes.push((this.current << (8 - this.used)) & 0xff);
    return Uint8Array.from(this.bytes);
  }
}

// Huffman code lengths for `frequencies` (zero means unused), none above the
// limit. The construction is deterministic: ties break by symbol order. Too deep
// a tree flattens the frequencies and tries again, which keeps the code a
// complete prefix code.
function codeLengths(frequencies: number[]): number[] {
  let weights = frequencies.slice();
  for (;;) {
    const lengths = new Array<number>(weights.length).fill(0);
    const leaves = weights
      .map((weight, symbol) => ({ weight, symbol }))
      .filter((leaf) => leaf.weight > 0)
      .sort((left, right) => left.weight - right.weight || left.symbol - right.symbol);
    interface Node { weight: number; symbol: number; left?: Node; right?: Node }
    const queue: Node[] = [];
    let leafIndex = 0;
    let queueIndex = 0;
    const pop = (): Node => {
      const leaf = leafIndex < leaves.length ? leaves[leafIndex] : undefined;
      const node = queueIndex < queue.length ? queue[queueIndex] : undefined;
      if (leaf && (!node || leaf.weight <= node.weight)) {
        leafIndex++;
        return { weight: leaf.weight, symbol: leaf.symbol };
      }
      if (!node) throw new Error("The Huffman construction ran out of nodes.");
      queueIndex++;
      return node;
    };
    for (let remaining = leaves.length; remaining > 1; remaining--) {
      const left = pop();
      const right = pop();
      queue.push({ weight: left.weight + right.weight, symbol: -1, left, right });
    }
    const root = queue.length > 0 ? queue[queue.length - 1] : undefined;
    let deepest = 0;
    const stack: { node: Node; depth: number }[] = root ? [{ node: root, depth: 0 }] : [];
    for (let item = stack.pop(); item; item = stack.pop()) {
      if (item.node.left && item.node.right) {
        stack.push({ node: item.node.left, depth: item.depth + 1 }, { node: item.node.right, depth: item.depth + 1 });
      } else {
        lengths[item.node.symbol] = item.depth;
        deepest = Math.max(deepest, item.depth);
      }
    }
    if (deepest <= maxCodeLength) return lengths;
    weights = weights.map((weight) => (weight > 0 ? Math.max(1, weight >> 1) : 0));
  }
}

// Canonical codes for the lengths: shorter codes first, equal lengths in symbol
// order, which is how the decoder builds its table.
function canonicalCodes(lengths: number[]): number[] {
  const codes = new Array<number>(lengths.length).fill(0);
  let code = 0;
  for (let length = 1; length <= maxCodeLength; length++) {
    for (const [symbol, symbolLength] of lengths.entries()) {
      if (symbolLength === length) codes[symbol] = code++;
    }
    code <<= 1;
  }
  return codes;
}

function usedSymbols(frequencies: number[]) {
  return frequencies.filter((weight) => weight > 0).length;
}

function lastUsed(lengths: number[]) {
  let last = -1;
  for (const [index, length] of lengths.entries()) if (length > 0) last = index;
  return last;
}

// A table of code lengths for the T and P sets. With one symbol (or none) the
// format has a form that spends no bits on the symbols themselves.
function writeLengthTable(
  writer: BitWriter,
  lengths: number[],
  frequencies: number[],
  countBits: number,
  special: number,
) {
  if (usedSymbols(frequencies) <= 1) {
    writer.put(countBits, 0);
    writer.put(countBits, Math.max(0, frequencies.findIndex((weight) => weight > 0)));
    return;
  }
  const count = lastUsed(lengths) + 1;
  writer.put(countBits, count);
  let index = 0;
  while (index < count) {
    const length = lengths[index++];
    if (length < 7) {
      writer.put(3, length);
    } else {
      writer.put(3, 7);
      for (let extra = 7; extra < length; extra++) writer.put(1, 1);
      writer.put(1, 0);
    }
    if (index === special) {
      let zeros = 0;
      while (zeros < 3 && index + zeros < count && lengths[index + zeros] === 0) zeros++;
      writer.put(2, zeros);
      index += zeros;
    }
  }
}

interface Token {
  symbol: number;
  // Distance - 1 for a match, -1 for a literal.
  back: number;
}

function hashAt(data: Uint8Array, index: number) {
  return Math.imul((data[index] << 16) | (data[index + 1] << 8) | data[index + 2], 2654435761) >>> 16;
}

// Greedy parse with one step of lazy matching.
function parse(data: Uint8Array, windowBits: number): Token[] {
  const length = data.length;
  const windowSize = 2 ** windowBits;
  const head = new Int32Array(1 << 16).fill(-1);
  const previous = new Int32Array(length).fill(-1);
  const tokens: Token[] = [];
  const insert = (index: number) => {
    if (index + 2 >= length) return;
    const hash = hashAt(data, index);
    previous[index] = head[hash];
    head[hash] = index;
  };
  const longest = (index: number) => {
    let bestLength = 0;
    let bestDistance = 0;
    if (index + minMatch > length) return { length: 0, distance: 0 };
    const limit = Math.min(maxMatch, length - index);
    let candidate = head[hashAt(data, index)];
    for (let steps = 0; candidate >= 0 && steps < maxChain; steps++) {
      const distance = index - candidate;
      if (distance > windowSize) break;
      if (data[candidate + bestLength] === data[index + bestLength]) {
        let matched = 0;
        while (matched < limit && data[candidate + matched] === data[index + matched]) matched++;
        if (matched > bestLength) {
          bestLength = matched;
          bestDistance = distance;
          if (matched === limit) break;
        }
      }
      candidate = previous[candidate];
    }
    return bestLength >= minMatch ? { length: bestLength, distance: bestDistance } : { length: 0, distance: 0 };
  };
  let index = 0;
  while (index < length) {
    const match = longest(index);
    insert(index);
    if (match.length === 0) {
      tokens.push({ symbol: data[index], back: -1 });
      index++;
      continue;
    }
    if (match.length < maxMatch && index + 1 < length && longest(index + 1).length > match.length) {
      tokens.push({ symbol: data[index], back: -1 });
      index++;
      continue;
    }
    tokens.push({ symbol: match.length + (255 + 1 - minMatch), back: match.distance - 1 });
    for (let step = 1; step < match.length; step++) insert(index + step);
    index += match.length;
  }
  return tokens;
}

function positionSymbolOf(back: number) {
  if (back <= 1) return back;
  return Math.floor(Math.log2(back)) + 1;
}

export interface TianoEncodeOptions {
  // Most symbols in one block (at most 65535).
  blockSymbols?: number;
}

export function encodeTiano(data: Uint8Array, variant: TianoVariant, options: TianoEncodeOptions = {}): Uint8Array {
  if (data.length === 0) throw new Error("There is nothing to compress: the data is empty.");
  if (data.length > maxTianoOutput) {
    throw new Error(`The data is ${String(data.length)} bytes; the decoder produces at most ${String(maxTianoOutput)}.`);
  }
  const requested = options.blockSymbols ?? defaultBlockSymbols;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`blockSymbols must be a whole number of at least 1, not ${String(requested)}.`);
  }
  const blockSymbols = Math.min(65535, requested);
  const { positionCountBits, windowBits } = variants[variant];
  const tokens = parse(data, windowBits);
  const writer = new BitWriter();
  for (let start = 0; start < tokens.length; start += blockSymbols) {
    const block = tokens.slice(start, start + blockSymbols);
    const characterFrequencies = new Array<number>(characterSymbols).fill(0);
    const positionFrequencies = new Array<number>(positionSymbols).fill(0);
    for (const token of block) {
      characterFrequencies[token.symbol]++;
      if (token.back >= 0) positionFrequencies[positionSymbolOf(token.back)]++;
    }
    const characterLengths = usedSymbols(characterFrequencies) > 1 ? codeLengths(characterFrequencies) : [];
    const positionLengths = usedSymbols(positionFrequencies) > 1 ? codeLengths(positionFrequencies) : [];

    writer.put(16, block.length);

    // The C table is written with the T alphabet: runs of zero lengths and the
    // lengths themselves.
    const extraSequence: { symbol: number; bits: number; value: number }[] = [];
    const extraFrequencies = new Array<number>(extraSymbols).fill(0);
    let characterCount = 0;
    if (characterLengths.length > 0) {
      characterCount = lastUsed(characterLengths) + 1;
      for (let index = 0; index < characterCount; ) {
        if (characterLengths[index] !== 0) {
          extraSequence.push({ symbol: characterLengths[index] + 2, bits: 0, value: 0 });
          index++;
          continue;
        }
        let run = 0;
        while (index + run < characterCount && characterLengths[index + run] === 0) run++;
        index += run;
        while (run > 0) {
          if (run >= 20) {
            const take = Math.min(run, 20 + 511);
            extraSequence.push({ symbol: 2, bits: characterCountBits, value: take - 20 });
            run -= take;
          } else if (run >= 3) {
            const take = Math.min(run, 18);
            extraSequence.push({ symbol: 1, bits: 4, value: take - 3 });
            run -= take;
          } else {
            extraSequence.push({ symbol: 0, bits: 0, value: 0 });
            run--;
          }
        }
      }
      for (const item of extraSequence) extraFrequencies[item.symbol]++;
    }
    const extraLengths = usedSymbols(extraFrequencies) > 1 ? codeLengths(extraFrequencies) : [];
    writeLengthTable(writer, extraLengths, extraFrequencies, extraCountBits, 3);

    if (characterLengths.length === 0) {
      writer.put(characterCountBits, 0);
      writer.put(characterCountBits, Math.max(0, characterFrequencies.findIndex((weight) => weight > 0)));
    } else {
      writer.put(characterCountBits, characterCount);
      const extraCodes = canonicalCodes(extraLengths);
      for (const item of extraSequence) {
        // A lone T symbol costs no bits.
        if (extraLengths.length > 0) writer.put(extraLengths[item.symbol], extraCodes[item.symbol]);
        if (item.bits > 0) writer.put(item.bits, item.value);
      }
    }
    writeLengthTable(writer, positionLengths, positionFrequencies, positionCountBits, -1);

    const characterCodes = canonicalCodes(characterLengths);
    const positionCodes = canonicalCodes(positionLengths);
    for (const token of block) {
      if (characterLengths.length > 0) writer.put(characterLengths[token.symbol], characterCodes[token.symbol]);
      if (token.back < 0) continue;
      const positionSymbol = positionSymbolOf(token.back);
      if (positionLengths.length > 0) writer.put(positionLengths[positionSymbol], positionCodes[positionSymbol]);
      if (positionSymbol > 1) writer.put(positionSymbol - 1, token.back - 2 ** (positionSymbol - 1));
    }
  }
  const body = writer.finish();
  const stream = new Uint8Array(headerBytes + body.length);
  const view = new DataView(stream.buffer);
  view.setUint32(0, body.length, true);
  view.setUint32(4, data.length, true);
  stream.set(body, headerBytes);
  return stream;
}
