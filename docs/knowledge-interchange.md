# Knowledge interchange: cases, rules and similarity

This project exists as two forks with the same functionality and their own
implementation: this one and the GPT fork (`titonax/UEFI-Editor-GPT`). Each
keeps its own knowledge format. This page documents **this fork's** format,
how it maps onto the GPT fork's, and what the two really share. It is not a
contract that both forks have signed: the GPT fork has not adopted this page.
`src/knowledge/interchange.test.ts` fails when the page and this fork's code
differ.

The comparison was made against the GPT fork's `main` at `0895143` (its
knowledge layer is unchanged at `d30cb3c`). It rests on reading its code and
documents, not on running its tests.

## What the two forks share

- **Identity.** The SHA-256 of the whole analysed image, in lower-case hex, plus
  its size. Of the 22 images recorded here, 14 are also recorded there with the
  **same SHA-256**; 8 are only recorded here and 3 only there.
- **No contradicted measurement.** For those 14, every count and container that
  both forks recorded agrees. Where the values differ, one side leaves the
  field out (see "Where they differ").
- **Principles.** Metadata only, never firmware bytes. An unobserved field is
  absent, and absence means unknown. A case or a similar image never selects a
  parser, enables an edit or unlocks writing. Shared structures (Setup,
  AMITSE, `$SPF`, FFS3) are not a generation verdict.

Nothing else is shared. In particular the file format, the ids, the vocabulary
and the similarity rule differ, so a case file from one fork is not valid in the
other without translation.

## Field correspondence

How this fork's fingerprint fields map onto the GPT fork's `structure` fields.
An em dash means the other fork has no counterpart.

| This fork | GPT fork | Note |
| --- | --- | --- |
| `container` | `container` | Same name. The GPT fork also has `ami-legacy-rom` and `award-rom`. |
| `vendorFamily` | `family` | `uefi-generic` is `uefi-unidentified` and `unknown` is `unidentified` there. |
| `generation` | `generation.generation` | There it is an object with `confidence` and `conflict`; here `generationEvidence`, and a conflict is the blocker `generation-conflict`. |
| `firmwareVolumes` | `firmwareVolumeCount` | Same meaning. |
| `ffs2Volumes` | `ffs2VolumeCount` | Same meaning. |
| `ffs3Volumes` | `ffs3VolumeCount` | Same meaning. |
| `directSetupFiles` | `outerSetupCount` | Setup FFS files an outer scan sees, by their descriptions. |
| `contextCount` | — | Not recorded there. |
| `formSets` | `formSetCount` | Same meaning. |
| `forms` | `formCount` | Same meaning. |
| `refs` | — | Not recorded there. |
| `navigation` | `navigation` | There a closed set of four values; here a short free code. |

Recorded there and not here: `intelDescriptor`, `outerAmitseCount`,
`guidedLzmaSectionCount`, `layout` and `legacyModuleCount`. Their cases also
carry `label`, `brand`, `regressionTests` and `limitations`; ours carry `stages`,
`blockers` and `notes`. `fileNames` there is `names` here. Ids there are slugs
such as `hp-boa-8005`; here `<family>-<8 hex>`. Cases there live in TypeScript
(`cases/ami.ts`, `cases/legacy.ts`) plus `cases/reviewed/*.json`; here one JSON
file per image.

A field with no counterpart is dropped when translating a case, never guessed.

## Where they differ

- **Generation.** The GPT fork records `aptio-iv` with `confirmed` for 9 of the
  shared images and `aptio-v` with `probable` for the Intel NUC. This fork keeps
  all of them `unresolved` because the records rest on structures the IV and V
  corpora share (`docs/ami/sample-corpus.md`). That is a policy difference, not
  a measurement difference, and it is not settled.
- **Container.** For the ASUS capsules the GPT fork records `vendor-image`, and
  `firmware-volume-image` for HP BOA; this fork recorded `unknown` for these
  five because its records do not state a container. The project's classifier
  returns `firmware-volume-image` when a volume starts at offset 0 and
  `vendor-image` when volumes exist elsewhere, both without an Intel
  descriptor. This fork has not rechecked those five images against it.
- **Similarity.** This fork reports a case as similar when at least 80% of at
  least 3 comparable fields agree. The GPT fork requires 4 matching fields,
  one of them distinctive, and no contradicting field, and it reports no
  percentage. It also has the statuses `insufficient-evidence` and `conflict`.
  The same image can be similar in one fork and novel in the other.
- **Rules.** Both keep a register that no parser consults. Here a rule is JSON
  (`AREA-TOPIC-NNN`, `minimumCases`, evidence `single-sample`, `multi-sample` or
  `externally-confirmed`); there it is TypeScript with `implementation`
  `{path, symbol}`, `prerequisites`, `scope`, `limitations` and evidence
  `reviewed-samples`, `single-sample` or `synthetic-only`. Only the hub rule
  exists in both.

## Case (`FirmwareCase`), this fork

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

## Fingerprint and similarity, this fork

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

## Rule (`FirmwareRule`), this fork

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

## Moving a case between the forks

There is no importer. To bring a case across, translate it by hand with the
correspondence table, keep the SHA-256 and size, drop the fields with no
counterpart, and check the SHA-256 against the source record before accepting
it. Do not copy a generation verdict across: re-derive it under the receiving
fork's own policy.

## Open points

These need a decision from both sides before anything is aligned further: the
generation policy, the similarity rule, the container values for capsules, and
whether to converge on one file format or keep translating.
