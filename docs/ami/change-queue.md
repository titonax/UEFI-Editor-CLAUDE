# Change queue

Every edit in the editor - Hide/Show/Move a tab, retarget a root menu, flip
an access level, restore a suppressed item - is staged as a reviewable,
individually toggleable entry instead of committing straight away. The
**Change queue** button in the footer opens a dialog listing every staged
entry with a plain-language description, a checkbox to include or exclude
it from the current plan, and a remove button; **Apply selected** commits
the currently checked entries as the plan the **UEFI files** export button
will act on.

This mirrors the same feature already shipped upstream in
[`titonax/uefi-editor-gpt`](https://github.com/titonax/uefi-editor-gpt) -
this codebase's port keeps its layered design intact:

- `src/components/scripts/changeQueue.ts` - a generic, vendor-agnostic
  queue engine (`ChangeQueueEntry`, `ChangeQueueAnalysis`,
  `analyzeChangeQueue`/`applyAnalyzedChangeQueue`) working over raw byte
  patches against named buffers. Not currently used directly by the AMI
  editor (see below), but kept as the shared foundation a future
  byte-patch-level queue (e.g. for Phoenix legacy Setup Table edits) could
  build on.
- `src/components/ChangeQueue/dataChangeQueue.ts` - the adapter this editor
  actually uses. It works at the logical `Data` object level instead of raw
  bytes: `diffData(before, after)` structurally diffs the whole object
  graph before and after an edit (an array only diffs element-wise when
  both sides have the same length; a length change - e.g. a tab's `Ref`
  moving from one Form's `children` array to another's - becomes one
  wholesale-replacement patch at that array's own path instead, which is
  exactly the shape a Move/Hide/Show produces). `operationDescription`
  pattern-matches which paths changed to build a human title and
  description; `projectDataChangeQueue` replays the enabled entries on top
  of the original data on every render, detecting a stale entry (one whose
  expected pre-state no longer holds, e.g. because an earlier entry was
  paused) and flagging when a set of selected operations cancel out to no
  net change.
- `src/components/ChangeQueue/useDataChangeQueue.ts` - a React hook whose
  `enqueueData` has the exact same shape as `useImmer`'s own setter
  (`(recipe: Data | ((draft: Draft<Data>) => void)) => void`). This is
  what makes the port a drop-in: every existing edit handler in this
  codebase already calls `setData(draft => { ... })`, and swapping that
  `setData` for `enqueueData` at the top of the tree (`App.tsx`) is the
  entire integration - no edit handler itself changed.
- `src/components/ChangeQueue/ChangeQueueDialog.tsx` /
  `DataChangeQueueDialog.tsx` - the Mantine dialog UI, ported unchanged.

## A known, deliberate scope cut

Upstream tracks a separate `ifrEdits`/`uefiHiiVisibilityEdits` log purely to
tell a Hide/Show (via `tabVisibility.ts`'s trick of relocating a tab's `Ref`
into an existing, reused constant-true `SuppressIf` scope) apart from a
plain cross-Form Move - both produce the *exact same* diff shape in this
data model (a `Ref` changes which Form's `children` array owns it), so
without that extra log there's no way to tell them apart from the diff
alone. This codebase doesn't have that log, and porting it wasn't in scope
for the initial cut of this feature. Until it's added, **both a Hide/Show
and a generic Move are described identically**, as "Move menu X: FormA
(0x..) → FormB (0x..)" - always accurate about what will actually happen on
export, just not as specific as upstream's wording for the Hide/Show case
in particular. See the header comment in `dataChangeQueue.ts` for the exact
mechanism, and `dataChangeQueue.test.ts` for a test that pins this behavior
down explicitly so a future change to add the more specific wording has a
clear "before" to compare against.
