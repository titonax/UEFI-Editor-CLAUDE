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
| 3 | EFI/Tiano recompression | Not started |
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
sections are still refused.

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
   firmware tolerates it: if there was room for a section header (4 bytes or
   more) after the section, any non-negative padding is accepted; if there was
   less, the padding must stay less than that. A result that does not fit, or
   that would create padding where there was none, is refused with its own code.
4. The data checksum of the file is repaired, then the file's buffer is
   carried up to its parent the same way, so two nested LZMA levels work.

`verifyRebuiltFirmware` checks every buffer on its own: the same length, every
changed byte explained by an edit, a repaired checksum or a rebuilt section, and
every link: an uncompressed section carries its child unchanged; an LZMA
section decodes to its child, keeps the original's properties and dictionary
size, declares the child's length, and is followed by erased padding.
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
  with other properties is refused.

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
