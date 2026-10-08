# Full-image reconstruction

Analysing an image and writing one are separate capabilities. A parsed Setup
tree is not proof that a modified firmware image can be rebuilt safely, so
full-image output stays disabled in the app until every layer between an edited
artifact and the source image can be rebuilt and checked. This page records the
stages and what each one guarantees.

| Stage | Scope | Status |
| --- | --- | --- |
| 1 | Same-size edits on a path where every encapsulation is uncompressed | Built, tested on synthetic images, **not connected to the export** |
| 2 | LZMA recompression that fits inside the original file | Built with LZMA-JS, tested on synthetic images, **not connected to the export** |
| 3 | EFI/Tiano recompression that fits inside the original file | Built (`tianoCodec.ts`, written here), tested on synthetic images and against the project's own C decoder, **not connected to the export** |
| 4 | Export in the UI: "Check firmware output", download, `changelog.txt` | Not started |

## Stage 1: `firmwareRebuild.ts`

`rebuildFirmware(graph, edits)` takes the provenance graph the extractor
produced and a list of `ArtifactEdit`s: an artifact, an offset inside its
payload, the bytes expected there and the replacement of the same length.

1. Every edit is checked: the artifact exists, the replacement has the same
   length, the range is inside the payload, the expected bytes are what the
   image holds, and no two edits overlap.
2. Each edited artifact is walked back to the source image. Every section on
   the way must be uncompressed and a plain pass-through: a Compression
   Section with type none, a Disposable Section, or a GUID-defined section with
   no data of its own and no attributes. A GUID-defined section that carries
   data (a CRC32, a signature) is refused, because that data may depend on the
   payload.
3. The edited bytes are written into a copy of the artifact's buffer, the data
   checksum of the FFS file that holds them is repaired (`ffsIntegrity.ts`),
   the buffer is copied into its parent through the section, and the owning
   FFS file there is repaired too, deepest first. The payload may sit directly
   in its file, behind a wrapper section of that file, or in a volume nested
   inside another file; every FFS file on the path is repaired. A section that
   is directly in the image with no FFS file around it is refused. Nothing changes length, so no
   section, file or volume header moves, and the volume header checksum is not
   affected.
4. For a complete Intel SPI image the descriptor is read (`flashDescriptor.ts`)
   and only bytes inside the BIOS region may change. A descriptor whose region
   cannot be read refuses the rebuild instead of assuming one. The signature is
   looked for at offset 0x10, like the preflight does; one found at offset 0 is
   refused as a layout nothing here understands. Whether real dumps ever differ
   from that has not been checked against a real SPI image.
5. The result is checked against the source (`verifyRebuiltFirmware`): same
   size, every changed byte explained by an edit or a repaired checksum, every
   replacement in place, every repaired file consistent. Any problem refuses the
   rebuild.

`verifyRebuiltFirmware` does not take the rebuild's own list of repaired files on
trust: it works out from the graph which FFS files the edits depend on and
requires each to be consistent in the output (and to have been repaired).

`verifyByReextraction` is the independent half: it reads the rebuilt image back
with the real extractor and requires every artifact to be the source's artifact
with the requested edits applied, at the same place.

With no edits the rebuilt image is the source image, byte for byte.

## Stage 2: LZMA sections

`rebuildFirmware(graph, edits, { codecs: { lzma } })` also goes through LZMA
sections (a Compression Section of type LZMA, or a GUID-defined section with the
LZMA GUID). Without a codec such a section is refused, as before. EFI/Tiano
sections are covered by stage 3.

Edits keep their size, so the decoded buffer keeps its length; what changes is
the packed stream. For each LZMA section on the path, deepest first:

