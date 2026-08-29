# HP Server L01 02.78 Aptio IV sample

> Metadata-only research record. The original firmware image and identifying NVRAM contents are intentionally not stored in this repository.

## Image identity

| Field | Value |
|---|---|
| Original filename | `L01_0278.BIN` |
| Size | 16,777,216 bytes (`0x1000000`) |
| SHA-256 | `c13e4495042f0bda3deadf4d110bf241cdeb6679153cde001b24e7e337b4e2c1` |
| Firmware family | AMI Aptio IV |
| Platform | HP server, Intel-based |
| Firmware version | `L01 v02.78` |
| Firmware date | `02/20/2020` |
| Platform marker | `SECURE_HP_SIGNATURE XXX v02.78` |
| Analysis policy | Parse/read-only; reconstruction and export disabled |

## Intel flash layout

| Region | Base | Size |
|---|---:|---:|
| Descriptor | `0x000000` | `0x001000` |
| GbE | `0x001000` | `0x002000` |
| Intel ME | `0x003000` | `0x57D000` |
| BIOS | `0x580000` | `0xA80000` |

## Firmware volumes

All detected volumes use FFSv2 filesystem GUID `8C8CE578-8A3D-4F1C-9935-896185C32DD3`.

| Base | Size |
|---|---:|
| `0x5E0000` | `0x8B0000` |
| `0xE90000` | `0x020000` |
| `0xEB0000` | `0x0A0000` |
| `0xF50000` | `0x0A0000` |
| `0xFF0000` | `0x010000` |

## Relevant modules

| Artifact | GUID / source | Base or extracted size |
|---|---|---:|
| AMITSE FFS | `B1DA0ADF-4F77-4070-A88E-BFFE1C60529A` | `0x78FE60`, size `0x49F93` |
| AMITSE PE32 | AMITSE compressed section | 437,984 bytes |
| AMITSE HII body | `97E409E6-4CC1-11D9-81F6-000000000000` | 163,257 bytes |
| SetupData body | `FE612B72-203C-47B1-8560-A66D946EB371` | 250,864 bytes |
| Setup FFS | `899407D7-99FE-43D8-9A21-79EC328CAC21` | `0x8D15A8`, size `0x34340` |
| Setup PE32 | Setup compressed section | 122,592 bytes |
| Setup HII body | `97E409E6-4CC1-11D9-81F6-000000000000` | 915,257 bytes |

## Parser result

Extraction was verified with UEFIExtract alpha 76 and IFRExtractor-RS 1.6.1.

- 11 English verbose IFR outputs / FormSets.
- Setup HII SHA-256: `b567ebef66ca5ee0039c2b3f6cebbb9fbacacaea0811d12cfacd40e733469028`.
- 145 forms.
- 2,467 parsed controls.
- 625 VarStore declarations.
- 704 `SuppressIf` scopes.
- 429 `GrayOutIf` scopes.
- 11 `DisableIf` scopes.
- 2,180 controls have an unambiguous SetupData match.
- 287 controls remain ambiguous or unmatched and must not be edited.

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
| Storage | `0x40F` |
| Security | `0x415` |
| Power | `0x41F` |
| Advanced | `0x423` |

## Compatibility significance

This sample confirms that the Aptio IV parser model also scales to a much larger and newer HP server image. It provides a useful corpus for distinguishing visibility classes:

- structurally suppressed with `SuppressIf`;
- runtime-disabled with `DisableIf`;
- visible but conditionally unavailable with `GrayOutIf`;
- access-level hidden through SetupData;
- ambiguous conditions that must not be described as hardware-dependent without resolving their variable source.

The complete-image detector finds this layout directly. Binary reconstruction remains disabled until section replacement, firmware-volume checksums, Intel-region preservation and byte-for-byte round-trip validation are implemented.
