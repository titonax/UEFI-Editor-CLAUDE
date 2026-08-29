# Cross-vendor Aptio IV sample intake

> Metadata-only research record. Firmware images, executable updaters and identifying platform data are intentionally not stored in this repository.

This intake expands testing beyond HP and records only initial container and structural detection. A confirmed result means the payload exposes the Aptio IV Setup/AMITSE architecture used by the parser; it does not imply write support.

## Sample matrix

| Vendor / model | Supplied container | Payload size | Initial state | Structural notes |
|---|---|---:|---|---|
| ASUS K56CB 205 | ZIP → `K56CBAS.205` | 6,293,504 | Aptio IV confirmed | Descriptorless vendor image; Setup and AMITSE directly detectable |
| MSI E7752IMS 2.B0 | ZIP → `E7752IMS.2B0` | 8,388,608 | Aptio IV confirmed | Intel descriptor; Setup and AMITSE directly detectable |
| MSI E7893AMS 1.40 | ZIP → `E7893AMS.140` | 8,388,608 | Aptio IV confirmed | Descriptorless image; Setup and AMITSE directly detectable |
| ASUS Rampage IV Extreme 4901 | ZIP → ASUS CAP | 8,390,656 | Aptio IV confirmed | `0x800`-byte ASUS capsule header; Setup and AMITSE detectable in payload |
| ASUS Sabertooth Z97 Mark 1 2702 | ZIP → ASUS CAP | 8,390,656 | Aptio IV confirmed | `0x800`-byte ASUS capsule header; Setup and AMITSE detectable in payload |
| ASRock Z77 Extreme4 3.00 | ZIP → `Z77EXT43.00` | 8,388,608 | Aptio IV candidate | Intel descriptor and AMITSE NVRAM marker; Setup/AMITSE require recursive decompression |
| Dell 2520 A11 | Dell PE updater | 6,206,176 | Payload pending | Vendor executable/secure-update container; no raw flash image exposed yet |
| Gigabyte Z68XP-UD4 U1L | PE 7-Zip self-extractor | 3,099,732 | Payload pending | Embedded 7-Zip stream begins at file offset `0x22400` |

## Payload SHA-256

| Payload | SHA-256 |
|---|---|
| `K56CBAS.205` | `ab56462aef141f05beea299aa14fc6fb6234412cf83f59903aef15807f2be1e9` |
| `E7752IMS.2B0` | `49593660b086ae48a3c968286e68c4b8e7e13e934483776b13802f3de4e3b330` |
| `E7893AMS.140` | `cebd6ec82bdd73b3dd953f981cd084efb789f52bc2481a9bfd242b5693b5e6ba` |
| `Z77EXT43.00` | `3bddf9d2f6d86e8102be4bb2cd54c49876349859c0d50a7cb7aaa7eec6870761` |
| Rampage IV Extreme 4901 CAP | `772c44e15c76315de3dc2f772360b643ddffe726ff6d1700d1a021cc0560aef5` |
| Sabertooth Z97 Mark 1 2702 CAP | `cb71e90c3863a3d0c097d5774bf5dd536bf4f528f679e17d27c2d1add69c6462` |

## Container SHA-256

| Supplied file | SHA-256 |
|---|---|
| `K56CBAS205.zip` | `d8c9f6c83d398f6f4575ac64c4a6d02dc3783cd5894adb980f841054da45b13e` |
| `7752v2B.zip` | `1fa97638f5b6b30241fa6f3beeb326e37eab9fc51b760d249708c58280298846` |
| `7893v14.zip` | `c521db05b8e6dbd5b70ab34fbed784be7930ce10fa6b4e601fe20663ccaf2b80` |
| Rampage IV Extreme 4901 ZIP | `d803fe5c4f0acd8fe3680022a8194e6049b098fce8c74d774849b2e7199f2a58` |
| Sabertooth Z97 Mark 1 2702 ZIP | `9824d257b12f8d946859f62c53df43ef89ad83fe9426146a5620b27b185c3963` |
| ASRock Z77 Extreme4 3.00 ZIP | `6c3bd1b7334514098d064524c71cfbff60ef342d5fe87f3183dee3c77e632378` |
| Dell 2520 A11 EXE | `29f7dc7bb6f1f8fa80e00a9dc7fe81d27a3406efb6980de2c4f517c58d0f74db` |
| Gigabyte Z68XP-UD4 U1L EXE | `c97d01ea1615dbfb80aa0046fb37f33dcf8147d006d0ffa8a98eb3d33f42e98c` |

## Raw structural offsets

These offsets are intake diagnostics, not modification targets.

| Payload | Firmware volumes | Setup FFS | AMITSE FFS |
|---|---|---|---|
| ASUS K56CB | `0x10800, 0x80800, 0x564800` | `0x27CFE0` | `0x1ACD20` |
| MSI E7752IMS | `0x200000, 0x240000, 0x760000` | `0x592388` | `0x388F20` |
| MSI E7893AMS | `0x30000, 0x80000, 0x760000` | `0x32EDB0` | `0x20DA60` |
| ASUS Rampage IV CAP | `0x180800, 0x1F0800, 0x230800, 0x680800, 0x700800, 0x780800, 0x7C0800` | `0x4B91B0` | `0x2F92F0` |
| ASUS Sabertooth Z97 CAP | `0x180800, 0x1C0800, 0x1F0800, 0x220800, 0x600800, 0x700800` | `0x5665E0` | `0x3D8DA0` |
| ASRock Z77 Extreme4 | `0x200000, 0x240000, 0x700000, 0x7FE000` | Compressed/not raw-visible | Compressed/not raw-visible |

## Implementation consequences

The full-image web pipeline must support:

1. Raw flash images with and without Intel descriptors.
2. ASUS capsules while preserving the original capsule header for output.
3. Arbitrary vendor payload extensions rather than assuming only `.bin` or `.rom`.
4. Recursive compressed section and nested firmware-volume traversal.
5. Dell secure-update container extraction as a separate pre-parser.
6. 7-Zip self-extractor payload extraction for Gigabyte packages.
7. Exact container/payload provenance so a rebuilt image is returned in the same intended format only when that format is safely reproducible.

Samsung and Supermicro remain desirable additions but are not blockers for the initial cross-vendor Aptio IV parser.
