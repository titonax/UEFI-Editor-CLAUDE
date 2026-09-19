# Firmware-context selection

Modern AMI images can contain more than one valid copy of Setup, AMITSE and
SetupData (a redundant/dual-BIOS layout, or several OEM navigation profiles
shipped side by side). A GUID identifies a module type; it does not identify
the active firmware slot. Selecting the first occurrence the extractor
happens to reach could silently combine Setup from one copy with policy data
from another.

Ported from `titonax/uefi-editor-gpt`'s PR #40 ("Keep repeated AMI firmware
contexts coherent"), adapted to this fork's own extraction pipeline (a Web
Worker with a hard extraction timeout, and dependency-injectable
decompression for tests/tooling - see `aptioIvExtractor.ts`'s own
`FirmwareDecompressor` parameter).

## Selection model

`extractAptioIvBytes`/`extractAptioIvArtifacts` no longer stop at the first
Setup FFS file found: they enumerate every one, then pair each with its best
AMITSE/SetupData companion, ranked in this order:

1. same decoded buffer and same firmware volume;
2. same decoded buffer;
3. one unambiguous shared encapsulation branch (deeper than just the source
   image itself).

If two companions tie for the best provenance, neither is attached - the
context is marked `setup-only` for that companion rather than guessed. Every
usable Setup occurrence becomes a firmware-context candidate
(`AptioIvArtifacts.artifactSets`), and the caller picks one via
`AptioIvExtractionOptions.artifactSetId` (defaulting to the first when
omitted).

If more than one context is found, `BiosImageUpload.tsx` requires an
explicit selection before "Start HII analysis" unlocks: a `NativeSelect`
lists every context's label, coherence and any warnings, and the worker is
re-run (or a cached result reused) for whichever one is chosen. This is
strictly additive to the existing single-context flow - a firmware with
exactly one coherent Setup context still auto-selects it, unchanged from
before this feature.

## Verification

Re-running this fork's own corpus (Supermicro H14SHM/H14SSL, both server
boards carrying dual-BIOS-shaped layouts) through the ported code found
exactly one coherent context for each of the two cached images - the
multi-context path was not independently reproduced against a real image in
this fork's own testing, unlike GPT's own claimed dual-copy evidence. The
selection and no-mixing logic itself is directly unit-tested instead
(`aptioIvExtractor.test.ts`'s "keeps duplicated firmware slots coherent and
selects them explicitly" fabricates two complete, concatenated Setup/AMITSE/
SetupData sets in one image and confirms both are found, correctly paired,
and independently selectable). Treat the multi-context UI as validated by
construction, not yet by an observed real-world duplicate in this fork's own
corpus.

This phase does not decide which redundant slot the platform will boot, nor
does it enable complete-image writing. It prevents cross-slot analysis and
preserves the information required for later reconstruction and slot-aware
editing.
