# UEFI Editor (Claude fork)

A browser-based editor for AMI Aptio Setup menus. It lets you inspect and
change which BIOS/UEFI setup items are hidden, disabled, or restricted by
access level, then generates patched firmware files you can reflash - all
client-side, no files ever leave your browser.

This is a maintenance/refactor fork of
[BoringBoredom/UEFI-Editor](https://github.com/BoringBoredom/UEFI-Editor).
The Aptio V editing workflow is the same; see
[`docs/aptio-iv/README.md`](docs/aptio-iv/README.md) for the separate,
experimental Aptio IV (full-image) support and its current limitations.

## ⚠️ Before you flash anything

This tool patches raw bytes in real firmware images. A mistake can produce
an image that won't boot.

- Always keep an unmodified backup of every file you upload.
- Only flash output you've reviewed - check the generated `changelog.txt`
  against what you actually intended to change.
- Have a recovery path available (an external programmer, or your
  motherboard's documented recovery procedure) before flashing.

## What it actually does

AMI's Aptio Setup is described by IFR (Internal Forms Representation)
opcodes compiled into the firmware's HII database. Two other tables outside
that database - the AMITSE menu executable and the "SetupData" region - can
independently gate whether a page is reachable or what its default/failsafe
byte values are. This editor:

1. Parses the IFR text dump (produced by
   [IFRExtractor-RS](https://github.com/LongSoft/IFRExtractor-RS)) into
   forms, prompts (CheckBox/Numeric/OneOf/String/Ref), VarStores, and
   `SuppressIf`/`GrayOutIf`/`DisableIf` conditions.
2. Cross-references those conditions against known Setup/hardware/access/UI
   VarStore names to explain *why* something is hidden, not just *that* it
   is.
3. Lets you flip a `SuppressIf` inactive, or edit a prompt's AMI access
   level / failsafe / optimal byte, directly in the browser.
4. Rewrites only the bytes that changed in the original `Setup.sct`,
   `AmiTseSct.sct`, and `SetupData` files, and produces a plain-text
   changelog alongside them.

## Using it

There are two ways to get data in:

**Full Aptio IV image** (top of the upload screen): drop in a complete
`.bin`/`.rom`/`.u1l` dump. The app locates the Setup firmware volume,
recursively decompresses nested volumes (LZMA/Tiano, via WebAssembly), and
runs IFRExtractor-RS on the result automatically. Downloading patched
Aptio IV output is currently disabled until safe reinsertion into the full
image is implemented - see `docs/aptio-iv/README.md`.

**Four separate files** (expert mode, works for Aptio V today): extract
these with [UEFITool](https://github.com/LongSoft/UEFITool) and
[IFRExtractor-RS](https://github.com/LongSoft/IFRExtractor-RS) yourself,
then upload:

| File | What it is |
| --- | --- |
| Setup HII / SCT | The Setup module's PE32/SCT section |
| IFR Extractor output TXT(s) | Run IFRExtractor-RS with `verbose` on the file above |
| AMITSE PE32 / SCT | The AMITSE module's PE32/SCT section |
| Setupdata BIN | The `SetupData` freeform section body |

Once loaded, the sidebar lists every Setup page. Each item's "HII effect"
badge shows whether it's unconditionally visible, hidden by a `SuppressIf`,
grayed out, or orphaned/broken (a `Ref` pointing at a form that doesn't
exist). Click a condition badge for the full expression and which VarStore
it reads.

## Development

```bash
npm install
npm run dev      # local dev server
npm run build    # production build (also builds the .wasm decompressors on CI)
npm test         # vitest - parser, patching, and hashing unit/integration tests
npm run lint      # eslint
```

Deployment to GitHub Pages runs automatically on push to `main` via
`.github/workflows/deploy.yaml`.

See [`src/components/scripts/README.md`](src/components/scripts/README.md)
for how the parsing/patching code is organized.
