# Aptio IV compatibility work

This branch is the development area for adding AMI Aptio IV support to UEFI Editor.

## Product target

The primary workflow is a single complete Aptio IV `.bin` or `.rom` image:

1. Detect the flash layout, firmware volumes, Setup, AMITSE and SetupData.
2. Extract and parse all HII/IFR form sets in the browser.
3. Classify items as visible, suppressed/hidden, access-level hidden, or runtime conditional.
4. Show the condition tree separately from claims about the physical hardware.
5. Allow only unambiguous visibility changes.
6. Rebuild the affected section, FFS and firmware volume with corrected sizes and checksums.
7. Verify all untouched regions byte-for-byte and download a flash-ready image plus a change log.

The manual four-file expert diagnostic mode was removed (matching
upstream): every session now goes through the full-image preflight.

## Current status

- The full-image preflight is implemented and runs read-only in the browser: flash layout and firmware volume detection, recursive LZMA/Tiano decompression, extraction of the Setup, AMITSE and SetupData modules, and IFRExtractor-RS via WebAssembly. Every extracted buffer keeps its provenance (source buffer, encapsulation path, owning FFS file).
- The Aptio IV/V generation is reported as evidence; shared structures alone never resolve it, and an unresolved image stays marked as such.
- The AMITSE multi-FormSet root visibility vector is detected in the Setup PE32; changes to it are recorded as reversible pending plans and included in `data.json`.
- Reconstruction and full-image export are not implemented: exporting extracted UEFI files stays disabled for every session now (the removed manual four-file mode was the only path that ever enabled it), and pending root-visibility plans cannot be applied yet. The blockers are listed by `assessFirmwareReconstruction()` and shown in the preflight report.
- Parser and patching changes are based on reproducible firmware samples.
- Modified output must never be flashed before independent validation and a recovery path are available.

## Sample intake

For each test platform, provide the following where available:

1. Original vendor BIOS image, without modifications.
2. Exact manufacturer, model, board revision and BIOS version.
3. SHA-256 checksum of the original image.
4. UEFITool version used for extraction.
5. Setup PE32 section extracted **as is**.
6. IFR Extractor output generated from that exact Setup section.
7. AMITSE PE32 section extracted **as is**.
8. setupdata extracted as **body**.
9. Screenshots or notes showing which firmware menus are visible and which are expected to be hidden.
10. Recovery method available for the platform, such as a hardware programmer or a verified vendor recovery procedure.

Do not commit firmware images when redistribution rights are unclear. They can be supplied privately for analysis, with only sanitized structural fixtures and checksums committed to the repository.

## Planned implementation

1. Identify Aptio IV module and data-layout variants.
2. Separate firmware-family detection from the existing parser.
3. Add Aptio IV parsing behind an explicit experimental mode.
4. Generate a change log containing every modified offset and byte sequence.
5. Reject ambiguous layouts rather than guessing.
6. Build sanitized test fixtures and regression tests.
7. Validate round-trip output before enabling downloads for Aptio IV images.

## Compatibility record

Each tested platform will be recorded with one of these states:

- **Parse only**: structures can be read but modified output is disabled.
- **Experimental write**: output can be produced for controlled offline validation.
- **Validated**: output was structurally verified and tested with a documented recovery path.
- **Unsupported**: the layout is ambiguous or incompatible.

## Development rule

Aptio IV and Aptio V handling must remain isolated where their structures differ. Compatibility will not be inferred solely from file names, strings or a successful parse.
