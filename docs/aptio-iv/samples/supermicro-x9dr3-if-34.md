# Supermicro X9DR3/i-F 3.4 Aptio IV sample

> Metadata-only research record. The original firmware image and identifying NVRAM contents are intentionally not stored in this repository.

## Image identity

| Field | Value |
|---|---|
| Supplied package | `X9DRi0_630.zip` |
| Firmware payload | `X9DRi0.630` |
| Package SHA-256 | `5f944601ee121f77d4d4d76370424450208a8d1b2c4cd3e969cbd0f765ad3462` |
| Payload SHA-256 | `3b4f01b4fb3361bf0ed8fe290225303172a72bb3ce479e83ca28c0bcff5d5b9c` |
| Payload size | 16,777,216 bytes (`0x1000000`) |
| Firmware family | AMI Aptio IV |
| Platform | Supermicro X9DR3/i-F |
| Firmware version | `3.4` |
| Build string | `06/30/2020 10:52:49` |
| Analysis policy | Parse/read-only; reconstruction and export disabled |

## Intel flash layout

| Region | Base | Size |
|---|---:|---:|
| Descriptor / platform data | `0x000000` | `0x020000` |
| Intel ME | `0x020000` | `0x7E0000` |
| BIOS | `0x800000` | `0x800000` |

## Firmware volumes

| Base | Size |
|---|---:|
| `0x800000` | `0x020000` |
| `0x860000` | `0x580000` |
| `0xE00000` | `0x200000` |

The image also contains `AMITSESetup`, confirming the AMI TSE configuration path used by the existing Aptio IV parser.

## Relevant modules

| Artifact | GUID | Base | FFS size |
|---|---|---:|---:|
| AMITSE | `B1DA0ADF-4F77-4070-A88E-BFFE1C60529A` | `0x9A2300` | `0x2AB8B` |
| Setup | `899407D7-99FE-43D8-9A21-79EC328CAC21` | `0xAA0618` | `0x0D522` |

Both modules contain AMI/Tiano standard-compression sections:

| Module | Compressed section size | Declared uncompressed size | Compression type |
|---|---:|---:|---|
| AMITSE | `0x2AB73` | `0x6041C` | Standard/Tiano (`1`) |
| Setup | `0x0D4F2` | `0x32DA4` | Standard/Tiano (`1`) |

## Compatibility significance

This is the first Supermicro/server sample in the corpus and provides a comparatively clean non-HP Aptio IV implementation:

- full 16 MiB Intel SPI image;
- conventional Setup and AMITSE GUIDs;
- directly discoverable FFS files;
- standard AMI/Tiano compression;
- no vendor capsule around the raw payload.

It is a strong reconstruction fixture because the complete flash layout, module boundaries and declared decompressed sizes are available before parsing HII. Full IFR and SetupData statistics remain pending integration of the browser-compatible Tiano decompressor.

## Safety state

- Full-image identification: confirmed.
- Flash-region and firmware-volume mapping: confirmed.
- Setup/AMITSE discovery: confirmed.
- Recursive decompression and IFR parsing: pending.
- Visibility editing and rebuilt output: disabled.
- Flash-ready output: not claimed.
