# `src/components/scripts`

The non-UI core: parsing the IFR text dump, classifying visibility, and
patching the binary firmware files. Each module has a matching
`*.test.ts` file next to it.

| Module | Responsibility |
| --- | --- |
| `ifrParser.ts` | Parses the IFRExtractor-RS text dump into `Data` (forms, prompts, VarStores, suppressions) and discovers the top-level menu (AMITSE table / SetupData page list / HII FormSet fallback). `parseData()` is the entry point; `parseSetupTxt()` runs the line-by-line scan via one handler function per opcode kind (`handleFormLine`, `handleConditionLine`, etc.), all mutating a shared `ParserState`. |
| `expressionFormatter.ts` | Turns a raw IFR condition expression (`EqIdVal QuestionId: 0x1, Value: 0x1`) into the human-readable form shown in the UI (`0x1 == 0x1`). |
| `binaryPatcher.ts` | `downloadModifiedFiles()`: applies the user's edits as byte-level patches to `Setup.sct`, `AmiTseSct.sct`, and `SetupData`, working on `Uint8Array`s (never full-file string copies), and produces the changelog. Also owns `validateByteInput()` for the access-level/failsafe/optimal text fields. |
| `hashing.ts` | SHA-256 helpers, including the checksum used to verify a re-uploaded `data.json` still matches the firmware files it was exported from. |
| `hexId.ts` | `parseHexId`/`sameHexId`/`normalizedHexId` - formId/questionId/varStoreId values are always `"0x..."` hex strings; every comparison in the codebase goes through here instead of a bare `parseInt`. |
| `visibility.ts` | Given a parsed `Data`, computes a child's effective visibility (visible/hidden/conditional/orphaned/broken) and summarizes a whole form branch, used by `FormUi`. |
| `aptioIvExtractor.ts` | Full-image path: locates firmware volumes/files, recursively decompresses (LZMA/Tiano WASM), and extracts the Setup/AMITSE/SetupData sections plus the IFR text dump. Experimental - see `docs/aptio-iv/README.md`. |
| `aptioIvImage.ts` | Inspects an uploaded image up front (volumes found, Setup/AMITSE FFS located) to show the user what will happen before running the heavier extraction. |
| `types.ts` | The `Data`/`Form`/`FormChildren`/`Suppression`/etc. shape shared across the app. |
| `testFixtures.ts` | A hand-built, minimal-but-representative IFR dump (FormSet + VarStore + Form with a `SuppressIf`-guarded CheckBox, a `Numeric` with a default, a `OneOf` with options, and a cross-form `Ref`) reused by `ifrParser.test.ts` and `binaryPatcher.test.ts`. Not itself a test file. |

## Why bytes, not hex strings

Firmware files are carried through the app as uppercase hex strings (that's
what the browser can read them as via `FileReader`/`Web Worker`, see
`hexWorker.ts`), but every module in this list except the very edges
(`FileUploads.tsx` reading files, `binaryPatcher.ts`'s `hexToBytes`/`Blob`
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
