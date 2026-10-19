# Roadmap

What is open, in what order, and what each item needs. Written 2026-10-18.
`CLAUDE.md` still governs how every item is done (tests first, no firmware in
the repo, evidence is not fact, nothing flashed).

The scheduled hourly task works from this file: it takes **one** `Ready` item,
in the order of "Pick order" below, does it on its own branch with a pull
request, and updates this file in the same change. If no item is `Ready` it
does nothing. Do not add a `Ready` item unless it really can be finished with
code and the data already in the repository.

Pick order: G1, W1, G2a, T1, D1, R1, R2, G2b, A4. Items that touch behaviour
users see (G1, G2a) go first; the two file splits (R1, R2) go after the test
and docs items so they start from a documented base.

| Status | Meaning |
| --- | --- |
| Ready | Code and repository data are enough. |
| Needs sample | Cannot be done without a real firmware image that is not in the repository. Nobody may fabricate one. |
| Needs decision | The owner (or both forks) must choose first. |
| Needs access | Approved, but it needs to read the GPT fork, which the hourly task cannot reach. A session with that access does it. |
| Deferred | The owner postponed it explicitly. Do not start. |
| Blocked | Waits for another item; the id is given. |

## 1. Aptio IV full-image reconstruction

Source of truth: `docs/ami/full-image-reconstruction.md` ("Pending") and
`docs/aptio-iv/README.md`. Nothing here has been flashed.

| Id | Status | Item | Done when |
| --- | --- | --- | --- |
| A1 | Needs sample | A real AMI image whose Setup section is EFI/Tiano-compressed (roughly 2012-2014, Aptio IV). | Rebuilt with an edit, read back with the C decoder, pass count recorded. |
| A2 | Needs sample | A root visibility change on a real image end to end: a detected vector and a Setup section with spare room. | Rebuilt, re-analysed, and the result recorded. |
| A3 | Needs sample | Corpus cases for the local sample set (needs the deployed runner and its "Add case" button). | Cases added under `src/knowledge/cases`. |
| A4 | Ready (evaluate first) | Room for an LZMA section that has none: the next free space in the volume moves a file boundary, which is outside the rebuild. | Refusal replaced by an exact, verified rebuild, or a written reason it stays a refusal. Do not force it. |

## 2. Phoenix-Award (`docs/award/README.md`)

Read-only inventory exists (module chain and `_ITEM.BIN` records). Everything
below is about going further. The only sample so far, `R01A2.BIN`, is not in
the repository, and its analysis needs it.

