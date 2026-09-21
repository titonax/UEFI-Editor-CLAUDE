# Phoenix firmware inventory

This editor only ever parses and edits AMI Aptio HII. For Phoenix-family
firmware it stops at a read-only structural inventory: which modules exist,
where, how large, and (for legacy PhoenixBIOS 4.0) whether they're LH5
compressed. It never decodes a Setup, template or string module, and never
offers to write to one. See
[`phoenixFirmware.ts`](../../src/components/scripts/phoenixFirmware.ts) for
the implementation and its bounds-checking.

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

## Documented cases

| Case | Evidence | What was verified |
| --- | --- | --- |
| Acer PhoenixBIOS 4.0 sample | `PhoenixBIOS 4.0 Release 6.1` string, `BCPSYS`/`BCPFFV`/`BCPCMP` records, one FFV volume matched by the real Flash File Volume GUID | BCP/FFV directory walk correctly resolves the FFV volume and enumerates its Setup, template and strings modules with LH5 compression sizes |
| Lenovo Flex 2 sample | `RSDS` debug record naming `...\Phoenix\SecCore\Sec\SecCore.pdb`, alongside an unrelated Insyde copyright string elsewhere in the same image | PDB provenance is reported independently of, and can coexist or conflict with, other vendor evidence in the same image — never collapsed into a single family verdict |

Both cases are exercised by
[`phoenixFirmware.test.ts`](../../src/components/scripts/phoenixFirmware.test.ts).

## How the corpus runner surfaces this

When either inventory is present, the corpus runner shows it independently of
AMI Aptio success or failure — a Phoenix image is never forced through the
Aptio HII pipeline. The accordion entry gets a `Phoenix` badge, the file
details panel lists the recovered modules (and any bounds/corruption
warnings) or the PDB-derived module names, and the CSV export carries
`phoenix_legacy_format`, `phoenix_legacy_module_count` and
`phoenix_uefi_debug_modules` columns. None of this feeds editing,
reconstruction, or any write path.
