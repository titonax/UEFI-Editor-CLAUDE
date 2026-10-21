# Phoenix: this fork and the GPT fork

Read-only comparison of the two forks' legacy Phoenix work, written for the
owner to decide between them (roadmap item G4). No code was copied and nothing
here changes how this fork behaves.

- This fork: `d7f3cdd` (2026-10-19).
- GPT fork (`titonax/uefi-editor-gpt`): `main` at `3cd7921`, PR #222,
  2026-10-19, read from a depth-limited clone. Its `docs/roadmap.md` is the
  authority for its status; some of its other pages lag behind it (see
  "Where the documents disagree").
- Compared by reading code, documents and line counts. Neither fork's tests
  were run for this page, and nothing was flashed on a board.

## What is the same

The two Phoenix paths share an origin:

- `phoenixFirmware.ts` exports the same API in both (`inspectPhoenixLegacyBytes`,
  `inspectPhoenixUefiBytes`, `findNamedPhoenixModule`, the same module and
  inventory types).
- `phoenixSetupTable.ts` exports the same core in both (`parsePhoenixStringTable`,
  `resolvePhoenixString`, `scanPhoenixSetupSections`, `parsePhoenixRootTable`,
  `buildPhoenixSetupMenu`, `forceItemsVisible`, `toPbeModuleBytes`,
  `savePhoenixSetupChanges`), and `PhoenixVisibilityPatch` has the same fields
  with the same comments.
- Both treat the one proven visibility mechanism the same way: a menu item's
  callback has a `mov ax, imm16` on its hide path, and overwriting that
  immediate with zero shows the item. Both report a callback as evidence, never
  as a runtime evaluation.
- Both read the root table through the fixed pointer at `0x68` of the template
  module.
- Both record the Acer Z03 image (`d34c9695…640194`) as a case; this fork took it
  from the GPT fork.

## What only the GPT fork has

| Area | Where (GPT fork) | Size |
| --- | --- | --- |
| LH5 **encoder** and a codec contract | `phoenixLh5Encoder.ts`, `phoenixCompressionCodec.ts`, `compressPhoenixLh5` in `phoenixLh5.ts` | 390 + 15 lines |
| Writing a modified module back into the FFV | `phoenixFfvRebuilder.ts` | 111 lines |
| Full-image rebuild with an independent re-open of the Setup | `phoenixFirmwareRebuilder.ts` | 131 lines |
| Phoenix edits as entries of the shared byte-patch queue | `phoenixChangeQueue.ts`, `PhoenixEditor/usePhoenixChangeQueue.ts` | 42 + 107 lines |
| Portable queue sessions (save and load) | `phoenixQueueSession.ts` | 162 lines |
| Static x86-16 callback tracing (a lazily loaded decoder, a bounded path engine) | `scripts/behavior/` and `PhoenixBehaviorDialog.tsx` | see `docs/phoenix/behavior-analysis.md` there |
| A navigation graph for the menu: parents, depth, and screens in `root`, `submenu` or `unlinked` placement | `phoenixSetupTable.ts` (`discoverPhoenixRootTable`, `placement`, `parentOffset`) | about 300 more lines than here |
| Root directories found without the fixed `0x68` pointer, when every label and target validates | same | |
| A full workspace with its own header, tree, form view and footer | `PhoenixEditor/` | about 1,900 lines |

Its own documents report, for the Z03 image: an optimized LH5 encoding of the
modified template that fits the original packed allocation (13,074 bytes in a
13,112-byte allocation), a rebuilt 1 MiB image whose modules all re-parse, bytes
outside the allocation unchanged, and a deployed-Firefox run of select, apply,
check, download and reload. Allocation or directory growth stays blocked.

## What only this fork has

| Area | Where (this fork) |
| --- | --- |
| The research record behind the visibility mechanism on a laptop's original and modified BIOS pair: the root table relocated from `0x022E` to `0x0868`, 116 hide-path sentinel conversions, and the hook present on 28 of 83 items on one image | `docs/phoenix/README.md` ("Documented cases") |
| Pick Field option staging, shown as a panel on the upload screen | `BiosImageUpload/PhoenixSetupMenuPanel.tsx` (214 lines) |
| More tests around module discovery (9 cases in `phoenixFirmware.test.ts` against 4) | `phoenixFirmware.test.ts` |

The GPT fork's documents do not mention that laptop pair, so the legacy
callback evidence it records rests on the Z03 image.

## Where they overlap without agreeing

- **Visible effect.** Both can export a patched template for Phoenix BIOS
  Editor. Only the GPT fork can also write the full image.
- **Menus.** This fork's sections have a name and items (`root-table` or
  `contiguous-scan`). The GPT fork's also have a parent, a depth and a
  placement, and it lists unlinked screens that no registered tab reaches.
- **Queue.** This fork's generic byte-patch queue engine (`scripts/changeQueue.ts`)
  is the same code the GPT fork's Phoenix queue is built on, ported verbatim,
  and this fork does not use it for Phoenix yet.
- **UI.** A panel on the upload screen here; a separate workspace there that
  mirrors the Aptio layout.

## Where the documents disagree

- The GPT fork's `docs/phoenix/setup-menu.md` still says Phoenix BIOS Editor
  must do the LH5 recompression, while its `README.md` and `docs/roadmap.md`
  describe its own encoder and full-image output as accepted.
- This fork's `docs/phoenix/README.md` says the real recompression step is
  Phoenix BIOS Editor's own, not a custom LH5 encoder. That is about the
  laptop pair it studied and does not describe the GPT fork's encoder.

Neither statement is wrong about its own scope; both lag behind the code of
the other fork.

## Options for the owner

These are the choices this page was written to inform. The first two are
cheap and reversible; the third is not.

1. **Keep them separate.** This fork stays at inventory, menu reading and the
   patched-template export. Nothing to build; no full-image Phoenix output here.
2. **Port in stages, behind this fork's existing queue.** In dependency order:
   the LH5 encoder (roadmap W1 also needs it), then the FFV and firmware
   rebuilders, then `phoenixChangeQueue.ts` onto the queue already here, and
   only then any editor UI. Each stage ships with its own tests and a
   read-back check, and none writes an image until the stage before it passes.
3. **Converge on one path.** Adopt the GPT fork's Phoenix editor wholesale.
   This is the largest change and discards this fork's panel; it also moves
   this fork's Phoenix status from "read, export a module" to "writes images"
   in one step.

The part that carries risk is writing an image, not reading one. The GPT fork's
acceptance is a single Phoenix image (Z03) rebuilt and re-read by its own
decoders, never flashed; a port inherits that limit and should say so.

What a decision needs from the owner: which option, and whether a Phoenix
image written by this fork is something this fork should offer at all.

## Decision

On 2026-10-21 the owner chose option 2, porting in stages behind this fork's
queue. The stages are rows P1 to P4 of `docs/ROADMAP.md`; the GPT fork's
queue sessions, callback tracing, menu graph and separate workspace are left
for a later choice (P5).
