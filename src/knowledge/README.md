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
| `index.ts` | `knownCases` and `knownRules`: every `cases/**/*.json` and `rules/*.json`, validated at load. |
| `cases/<family>/<id>.json` | One case per image. |
| `ruleSchema.ts` | `FirmwareRule` type, `validateFirmwareRule()`, `findRuleProblems()` (rule ids unique, every validated case is a recorded case) and `ruleWarnings()` (rules resting on a single case). |
| `rules/<id>.json` | One rule per generalisation, for example `AMI-HUB-001`. |

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
cases, and the CSV export gains `knowledge` and `knowledge_case` columns. A file
that is not an exact case also says why: the closest recorded case, the fields
the two agree on and the fields where they differ, with both values ("Differ:
Forms (2 here, 229 in the case)"). The dashboard tallies those differences over
the new cases ("Why the new cases are new") and counts the new cases that had no
recorded case close enough to compare against. This points at where to work on
an image; it is not a verdict on it. None
of this changes how an image is analysed.

The volume counts come from the shallow preflight scan
(`inspectAmiFirmwareBytes`): `firmwareVolumes`, `ffs2Volumes`, `ffs3Volumes`
and `directSetupFiles` (Setup FFS files visible without decompressing). The
bundled cases take the same four numbers from the table in
`docs/ami/sample-corpus.md`.

## Cases and rules

A **case** is a fact: one image was observed to have this structure. A **rule**
is a generalisation the editor relies on ("this pattern means that"). They are
kept apart so a pattern seen on one image cannot quietly become a rule.

A rule is recorded with the cases that back it (`validatedCases`), the code that
applies it (`implementation`), the tests that pin it (`tests`) and, where it
exists, the documentation (`documentation`). Its `evidence` level says how
strongly it is backed:

| `evidence` | Meaning | Requirement |
| --- | --- | --- |
| `single-sample` | A candidate seen once. | Exactly one validated case. `npm run cases:check` prints a warning for it. |
| `multi-sample` | Seen on several recorded cases. | At least two validated cases and `minimumCases` of at least 2. |
| `externally-confirmed` | Backed by knowledge from outside this editor (the vendor, AMIBCP, a datasheet). | At least one case and `documentation` naming the source. |

Rules are a register, not an engine: no parser consults them. Do not add a
branch to a parser because a case looks like another one; add a rule only once
the behaviour is implemented, tested and seen on more than one case.

The check counts distinct recorded cases. It cannot tell whether two cases are
independent (two firmware versions of one board count as two), so independence
is a judgement for whoever adds the rule.

### Adding a rule

1. Record the cases first (see "Adding a case").
2. Write `rules/<id>.json` with `id` as `<AREA>-<TOPIC>-<NNN>` (for example
   `AMI-ROOT-002`), the file name equal to the id.
3. Point `implementation`, `tests` and `documentation` at files that exist.
4. Run `npm run cases:check`. It validates the rule, that every validated case is
   recorded, that the files exist, and lists any rule that rests on one case.
