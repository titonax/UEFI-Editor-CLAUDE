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
  // navigation from other pages. These aren't "this Form's parent" in any
  // useful sense and should be excluded from reparent-target pickers.
  isSelfReference: boolean;
}

function resolveRefTarget(data: Data, sourceFormIndex: number, ref: RefPrompt) {
  const form = data.forms[sourceFormIndex];
  return findFormIndexByFormId(
    data.forms,
    ref.formId,
    ref.targetFormSetGuid ?? form.formSetGuid,
  );
}

// Every Ref opcode anywhere in the data that currently resolves to
// `targetFormIndex`. A Form can in principle appear under several distinct
// parents (nothing here rules that out), so "moving a Form" always means
// moving one specific Ref location, never "the Form's parent" as if it had
// exactly one - see isSelfReference for the far more common real-world
// reason a Form has multiple incoming Refs.
export function findIncomingRefs(
  data: Data,
  targetFormIndex: number,
): RefLocation[] {
  const locations: RefLocation[] = [];

  data.forms.forEach((form, sourceFormIndex) => {
    form.children.forEach((child, childIndex) => {
      if (child.type !== "Ref") {
        return;
      }
      const resolvedIndex = resolveRefTarget(data, sourceFormIndex, child);
      if (resolvedIndex === targetFormIndex) {
        locations.push({
          sourceFormIndex,
          childIndex,
          ref: child,
          targetFormIndex: resolvedIndex,
          isSelfReference: sourceFormIndex === resolvedIndex,
        });
      }
    });
  });

  return locations;
}

// True if retargeting `location`'s Ref to `newTargetFormIndex` would make
// the Ref's own containing Form reachable from its new target - i.e. it
// would introduce a cycle. buildMenuTree already tolerates cycles without
// infinite recursion (ancestor tracking stops it), but a reparent that
// creates one on the spot is never what was actually asked for, so it's
// rejected up front instead of silently produced.
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

export type MoveBlockReason =
  | "same-target"
  | "would-create-cycle"
  | "target-not-found";

export interface MoveCandidateResult {
  allowed: boolean;
  reason?: MoveBlockReason;
}

// Whether `location`'s Ref could be safely retargeted to point at
// `newTargetFormIndex` instead. This only ever checks graph-shape
// constraints (does the target exist, would it create a cycle) - it does
// not yet know anything about byte-level feasibility (that's a separate,
// later concern once this becomes an actual binary patch).
export function evaluateMoveCandidate(
  data: Data,
  location: RefLocation,
  newTargetFormIndex: number,
): MoveCandidateResult {
  if (newTargetFormIndex < 0 || newTargetFormIndex >= data.forms.length) {
    return { allowed: false, reason: "target-not-found" };
  }
  if (newTargetFormIndex === location.targetFormIndex) {
    return { allowed: false, reason: "same-target" };
  }
  if (wouldCreateCycle(data, location, newTargetFormIndex)) {
    return { allowed: false, reason: "would-create-cycle" };
  }
  return { allowed: true };
}
