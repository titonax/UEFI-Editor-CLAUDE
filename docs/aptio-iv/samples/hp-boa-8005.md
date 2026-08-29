# HP BOA / BIOS 80.05 Aptio IV sample

> Metadata-only research record. The original firmware image and identifying NVRAM contents are intentionally not stored in this repository.

## Image identity

| Field | Value |
|---|---|
| Original filename | `BOA_8005.BIN` |
| Size | 8,388,608 bytes (`0x800000`) |
| SHA-256 | `c0a18c739897fcc0ee428802272c566ec49014b6074aadf0c55fdb5513e816ff` |
| Firmware family | AMI Aptio IV |
| Platform | HP, AMD-based |
| Platform marker | `SECURE_HP_SIGNATURE B26 v80.05` |
| Flash descriptor | Not present in the supplied image |
| Analysis policy | Parse/read-only; reconstruction and export disabled |

## Top-level firmware volumes

All detected top-level volumes use FFSv2 filesystem GUID `8C8CE578-8A3D-4F1C-9935-896185C32DD3`.

| Base | Size | Notes |
|---|---:|---|
| `0x000000` | `0x020000` | OEM resources |
| `0x050000` | `0x020000` | NVAR store |
| `0x090000` | `0x5B0000` | Contains the compressed main nested firmware volume |
| `0x640000` | `0x0E0000` | Auxiliary/recovery volume |
| `0x720000` | `0x0E0000` | Auxiliary/recovery volume |

The decompressed nested main volume is `0x7E0000` bytes. Setup and AMITSE GUIDs are absent from the raw outer image and become visible only after recursively decompressing the nested volume.

## Relevant modules

| Artifact | GUID / source | Extracted size |
|---|---|---:|
| Setup FFS | `899407D7-99FE-43D8-9A21-79EC328CAC21` | `0x78DF1` |
| Setup PE32 | Setup compressed section | 78,560 bytes |
| Setup HII body | `97E409E6-4CC1-11D9-81F6-000000000000` | 416,431 bytes |
| AMITSE FFS | `B1DA0ADF-4F77-4070-A88E-BFFE1C60529A` | `0x12B539` |
| AMITSE PE32 | AMITSE compressed section | 734,560 bytes |
| AMITSE HII body | `97E409E6-4CC1-11D9-81F6-000000000000` | 377,312 bytes |
| SetupData body | `FE612B72-203C-47B1-8560-A66D946EB371` | 114,072 bytes |

## Parser result

Extraction was verified with UEFIExtract alpha 76 and IFRExtractor-RS 1.6.1.

- 11 English verbose IFR outputs / FormSets.
- Setup HII SHA-256: `21048f81e8143a6b94c409923c076892f90925462b6d78a66b9903172d220f78`.
- 103 forms.
- 890 parsed controls.
- 466 VarStore declarations.
- 340 suppression scopes.
- 777 controls have an unambiguous SetupData match.
- 113 controls remain ambiguous or unmatched and must not be edited.

Detected form roots:

| Root | FormId |
|---|---|
| Main | `0x400` |
| Advanced | `0x402` |
| Chipset | `0x405` |
| Boot | `0x406` |
| Security | `0x408` |
| Save & Exit | `0x409` |
| File | `0x40A` |
| Storage | `0x40B` |
| Security | `0x40C` |
| Power | `0x40D` |
| Advanced | `0x40E` |

## Compatibility significance

This sample proves that raw GUID scanning is insufficient for full-image support. A valid Aptio IV image may place the complete main firmware volume inside a compressed volume-image section. The web parser therefore needs recursive section parsing and AMI/Tiano decompression before module discovery.

The full-image detector now identifies this layout as a nested Aptio IV candidate instead of rejecting it. Binary reconstruction remains disabled until nested recompression, size propagation and checksum repair pass byte-for-byte round-trip tests.
