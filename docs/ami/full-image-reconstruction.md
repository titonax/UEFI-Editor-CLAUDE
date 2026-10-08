# Full-image reconstruction

Analysing an image and writing one are separate capabilities. A parsed Setup
tree is not proof that a modified firmware image can be rebuilt safely, so
full-image output stays disabled in the app until every layer between an edited
artifact and the source image can be rebuilt and checked. This page records the
stages and what each one guarantees.

| Stage | Scope | Status |
| --- | --- | --- |
| 1 | Same-size edits on a path where every encapsulation is uncompressed | Built, tested on synthetic images, **not connected to the export** |
| 2 | LZMA recompression that fits the original allocation | Not started |
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
   FFS file there is repaired too, deepest first. Nothing changes length, so no
   section, file or volume header moves, and the volume header checksum is not
   affected.
4. For a complete Intel SPI image the descriptor is read (`flashDescriptor.ts`)
   and only bytes inside the BIOS region may change. A descriptor whose region
   cannot be read refuses the rebuild instead of assuming one.
5. The result is checked against the source (`verifyRebuiltFirmware`): same
   size, every changed byte explained by an edit or a repaired checksum, every
   replacement in place, every repaired file consistent. Any problem refuses the
   rebuild.

`verifyByReextraction` is the independent half: it reads the rebuilt image back
with the real extractor and requires every artifact to be the source's artifact
with the requested edits applied, at the same place.

With no edits the rebuilt image is the source image, byte for byte.

### What a file checksum repair does

An FFS header sums to zero with its file-checksum and state bytes counted as
zero. A same-size edit never changes the header, so only the data checksum can
move, and only for a file with the checksum attribute set (otherwise the byte
is the fixed 0xAA). A source file whose own checksums were already wrong, or
that carries a tail, is refused: the rebuild does not correct what it was not
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