| Id | Status | Item | Done when |
| --- | --- | --- | --- |
| W1 | Ready | An LH5 **encoder** in the repo. | Round trip: encode, then decode with `phoenixLh5.ts`, gives the original bytes for varied inputs. No claim that the output matches what Award's own tool writes. |
| W2 | Needs sample | Link each item to its title in `_EN_CODE.BIN`. | Item names shown in the inventory, with the rule documented. |
| W3 | Needs sample | Meaning of the flags word bits other than `0x8`, and of the bytes at +4/+5. | Each bit named from the setup code, with the instruction addresses that read it. |
| W4 | Needs sample | A second Award image (4.51PG, a 2 MiB mirrored image, or another vendor's 6.00PG). | Inventory checked against it and differences recorded. |
| W5 | Needs sample | Record `R01A2.BIN` as a case (metadata only). | Case added through the runner. |
| W6 | Blocked (W1, W3) | Hide/Show of a **statically** hidden item by editing the flags word, rebuilding the module and its LHA header. | Export refuses when the item is also hidden by code at run time; read-back verified; documented as untested on hardware. |

W6 must stay behind an explicit experimental label: the code also sets the
hide bit at run time, and no Award board has been tried.

## 3. Parity with the GPT fork

The GPT fork is `titonax/UEFI-Editor-GPT`. The notes below come from reading
its `main` at `e001282` (PR #77) in September 2026; it has moved since and
could not be re-read when this was written, so check before starting any item.

| Id | Status | Item | Done when |
| --- | --- | --- | --- |
| G1 | Ready | Name Hide/Show in the Change queue. Today a Hide/Show done by relocating a tab's Ref is worded as a "Move menu X" because the diff has the same shape (see `docs/ami/change-queue.md`). `RefPrompt` already carries `hiddenByTabToggle` and `repositionedWithinForm` from `tabVisibility.ts`; use them instead of adding an `ifrEdits` log. | The queue says Hide or Show for tab-toggle relocations and Move for the Move dialog, with a test for each, and `change-queue.md` loses its scope-cut section. Check how Show clears the markers first. |
| G2a | Ready | An optional **Manufacturer** selector on the upload screen. `classifyBrand` already takes a `declaredBrand` ("user-supplied" signal, ranked below an exact documented SHA-256 and above marker/filename matches) but no screen passes one. | The selector lists `supportedBrands`, its choice reaches `classifyBrand`, the report shows the resulting brand and its basis, a choice that disagrees with a documented hash is shown as a disagreement rather than overriding it, and a component test covers each. |
| G2b | Ready | Audit this fork's UI against what the GPT fork's screens showed, as seen in the owner's screenshots: a per-item visibility-gate badge ("hidden when true" / "no visibility gate") in the menu tree, per-item Hide / Show / Move controls in the tree, and the vendor badge on the upload screen. Read-only: write `docs/ui-parity.md` listing, for each, whether this fork has it (with file and component) or not. | The page exists and each missing piece is added below as its own `Ready` row with a test as its completion check. No UI is changed in this item. |
| G3 | Deferred | **uefi-unbranded**: a vendor-neutral UEFI HII engine for Insyde and modern Phoenix UEFI firmware (the GPT fork's discovery, editing, patcher, suppression and workspace modules and its navigation table and menu actions). The owner asked that it not be forgotten and not be started yet. | Only when the owner lifts the deferral. |
| G4 | Needs access | Approved by the owner on 2026-10-19 without picking a side. First step, read-only: a comparison of the GPT fork's separate Phoenix editor (its own form UI, footer and change queue) with this fork's legacy Phoenix Setup Table work, in `docs/phoenix/gpt-comparison.md`. No code is copied and neither path is removed until the owner reads it. | The page lists what each path can do, where they overlap and where they disagree, with file references on both sides. |
| G5 | Needs access | Approved by the owner on 2026-10-19. The open points in `docs/knowledge-interchange.md` (generation policy, similarity rule, capsule container values, one format or translation) need the GPT fork's current code and its owner's agreement; this fork cannot settle them alone. First step: re-run the comparison against the GPT fork's current `main` and update that page and its test. | The page's comparison commit is current, and each open point is either settled in writing by both sides or restated with what is still undecided. |

## 4. Code health

All of these keep behaviour identical. Tests stay green before and after, and
public exports and test names do not change.

| Id | Status | Item | Done when |
| --- | --- | --- | --- |
| T1 | Ready | A component test for `ChangeQueueDialog` (no test file today): the metrics badges, an entry's checkbox pausing it, remove, clear, the error and warning alerts, the empty state, and the "Plan applied" state. | `ChangeQueueDialog.test.tsx` covers each, and `npm test` is green. |
| D1 | Ready | Bring the module map in `src/components/scripts/README.md` up to date: 13 of the 55 non-test modules in the folder are not named there (the Award, change-queue and Phoenix modules among them). | Every non-test module in `src/components/scripts/` and `src/components/ChangeQueue/` is named in the map, checked against `ls`. |
| R1 | Ready | Split `amiFirmwareImage.ts` (873 lines, named in `CLAUDE.md`) along its own seams (vendor and brand signatures, container detection, generation assessment, setup-profile inspection). | No resulting file over about 600 lines, `amiFirmwareImage.ts` keeps re-exporting what other modules import, and the full suite passes unchanged. |
| R2 | Ready | Split `menuTree.ts` (806 lines) the same way. | Same conditions as R1. |

## 5. Keeping this file true

- Change an item's status in the same pull request that changes the code.
- When a `Needs sample` item gets its sample, say so here and set it to `Ready`.
- When a source document changes (the "Pending" section, `docs/award/README.md`,
  `docs/knowledge-interchange.md`), update the matching rows here.
- Do not list work that has no completion test.
