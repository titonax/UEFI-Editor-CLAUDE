# Roadmap

What is open, in what order, and what each item needs. Written 2026-10-18.
`CLAUDE.md` still governs how every item is done (tests first, no firmware in
the repo, evidence is not fact, nothing flashed).

The scheduled hourly task works from this file: it takes **one** `Ready` item,
in the order of "Pick order" below (skipping any that are `Blocked`), does it
on its own branch with a pull request, and updates this file in the same
change. The owner allowed it to merge its own pull requests on 2026-10-21, but
only when every check on the pull request has passed and it merges cleanly; a
red or pending check leaves the pull request open. If no item is `Ready` it
does nothing. Do not add a `Ready` item unless it really can be finished with
code and the data already in the repository.

Pick order: P1, P2, P3, P4, G1, G5a, G2a, T1, D1, R1, R2, G2b, A4. The staged
Phoenix port (P1 to P4) goes first because the owner chose it and asked for P1
before anything else; each stage waits for the one before it to merge. After
that, items that touch behaviour users see (G1, G2a) go first, and the two file
splits (R1, R2) go after the test and docs items so they start from a
documented base.

| Status | Meaning |
| --- | --- |
| Ready | Code and repository data are enough. |
| Needs sample | Cannot be done without a real firmware image that is not in the repository. Nobody may fabricate one. |
| Needs decision | The owner (or both forks) must choose first. |
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
| W1 | Blocked (P1) | An LH5 encoder for Award modules. It is the same encoder as P1; Award uses it only after P1 is done. | P1 is done and an Award round trip over `-lh5-` module bodies passes. |
| W2 | Needs sample | Link each item to its title in `_EN_CODE.BIN`. | Item names shown in the inventory, with the rule documented. |
| W3 | Needs sample | Meaning of the flags word bits other than `0x8`, and of the bytes at +4/+5. | Each bit named from the setup code, with the instruction addresses that read it. |
| W4 | Needs sample | A second Award image (4.51PG, a 2 MiB mirrored image, or another vendor's 6.00PG). | Inventory checked against it and differences recorded. |
| W5 | Done | `R01A2.BIN` is recorded as a case (`src/knowledge/cases/award/award-d7ec1c70.json`, taken from the GPT fork's `docs/award/emachines-el1200-r01a2.md`; the board is an eMachines EL1200). | - |
| W6 | Blocked (W1, W3) | Hide/Show of a **statically** hidden item by editing the flags word, rebuilding the module and its LHA header. | Export refuses when the item is also hidden by code at run time; read-back verified; documented as untested on hardware. |
| W7 | Done | Module count reconciled with the GPT fork on 2026-10-19: the image has 19 `-lh5-` and 4 stored `-lh0-` members, and the GPT page says all 23 are `-lh5-`. Recorded in `docs/award/README.md`. | The owner may check the GPT page against the image. |

W6 must stay behind an explicit experimental label: the code also sets the
hide bit at run time, and no Award board has been tried.

## 3. Parity with the GPT fork

The GPT fork is `titonax/UEFI-Editor-GPT`. It was re-read on 2026-10-19 at
`3cd7921` (PR #222), up from `e001282` (PR #77) in September. Its own plan is
`docs/roadmap.md` there. It writes Phoenix full images, has a Phoenix editor
workspace, a vendor-neutral UEFI HII editor and portable queue sessions; this
fork has none of those four (it does write same-size AMI Aptio IV images). Check it again before starting any item here.

| Id | Status | Item | Done when |
| --- | --- | --- | --- |
| G1 | Ready | Name Hide/Show in the Change queue. Today a Hide/Show done by relocating a tab's Ref is worded as a "Move menu X" because the diff has the same shape (see `docs/ami/change-queue.md`). `RefPrompt` already carries `hiddenByTabToggle` and `repositionedWithinForm` from `tabVisibility.ts`; use them instead of adding an `ifrEdits` log. | The queue says Hide or Show for tab-toggle relocations and Move for the Move dialog, with a test for each, and `change-queue.md` loses its scope-cut section. Check how Show clears the markers first. |
| G2a | Ready | An optional **Manufacturer** selector on the upload screen. `classifyBrand` already takes a `declaredBrand` ("user-supplied" signal, ranked below an exact documented SHA-256 and above marker/filename matches) but no screen passes one. | The selector lists `supportedBrands`, its choice reaches `classifyBrand`, the report shows the resulting brand and its basis, a choice that disagrees with a documented hash is shown as a disagreement rather than overriding it, and a component test covers each. |
| G2b | Ready | Audit this fork's UI against what the GPT fork's screens showed, as seen in the owner's screenshots: a per-item visibility-gate badge ("hidden when true" / "no visibility gate") in the menu tree, per-item Hide / Show / Move controls in the tree, and the vendor badge on the upload screen. Read-only: write `docs/ui-parity.md` listing, for each, whether this fork has it (with file and component) or not. | The page exists and each missing piece is added below as its own `Ready` row with a test as its completion check. No UI is changed in this item. |
| G3 | Deferred | **uefi-unbranded**: a vendor-neutral UEFI HII engine for Insyde and modern Phoenix UEFI firmware (the GPT fork's discovery, editing, patcher, suppression and workspace modules and its navigation table and menu actions). The owner asked that it not be forgotten and not be started yet. | Only when the owner lifts the deferral. |
| G4 | Done (decided) | The owner chose option 2 of `docs/phoenix/gpt-comparison.md` on 2026-10-21: port the GPT fork's Phoenix writer in stages behind this fork's queue. The stages are P1 to P4 below. | - |
| G5 | Needs decision | Re-compared on 2026-10-19 against the GPT fork's `main` (`3cd7921`): its knowledge layer is unchanged, and `docs/knowledge-interchange.md` now says so. The four open points there still need both sides. | The page's open points are each settled in writing by both sides, or restated with what is still undecided. |
| G5a | Ready | Derive the documented-sample table in `brandKnowledge.ts` from the cases in `src/knowledge/cases` so a hash lives in one place, as the GPT fork does. Its duplicate held a 65-character hash (fixed on 2026-10-19). | `brandKnowledge.ts` reads its samples from the cases, every sample hash is checked as 64 lower-case hex by a test, and `classifyBrand`'s results do not change for any existing test. |

### 3a. Phoenix staged port (G4, option 2)

Each stage ports from the GPT fork (`titonax/uefi-editor-gpt`; a public
repository, readable with `git clone`) but is re-verified here: read its file,
write this fork's tests first, keep a one-line provenance comment at the top
of each ported module, and say in the pull request what the stage does not
prove. No stage writes a Phoenix image until the one before it passes, and
nothing is flashed. The GPT fork's accepted result is a single image (Acer
Z03, SHA-256 `d34c9695d6d54595836212021797dd7557cabae0d25fd33cd0faa87c25640194`)
rebuilt and re-read by its own decoders; that image is not in this repository.

| Id | Status | Item | Done when |
| --- | --- | --- | --- |
| P1 | Ready | The LH5 encoder and its codec contract: GPT's `phoenixLh5Encoder.ts`, `phoenixCompressionCodec.ts` and `compressPhoenixLh5`. | `compress` then `phoenixLh5.ts`'s `decompress` returns the original bytes for empty, tiny, repetitive, random and real-body inputs (the real LH5 body fixture already in `phoenixLh5.test.ts` is one); the encoded size for that fixture is reported next to its original packed size, and the page makes no claim that it fits an allocation. |
| P2 | Blocked (P1) | Replacing one module's LH5 payload inside its FFV: GPT's `phoenixFfvRebuilder.ts`, same allocation only. | Synthetic-FFV tests assert the exact bytes before and after; growth, a missing module and a directory change are typed refusals; bytes outside the payload are unchanged. |
| P3 | Blocked (P2) | A Phoenix image rebuild with an independent re-open: GPT's `phoenixFirmwareRebuilder.ts`. | The output is re-read with `inspectPhoenixLegacyBytes` and `inspectPhoenixSetupMenu`; the module inventory and screen list match the source except the requested edit; a mismatch is a typed refusal; `changelog.txt` lists the changed range. |
| P4 | Blocked (P3) | Phoenix Show edits as entries of this fork's queue: GPT's `phoenixChangeQueue.ts` as byte-patch entries against `phoenix:TEMPLAT00.ROM`, through the byte-patch engine already in `scripts/changeQueue.ts`, then the panel's Apply / Check / download path in `PhoenixSetupMenuPanel.tsx`. | Pause, remove and reorder work for Phoenix entries; the download stays disabled until the plan is applied and the check passed; a component test with a mocked builder covers it; the panel says the image is experimental and unflashed. |
| P5 | Needs decision | What follows P4: the GPT fork's portable queue sessions, callback tracing, navigation graph with unlinked screens, and a separate editor workspace. | The owner chooses which of these to port, after P4, and each becomes its own row. |

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