1. The buffer is re-encoded (`lzmaSection.ts`). The original's header is read
   first and the re-encode **refuses** unless it can reproduce it: the same
   properties byte (this encoder only writes `0x5D`, lc=3 lp=0 pb=2), a declared
   size equal to the data's length (a stream that relies on an end marker is
   refused) and a dictionary no larger than the original's. The stream is written
   with no end marker, the way EDK2's `LzmaCompress` writes it, and its header
   declares the original's dictionary size. The result must decode back to the
   data with the codec's own decoder.
2. The section may change size only if it is **the last section of its FFS
   file and everything after it in the file is erased padding (0xFF)**. The
   file keeps its size, so no file header moves; the section's size field is
   updated and the bytes after the new end are filled with 0xFF.
3. The padding may change length only where the source already shows the
   firmware tolerates it. It is measured from where the next section would
   start (the next 4-byte boundary): if there was room for a section header (4
   bytes or more) after the section, any non-negative padding is accepted; if
   there was less, the padding must stay less than that. A result that does not
   fit, or that would create padding where there was none, is refused with its
   own code. The padding must be 0xFF; a volume that erases to 0x00 is refused
   rather than handled.
4. The data checksum of the file is repaired, then the file's buffer is
   carried up to its parent the same way, so two nested LZMA levels work.

`verifyRebuiltFirmware` checks every buffer on its own: the same length, every
changed byte explained by an edit, a repaired checksum or a rebuilt section, and
every link: an uncompressed section carries its child unchanged; an LZMA
section decodes to its child, keeps the original's properties and dictionary
size, declares the child's length, is followed by erased padding and is exactly
what the encoder writes for that child (so bytes the decoder never reads, such as
garbage after the end of the data, cannot hide). Only a section's size field,
payload and padding may differ from the source: any other byte of its header is
unexplained. What the rebuild reports about itself (the buffers, the changed
bytes and ranges, the layout changes) is checked against the bytes too.

An edit that changes nothing leaves the image byte for byte as it was: a stream
the vendor wrote is only rewritten when something below it really changed.

The encoder is LZMA-JS (`lzma`, MIT), imported from its engine file rather than
its Node-only entry point so that it bundles for a browser. It is synchronous,
and encoding, the round-trip decode and the verification decodes can take long
on a large image: the app must run it in a worker (stage 4).
`verifyByReextraction` accepts the decompressor to read the image back with; in
the app that is the project's WebAssembly decoder, which shares no code with
the encoder. The tests also decode with `xz` when it is installed.

### What this stage does not prove

- Whether the **platform's own LZMA decoder** accepts the re-encoded stream.
  The stream is valid LZMA with the original's properties and declared size, but
  it is not byte-identical to what the vendor's tool wrote, and nobody here has
  run it on a real board. Only a flash test settles that.
- That the padding rule matches how a given firmware parses a file's tail. It
  rests on the source already containing such padding.
- LZMA-JS fixes the properties and chooses its own dictionary, so an image built
  with other properties is refused, and so is one declaring a dictionary above
  what its decoder can check (about 100 MB).
- A vendor stream that carries both a declared size and an end marker is
  re-encoded with the size and no marker. Decoders that stop at the declared
  size read both, but that is again something only a board can confirm.

### What a file checksum repair does

An FFS header sums to zero with its file-checksum and state bytes counted as
zero. A same-size edit never changes the header, so only the data checksum can
move, and only for a file with the checksum attribute set (otherwise the byte
is the fixed 0xAA, which is checked in the source too). A source file whose own
checksums were already wrong, or that carries a tail, is refused: the rebuild does not correct what it was not
asked to touch. When the edit changes the data sum by exactly what an inner
checksum byte compensates (an uncompressed volume inside a file), the outer
checksum legitimately does not change.

### Refusals

Every refusal is typed (`RebuildRefusalCode`) and explained:
`artifact-missing`, `edit-out-of-range`, `size-change`, `precondition-mismatch`,
`overlapping-edits`, `incomplete-path`, `compressed-section`,
`unsupported-section`, `source-file-elsewhere`, `conflicting-edit`,
`invalid-file-header`, `invalid-file-checksum`, `unsupported-file-attributes`,
`descriptor-invalid`, `outside-bios-region`, `verification-failed`. All of them
are reported together, not just the first.

