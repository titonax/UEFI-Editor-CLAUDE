# Manufacturer evidence catalogue

The manufacturer can help choose which firmware structures to investigate,
including when the exact model is unknown. It is an observation about our
documented corpus, never proof that another image has the same architecture.
The complete structural analysis still runs for every input. Editing and
full-image writing remain subject to their own checks.

## Evidence and precedence

The application records _why_ it associated an input with a manufacturer:

| Evidence        | Meaning                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| Exact SHA-256   | Same supplied image or extracted payload as a documented sample          |
| User selection  | Manufacturer supplied for this particular file; the model can be unknown |
| Firmware marker | A recognizable vendor string in the input bytes, with its offset         |
| Filename        | A manufacturer token in the selected file's name                        |

This is the precedence order. All signals are exported, including disagreeing
lower-priority signals. Multiple different brands at the strongest available
level leave the manufacturer unresolved. An explicit selection takes priority
over weaker automatic clues, while disagreement remains visible in the report.
No marker on its own establishes a firmware generation or navigation mechanism.

## Current observations

The catalogue contains **13 identified image or payload hashes** drawn from
the repository's existing metadata-only sample records:

| Manufacturer   | Samples | Aptio generation documented  | Observed input containers                                                       | Proven top-level navigation         |
| -------------- | ------: | ----------------------------- | --------------------------------------------------------------------------------- | ------------------------------------ |
| ASUS           |       5 | IV in 3 samples              | Vendor images                                                                    | Single-FormSet IFR hub in 2 samples |
| HP             |       3 | IV in 3 samples              | 2 Intel flash images, 1 firmware-volume image                                   | Not yet catalogued                  |
| Intel (NUC)    |       1 | Not yet catalogued           | Firmware-volume image, despite `.CAP` extension                                 | Single-FormSet IFR hub in 1 sample  |
| MSI            |       2 | IV in 2 samples              | 1 Intel flash image, 1 vendor image                                             | Not yet catalogued                  |
| ASRock         |       1 | Not yet catalogued           | Intel flash image                                                               | Not yet catalogued                  |
| Supermicro     |       1 | IV in 1 sample               | Intel flash image                                                               | Not yet catalogued                  |
| Dell, Gigabyte |       0 | Not yet catalogued           | No extracted payload hash in this catalogue yet                                 | Not yet catalogued                  |

An Intel NUC's support page listing it under a motherboard partner's site does
not make it that partner's board: its browser preflight identifies it as a
firmware-volume image despite a `.CAP` extension, and a validated outer
firmware volume carrying the AMI FID GUID, a `$FID` record and an `INTEL`
vendor field supplies an internal manufacturer clue independent of any single
sample hash (see `intelFidMarker` in
[`amiFirmwareImage.ts`](../../src/components/scripts/amiFirmwareImage.ts)).

The per-sample source paths and hashes are in
[`brandKnowledge.ts`](../../src/components/scripts/brandKnowledge.ts). The
ASUS hub evidence comes from
[`single-formset-ifr-navigation.md`](single-formset-ifr-navigation.md). The
other samples are in the HP, Supermicro and cross-vendor records under
[`docs/aptio-iv/samples`](../aptio-iv/samples). Samples without a verified
navigation observation contribute to manufacturer/container counts, not to a
navigation prediction. For example, five ASUS images do **not** mean five
confirmed single-FormSet hubs.

## How a new image is treated

1. Identify manufacturer clues and record their provenance, with or without a
   model name. If the clues are absent or ambiguous, keep the manufacturer
   unknown; the user can select it explicitly.
2. Show the catalogue's measured Aptio generations, containers, layouts and
   navigation mechanisms for that brand as leads, with sample counts.
3. Run the existing container, firmware-volume, HII and navigation detectors on
   the **actual image**. Compare structurally proven navigation with the lead;
   report a matching or new pattern when both sides have evidence.
4. Keep editing and reconstruction decisions tied to the actual image's
   structural proof and provenance. A brand match never unlocks a write path.

The corpus runner surfaces these leads per file (a manufacturer badge, its
evidence basis, and whether the observed navigation mechanism matches or
departs from the brand's documented prior); it does not reorder detectors or
learn new patterns automatically.

## Growing the catalogue

Add a new case only after recording the exact analyzed payload hash, source
record, container evidence, and separately verified layout/navigation results.
An unexpected pattern is valuable evidence for another architecture, rather
than a reason to force the existing rule onto that image. Keep the source
metadata and regression sample descriptions reviewable without committing
firmware binaries or user-specific data.

An **Add case** flow would require an explicit ingestion and review process for
new evidence before it could amend the shipped catalogue. It is not part of
this version.
