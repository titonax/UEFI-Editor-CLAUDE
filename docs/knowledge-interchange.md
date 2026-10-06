# Knowledge interchange: cases, rules and similarity

This page fixes the part of `src/knowledge` that two implementations of the
editor (this one and the GPT fork) must share, so a case recorded in one is
valid in the other. It is the contract; the code is the reference, and
`src/knowledge/interchange.test.ts` fails when this page and the code differ.

Everything else (UI, extraction, where a case is stored, how the corpus runner
shows it) is each implementation's own business. A case is **metadata only**:
no firmware bytes, ever. A field that was not observed is **absent**, never
guessed; absence means unknown.

## Case (`FirmwareCase`)

One JSON object per analysed image, at `cases/<family>/<id>.json`, written with
2-space indentation and a trailing newline. Unknown keys are rejected.

| Field | Type | Rule |
| --- | --- | --- |
| `schemaVersion` | number | `schemaVersion` is 1 |
| `id` | string | `<family>-<first 8 hex of sha256>`, lower case |
| `sha256` | string | 64 lower-case hex characters, of the whole image; the identity |
| `size` | number | positive integer, bytes |
| `names` | string[] | at least one file name the exact image was seen under |
| `vendorFamily` | enum | informational only; never selects a code path |
| `container` | enum | as observed |
| `generation` | enum | `unresolved` unless the evidence resolves it |
| `generationEvidence` | enum | `unresolved` exactly when `generation` is |
| `features` | object | only observed counts and the navigation code |
| `stages` | object, optional | per-stage outcome, when run through the corpus runner |
| `blockers` | string[] | short codes naming what keeps the image from going further |
| `source` | string | a docs page, or `corpus-runner` |
| `notes` | string[], optional | |

Every text value is non-empty and at most 200 characters. `features` keys are
the counts in the fingerprint below (all whole numbers >= 0) plus `navigation`
(a short code, not prose).

Closed vocabularies:

- `vendorFamily`: `ami-aptio`, `award`, `phoenix`, `phoenix-uefi`, `insyde`, `ami-legacy`, `uefi-generic`, `embedded-non-bios`, `legacy-framework-hii`, `intel-me`, `non-firmware`, `unknown`
- `container`: `intel-flash`, `firmware-volume-image`, `vendor-image`, `phoenix-rom`, `unknown`
- `generation`: `aptio-iv`, `aptio-v`, `unresolved`
- `generationEvidence`: `confirmed`, `probable`, `unresolved`
- `stages`: `preflight`, `extraction`, `hii`, `navigation`, `editability`, `reconstruction`
- `stage status`: `passed`, `warning`, `failed`, `blocked`, `not-run`

Directory and id prefix are the `vendorFamily`, except `ami-aptio`, which uses
`ami`. One case per image (SHA-256) and one id per case.

Shared structures (Setup, AMITSE, `$SPF`, FFS3) are family evidence, not a
generation verdict: a case keeps `generation: "unresolved"` unless something
that separates Aptio IV from V resolves it.

## Fingerprint and similarity

A fingerprint is what can be compared between a case and a newly analysed
image. A field missing on either side is skipped: it counts neither for nor
against.

- `fingerprint`: `container`, `vendorFamily`, `generation`, `firmwareVolumes`, `ffs2Volumes`, `ffs3Volumes`, `directSetupFiles`, `contextCount`, `formSets`, `forms`, `refs`, `navigation`

`container` and `vendorFamily` count as unknown when they are `unknown`. Two
values agree only when they are strictly equal.

1. **Known case**: the image's SHA-256 equals a case's `sha256`.
2. Otherwise, per case: `similarity` = agreeing fields / compared fields. A
   case is reported only with at least 3 comparable fields (a single shared
   container must not read as 100%). Order: similarity, then compared count
   (more first), then id.
3. **Similar**: similarity ≥ 0.8 for the best case. **New case**: anything else.

Similarity is how alike two images look as observed. It is not a probability
that the image is a given vendor or generation, and it never changes how the
image is analysed.

## Rule (`FirmwareRule`)

A rule is a generalisation, backed by recorded cases, at `rules/<id>.json`. It
is a register, not an engine: no parser consults it.

| Field | Rule |
| --- | --- |
| `id` | `<AREA>-<TOPIC>-<NNN>` in capitals, for example `AMI-HUB-001` |
| `description` | short text |
| `evidence` | see below |
| `minimumCases` | positive whole number |
| `validatedCases` | recorded case ids, no repeats |
| `implementation`, `tests` | repository-relative paths, at least one each |
| `documentation`, `notes` | optional |

- `rule evidence`: `single-sample`, `multi-sample`, `externally-confirmed`

`single-sample` has exactly one case and is reported as a warning.
`multi-sample` has `minimumCases` of at least 2 and at least that many cases.
`externally-confirmed` needs documentation naming the outside source. A rule
is only added when the behaviour is implemented, tested and documented.

## Aligning

Both forks agree on: the case schema and vocabularies above, the id and path
rule, the fingerprint fields, and the 80% / 3-field thresholds. If either side
changes one of those, change this page and bump `schemaVersion` in the same
change. Cases already recorded stay valid across forks as long as they pass
the validator of the fork that reads them.