### What this does not prove

A rebuilt image proves the PI structure survived. It does not prove the
firmware will boot: vendor signatures, ME and Boot Guard measurements are not
known to this code, and only a physical flash tests those. The tests use
synthetic images with valid checksums; no firmware is committed. A real image
has to be rebuilt and read back by the maintainer before any claim is made
about it.

### Open design point

Writing is meant to be enabled by what the rebuild proves about the image in
hand (the checks above), not by which board or SHA-256 the image is: a recorded
case or vendor family never selects a code path.

## Stage 3: EFI/Tiano sections

`rebuildFirmware` also goes through EFI/Tiano sections (a Compression Section of
type 1, or a GUID-defined section with the Tiano GUID). The codec is written in
this repository (`tianoCodec.ts`) because no maintained JavaScript one exists,
and is used unless `codecs.tiano` supplies another. The size and padding rules
are exactly those of stage 2: the section may change size only if it is the last
one in its FFS file and the bytes after it are erased padding, the file keeps its
size, and padding may change length only where the source shows it is tolerated.
The refusal codes for those rules are shared (`compressed-does-not-fit`,
`compressed-padding-change`, `section-not-terminal`).

### The format

A stream is an 8-byte header (packed size without the header, original size)
then blocks of Huffman-coded symbols: a literal/length table, an extra-length
table and a position table, each coded as a set of code lengths. There are two
variants, **EFI** (position symbols of 4 bits, a window of 2^13 bytes) and
**Tiano** (5 bits, 2^19 bytes). Both are read by the C decoder in
`tools/tiano-wasi`, which the app builds to WebAssembly; the codec follows that
code, not a description of it.

### How the variant is chosen

It is not assumed from the section type. The original stream is decoded with
both variants (`tianoSection.ts`) and the variant that reads it back to exactly
the bytes the image holds is the one the firmware uses. If neither does (the
codec cannot read the vendor's stream) or both do, the rebuild **refuses**
(`tiano-recompression`) instead of guessing. It also refuses an original with
bytes after its packed data, since they would move or be lost, and one whose
header size differs from the decoded length.

### What the encoder writes

A greedy-with-one-step-lookahead LZ77 over a hash chain of 3-byte prefixes
(chain limit 128), blocks of up to 32768 symbols, a Huffman code per block
limited to the 16 bits and the alphabets the decoder accepts, and the code
tables in the form the decoder reads. It is deterministic. It does not match
the compression ratio or the exact bytes of Intel's `TianoCompress`, so a
rebuilt stream is **not** the vendor's: that is why a section nothing changed
below is left untouched and the verification demands the encoder's own canonical
form for a rewritten one.

### Verification

`verifyRebuiltFirmware` adds, per EFI/Tiano link, to the shared checks (erased
padding, size field, only the size field, payload and padding changed): the
header's packed and original sizes match the stream and the child; the stream
decodes, in the variant of the stream it replaces, to the child; it is exactly
the encoder's output for that child; and, because the project's extractor tries
the Tiano decoder first and keeps the first that parses, an EFI stream is
checked not to be read by the Tiano decoder as other bytes.

### What this stage does not prove

- Whether the **platform's own decoder** accepts the stream. The codec is
  validated against the C decoder in `tools/tiano-wasi` (the tests compile it
  with `gcc` when present and are skipped, visibly, when not), which is the same
  source the app runs and the EDK2 reference the format comes from. Firmware
  builds can carry older or modified decoders; only a flash test settles that.
- That a vendor's stream the codec cannot read (a different table layout, an
  unusual block) is rare. It is refused, not rebuilt.
- Anything in the section or file headers the firmware computes from the
  compressed bytes beyond the sizes and the FFS data checksum.
