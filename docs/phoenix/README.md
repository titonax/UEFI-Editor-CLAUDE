# Phoenix firmware inventory

This editor only ever parses and edits AMI Aptio HII. For Phoenix-family
firmware it stops at a read-only inventory: which modules exist, where, how
large, and (for legacy PhoenixBIOS 4.0) whether they're LH5 compressed. For a
legacy PhoenixBIOS 4.0 CMOS Setup Table specifically, it goes one step
further and also decodes and displays the Setup screens themselves (see
[Legacy CMOS Setup Table menu](#legacy-cmos-setup-table-menu-inspectphoenixsetupmenu)
below) — but this is still read-only: nothing here ever offers to write to a
Phoenix module. See
[`phoenixFirmware.ts`](../../src/components/scripts/phoenixFirmware.ts) for
the module-inventory implementation and its bounds-checking.

## Two unrelated code paths

Phoenix firmware shows up in the corpus in two structurally unrelated shapes,
inspected independently:

### Legacy PhoenixBIOS 4.0 (`inspectPhoenixLegacyBytes`)

A `PhoenixBIOS` string plus a `BCPSYS` record (system info) and a `BCPCMP`
record (compression parameters) identify the image; the image must also be a
power-of-two size of at least 64 KiB, matching how these ROMs are laid out.
From there, two module-location strategies are tried in order:

1. **BCP/FFV directory** (modern modular ROMs). `BCPSYS` names a `BCPFFV`
   record, which points at a `volumedir.bin2` directory module. Its entries
   are matched by the real Flash File Volume GUID
   (`FED91FBA-D37B-4EEA-8729-2EF29FB37A78`); each matching entry names one FFV
   volume, walked module-by-module. Every module read is bounds-checked
   against its volume before being trusted, and a module that would overrun
   its volume stops the walk with a warning instead of reading past it.
2. **Module chain fallback** (older ROMs with no usable FFV directory).
   `BCPSYS` links directly to a singly-linked list of fixed-header modules.
   The walk carries its own cycle guard (a visited-offset set) and a hard cap
   on iterations, and stops with a warning rather than looping or reading out
   of bounds.

Either path reports the build code/date from `BCPSYS`, the declared
compression algorithm from `BCPCMP`, and each module's name, offset, size,
and — only when the compressed-section header itself checks out — its
packed/unpacked sizes. A module name that decodes to a packed `_<type><NN>`
form (for example `_E00`) is expanded to its human name (`SETUP0.ROM`) using
the same single-letter type codes Phoenix uses (`E` = Setup, `T` = Template,
`S` = Strings, and so on); anything else falls back to the raw stored name.
`inspectPhoenixLegacyBytes` returns `null` for anything that isn't a bounded,
well-formed PhoenixBIOS 4.0 image — it never guesses.

### Phoenix-derived UEFI PDB provenance (`inspectPhoenixUefiBytes`)

A genuinely UEFI-era Phoenix build has no BCP/FFV structures at all. The only
trace left in the image is a CodeView (`RSDS`) debug record naming a
`\Phoenix\...\*.pdb` module path, left over from the build process. This is
scanned for directly (capped at 64 distinct module names, with a bounded
per-candidate path scan), and reports which named modules exist and whether
one of them is `SecCore` — the earliest boot module, worth calling out
specifically since its presence is a strong provenance signal.

**This is module provenance, not a Setup-format verdict.** A PDB path proves
that particular module's toolchain, not that the image's HII/Setup
implementation is Phoenix's. A real sample in the corpus carried Phoenix
SecCore PDB paths *and* an unrelated Insyde copyright string side by side —
see [Documented cases](#documented-cases) below. Reconciling that kind of
conflicting evidence across the whole image is the corpus runner's job, not
this function's: it reports only what it actually found.

## Legacy CMOS Setup Table menu (`inspectPhoenixSetupMenu`)

The AMI Aptio side of this editor builds a full HII menu tree. The Phoenix
counterpart is the legacy PhoenixBIOS 4.0 CMOS Setup Table — the format
Phoenix's own BIOS Editor and SLIC Tool read — decoded into the same kind of
read-only screen/item inventory. See
[`phoenixSetupMenu.ts`](../../src/components/scripts/phoenixSetupMenu.ts) for
orchestration,
[`phoenixLh5.ts`](../../src/components/scripts/phoenixLh5.ts) for
decompression, and
[`phoenixSetupTable.ts`](../../src/components/scripts/phoenixSetupTable.ts)
for the format parser.

### Locating the two modules

A Setup Table is always split across two modules, `TEMPLAT.ROM` (the screen
layout) and `STRINGS.ROM` (every prompt/help string, referenced by offset).
`inspectPhoenixSetupMenu` finds them two ways, tried in order:

1. Through the already-validated `inspectPhoenixLegacyBytes` module
   inventory (see above), matching module names against `/^TEMPLAT\d+\.ROM$/i`
   and `/^STRINGS\d+\.ROM$/i`.
2. A direct `findNamedPhoenixModule` scan for a literal `TEMPLAT0.ROM` /
   `STRINGS0.ROM` FFV module header, with no `BCPSYS`/`BCPFFV` directory
   required. This covers a modern Phoenix SecureCore UEFI build that still
   carries a legacy CMOS Setup Table module pair with no BCP/FFV structures
   around it at all — the same shape `inspectPhoenixUefiBytes` already
   handles for PDB-only provenance (see above), just for the Setup Table
   itself.

Either way, both modules must resolve and both must actually be LH5
compressed sections before decompression is attempted; if either is missing,
`inspectPhoenixSetupMenu` returns `null` rather than showing a partial menu.

### LH5 decompression

Phoenix FFV modules are compressed with LH5 (classic LZSS + adaptive Huffman
coding, the algorithm behind `.lzh`/LHA archives). There's no native
JS/browser implementation and no LZH encoder anywhere in this toolchain, so
`phoenixLh5.ts` wraps the compressed module payload in a minimal synthetic
level-0 LHA archive header (method id `-lh5-`, size fields, filename, a
placeholder CRC16 accepted with `checkCrc: "warn"` since the real CRC can't
be known before decompression) and hands it to
[`@kirinsaninc/lhats`](https://www.npmjs.com/package/@kirinsaninc/lhats), a
pure-TypeScript, zero-dependency `-lh5-` decoder. Before depending on it, its
output was cross-checked byte-for-byte against 7-Zip's own read-only `Lzh`
codec (`7z i` lists it; `7z a -tlzh` fails with `E_NOTIMPL`, confirming it's
read-only) on four real compressed module payloads from the samples below.

### Setup Table format

Both `STRINGS.ROM` and `TEMPLAT.ROM` are reverse-engineered from a
BIOS-modding tutorial's hex dumps, then independently verified against real
decompressed firmware (see [Documented cases](#documented-cases)):

- **`STRINGS.ROM`**: a `STRPACK-BIOS` signature, zero padding, a language
  count and language-id table, then the string table itself. A string
  *reference* (as carried by a `TEMPLAT.ROM` item) is not the text's own
  offset — it's the offset of a 2-byte *slot* in the table; that slot holds
  the text's real offset; the text itself is a null-terminated string there.
  This double indirection was confirmed by resolving real Prompt/Help string
  pairs (e.g. `F12 Boot Menu:` and its help text) through it.
- **`TEMPLAT.ROM`**: a stream of `[type:u8][length:u8][payload…]` item
  records, where `length` is the record's total size including its own
  2-byte header. Confirmed types: `0x00`/`0x01` Pick Field (prompt + help
  refs, variable length), `0x10` Generic Text (single string ref, fixed 10
  bytes), `0x11` Information (likely a submenu container, fixed 12 bytes),
  `0x20` Date (prompt + help refs, fixed 10 bytes — the Main screen's
  companion to Time, e.g. `System Date:`/`System Time:`), `0x21` Time
  (prompt + help refs, fixed 10 bytes), `0x22`/`0x24` Action (prompt + help
  refs, fixed 18/14 bytes — a triggerable action with no editable value of
  its own, e.g. Security's `Set Supervisor Password` or Exit's `Exit Saving
  Changes`; `0x22` was previously misidentified as a second Date encoding by
  naming symmetry alone, before the root table below made its real records
  resolvable), `0x23` Free-form Hex (kept as raw bytes only — its layout
  isn't confirmed) and `0x27` Boot Device Slot (fixed 14 bytes, no prompt of
  its own — the device name isn't static text Phoenix could store at
  ROM-build time, since it depends on what's plugged in at boot). Every
  field beyond what's named above is kept as `rawBytes` rather than guessed
  at — except a Pick Field's own **option list**: a packed array of string
  references filling the record from `+16` to its own end (so a 20-byte
  record carries 2 options, a 32-byte one up to 8). Confirmed against real
  `Enabled`/`Disabled`, memory-size and mode-name option lists across two
  independent firmware samples, and matches the tutorial's own worked
  example byte-for-byte (its `CA 05`/`CC 05` fields at the same +16 offset,
  left unlabeled there). An unused trailing slot (a `0` reference, or one
  that doesn't resolve to a string) is left out of `PhoenixSetupItem.options`
  rather than shown as a blank entry.

**Items live behind a root/tab table — not, as an earlier version of this
document claimed, purely as contiguous runs.** That earlier claim ("an
earlier hypothesis... turned out to be a byte-offset counting error") was
itself wrong: it came from a *generalized, blind scan* for the table's shape
that produced too many false positives to trust, not from checking the
table's real, fixed location. `parsePhoenixRootTable` reads it directly, at
a **fixed** `TEMPLAT.ROM` field — Phoenix BIOS Editor offset `0x0068`
(`+4` for the raw decompressed-buffer offset, like every pointer below) —
confirmed as the standard location across two independent, unrelated
samples of the same laptop family (a pristine factory image and a later,
differently restructured one). That field holds a pointer to an array of
`(labelPointer, contentPointer)` pairs, one per real Setup tab, terminated by
a `(0, 0)` pair:

- **`labelPointer`** resolves (`+4`) to a Generic Text or Information item
  whose string reference is the tab's real name — `Information`, `Main`,
  `Security`, `Advanced`, `Advanced2`, `Intel`, `Boot`, `Exit` on the
  cross-validation samples.
- **`contentPointer`** resolves (`+4`) to a list of `(itemPointer, 0x0000)`
  pairs, one per item actually shown on that tab, terminated by an
  `itemPointer` of `0`. Each `itemPointer` resolves (`+4`) to a full item
  record — **elsewhere** in `TEMPLAT.ROM`, not contiguous with the content
  list or with each other. This is exactly why `scanPhoenixSetupSections`'s
  contiguous-run heuristic can't recover a tab's real membership on its
  own: a tab's items are interleaved with other tabs' and sub-menus' own
  items, not laid out back-to-back. Confirmed item-for-item on both
  cross-validation samples — e.g. `Information`'s 13 entries resolve to
  exactly `CPU Type:`, `CPU Speed:`, … `UUID:`, the real System Information
  screen, and `Exit`'s 6 entries resolve to `Exit Saving Changes`, `Exit
  Discarding Changes`, `Load Setup Defaults`, `Discard Changes`, `Save
  Changes` plus one separator.

`buildPhoenixSetupMenu` prefers this root table when it's present
(`PhoenixSetupMenu.source === "root-table"`, each section's `name` set to
its real tab name), and falls back to `scanPhoenixSetupSections`'s unnamed
contiguous-run scan (`source === "contiguous-scan"`, `name: null`) only when
it isn't — e.g. the Acer sample referenced elsewhere in this document, which
reads back `0` at the fixed field and uses a different, earlier-investigated
addressing scheme instead.

### Known limitations

- **The root table isn't universal.** A firmware that doesn't use the fixed
  `0x0068` field (or had it patched to point elsewhere) falls back to the
  unnamed contiguous-run scan, with the same tab-membership blind spot the
  root table exists to fix.
- **A callback-based visibility mechanism exists and this parser can't
  evaluate it.** See
  [Menu visibility: a real, confirmed callback mechanism](#menu-visibility-a-real-confirmed-callback-mechanism)
  below. Some items are gated at Setup-render time by embedded x86 code this
  parser has no way to execute, so its item inventory can include an item a
  real, unmodified BIOS would actually keep hidden.

### Menu visibility: a real, confirmed callback mechanism

An earlier version of this document claimed a specific flag-plus-callback
visibility mechanism (reported from an unrelated chat transcript, not this
codebase) didn't check out against the real original/modified ROM pair in
[Documented cases](#documented-cases). That check was wrong, for two
correctable reasons, and the mechanism is now confirmed byte-for-byte and
disassembled instruction-for-instruction:

1. **Offset base mismatch.** Phoenix BIOS Editor / Phoenix SLIC Tool strips
   a 4-byte `[u16 totalSize][u16 marker = 0x0019]` LH5-container header when
   it extracts `TEMPLAT0.ROM`/`STRINGS0.ROM` for editing — this is a generic
   framing byte-count present on every LH5-packed Phoenix resource
   (confirmed on `TEMPLAT.ROM`, `STRINGS.ROM` *and* `SETUP0.ROM` across three
   independent real samples), not something specific to the Setup Table
   format. This codebase's own LH5 decompression (`phoenixLh5.ts`) doesn't
   strip it, since nothing in this parser needs to. Any offset quoted
   against a PBE-extracted file — including the tutorial PDF's own worked
   example and the transcript above — is exactly 4 less than the equivalent
   offset into this codebase's raw decompressed buffer.
2. **Wrong file pair.** The transcript's offsets describe the transition
   from a genuinely pristine build to a patched one. `110_MFG.ROM` (despite
   its name) was **already patched** relative to that pristine state — the
   patch had already landed by the time it was captured. Comparing it
   against `110_MOD.ROM` (the user's own further edit, made on top of the
   already-patched `110_MFG.ROM`) shows no change at that address, because
   there was nothing left to change there. `ORIGINAL.bin` — a third real
   sample of the same laptop platform (same PDB build paths), added to this
   investigation later — is the genuinely pristine build, and diffing it
   against `110_MFG.ROM` shows exactly the transition described.

With both corrections applied, every specific claim resolves exactly:

- `TEMPLAT0.ROM + 0x110D` (PBE-relative) → this codebase's raw offset
  `0x1111`: a `Generic Text` item record (`10 0a 34 05 00 00`) whose string
  reference is `0x0534` — matching the transcript's claimed pointer exactly.
  `resolvePhoenixString` on that reference returns `"Intel"`.
- `TEMPLAT0.ROM + 0x3F65` (PBE-relative) → raw offset `0x3F69`: real,
  disassembled 8086 machine code (confirmed with Capstone, 16-bit real
  mode), not filler:
  ```
  3f69  push bp
  3f6a  mov bp, sp
  3f6c  call 0x3f71
  3f6f  pop bp
  3f70  retf
  3f71  push dx
  3f72  mov ax, 0x231        ; NVRAM token 0x0231
  3f75  call 0x5c4e          ; read-token helper
  3f78  pop dx
  3f79  cmp al, 1
  3f7b  je   0x3f7f          ; token == 1 -> keep checking
  3f7d  jmp  0x3f8f          ; token != 1 -> hide
  3f7f  xor  ax, ax
  3f81  lcall 0xf000, 0x4b6d ; far call into the main BIOS
  3f86  test al, 4           ; bit 0x04
  3f88  jne  0x3f8f          ; bit set -> hide
  3f8a  mov  ax, 0           ; "show" path: return 0
  3f8f  mov  ax, 0x0013      ; "hide" path: return 0x13 (ORIGINAL.bin)
                              ;              return 0x0000 (110_MFG.ROM / 110_MOD.ROM)
  3f92  ret
  ```
  This is exactly the OR'd condition the transcript described (NVRAM token
  `0x0231 != 1`, or bit `0x04` of a far call into `F000:4B6D`), reading the
  token via a helper at `0x5c4e` and the RAM state via a genuine far call
  into the platform's core BIOS segment.
- `TEMPLAT0.ROM + 0x3F8C` (PBE-relative) → raw offset `0x3F90`: not a
  separate data flag — it's the **low byte of the `mov ax, imm16` immediate
  operand on the "hide" path's own return instruction**, at `0x3f8f`-`0x3f91`
  above. `ORIGINAL.bin` has `13 00` there (hide path returns `0x0013`);
  `110_MFG.ROM` and `110_MOD.ROM` both have `00 00` (hide path returns `0`,
  identically to the show path, making the whole condition inert). The
  "patch" described in the transcript is a **machine-code edit**, not a
  data/config toggle: overwriting the immediate operand of an existing
  instruction so both branches of the callback return the same value.

So Phoenix *does* have a genuine, `SuppressIf`-style conditional visibility
mechanism — just implemented as inline embedded 8086 machine code the Setup
engine calls at render time (reading NVRAM tokens and live BIOS RAM state),
not as a declared expression evaluated against static operands the way AMI
Aptio's HII does it. This coexists with a second, unrelated, purely
structural mechanism confirmed separately in the same firmware: the
"Keyboard auto-repeat rate:" and "Set User Password" items are revealed by
populating an empty slot in a pre-item reference region with a copy of that
item's own string reference (no code involved for those two). Both are real;
neither is universal — different items in the same ROM use different gates.

**What this means for the shipped parser.** This parser has no x86
interpreter and does not attempt to evaluate these callbacks — doing so
safely and generally is a much larger undertaking than a static byte parser.
Concretely, this means an item like `"Intel"` above, whose embedded callback
would make it runtime-invisible on an unpatched Setup, still shows up in
this tool's inventory: the parser reports every item record it can reach
structurally, not only the ones a live BIOS would actually render. That is a
real, working-as-verified limitation now, not an unproven one — replacing
this document's earlier, incorrect claim that no such condition mechanism
exists in this format at all. Locating *which* items carry such a callback
(and where its address is stored — not yet identified) is a natural next
step, not yet done.

The pre-item reference region discussed in an earlier revision of this
section (the one holding the "Keyboard auto-repeat rate:"/"Set User
Password" reveal slots) is unrelated to this callback mechanism — it's a
separate table, and remains only partially understood (see this file's git
history for that narrower investigation if useful); this section now focuses
on the callback mechanism, which is the one with full, exact confirmation.

## Documented cases

| Case | Evidence | What was verified |
| --- | --- | --- |
| Acer PhoenixBIOS 4.0 sample | `PhoenixBIOS 4.0 Release 6.1` string, `BCPSYS`/`BCPFFV`/`BCPCMP` records, one FFV volume matched by the real Flash File Volume GUID | BCP/FFV directory walk correctly resolves the FFV volume and enumerates its Setup, template and strings modules with LH5 compression sizes; its `ACPI1.ROM` module's real LH5 body is used verbatim as a decompression test fixture in [`phoenixLh5.test.ts`](../../src/components/scripts/phoenixLh5.test.ts) |
| Lenovo Flex 2 sample | `RSDS` debug record naming `...\Phoenix\SecCore\Sec\SecCore.pdb`, alongside an unrelated Insyde copyright string elsewhere in the same image | PDB provenance is reported independently of, and can coexist or conflict with, other vendor evidence in the same image — never collapsed into a single family verdict |
| A laptop's original/modified BIOS pair, plus a third pristine sample of the same platform | `110_MFG.ROM`/`110_MOD.ROM` (a real user edit) and `ORIGINAL.bin` (same laptop platform — identical PDB build paths — genuinely pristine, unlike `110_MFG.ROM` despite its name), all carrying a legacy CMOS Setup Table | Decompressing and diffing all three confirmed the Setup Table format above end to end, including how a hidden chipset debug menu ("Intel") was made visible by relabeling a placeholder section and wiring its item-list linkage. A deeper follow-up disassembled the actual embedded 8086 callback (via Capstone) that conditionally hides the "Intel" item — reading an NVRAM token and a live BIOS RAM bit — and confirmed, byte-for-byte and instruction-for-instruction, exactly how patching its machine code neutralizes the condition; see [Menu visibility: a real, confirmed callback mechanism](#menu-visibility-a-real-confirmed-callback-mechanism) above. A further follow-up located and fully decoded the root/tab table on both `ORIGINAL.bin` (6 tabs: Information, Main, Security, Intel, Boot, Exit) and `110_MFG.ROM`/`110_MOD.ROM` (8 tabs — Advanced/Advanced2 split out of the same content), confirming every tab's real name and its full, non-contiguous item membership item-for-item; see [Setup Table format](#setup-table-format) above |

The Acer case and the module-discovery/decompression pipeline are exercised
by
[`phoenixFirmware.test.ts`](../../src/components/scripts/phoenixFirmware.test.ts),
[`phoenixLh5.test.ts`](../../src/components/scripts/phoenixLh5.test.ts) and
[`phoenixSetupMenu.test.ts`](../../src/components/scripts/phoenixSetupMenu.test.ts).
The Setup Table format itself (string double indirection, item record types,
sequential section scanning) is exercised with synthetic-but-structurally-
real fixtures in
[`phoenixSetupTable.test.ts`](../../src/components/scripts/phoenixSetupTable.test.ts) —
synthetic because reproducing a full screen's worth of real compressed data
as a literal test fixture isn't practical, unlike the small LH5 body excerpts
used elsewhere.

## Where this is computed

The module inventory (`inspectPhoenixLegacyBytes` / `inspectPhoenixUefiBytes`)
is called from `inspectAmiFirmwareBytes` in
[`amiFirmwareImage.ts`](../../src/components/scripts/amiFirmwareImage.ts) —
the same shallow, synchronous preflight every caller already runs — each
gated behind a cheap signature hit first (a `PhoenixBIOS` string for the
legacy inventory, a `\Phoenix\` path segment plus at least one valid firmware
volume for the PDB scan) so an image that is nothing like Phoenix never pays
for either bounded walk. The result is attached to the preflight's own report
(`report.phoenixLegacy` / `report.phoenixUefi`) and to its `container`
(`"phoenix-rom"` for a legacy ROM) and `vendorGuess` (`"phoenix"` /
`"phoenix-uefi"` family) — computed once, available to every caller, rather
than recomputed per screen. A validated legacy FFV/module-chain directory is
treated as stronger evidence than a bare vendor string; the PDB-only case is
only reached once nothing stronger (Award, Insyde, a validated Phoenix
legacy directory) already matched, so it never overrides a conflicting
vendor string — see [Documented cases](#documented-cases) above for exactly
that scenario.

`inspectPhoenixSetupMenu`, by contrast, is never part of that synchronous
preflight: decompressing two LH5 modules is genuinely async, unlike every
other Phoenix check here. It's called directly by the single-image upload
screen (see below) right after the preflight resolves, and only when that
preflight's own `amiAptioCandidate` came back false — a real AMI Aptio image
is never also a legacy Phoenix Setup Table, so this never runs for one.

## Where this is surfaced

Both the single-image upload screen
([`BiosImageUpload.tsx`](../../src/components/BiosImageUpload/BiosImageUpload.tsx))
and the **Local firmware corpus runner**
([`CorpusRunner.tsx`](../../src/components/CorpusRunner/CorpusRunner.tsx))
read the module inventory straight off the shared preflight, independently
of AMI Aptio success or failure — a Phoenix image is never forced through the
Aptio HII pipeline, and opening one directly in the editor shows its
inventory instead of a bare "no valid firmware volumes" message. The upload
screen shows an Alert with the module table or the PDB provenance; the
corpus runner's accordion entry gets a `Phoenix` badge, its file details
panel shows the same table/provenance (plus any bounds/corruption warnings),
and its CSV export carries `phoenix_legacy_format`,
`phoenix_legacy_module_count` and `phoenix_uefi_debug_modules` columns.

A real Setup Table find is itself Phoenix evidence - as good as
`inspectPhoenixLegacyBytes`'s own BCPSYS/BCPFFV-anchored one - so it's
folded into the same `report.vendorGuess`/`report.container` the outer
preflight already computes: an image with no BCP/FFV directory to walk
(only `findNamedPhoenixModule`'s standalone `_T00`/`_S00` pair) still gets
the `VendorSummary` panel instead of a nonsensical "AMI Aptio — generation
unresolved" one once its Setup Table resolves.

The Setup Table menu itself is currently wired into the single-image
upload screen only, laid out the same way the AMI editor is: a screen list
on the left (`NavLink` per screen, the first one selected by default) and
the selected screen's item table on the right (type/prompt/help/options),
using the same Mantine table components the AMI Aptio HII tree already
uses elsewhere in the same screen. When the image carries a root/tab table
(see [Setup Table format](#setup-table-format) above), the screen list shows
the image's own real tab names and a "Real tab names (root table)" badge;
otherwise it falls back to generic "Screen N" labels in scan order, same as
before. A `Generic Text`/`Information` row (a confirmed in-line group label,
not a regular question) renders in bold rather than being hidden or given a
synthesized section title it hasn't earned. A Pick Field's option list is a
real `Select`, not just a read-only column - **its selection is genuinely
changeable**, but only ever held in this browser tab's own React state. It
is not yet wired into the corpus runner — a natural follow-up, not yet
requested.

**Nothing selected in that dropdown is written anywhere.** Turning a
selection into a rebuilt, flashable ROM needs re-compressing the edited
`TEMPLAT.ROM` back into LH5 and re-inserting it at the right offset - and
no LH5 encoder exists for this: `@kirinsaninc/lhats` (used for
decompression) is read-only by design, and the only compressor found on
npm (`lzh`) is a native Node C++ addon, unusable in a browser. Writing one
from scratch (a real LZSS + adaptive-Huffman encoder, validated
byte-for-byte against real compressed samples before it's trusted with
anything meant for real hardware - the tutorial's own warning about a
bricked machine if the rebuilt size doesn't fit isn't hypothetical) is a
distinct, substantially larger effort than reading the format, not yet
attempted.
