# HP IPISB-CH2 / W25Q32 Aptio IV sample

> Metadata-only research record. The original firmware image is intentionally not stored in this repository.

## Image identity

| Field | Value |
|---|---|
| Original filename | `IPISB-CH2-W25Q32_20170616_155538.BIN` |
| Size | 4,194,304 bytes (`0x400000`) |
| SHA-256 | `6d18c962f3ffa6b941ada4e6fa71be4cdf1e7ff8297f5f4a4b73e29969f350a9` |
| Firmware family | AMI Aptio IV |
| Platform marker | `SECURE_HP_SIGNATURE AB5 v07.09` |
| Internal date string | `07/22/2011` |
| Analysis policy | Parse/read-only; writing is disabled until reconstruction is proven safe |

The `20170616` portion of the filename appears to be the dump date, not the firmware build date.

## Intel flash layout

| Region | Range |
|---|---|
| Flash descriptor | `0x000000–0x001000` |
| GbE | `0x001000–0x003000` |
| Intel ME | `0x003000–0x200000` |
| BIOS | `0x200000–0x400000` |

## Firmware volumes

All detected volumes use firmware filesystem GUID `7A9354D9-0468-444A-81CE-0BF617D890DF`.

| Range | Purpose |
|---|---|
| `0x220000–0x230000` | NVRAM; includes `AMITSESetup` and `SetupCpuFeatures` |
| `0x230000–0x240000` | Redundant NVRAM |
| `0x240000–0x3A0000` | Main DXE/application volume |
| `0x3A0000–0x400000` | PEI/recovery/reset volume |

## Relevant modules and extracted bodies

| Artifact | GUID / source | Size or range | Result |
|---|---|---|---|
| Setup FFS | `899407D7-99FE-43D8-9A21-79EC328CAC21` | `0x35E8E8–0x371E51` | FFS checksum valid |
| Setup PE32 | Setup FFS PE32 section | 49,088 bytes | Does not contain the classic IFR payload |
| Setup HII package body | Freeform subtype `97E409E6-4CC1-11D9-81F6-000000000000` | 289,831 bytes | Contains 12 language packages and IFR |
| AMITSE FFS | `B1DA0ADF-4F77-4070-A88E-BFFE1C60529A` | `0x31EE38–0x34E1E5` | FFS checksum valid |
| AMITSE PE32 | AMITSE FFS PE32 section | 332,512 bytes | Aptio IV menu/application data |
| AMITSE HII body | Freeform subtype `97E409E6-4CC1-11D9-81F6-000000000000` | 104,030 bytes | HII resources |
| SetupData body | Freeform subtype `FE612B72-203C-47B1-8560-A66D946EB371` | 94,912 bytes | Starts with Aptio IV `$SPF` signature |

## IFR extraction results

Extraction was verified with UEFIExtract alpha 76 and IFRExtractor-RS 1.6.1.

- The Setup HII body produces 11 English IFR text outputs.
- The extracted HII SHA-256 recorded by IFRExtractor-RS is `ae5c40e72e05c27b330f2813916e827456dc31db05639f3cf5b973a4961a678e`.
- 11 form sets were detected: Main, Advanced, Chipset, Boot, Security, Save & Exit, File, Storage, Security, Power, and a second Advanced form set.
- The outputs contain 78 forms in total.
- Conditional visibility is extensive: the data includes hundreds of `Suppress If` and `Gray Out If` opcodes.

## SetupData matching

The existing Aptio V matching strategy was tested against the Aptio IV `$SPF` body.

| Type | Total | Unique matches | Ambiguous | Missing |
|---|---:|---:|---:|---:|
| Ref | 85 | 85 | 0 | 0 |
| String | 11 | 11 | 0 | 0 |
| Numeric | 93 | 93 | 0 | 0 |
| CheckBox | 309 | 112 | 196 | 1 |
| OneOf | 280 | 280 | 0 | 0 |

Ambiguous or missing entries must remain non-editable until an additional Aptio IV discriminator is implemented.

## Compatibility conclusions

The existing editor model and frontend are largely reusable, but the Aptio V file assumptions are not.

| Existing Aptio V input | Aptio IV equivalent in this sample |
|---|---|
| Setup SCT | Setup HII body with subtype GUID `97E409E6-...` |
| Single IFR TXT | 11 IFR TXT outputs, combined in stable numeric order |
| AMITSE SCT | AMITSE PE32 body |
| `setupdata.bin` | `FE612B72-...` SetupData body beginning with `$SPF` |

The upload UI now accepts multiple IFR TXT files and combines them internally while preserving the original single-file Aptio V path. Menu discovery now considers every parsed FormSet instead of retaining only the final one.

## Current compatibility state

- Read/parse path: **validated end-to-end in the browser** (see below).
- Aptio IV identification and extraction mapping: confirmed for this sample.
- Multiple IFR and FormSet input: implemented.
- Export/reinsertion: not implemented.
- Firmware writing/flashing: deliberately disabled.

## Browser validation (2026-08-30)

Ran this exact image through the full "Full Aptio IV image" one-shot upload
path in a real browser (recursive extraction -> parseData -> menu tree),
using the actual CI-built WASM binaries, not a mock. Confirmed the app
reaches the loaded menu tree: 78 forms, "AMI full profile" detected with
Main/Advanced/PCI Subsystem Settings/CPU Configuration/... all present,
matching the 78-form, 11-form-set count already recorded above.

This surfaced a real bug in the browser-side state wiring (unrelated to
extraction/parsing correctness): `App.tsx`'s `setLoadedData` wrapper
discarded the very first data assignment when the app's `data` state was
still `null`, so the initial parse silently never reached the UI - no
error, extraction and parseData both completed correctly. Fixed in
`src/loadedData.ts` (`applyLoadedData`). See the "Read/parse path" item
above; this was the last blocker for item 1 in the "Next steps" list.

## Next steps

1. ~~Run the complete browser parser against all four Aptio IV equivalent inputs.~~ Done (2026-08-30).
2. Add a safe representation for ambiguous SetupData matches.
3. Identify the additional discriminator needed by repeated CheckBox records.
4. Validate the Aptio IV AMITSE menu table and menu editing offsets.
5. Implement reconstruction and reinsertion only after byte-for-byte round-trip tests pass.
