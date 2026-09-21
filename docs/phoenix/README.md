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
  `0x21` Time (prompt + help refs, fixed 10 bytes), `0x22` Date (fixed 18
  bytes seen; not fully decoded beyond its header) and `0x23` Free-form Hex
  (kept as raw bytes only — its layout isn't confirmed). Every field beyond
  what's named above is kept as `rawBytes` rather than guessed at.

**Items are laid out sequentially, not through pointer indirection.** An
earlier hypothesis — that a root/navigation table holds pointers to each
screen's item list — turned out to be a byte-offset counting error; the real
layout is long, contiguous runs of back-to-back item records ("screens"),
separated by non-item data (confirmed to include embedded x86 executable
code stubs between screens in real firmware).
`scanPhoenixSetupSections` finds these runs directly: at each candidate
offset it counts how many consecutive bytes frame as valid item records
(bounded by a small lookahead window), keeps the longest run found, and — if
that run has at least 5 items — treats it as one screen and continues
scanning after it; otherwise it advances one byte and retries. This sidesteps
actually locating the root/tab-navigation table, at the cost of a known
limitation below.

### Known limitations

- **Screen names aren't resolved.** The root table linking each screen to its
  own tab title (`Main`, `Security`, `Boot`, …) was never cracked for the
  real samples this was verified against, so the UI labels screens
  generically ("Screen 1", "Screen 2", …) in scan order rather than by their
  real tab name.
- **No menu-visibility condition mechanism was found.** AMI Aptio HII has an
  explicit `SuppressIf`-style expression that can hide a form/question.
  Nothing equivalent turned up in the Phoenix Setup Table format while
  reverse-engineering it against the samples below — including the modified
  pair, where making a hidden "Intel" menu visible again was done by editing
  a section's own label and wiring its item-list linkage back in, not by
  flipping a separate visibility flag/expression. Visibility here appears to
  be purely structural: an item is part of the inventory if and only if it's
  in a section's contiguous, reachable run. If a real sample turns up a
  counterexample, this note (and the parser) should be revisited — it isn't
  a claim that no such mechanism can ever exist in this format, only that
  none was found in what was actually inspected.

## Documented cases

| Case | Evidence | What was verified |
| --- | --- | --- |
| Acer PhoenixBIOS 4.0 sample | `PhoenixBIOS 4.0 Release 6.1` string, `BCPSYS`/`BCPFFV`/`BCPCMP` records, one FFV volume matched by the real Flash File Volume GUID | BCP/FFV directory walk correctly resolves the FFV volume and enumerates its Setup, template and strings modules with LH5 compression sizes; its `ACPI1.ROM` module's real LH5 body is used verbatim as a decompression test fixture in [`phoenixLh5.test.ts`](../../src/components/scripts/phoenixLh5.test.ts) |
| Lenovo Flex 2 sample | `RSDS` debug record naming `...\Phoenix\SecCore\Sec\SecCore.pdb`, alongside an unrelated Insyde copyright string elsewhere in the same image | PDB provenance is reported independently of, and can coexist or conflict with, other vendor evidence in the same image — never collapsed into a single family verdict |
| A laptop's original/modified BIOS pair | An original ROM and two user-modified copies of it, all carrying a legacy CMOS Setup Table | Decompressing and diffing all three confirmed the Setup Table format above end to end, including how a hidden chipset debug menu ("Intel") was made visible by relabeling a placeholder section and wiring its item-list linkage — see [Known limitations](#known-limitations) above for what this did and didn't show about menu visibility |

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

The Setup Table menu itself is currently wired into the single-image upload
screen only: it shows as a `Phoenix Setup menu` badge plus a per-screen
accordion (type/prompt/help table) once decompression and parsing resolve,
using the same Mantine accordion/table components the AMI Aptio HII tree
already uses elsewhere in the same screen. It is not yet wired into the
corpus runner — a natural follow-up, not yet requested.

None of this — module inventory or Setup Table menu alike — feeds editing,
reconstruction, or any write path.
