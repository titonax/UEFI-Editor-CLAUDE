# `src/components/scripts`

The non-UI core: parsing the IFR text dump, classifying visibility, and
patching the binary firmware files. Each module has a matching
`*.test.ts` file next to it.

| Module | Responsibility |
| --- | --- |
| `ifrParser.ts` | Parses the IFRExtractor-RS text dump into `Data` (FormSets, forms, prompts, VarStores, suppressions) and discovers the top-level menu: AMITSE table entries (only a Form with that FormId inside that very FormSet counts), the SetupData page list, or the HII FormSet roots as a last resort. A SetupData root takes the offset of the AMITSE entry for its FormSet: the only one when the FormSet is registered once, otherwise the single entry for the root's own FormId, and no offset when that is ambiguous (an export must not overwrite another page's slot). `parseData()` is the entry point; `parseSetupTxt()` runs the line-by-line scan via one handler function per opcode kind (`handleFormLine`, `handleConditionLine`, etc.), all mutating a shared `ParserState`. |
| `singleFormSetNavigation.ts` | Detects the single-FormSet layout where the entry Form is an IFR navigation hub whose direct Refs are the tabs (`inspectSingleFormSetNavigation`), makes that hub the only menu root (`singleFormSetHubMenu`), and rebuilds the tab inventory from the current graph after a move, a visibility toggle, or a `data.json` import (`refreshSingleFormSetNavigation`), preserving each still-present page's known relative order (`preserveKnownPageOrder`) so one change doesn't reshuffle the rest. A registered page reachable only through a Ref parked in a constant-true `SuppressIf` scope is reported as role `suppressed-tab`, one Show away from being a direct tab again. AMITSE registration is carried as evidence, never as promotion. |
| `setupDataFlags.ts` | Decodes which bits of the SetupData control flag byte ("Access Level") are set, for the field's tooltip. Purely informational: across 14 reference images no bit correlates with whether an item is actually hidden, so nothing here drives visibility. Evidence in `docs/ami/setupdata-control-flags.md`. |
| `setupData.ts` | The AMI SetupData "question metadata" record model: `indexSetupData()` decodes the region once and keys every 54-byte window by its anchor bytes, and `getAdditionalData()` resolves one question's page id, access level and failsafe/optimal bytes (and their offsets) from that index - exactly one record must match. |
| `expressionFormatter.ts` | Turns a raw IFR condition expression (`EqIdVal QuestionId: 0x1, Value: 0x1`) into the human-readable form shown in the UI (`0x1 == 0x1`). |
| `visibility.ts` | Given a parsed `Data`, computes a child's effective visibility (visible/hidden/conditional/orphaned/broken) and summarizes a whole form branch, used by `FormUi`. |
| `refMoving.ts` | Which Ref may move to another Form: only one that owns its outermost hide condition alone (`isSoleOwnerOfCondition`), and where its movable block starts (`movableBlockStart`: the Ref itself, or the whole SuppressIf/GrayOutIf/DisableIf wrapper it is the sole occupant of). The destination verdicts themselves live in `../Navigation/relocating.ts`. |
| `hiiPackages.ts` | Binary discovery of HII Forms Packages inside a Setup buffer - package lists, bare packages, and the opcode-stream check that keeps a stray `0x02` byte from being mistaken for one. Feeds the preflight layout profile and the cross-package move rules. |
| `binaryPatcher.ts` | `downloadModifiedFiles()`: applies the user's edits as byte-level patches to `Setup.sct`, `AmiTseSct.sct`, and `SetupData`, working on `Uint8Array`s (never full-file string copies). Ref moves are detected by comparing each Ref's current Form with where it pristinely lived, applied as an in-place byte rotation with a composed offset remap, and rebalance the Forms Package (and package list) lengths when they cross packages; pending root-visibility plans refuse the export. A Ref parked by the single-FormSet tab visibility toggle (`RefPrompt.hiddenByTabToggle`) always moves as the bare opcode alone, landing right before the reused `SuppressIf` scope's own End rather than at its destination Form's end (`destinationOffsetOverride`, also used to land a shown Ref back next to its previous neighbor instead of always at the end). Also owns `validateByteInput()` for the access-level/failsafe/optimal text fields. Every offset is checked against the file before it is read or written (typed arrays silently ignore out-of-range writes), `hexToBytes()` refuses odd-length or non-hex text, and a blank SetupData field means "leave it as it is" without blocking the fields that have a value. |
| `dataValidation.ts` | `parseDataFile()`: structural validation of a re-uploaded `data.json` (every field, every enum, every offset shape) before the hash/checksum checks and before anything is applied. |
| `hashing.ts` | SHA-256 helpers, including the checksum used to verify a re-uploaded `data.json` still matches the firmware files it was exported from. `sha256Hex()` races `crypto.subtle.digest()` against a 15s timeout, since some browser extensions intercept Web Crypto and can leave it permanently unresolved. |
| `hexId.ts` | `parseHexId`/`sameHexId`/`normalizedHexId`/`sameGuidOrBothUndefined` - formId/questionId/varStoreId values are always `"0x..."` hex strings and GUIDs compare case-insensitively; every comparison in the codebase goes through here instead of a bare `parseInt`. |
| `hexWorker.ts` | Web Worker that turns an uploaded file into the uppercase hex string the rest of the app carries firmware bytes around as. |
| `amiFirmwareImage.ts` | Read-only inspection of a complete image for the preflight report: container kind, firmware volumes, the Setup/AMITSE/SetupData FFS files, the Setup HII layout profile (`inspectAmiSetupProfile`) and the Aptio IV/V evidence (`reconcileAmiGeneration`), which never turns shared structures into proof of a generation. |
| `firmwareSections.ts` | Walks PI sections (compression, GUID-defined LZMA/Tiano, disposable, freeform, PE32) so inspection and extraction traverse the same encapsulations. |
| `firmwareProvenance.ts` | The provenance graph of every buffer the extractor produced - parent edges, encapsulation path, owning FFS file, artifact locations - and `assessFirmwareReconstruction()`, which lists why full-image writing is still disabled. |
| `aptioIvExtractor.ts` | Full-image extraction: locates firmware volumes/files, recursively decompresses (LZMA/Tiano WASM), and extracts the Setup/AMITSE/SetupData sections plus the IFR text dump, keeping the provenance graph above. Runs inside `aptioIvExtractorWorker.ts`, not on the main thread - the WASM decompression + IFRExtractor-RS run are synchronous and CPU-bound. |
| `firmwareRebuild.ts` | Full-image rebuild, stages 1 to 3 (see `docs/ami/full-image-reconstruction.md`): `rebuildFirmware()` applies same-size `ArtifactEdit`s on a path of uncompressed sections, of LZMA sections when an LZMA codec is supplied, and of EFI/Tiano sections with the built-in codec (a compressed section may resize only inside its file; an LZMA section whose file it filled may end earlier and leave erased padding when the volume declares 0xFF erasure), repairs the FFS data checksums on the way, keeps a complete SPI image inside its BIOS region and returns typed refusals; `verifyRebuiltFirmware()` and `verifyByReextraction()` check the result against the source and by reading it back with the extractor. Used by `fullImageExport.ts`. |
| `ffsIntegrity.ts` | FFS file header and data checksums: validity, and the repair of the data checksum after a same-size edit (it refuses a file that was already inconsistent). |
| `flashDescriptor.ts` | The BIOS region an Intel flash descriptor declares (`biosRegionOf`): none, a region, or invalid with the reason. |
| `firmwareImageFixtures.ts` | Synthetic firmware volumes, FFS files and PI sections with valid checksums, and a minimal SPI image, for the rebuild tests. Not itself a test file. |
| `lzmaSection.ts` | LZMA streams as the firmware stores them: `readLzmaHeader()` and `reencodeLzma()`, which re-encodes edited data with the original's properties, a declared size and no end marker and a dictionary no larger than the original's, and refuses anything it cannot reproduce or read back. The codec is a `LzmaCodec`. |
| `lzmaJs.ts` | The `LzmaCodec` backed by the `lzma` package (LZMA-JS), imported from its engine file so it bundles for a browser: fixed properties 0x5D, no end marker (the library's shared flag is put back after each call), and a decoder that never lets the library's string-or-bytes return corrupt binary data. |
| `fullImageExport.ts` | Stage 4: `changesFromPlan()` (the applied plan as per-file changes, via `computeModifiedFiles()`), `planArtifactEdits()` and `checkFullImageOutput()`, which rebuilds, reads the image back with the injected decompressor and returns the image, its `changelog.txt` and SHA-256s, or why not. Run in a worker by `fullImageCheckWorker.ts` / `fullImageCheckClient.ts`; the dialog is `FullImageExport/FullImageExportDialog.tsx`. |
| `tianoCodec.ts` | The EFI/Tiano compressor and decompressor (`encodeTiano()`, `decodeTiano()`, `readTianoHeader()`), both variants, written against `tools/tiano-wasi/Decompress.c`. Throws a typed message on a stream it cannot read. |
| `tianoSection.ts` | EFI/Tiano streams as sections hold them: `reencodeTiano()` picks the variant that reads the original back to the image's bytes (refusing if none or both), and `tianoStreamProblems()` is the independent check of a rebuilt stream. |
| `referenceTiano.ts` | Test helper: compiles `tools/tiano-wasi` with `gcc` and decodes with it, sharing no code with the encoder; says whether `gcc` is available so the tests that need it are reported as skipped. |
| `referenceLzma.ts` | Test helper: decodes an LZMA stream with `xz`, which shares no code with the encoder, and says whether `xz` is installed so the tests that need it are reported as skipped instead of passing with nothing checked. |
| `aptioIvExtractorWorker.ts` / `aptioIvExtractorClient.ts` | The Web Worker wrapping `extractAptioIvArtifacts()`, and `extractFirmwareInWorker()`, which `BiosImageUpload.tsx` calls with a 90s wall-clock timeout that force-terminates the worker - `worker.terminate()` works regardless of what the worker is doing internally, unlike a main-thread `setTimeout` racing a synchronous computation that never yields. |
| `amiRootVisibility.ts` | Detects the AMITSE multi-FormSet root byte vector in the Setup PE32 (the x86-64 loop that walks it, corroborated by the FormSet count) and reports it as immutable evidence about the source BIOS. |
| `amiRootVisibilityEditing.ts` | Reversible desired-state plans for individual roots (`toggleAmiRootVisibility`, `desiredAmiRootVisibility`) and the byte-for-byte check that a re-uploaded `data.json`'s plans still describe the loaded firmware. |
| `types.ts` | The `Data`/`Form`/`FormChildren`/`Suppression`/root-visibility shapes shared across the app. |
| `testFixtures.ts` | Hand-built fixtures reused across test files: a minimal-but-representative IFR dump (FormSet + VarStore + Form with a `SuppressIf`-guarded CheckBox, a `Numeric` with a default, a `OneOf` with options, and a cross-form `Ref`), and `buildMoveFixture()`, a real-shaped HII package list (two Forms Packages in two FormSets) with a matching `Data` for the move tests. Not itself a test file. |

The tree, its verdicts and the move dialog's analysis live next to the UI in
`src/components/Navigation` (`menuTree.ts`, `reparenting.ts`,
`relocating.ts`, `navigationWidth.ts`) - they consume `Data` but never touch
bytes. The single-FormSet tab visibility toggle's own analysis and mutation
(`analyzeTabVisibilityToggle`, `applyTabVisibilityToggle`) live next to the
tab inventory UI in `src/components/FormUi/tabVisibility.ts`, on the same
terms; `relocating.ts`'s move dialog refuses a Ref that toggle currently has
parked, pointing at Show instead.

## Why bytes, not hex strings

Firmware files are carried through the app as uppercase hex strings (that's
what `PopulatedFiles.*Container.textContent` holds - `BiosImageUpload.tsx`'s
own `toHex()` produces it from the extracted bytes), but every module in
this list except the very edges (`binaryPatcher.ts`'s `hexToBytes`/`Blob`
boundary) treats offsets and comparisons as bytes/numbers, not hex-string
character positions. If you're adding a new patch, decode once at the
boundary and index by byte offset - don't reintroduce string
slice-and-concat patching.

## Adding a new opcode/condition type to the parser

1. Add the regex and its handler function in `ifrParser.ts`, following the
   existing `handle*Line(state, match, ...)` pattern - each handler takes
   the shared `ParserState` and mutates it.
2. Wire the `if (match) handleXLine(...)` call into `parseSetupTxt()`'s
   loop, in the same relative position real IFR dumps would produce it
   (condition/scope handling is order-sensitive).
3. Add a fixture line (or a new fixture, see `testFixtures.ts` for the
   pattern) and a `parseData()` assertion in `ifrParser.test.ts` before
   relying on it - the existing fixtures deliberately don't cover every
   opcode, and this parser has no schema to catch a silently-wrong regex.
