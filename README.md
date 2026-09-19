# UEFI Editor (Claude fork)

A browser-based explorer and editor for AMI Aptio IV and V Setup menus. It
rebuilds the BIOS menu hierarchy from the firmware's HII/IFR data, shows the
evidence behind every "hidden", "grayed out" or "restricted" verdict, and lets
you make controlled changes - forcing a `SuppressIf` off, editing a prompt's
AMI access-level / failsafe / optimal bytes, moving a submenu to another page,
or planning a root-menu visibility change - before generating patched files.
Everything runs client-side; no file ever leaves your browser.

This is a maintenance/refactor fork of
[BoringBoredom/UEFI-Editor](https://github.com/BoringBoredom/UEFI-Editor).
The four-file Aptio V editing workflow is the same; see
[`docs/aptio-iv/README.md`](docs/aptio-iv/README.md) for the full-image
(Aptio IV) reconstruction roadmap and its current limitations.

## ⚠️ Before you flash anything

This tool patches raw bytes in real firmware images. A mistake can produce
an image that won't boot.

- Always keep an unmodified backup of every file you upload.
- Only flash output you've reviewed - check the generated `changelog.txt`
  against what you actually intended to change.
- Have a recovery path available (an external programmer, or your
  motherboard's documented recovery procedure) before flashing.

## What it actually does

AMI's Aptio Setup is described by IFR (Internal Forms Representation)
opcodes compiled into the firmware's HII database. Two other tables outside
that database - the AMITSE menu executable and the "SetupData" region - can
independently gate whether a page is reachable or what its default/failsafe
byte values are. This editor:

1. Parses the IFR text dump (produced by
   [IFRExtractor-RS](https://github.com/LongSoft/IFRExtractor-RS)) into
   FormSets, forms, prompts (CheckBox/Numeric/OneOf/String/Ref), VarStores
   and `SuppressIf`/`GrayOutIf`/`DisableIf` conditions, recording every
   opcode's binary offset so edits can later be applied as byte patches.
2. Builds a GUID-aware `FormSet → Form → Ref target` graph. Duplicate
   FormIds across FormSets, detached graphs, cycles and broken references
   are represented as such instead of being collapsed or guessed away. A
   single-FormSet layout whose entry Form fans out into the tabs is
   recognised as an IFR navigation hub, with its direct Refs listed as the
   current tabs in firmware order and AMITSE registration kept as
   corroboration only.
3. Cross-references conditions against known Setup/hardware/access/UI
   VarStore names to explain *why* something is hidden, not just *that* it
   is. `SuppressIf` hiding is kept separate from `GrayOutIf`/`DisableIf`
   availability, and runtime/hardware evidence is reported as evidence,
   never as a confirmed fact.
4. Lets you force a `SuppressIf` off ("Force visible" is limited to
   `SuppressIf`; other conditions stay read-only), edit a prompt's access
   level / failsafe / optimal byte, move a submenu's `Ref` to another Form,
   and - when a multi-FormSet AMITSE root vector is detected - record a
   desired Visible/Hidden state per root menu.
5. Rewrites only the bytes that changed in the original `Setup.sct`,
   `AmiTseSct.sct` and `SetupData` files (rebalancing HII Forms Package
   lengths when a move crosses packages) and produces a plain-text changelog
   alongside them.

## Using it

There are two ways to get data in.

**Complete AMI image** (top of the upload screen): select the firmware dump,
whatever its file extension. The app first runs a read-only preflight in the
browser - it locates the flash layout and firmware volumes, recursively
decompresses LZMA/Tiano sections, extracts the Setup, AMITSE and SetupData
modules, and runs IFRExtractor-RS via WebAssembly - and then reports what it
found: the container kind, every volume, the compression path each artefact
came through, how the Setup HII is laid out, and whether the image reads as
Aptio IV or V (shared structures alone are never taken as proof, so an
unresolved image stays marked as such). If the image carries more than one
coherent Setup/AMITSE/SetupData context - a redundant/dual-BIOS layout, or
several OEM navigation profiles side by side - the preflight lists every one
and requires an explicit choice before continuing; see
[`docs/ami/firmware-context-selection.md`](docs/ami/firmware-context-selection.md).
Press **Start HII analysis** to open the menu tree. A modified Setup module
cannot yet be reinserted into the image it came from, so the **UEFI files**
export stays disabled in this mode; `data.json` export still works.

**Four separate files** (manual compatibility mode): extract these with
[UEFITool](https://github.com/LongSoft/UEFITool) and
[IFRExtractor-RS](https://github.com/LongSoft/IFRExtractor-RS) yourself,
then upload. The **UEFI files** export works here for Aptio IV and V alike,
since you reinsert the patched modules with UEFITool yourself:

| File | What it is |
| --- | --- |
| Setup HII / SCT | The Setup module's PE32/SCT section |
| IFR Extractor output TXT(s) | Run IFRExtractor-RS with `verbose` on the file above |
| AMITSE PE32 / SCT | The AMITSE module's PE32/SCT section |
| Setupdata BIN | The `SetupData` freeform section body |

Once loaded, the sidebar shows the BIOS menu tree: the root menus proven by
the AMITSE table and SetupData page list, every submenu under them, and any
page that no menu reaches. Each item is coloured by its effective state:

| State | Meaning |
| --- | --- |
| Green | No active IFR gate, or the desired root state is visible |
| Red | `SuppressIf` or the AMITSE root vector hides it |
| Orange | `GrayOutIf` or `DisableIf` can make it unavailable |
| Gray | Evidence is insufficient for a stronger conclusion |
| Pink | The graph contains a broken reference |

Click a condition badge for the full expression and which VarStore it reads.
Drag the tree's right edge to resize it (the arrow keys, Home/End and a
double-click to reset work too); the width is remembered between sessions.

To move a submenu, use the move button on its tree row and choose the new
parent Form. Every Form is listed with a verdict: safe inside its Forms
Package, safe across packages (the package lengths are rebalanced at export),
needs REF3 conversion (a plain REF/REF2 cannot cross FormSets), or
unavailable with the reason - a graph cycle, a duplicate target, a hide
condition shared with other items, a scoped Ref, an unproven package. Only a
direct, non-scoped `Ref` moves, together with the hide condition it is the
sole occupant of, and the Setup HII never changes size. Like every other
edit, the bytes only move when you export.

When a single-FormSet navigation hub is detected, the top-level view lists
every page with its role: the hub, a current direct tab, a tab hidden by the
visibility toggle, an AMITSE-registered descendant, or a registered-only
page, together with the effective IFR state of its Ref: a vendor layout often
keeps AMI reference tabs under an always-true `SuppressIf`, and those count
as direct tabs that are hidden. "Visible as a tab" is structural there:
a direct tab's **Hide** button parks its Ref inside an existing, reused
constant-true `SuppressIf` scope elsewhere in the FormSet, and a hidden tab's
**Show** button moves it straight back - both fixed-size, no new opcode ever
created. The **Move…** control still relocates a tab's hub Ref under another
existing Form (demoting it), and **Not a tab · promote/move** returns a
descendant's existing Ref to the hub (promoting it); a tab hidden by the
toggle offers only Show, since it must return to the hub before it can be
moved anywhere else. AMITSE registration by itself never promotes a page, and
no FormSet or menu is ever created. See
[`docs/ami/single-formset-ifr-navigation.md`](docs/ami/single-formset-ifr-navigation.md).

When a multi-FormSet root vector is detected in the Setup PE32, the top-level
view shows each root's original, code-corroborated state next to a
desired-state button that alternates between `Visible (01)` and
`Hidden (00)`. Pressing it back to the original value removes the pending
change. These plans are saved in `data.json` and reflected in the tree, but
exporting extracted UEFI files is blocked while one is pending: the root byte
lives inside the Setup PE32, which only the (not yet available) full-image
reconstruction path can rewrite.

The header names the loaded firmware (the image, or the Setup file in
four-file mode) next to the breadcrumb of the page you are on.

The Access Level byte is really AMI's SetupData control flag byte, not a
level; its tooltip decodes the bits that are set. Across 14 reference images
no bit correlates with whether an item is actually hidden - see
[`docs/ami/setupdata-control-flags.md`](docs/ami/setupdata-control-flags.md)
for the evidence - so it is shown for reference only and never drives the
HII effect column.

`data.json` round-trips the whole session, pending plans included. A
re-uploaded file is validated against the loaded firmware's hashes, its
offset checksum and its schema before anything is applied.

If a firmware's forms cross-reference each other from an unusually large
number of paths, the menu tree stops expanding past a safety cap instead of
hanging the tab; a yellow banner in the sidebar says so when it happens.

## Development

```bash
npm install
npm run dev      # local dev server
npm run build    # production build (the .wasm decompressors/IFRExtractor are built on CI)
npm test         # vitest - parser, patching, hashing, firmware inspection and component tests
npm run lint     # eslint
```

The full-image path needs `public/ifrextractor.wasm`,
`public/firmware-decompress.wasm` and `public/tiano-decompress.wasm`. They are
built from source by `.github/workflows/deploy.yaml` and are ignored by git;
without them a local dev server still offers the four-file mode.

Deployment to GitHub Pages runs automatically on push to `main` via
`.github/workflows/deploy.yaml`.

See [`src/components/scripts/README.md`](src/components/scripts/README.md)
for how the parsing/patching code is organized.

### Corpus regression runner

If you have a local set of real firmware extracts (never commit them -
see [`docs/aptio-iv/README.md`](docs/aptio-iv/README.md)'s "Sample intake"),
you can run every one of them through the parser and classifier and get a
structured report per image instead of checking each by hand:

```bash
CORPUS_DIR=/path/to/your/corpus npx vitest run src/components/scripts/corpusRunner.node.test.ts
```

Each `<CORPUS_DIR>/<image-name>/` subdirectory holds the same four files the
"Four separate files" mode above accepts, named `setup.sct`, `amitse.sct`,
`setupdata.bin` and `setup.ifr.txt`. The run writes one JSON report per image
plus a `summary.txt` (both under `<CORPUS_DIR>/reports` by default, or
`$CORPUS_OUT`) recording Form/Ref/condition counts, the single-FormSet
navigation verdict, and - for every page in that inventory - whether Hide and
Show are available and the exact reason when they aren't. It's a diagnostic
tool only: read-only, like the app's own preflight, never patches or exports
anything. `CORPUS_DIR` unset (the default) skips it entirely, so it never
affects `npm test`/CI.
