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

Select a complete firmware dump, whatever its file extension. The app first
runs a read-only preflight in the browser - it locates the flash layout and
firmware volumes, recursively decompresses LZMA/Tiano sections, extracts the
Setup, AMITSE and SetupData modules, and runs IFRExtractor-RS via
WebAssembly - and then reports what it found: the container kind, every
volume, the compression path each artefact came through, how the Setup HII
is laid out, and whether the image reads as Aptio IV or V (shared structures
alone are never taken as proof, so an unresolved image stays marked as
such). If the image carries more than one coherent Setup/AMITSE/SetupData
context - a redundant/dual-BIOS layout, or several OEM navigation profiles
side by side - the preflight lists every one and requires an explicit choice
before continuing; see
[`docs/ami/firmware-context-selection.md`](docs/ami/firmware-context-selection.md).
Press **Start HII analysis** to open the menu tree.

If the outer byte scan already identifies the image as a definitively
non-AMI vendor (Award/Phoenix-Award, Phoenix, Insyde, legacy AMIBIOS,
embedded Linux, an Intel Management Engine region, a recognized
non-firmware file, or legacy EFI 1.10 "Framework" HII), the app skips the
AMI-only deep extraction entirely - it can only ever end in "Setup FFS was
not found" - and shows that vendor's guess, its evidence and the outer
container instead of the AMI generation/Setup-profile panel, which was
never going to apply to it. A genuinely ambiguous image (firmware volumes
present but no vendor marker visible yet, since Setup/AMITSE can still be
hidden behind encapsulation) still goes through the full AMI flow, since
that's exactly the case the deep scan exists to resolve. A Phoenix
inventory panel (see below) still appears independently of this, whichever
side of the split the image landed on.

> The manual "four separate files" upload (paste in Setup/AMITSE/SetupData
> already extracted with UEFITool + IFRExtractor-RS yourself) has been
> removed, matching upstream. That was also the only path that ever enabled
> **UEFI files** export (a modified Setup module still can't be reinserted
> into the image it came from), so exporting patched extracted files is
> presently unavailable from the UI; `data.json` still round-trips a full
> session, and the CLI corpus runner further down still accepts the same
> four-file shape directly for local diagnostics.

Below the single-image upload, **Local firmware corpus runner** lets you
select several real firmware images, press **Run local corpus analysis**,
and get a read-only report on every one of them - entirely in the browser:
nothing is patched, exported, or leaves the tab. A summary strip (files,
unique-by-hash, recognized/partial/unsupported/failed counts, extraction/
navigation/Hide-Show-editable rates) sits above a per-file accordion; each
row's badges give size, container, detected generation, Form/Ref counts and
status at a glance, and expanding it shows a per-stage pass/warning/failed/
blocked table (preflight → extraction → HII → navigation → editability →
reconstruction), the SHA-256, the navigation reason, and the full per-page
Hide/Show availability table. **Cancel** stops a run after its current file
and keeps whatever finished so far; **Clear** resets everything. Export the
whole run as JSON or as a CSV summary. It never opens any image into the
editor itself (a multi-context image is silently analysed at its default
context rather than asking you to pick), and it's a separate tool from the
CLI corpus runner further down - this one is for
"how does this whole pile of firmware look right now," the CLI one is for
scripted regression runs against a fixed local corpus.

A real-world folder of firmware dumps is never all AMI Aptio, so an image
that isn't is labelled **Unsupported** with a best-effort vendor guess -
Award/Phoenix-Award, Phoenix, Insyde H2O, legacy AMIBIOS, an Intel Management
Engine region, a recognized non-firmware file, some other/unbranded UEFI,
legacy EFI 1.10 "Framework" HII (a pre-UEFI2.0 machine whose Setup module
IFRExtractor itself reports as Framework rather than UEFI - its rough
FormSet/form/reference inventory is still shown, read-only), or embedded
Linux firmware that was never a PC BIOS at all (a router or appliance dump)
- rather than the generic **Failed** reserved for a genuinely unexpected
error (a truncated file, a worker crash, the 512 MiB safety cap). Most of
these guesses come from the same shallow byte-signature scan the AMI
preflight already runs (`src/components/scripts/amiFirmwareImage.ts`); none
of them are ever parsed further, so a guess stays a label, not a claim of
support.

Independently of that vendor guess, every image also gets a best-effort
**manufacturer** (motherboard/system vendor) lead - ASUS/HP/Intel/MSI/
ASRock/Supermicro/Gigabyte/Dell - from an exact SHA-256 match against this
repository's own documented samples, an explicit selection, a firmware-marker
byte string, or a filename token, in that precedence order (see
[`docs/ami/manufacturer-knowledge.md`](docs/ami/manufacturer-knowledge.md)
for the evidence catalogue and
[`src/components/scripts/brandKnowledge.ts`](src/components/scripts/brandKnowledge.ts)
for the logic). A brand match is a lead, never proof: the actual structural
detectors still run on every image regardless, and a match never unlocks
editing on its own - the report does say whether this image's own proven
navigation mechanism matches or departs from that brand's documented prior.

