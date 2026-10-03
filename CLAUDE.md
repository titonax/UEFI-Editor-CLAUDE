# CLAUDE.md

Browser-based explorer/editor for AMI Aptio IV/V Setup menus (IFR/HII). It
patches raw bytes in real firmware images, so a silent mistake can brick a
board. Everything runs client-side; no firmware ever leaves the browser.

Read first: `README.md` (behaviour), `src/components/scripts/README.md`
(module map, how to add an opcode), `docs/ami`, `docs/aptio-iv`,
`docs/phoenix` (evidence and decisions).

## Commands

```bash
npm ci
npm run lint     # eslint
npm test         # vitest (jsdom); must stay green
npm run build    # tsc -b && vite build
```

CI (`.github/workflows/deploy.yaml`) runs lint, test and build. The `.wasm`
decompressors and IFRExtractor are built on CI and git-ignored
(`public/*.wasm`); never commit them. Tests do not need them.

## Layout

- `src/components/scripts/` - non-UI core: IFR parser, visibility,
  `binaryPatcher.ts`, firmware extraction, Phoenix support. Each module has
  a sibling `*.test.ts`.
- `src/components/Navigation`, `FormUi`, `ChangeQueue`, `CorpusRunner`,
  `BiosImageUpload` - UI and analysis that consume `Data` but never touch
  bytes.
- `tools/` - Rust (`lzma-wasi`) and C (`tiano-wasi`) decompressors built to
  WASI.

## Invariants (do not break these)

- **Bytes, not hex strings.** Firmware travels as an uppercase hex string
  only at the edges; decode once and index by byte offset. Never patch with
  string slice-and-concat.
- **Offsets are sacred.** Every IFR opcode keeps its binary offset; edits
  are byte patches against the original files, with HII package lengths
  rebalanced when a move crosses packages.
- **Evidence is not fact.** Report runtime/hardware/AMITSE evidence as
  evidence. Shared structures are never proof of an Aptio generation.
  Do not guess a verdict; leave it unresolved and say why.
- **Compare ids through `hexId.ts`**, never a bare `parseInt`; GUIDs compare
  case-insensitively.
- **No silent failures.** No empty `catch {}`, no `.catch(() => [])`, no
  fallback that hides a parse failure. Return or throw a typed, explained
  result so the UI can show why something was refused.
- **Every applied change appears in `changelog.txt`.** Export refuses
  (rather than approximates) when a plan cannot be applied exactly.
- **Never commit firmware samples** (see "Sample intake" in
  `docs/aptio-iv/README.md`).

## Workflow for every task

1. **Read** the affected module, its test and the relevant `docs/` page.
   Search for an existing helper before writing a new one.
2. **Plan** briefly for anything non-trivial (new vendor support, new patch
   type, refactor across modules) and confirm with the user before coding.
3. **Test first.** A bug gets a failing test that reproduces it; a new byte
   patch gets a fixture-based test (see `testFixtures.ts`, `buildMoveFixture`)
   asserting the exact bytes before and after.
4. **Implement** the smallest change that passes.
5. **Verify**: `npm run lint && npm test && npm run build`. Report failures
   with their output; never skip or weaken a test to get green.
6. **Self-review the diff** for swallowed errors, off-by-one offsets and
   hex/byte mix-ups before committing, and add a short note to the matching
   `docs/` page when a decision or heuristic changes.
7. Commit with a descriptive message on the working branch. Do not open a PR
   unless asked.

Files over ~800 lines (`ifrParser.ts`, `aptioIvExtractor.ts`,
`amiFirmwareImage.ts`, `BiosImageUpload.tsx`) are refactor candidates, but
only split them in a dedicated change with tests green before and after.
