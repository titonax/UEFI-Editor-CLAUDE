import type { Data, RefPrompt } from "../scripts/types";
import { findFormIndexByFormId } from "../scripts/hexId";

export interface RefLocation {
  sourceFormIndex: number;
  childIndex: number;
  ref: RefPrompt;
  targetFormIndex: number;
  // True when this Ref's containing Form and its target are the same Form.
  // Checked against a real firmware image: every Form there with more than
  // one incoming Ref turned out to be exactly this - action buttons ("Save
  // Changes and Exit", "Discard Changes", "Restore Defaults", ...)
  // implemented as Refs that point back at their own Form, not genuine
  // navigation from other pages.
  isSelfReference: boolean;
}

export function resolveRefTarget(data: Data, sourceFormIndex: number, ref: RefPrompt) {
  const form = data.forms[sourceFormIndex];
  return findFormIndexByFormId(
    data.forms,
    ref.formId,
    ref.targetFormSetGuid ?? form.formSetGuid,
  );
}

// Builds the RefLocation for one already-known Ref (a specific child of a
// specific Form) - the tree already knows exactly which Ref a given row
// came from (see sourceFormIndex/refChildIndex on MenuTreeNode).
export function buildRefLocation(
  data: Data,
  sourceFormIndex: number,
  childIndex: number,
): RefLocation {
  const form = data.forms[sourceFormIndex];
  const ref = form.children[childIndex];
  if (ref.type !== "Ref") {
    throw new Error("Something went wrong. Please file a bug report on Github.");
  }
  const targetFormIndex = resolveRefTarget(data, sourceFormIndex, ref);
  return {
    sourceFormIndex,
    childIndex,
    ref,
    targetFormIndex,
    isSelfReference: sourceFormIndex === targetFormIndex,
  };
}

// True if a Ref living in `location`'s Form pointing at `newTargetFormIndex`
// would make that Form reachable from its own target - i.e. it would
// introduce a cycle. buildMenuTree already tolerates cycles without
// infinite recursion (ancestor tracking stops it), but a move that creates
// one on the spot is never what was actually asked for, so it's rejected
// up front instead of silently produced.
export function wouldCreateCycle(
  data: Data,
  location: Pick<RefLocation, "sourceFormIndex">,
  newTargetFormIndex: number,
): boolean {
  if (newTargetFormIndex === location.sourceFormIndex) {
    return true;
  }

  const visited = new Set<number>();
  const queue = [newTargetFormIndex];

  while (queue.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- queue.length > 0 guarantees an element
    const formIndex = queue.shift()!;
    if (visited.has(formIndex)) {
      continue;
    }
    visited.add(formIndex);
    if (formIndex === location.sourceFormIndex) {
      return true;
    }

    const form = data.forms[formIndex];
    for (const child of form.children) {
      if (child.type !== "Ref") {
        continue;
      }
      const resolved = resolveRefTarget(data, formIndex, child);
      if (resolved >= 0) {
        queue.push(resolved);
      }
    }
  }

  return false;
}
