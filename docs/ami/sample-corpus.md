# AMI full-image comparison corpus

This manifest records the read-only inspection results for a user-supplied
Aptio V comparison set. Firmware binaries are not committed. Hashes preserve
sample identity without redistributing vendor images.

The current result is deliberately `unresolved`: every unique sample proves AMI
Aptio family structures, but none exposes generation metadata strong enough to
override the shared IV/V layout. This is a successful classification outcome,
not a parser failure.

| Sample                                    |      Bytes | SHA-256                                                            | Container    | Valid FV | FFS2 / FFS3 | Direct Setup | Generation                |
| ------------------------------------------ | ---------: | ------------------------------------------------------------------ | ------------ | -------: | ----------: | -----------: | ------------------------- |
| `FNCML357.0067.CAP`                       | 20,971,520 | `12770cbddbab0fd071e91142afe6b1882c7a50c0e7b438866f6b99b5c660da64` | Raw FV image |       19 |      19 / 0 |            0 | Unresolved                |
| `BIOS_H12SSL-1B95_20260513_3.7_STDsp.bin` | 33,554,432 | `6439feb56eea3e18ed8372e507a9b089badd617a6e071a26449a465a782eb882` | Vendor image |        8 |       6 / 2 |            0 | Unresolved                |
| `E7B09AMS.1C0`                            | 16,777,216 | `dc86ddfec044a92a91cc4ded3173b2297de2095778a1070460e2dba00dccdb8d` | Vendor image |        3 |       3 / 0 |            1 | Unresolved                |
| `E7B09AMS.1D9`                            | 16,777,216 | `72633d6073fcc60baf6ea92b36331852d2ba681b08c38b2f50f104f83e94edcd` | Vendor image |        3 |       3 / 0 |            1 | Unresolved                |
| `image1.bin`                              | 33,554,432 | `14c74b9b80e71d3302c13aea0dfea3560e1452a55c698c20e457c5b495154443` | Intel flash  |       12 |      12 / 0 |            0 | Unresolved                |
| `image2.bin`                              | 33,554,432 | `56430f2f4f9aef4e50f503dc8397fdb20b005bf38a8b9029c43e3eed56c39229` | Intel flash  |       12 |      12 / 0 |            0 | Unresolved                |
| `image3.bin`                              | 33,554,432 | `56430f2f4f9aef4e50f503dc8397fdb20b005bf38a8b9029c43e3eed56c39229` | Intel flash  |       12 |      12 / 0 |            0 | Duplicate of `image2.bin` |
| `X399AG7.F12`                             | 16,777,216 | `23c00cf1c97a1f03c5bda1ff24bf10bee75facf20914b5404205b28436561d70` | Vendor image |        3 |       3 / 0 |            0 | Unresolved                |
| `X399AORUSGaming7.F13d`                   | 16,777,216 | `9f8a45c657c4cdb0ac594a8df478e093a00dc47d0e01114899c74d54c8bd044a` | Vendor image |        5 |       5 / 0 |            0 | Unresolved                |
| `X399TC3.90`                              | 16,777,216 | `6fd5a017413135603e5f8522bf98f46784c29f31b4e83441f551f699952aa42f` | Vendor image |        4 |       4 / 0 |            0 | Unresolved                |
| `X399TC4.03`                              | 16,777,216 | `baba9db1b7f98b88cd00ff4a9b1ab2c246bef173813776026997cc23d23cdaa5` | Vendor image |        4 |       4 / 0 |            0 | Unresolved                |

## Regression conclusions

- `AMITSESetup`, NVAR, classic Setup/AMITSE GUIDs and FFS3 are family or format
  evidence, not generation discriminators.
- Both MSI samples contain the classic Setup, AMITSE and SetupData GUIDs. The
  former detector therefore labelled the entire comparison set as Aptio IV.
- A `.CAP` suffix does not prove an outer capsule: `FNCML357.0067.CAP` starts
  directly with a checksummed firmware volume.
- Recursive extraction is required for eight of the ten unique images because
  their Setup FFS is not visible in the outer byte stream.
- `image2.bin` and `image3.bin` are byte-identical and count as one sample.

## `image2.bin` nested extraction regression

The outer image contains eight structurally valid GUID-defined LZMA sections.
Opening the main nested volume resolves the three AMI artifacts that are not
visible to the preflight scan:

| Artifact    | Nested layout                                     | Extracted bytes | SHA-256                                                            |
| ----------- | -------------------------------------------------- | ---------------: | ------------------------------------------------------------------ |
| Setup / IFR | Setup FFS → PE32                                  |          749,344 | `1eb3f351dbf1bc1385ae46eab0a4d8441cb393b186a9cace2ffe4d062217d3d5` |
| AMITSE      | AMITSE FFS → GUID-defined LZMA → PE32             |          134,336 | `9bff75a39e94cda1b606e81e0cee9abe058e07db117ec151689ad9ad3d827641` |
| SetupData   | SetupData FFS → GUID-defined LZMA → freeform body |          407,344 | `24628d61cd193b5ae71340592ec826209a62911dae89946812eab9cfa34a347b` |

IFRExtractor produces one Form Package and 2,356,133 characters of verbose
IFR text from the Setup PE32. This sample therefore requires both supported
Setup sources: a freeform HII body when present, or the Setup PE32 otherwise.
