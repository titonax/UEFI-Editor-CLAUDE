# `src/knowledge`

A small, versioned memory of firmware images the editor has analysed.
It is **metadata only** (no firmware bytes) and it is **observational**: the
structural analysers (`amiFirmwareImage.ts`, `aptioIvExtractor.ts`, ...) keep
deciding what an image is by reading it. Cases only let the editor say "this
image is known" or "this image resembles those".

Never choose a code path from a case, and never from a manufacturer or vendor
family either: `vendorFamily` is informational.

| File | Role |
| --- | --- |
| `schema.ts` | `FirmwareCase` type and `validateFirmwareCase()`: strict shape check (unknown keys rejected, short text only, closed vocabularies, generation/evidence consistency) plus `findCollectionProblems()` (one case per SHA-256, unique ids). |
| `fingerprint.ts` | `FirmwareFingerprint`: the comparable shape of an analysed image, built from a case (`fingerprintFromCase`) or from a corpus runner result (`fingerprintFromEntry`). A field that was not observed is absent, never guessed. |
| `caseMatcher.ts` | `matchCases()`: exact match by SHA-256, then structurally similar cases. |
| `index.ts` | `knownCases`: every `cases/**/*.json`, validated at load. |
| `cases/<family>/<id>.json` | One case per image. |

## Similarity is not probability

`similarity` is the share of comparable fields on which two fingerprints agree
(`agreeing / compared`). Fields unknown on either side are skipped, and a pair
with fewer than `minimumComparedFields` comparable fields is not reported at
all, so one shared container type never reads as a 100% match. It says how
alike two images look as observed, not how likely an image is to be a given
vendor or generation.

## Adding a case

1. Run the image through the corpus runner (`Local firmware corpus runner`).
   Its detail panel has an **Add case** button (hidden for an image that is
   already a recorded case). It downloads `<id>.json`: metadata only, no
   firmware, nothing leaves the browser.
2. Put the file at `src/knowledge/cases/<family>/<id>.json` (the button prints
   the exact path; `ami-aptio` images go under `ami/`). `id` is `<family>-<first
   8 hex of the SHA-256>`. If the same image is already a case, add the new file
   name to its `names` instead of creating a second case.
3. Run `npm run cases:check`.
4. Omit any field that was not observed. Keep `generation: "unresolved"` unless
   the evidence resolves it (see `docs/ami/sample-corpus.md`).

`npm run cases:check` validates every case (strict shape, closed vocabularies,
short text only, generation/evidence consistency), rejects two cases for one
image or one id, and requires each file to sit at `cases/<family>/<id>.json`.
It runs the `src/knowledge` tests, and so does `npm test` (and therefore CI).
Cases recorded from `docs/ami/sample-corpus.md` are additionally checked against
that table.

Do not commit firmware. A case that needs bytes to make sense is not a case.

## Where it shows up

The corpus runner (`src/components/CorpusRunner`) fingerprints every analysed
image from what it already measured (container, vendor family, generation,
context count, the preflight volume counts, HII counts, navigation mechanism)
and calls `classifyEntry()` (`corpusKnowledge.ts`):

- **Known case**: the SHA-256 is a recorded case.
- **Similar** (`≈ N% like <id>`): no exact case, but a case agrees on at least
  `similarThreshold` (80%) of at least `minimumComparedFields` comparable fields.
- **New case**: nothing resembles it closely enough; a candidate to record.

Each file shows one badge, the dashboard counts the three classes over distinct
cases, and the CSV export gains `knowledge` and `knowledge_case` columns. None
of this changes how an image is analysed.

The volume counts come from the shallow preflight scan
(`inspectAmiFirmwareBytes`): `firmwareVolumes`, `ffs2Volumes`, `ffs3Volumes`
and `directSetupFiles` (Setup FFS files visible without decompressing). The
bundled cases take the same four numbers from the table in
`docs/ami/sample-corpus.md`.
