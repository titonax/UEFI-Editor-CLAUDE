# Roadmap

What is open, in what order, and what each item needs. Written 2026-10-18.
`CLAUDE.md` still governs how every item is done (tests first, no firmware in
the repo, evidence is not fact, nothing flashed).

The scheduled hourly task works from this file: it takes **one** item whose
status is `Ready`, does it on its own branch with a pull request, and updates
this file in the same change. If no item is `Ready` it does nothing. Do not
add a `Ready` item unless it really can be finished with code and the data
already in the repository.

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
| G2 | Needs decision | UI parity: visibility-gate badges per item, per-item Hide/Show/Move in the tree, the manufacturer selector. Compare with what this fork already has before choosing. | A list of what is actually missing, agreed by the owner. |
| G3 | Deferred | **uefi-unbranded**: a vendor-neutral UEFI HII engine for Insyde and modern Phoenix UEFI firmware (the GPT fork's discovery, editing, patcher, suppression and workspace modules and its navigation table and menu actions). The owner asked that it not be forgotten and not be started yet. | Only when the owner lifts the deferral. |
| G4 | Needs decision | The GPT fork's separate Phoenix editor (its own form UI, footer and change queue) overlaps this fork's own legacy Phoenix Setup Table work. Do not reconcile the two without direction. | The owner says which path wins or how they coexist. |
| G5 | Needs decision | Knowledge-format interchange (`docs/knowledge-interchange.md`, "Open points"): generation policy, similarity rule, capsule container values, one format or translation. | Both sides agree; this fork's page and tests updated. |

## 4. Keeping this file true

- Change an item's status in the same pull request that changes the code.
- When a `Needs sample` item gets its sample, say so here and set it to `Ready`.
- When a source document changes (the "Pending" section, `docs/award/README.md`,
  `docs/knowledge-interchange.md`), update the matching rows here.
- Do not list work that has no completion test.