Below the summary strip, a **Compatibility by layer** dashboard turns the
whole run into read-only statistics, all measured once per distinct SHA-256
(a duplicate upload never double-counts): a per-stage pass/warning/failed/
blocked/not-run breakdown with its own eligibility rule (extraction requires
preflight to have passed, HII requires extraction, navigation/editability/
reconstruction all require HII); a **first recognition blocker** table -
which single stage first kept each distinct case from being recognized,
with example filenames; a **failure taxonomy** classifying every failure
message into a small closed set of codes (`NO_SETUP_FFS`,
`SECTION_DECODE_FAILED`, `FRAMEWORK_HII`, ...); and a **distribution of
cases** tab set breaking the same extraction/navigation/HII-edit/full-image
rates down by firmware family, IFR format, manufacturer, container and
Aptio generation. See
[`src/components/scripts/corpusDashboard.ts`](src/components/scripts/corpusDashboard.ts)
for exactly how each figure is computed and
[`src/components/CorpusRunner/CorpusDashboard.tsx`](src/components/CorpusRunner/CorpusDashboard.tsx)
for the UI.

A Phoenix-family image gets more than a vendor-guess label: the shared
preflight (`inspectAmiFirmwareBytes`) reports a read-only structural
inventory independently of AMI Aptio success or failure, so it shows up
both in the single-image upload screen and in the corpus runner - opening a
Phoenix image directly in the editor shows its inventory instead of a bare
"no valid firmware volumes" message. For legacy PhoenixBIOS 4.0 ROMs
(`BCPSYS`/`BCPFFV`/`BCPCMP` records) it walks the Flash File Volume
directory - or falls back to the older BCPSYS-linked module chain - and
lists every recovered module's name, offset, size and LH5 compression
sizes, bounds-checked at every step so a malformed directory or a corrupt
compressed section stops the walk with a warning instead of reading past
it. For a Phoenix-derived UEFI build (no BCP/FFV structures at all) it
reports the `\Phoenix\...\*.pdb` debug-path module names left in CodeView
records, flagging when `SecCore` is among them - this is module provenance
only, never a Setup-format verdict, since a real sample carried Phoenix
SecCore PDB paths alongside an unrelated Insyde copyright string in the
same image (the stronger, conflicting vendor string still wins the vendor
guess; the PDB provenance is still reported alongside it). Neither
inventory feeds editing, reconstruction, or any write path.

For a legacy PhoenixBIOS 4.0 CMOS Setup Table specifically, the single-image
upload screen goes one step further than the module inventory above: it
LH5-decompresses the Setup's `TEMPLAT.ROM`/`STRINGS.ROM` module pair and
shows the same kind of read-only screen/item tree the AMI Aptio HII menu
already gives - type, prompt, help text and a Pick Field's own option list
(e.g. `Enabled`/`Disabled`) for every entry, grouped by screen - so a
legacy Phoenix ROM's actual Setup menus are visible without Phoenix's own
BIOS Editor. This never claims a confirmed hierarchy between screens (a
real root/tab-navigation table wasn't fully recovered) and stays strictly
read-only, like everything else Phoenix-related here. See
[`docs/phoenix/README.md`](docs/phoenix/README.md) for both documented cases
and
[`src/components/scripts/phoenixFirmware.ts`](src/components/scripts/phoenixFirmware.ts)
/
[`src/components/scripts/phoenixSetupMenu.ts`](src/components/scripts/phoenixSetupMenu.ts)
for the implementation.

When an image genuinely is AMI Aptio but a compressed section still fails to
decompress, the error names exactly which one - its GUID-defined
decompression scheme (when it has one), the FFS file that owns it, and its
buffer/depth/offset/size - instead of a bare "stream rejected", so a real
corpus failure can be located directly in a byte-level tool like UEFITool
rather than hand-scanned for across a multi-megabyte image. That one bad
section no longer aborts the whole extraction either: it's recorded as a
warning on whatever firmware context was still found, so one trapped or
rejected decompressor never costs every other context's evidence.

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

The header names the loaded firmware image next to the breadcrumb of the
page you are on.

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

The app needs `public/ifrextractor.wasm`, `public/firmware-decompress.wasm`
and `public/tiano-decompress.wasm` to do anything at all - they are built
from source by `.github/workflows/deploy.yaml` and are ignored by git, and
with the manual upload removed there is no local fallback without them.

Deployment to GitHub Pages runs automatically on push to `main` via
`.github/workflows/deploy.yaml`.

See [`src/components/scripts/README.md`](src/components/scripts/README.md)
for how the parsing/patching code is organized.

### CLI corpus regression runner

For scripted/CI-style runs rather than the in-browser panel above: if you
have a local set of real firmware extracts (never commit them -
see [`docs/aptio-iv/README.md`](docs/aptio-iv/README.md)'s "Sample intake"),
you can run every one of them through the parser and classifier and get a
structured report per image instead of checking each by hand:

```bash
CORPUS_DIR=/path/to/your/corpus npx vitest run src/components/scripts/corpusRunner.node.test.ts
```

Each `<CORPUS_DIR>/<image-name>/` subdirectory holds the four files
`parseData`/`PopulatedFiles` accept directly (the Setup HII/SCT, IFR
Extractor output, AMITSE PE32/SCT and SetupData BIN), named `setup.sct`,
`amitse.sct`, `setupdata.bin` and `setup.ifr.txt`. The run writes one JSON report per image
plus a `summary.txt` (both under `<CORPUS_DIR>/reports` by default, or
`$CORPUS_OUT`) recording Form/Ref/condition counts, the single-FormSet
navigation verdict, and - for every page in that inventory - whether Hide and
Show are available and the exact reason when they aren't. It's a diagnostic
tool only: read-only, like the app's own preflight, never patches or exports
anything. `CORPUS_DIR` unset (the default) skips it entirely, so it never
affects `npm test`/CI.
