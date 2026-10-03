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

1. Run the image through the corpus runner (`CorpusRunner`) and keep only the
   metadata it reports.
2. Write `cases/<family>/<id>.json` where `id` is `<family>-<first 8 hex of the
   SHA-256>`. If the same image is already a case, add the new file name to its
   `names` instead of creating a second case.
3. Omit any field that was not observed. Keep `generation: "unresolved"` unless
   the evidence resolves it (see `docs/ami/sample-corpus.md`).
4. `npm test` validates the file and checks the collection; the AMI cases are
   also checked against the table in `docs/ami/sample-corpus.md`.

Do not commit firmware. A case that needs bytes to make sense is not a case.
