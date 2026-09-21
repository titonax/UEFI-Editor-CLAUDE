import { LhaReader, Uint8ArrayReader, Uint8ArrayWriter } from "@kirinsaninc/lhats";

// Phoenix FFV modules store their compressed body as a bare -lh5- stream -
// the LZSS+adaptive-Huffman payload only, with none of the surrounding LHA
// archive header @kirinsaninc/lhats expects. That header carries nothing an
// -lh5- decoder itself needs beyond the method id and the two size fields,
// so a minimal synthetic one (verified byte-for-byte against real Phoenix
// STRINGS0.ROM/TEMPLAT0.ROM payloads via an independent LH5 decoder) is
// enough to hand the real compressed bytes to a well-tested reader instead
// of reimplementing the bitstream format from scratch.
function buildSyntheticLhaArchive(compressed: Uint8Array, unpackedSize: number) {
  const method = new TextEncoder().encode("-lh5-");
  const filename = new TextEncoder().encode("payload.bin");
  const body = new Uint8Array(5 + 4 + 4 + 2 + 2 + 1 + 1 + 1 + filename.length + 2);
  const view = new DataView(body.buffer);
  let offset = 0;
  body.set(method, offset);
  offset += method.length;
  view.setUint32(offset, compressed.length, true);
  offset += 4;
  view.setUint32(offset, unpackedSize, true);
  offset += 4;
  offset += 2; // time (unused)
  view.setUint16(offset, 0x21, true); // a valid-looking MS-DOS date
  offset += 2;
  body[offset] = 0x20; // attribute
  offset += 1;
  body[offset] = 0x00; // header level 0
  offset += 1;
  body[offset] = filename.length;
  offset += 1;
  body.set(filename, offset);
  offset += filename.length;
  // CRC16 of the uncompressed data is unknown until it's decompressed;
  // checkCrc: "warn" below means a placeholder here never blocks the read.
  view.setUint16(offset, 0, true);

  let checksum = 0;
  for (const byte of body) checksum = (checksum + byte) & 0xff;
  const archive = new Uint8Array(2 + body.length + compressed.length);
  archive[0] = body.length;
  archive[1] = checksum;
  archive.set(body, 2);
  archive.set(compressed, 2 + body.length);
  return archive;
}

// Decompresses a raw Phoenix FFV -lh5- module body (LZSS with an 8 KiB
// window + adaptive Huffman coding - the same scheme classic .lzh archives
// use). Never used for anything AMI Aptio parses or edits.
export async function decompressPhoenixLh5(
  compressed: Uint8Array,
  unpackedSize: number,
): Promise<Uint8Array> {
  const archive = buildSyntheticLhaArchive(compressed, unpackedSize);
  const reader = new LhaReader(new Uint8ArrayReader(archive), { checkCrc: "warn" });
  try {
    const entries = await reader.getEntries();
    if (entries.length === 0) throw new Error("LH5 decompression produced no output.");
    return await entries[0].getData(new Uint8ArrayWriter());
  } finally {
    await reader.close();
  }
}
