// Adapted from titonax/uefi-editor-gpt's own ChangeQueue/dataChangeQueue.ts.
// Turns an edit to the AMI editor's Data object into a describable,
// toggleable ChangeQueueEntry instead of committing it immediately: the
// existing edit handlers (RootVisibilityAnalysis, tabVisibility.ts,
// MenuMoveDialog, RootsTable, Footer's quick actions, ...) are completely
// unchanged - they still call setData(draft => {...}); see
// useDataChangeQueue.ts for the Updater<Data> wrapper that makes that
// transparent.
//
// The mechanism: diff the whole Data object structurally before/after an
// edit (diffData), keep that diff as the entry's payload, and separately
// pattern-match on *which* fields changed to produce a human description
// (operationDescription). Nothing here computes byte patches - that still
// happens the same way it always did, in downloadModifiedFiles, once the
// queue's own projected Data becomes the real one (see App.tsx/Footer.tsx).
//
// One deliberate scope cut from the ported original: GPT's fork tracks a
// separate `ifrEdits`/`uefiHiiVisibilityEdits` log to tell a Hide/Show (via
// tabVisibility.ts's Ref relocation into a reused SuppressIf scope) apart
// from a plain cross-Form Move - this codebase doesn't have that log, and
// both produce the exact same diff shape (a Ref moves from one Form's
// children array to another's). Until that's worth adding, both are
// described as "Move menu X: FormA (0x..) -> FormB (0x..)" - always
// accurate about what will happen, just not as specific as GPT's wording
// for the Hide/Show case specifically.
import type { ChangeQueueAnalysis, ChangeQueueEntry } from "../scripts/changeQueue";
import type { Data, RefPrompt } from "../scripts/types";

type DataPathPart = string | number;

export interface DataValuePatch {
  path: DataPathPart[];
  expectedExists: boolean;
  expected?: unknown;
  replacementExists: boolean;
  replacement?: unknown;
}

export interface DataChangePayload {
  patches: DataValuePatch[];
}

export interface DataQueueProjection {
  data: Data;
  analysis: ChangeQueueAnalysis<DataChangePayload>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: object, key: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return (
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => equal(value, right[index]))
    );
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => hasOwn(right, key) && equal(left[key], right[key]))
    );
  }
  return false;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

// Arrays diff element-wise only when both sides are the same length - a
// length change (e.g. a Ref spliced out of one Form's children and into
// another's) becomes one wholesale replacement patch at the array's own
// path instead, which is exactly the shape structuralDescription's trigger
// below looks for.
function diffValues(
  before: unknown,
  after: unknown,
  path: DataPathPart[],
  patches: DataValuePatch[],
) {
  if (equal(before, after)) return;
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    for (let index = 0; index < before.length; index += 1) {
      diffValues(before[index], after[index], [...path, index], patches);
    }
    return;
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      const beforeExists = hasOwn(before, key);
      const afterExists = hasOwn(after, key);
      if (!beforeExists || !afterExists) {
        patches.push({
          path: [...path, key],
          expectedExists: beforeExists,
          expected: beforeExists ? clone(before[key]) : undefined,
          replacementExists: afterExists,
          replacement: afterExists ? clone(after[key]) : undefined,
        });
      } else {
        diffValues(before[key], after[key], [...path, key], patches);
      }
    }
    return;
  }
  patches.push({
    path,
    expectedExists: true,
    expected: clone(before),
    replacementExists: true,
    replacement: clone(after),
  });
}

export function diffData(before: Data, after: Data): DataValuePatch[] {
  const patches: DataValuePatch[] = [];
  diffValues(before, after, [], patches);
  return patches;
}

function pathLabel(path: DataPathPart[]) {
  return path.map(String).join(".");
}

function readPath(root: unknown, path: DataPathPart[]) {
  let current = root;
  for (const part of path) {
    if (!isObject(current) || !hasOwn(current, part)) {
      return { exists: false, value: undefined };
    }
    current = current[part as keyof typeof current];
  }
  return { exists: true, value: current };
}

function writePath(root: unknown, patch: DataValuePatch) {
  if (patch.path.length === 0) {
    throw new Error("A queued data operation cannot replace the editor root.");
  }
  let parent = root;
  for (const part of patch.path.slice(0, -1)) {
    if (!isObject(parent) || !hasOwn(parent, part)) {
      throw new Error(`The queued path ${pathLabel(patch.path)} no longer exists.`);
    }
    parent = parent[part as keyof typeof parent];
  }
  if (!isObject(parent)) {
    throw new Error(`The queued path ${pathLabel(patch.path)} has no parent.`);
  }
  // patch.path.length === 0 already returned above, so this is never
  // undefined.
  const key = patch.path[patch.path.length - 1];
  if (patch.replacementExists) {
    parent[key] = clone(patch.replacement);
  } else if (Array.isArray(parent) && typeof key === "number") {
    parent.splice(key, 1);
  } else {
    Reflect.deleteProperty(parent, key);
  }
}

interface OperationDescription {
  operation: string;
  title: string;
  description: string;
}

function referenceKey(reference: RefPrompt, ownerGuid?: string) {
  return [
    reference.questionId,
    reference.formId,
    (reference.targetFormSetGuid ?? ownerGuid ?? "").toLowerCase(),
  ].join("|");
}

function referenceLocations(data: Data) {
  return data.forms.flatMap((form, formIndex) =>
    form.children.flatMap((child, childIndex) =>
      child.type === "Ref" ? [{ form, formIndex, childIndex, reference: child }] : [],
    ),
  );
}

// Finds a Ref that changed which Form owns it - the shared structural
// signature of both a generic Move and a tabVisibility.ts Hide/Show (see
// this module's own doc comment for why they're described identically).
function movedReference(before: Data, after: Data) {
  const afterLocations = referenceLocations(after);
  for (const previous of referenceLocations(before)) {
    const key = referenceKey(previous.reference, previous.form.formSetGuid);
    const current = afterLocations.find(
      (candidate) =>
        referenceKey(candidate.reference, candidate.form.formSetGuid) === key,
    );
    if (current && current.formIndex !== previous.formIndex) {
      return { previous, current };
    }
  }
  return undefined;
}

function displayValue(value: unknown) {
  if (value === undefined) return "not set";
  if (value === null) return "none";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "enabled" : "disabled";
  return JSON.stringify(value);
}

function textOr(value: string | undefined, fallback: string) {
  return value?.trim().length ? value : fallback;
}

function rootVisibilityDescription(
  before: Data,
  after: Data,
): OperationDescription | undefined {
  const roots = new Set([
    ...(before.rootVisibilityEdits ?? []).map((edit) => edit.rootIndex),
    ...(after.rootVisibilityEdits ?? []).map((edit) => edit.rootIndex),
  ]);
  for (const rootIndex of roots) {
    const previous = before.rootVisibilityEdits?.find(
      (edit) => edit.rootIndex === rootIndex,
    );
    const current = after.rootVisibilityEdits?.find(
      (edit) => edit.rootIndex === rootIndex,
    );
    if (equal(previous, current)) continue;
    const evidence = after.rootVisibility?.entries.find(
      (entry) => entry.rootIndex === rootIndex,
    );
    const previousValue = previous?.replacement ?? evidence?.value;
    const currentValue = current?.replacement ?? evidence?.value;
    const name =
      evidence?.name ??
      current?.description ??
      previous?.description ??
      `root ${String(rootIndex)}`;
    const action = currentValue === 1 ? "Show" : "Hide";
    return {
      operation: action,
      title: `${action} root menu ${name}`,
      description: `Root visibility ${String(previousValue ?? "?")} → ${String(currentValue ?? "?")}.`,
    };
  }
  return undefined;
}

// Covers both a generic cross-Form Move and a tabVisibility.ts Hide/Show -
// see this module's own doc comment for why they share one description
// shape here.
function structuralDescription(
  before: Data,
  after: Data,
): OperationDescription | undefined {
  const moved = movedReference(before, after);
  if (!moved) return undefined;
  const name = textOr(
    moved.previous.reference.name,
    `Form ${moved.previous.reference.formId}`,
  );
  return {
    operation: "Move",
    title: `Move menu ${name}`,
    description: `${moved.previous.form.name} (${moved.previous.form.formId}) → ${moved.current.form.name} (${moved.current.form.formId}).`,
  };
}

function suppressionDescription(
  patches: DataValuePatch[],
  after: Data,
): OperationDescription | undefined {
  const changes = patches.flatMap((patch) => {
    if (
      patch.path[0] !== "suppressions" ||
      typeof patch.path[1] !== "number" ||
      patch.path[2] !== "active"
    ) {
      return [];
    }
    // patch.path[1] came from diffing after.suppressions itself, so it's
    // always a valid index into it.
    return [after.suppressions[patch.path[1]]];
  });
  if (changes.length === 0) return undefined;
  const offsets = new Set(changes.map((condition) => condition.offset));
  const affected = after.forms.flatMap((form) =>
    form.children.flatMap((child) =>
      (child.suppressIf ?? []).some((offset) => offsets.has(offset))
        ? [{ form, child }]
        : [],
    ),
  );
  const active = changes.every((condition) => condition.active);
  const action = active ? "Hide" : "Show";
  if (affected.length === 1) {
    const target = affected[0];
    const kind = target.child.type === "Ref" ? "menu" : "option";
    return {
      operation: action,
      title: `${action} ${kind} ${textOr(target.child.name, "unnamed")}`,
      description: `${active ? "Restore" : "Disable"} SuppressIf ${changes.map((condition) => condition.offset).join(", ")} in ${textOr(target.form.name, "unknown Form")}.`,
    };
  }
  const names = affected.map(({ child }) => textOr(child.name, "unnamed"));
  const forms = [...new Set(affected.map(({ form }) => form.name))];
  return {
    operation: action,
    title: `${action} ${String(affected.length > 0 ? affected.length : changes.length)} suppressed item(s)${forms.length === 1 ? ` in ${forms[0]}` : ""}`,
    description:
      names.length > 0
        ? names.join(", ")
        : `${active ? "Restore" : "Disable"} SuppressIf ${changes.map((condition) => condition.offset).join(", ")}.`,
  };
}

function valueDescription(
  patches: DataValuePatch[],
  after: Data,
): OperationDescription | undefined {
  const fields = new Map([
    ["accessLevel", "access level"],
    ["failsafe", "failsafe default"],
    ["optimal", "optimal default"],
  ]);
  const changes = patches.flatMap((patch) => {
    const [forms, formIndex, children, childIndex, field] = patch.path;
    if (
      forms !== "forms" ||
      typeof formIndex !== "number" ||
      children !== "children" ||
      typeof childIndex !== "number" ||
      typeof field !== "string" ||
      !fields.has(field)
    ) {
      return [];
    }
    return [
      {
        patch,
        form: after.forms[formIndex],
        child: after.forms[formIndex]?.children[childIndex],
        field,
      },
    ];
  });
  if (changes.length === 0) return undefined;
  if (changes.length === 1) {
    const change = changes[0];
    const label = fields.get(change.field) ?? change.field;
    return {
      operation: "Change",
      title: `Set ${label} for ${textOr(change.child.name, "unnamed option")}`,
      description: `${displayValue(change.patch.expected)} → ${displayValue(change.patch.replacement)} in ${textOr(change.form.name, "unknown Form")}.`,
    };
  }
  const first = changes[0];
  const sameField = changes.every((change) => change.field === first.field);
  const sameForm = changes.every((change) => change.form === first.form);
  const label = sameField
    ? (fields.get(first.field) ?? first.field)
    : "Setup values";
  return {
    operation: "Change",
    title: `Set ${label}${sameForm ? ` in ${textOr(first.form.name, "Form")}` : ""}`,
    description: changes
      .map(
        (change) =>
          `${textOr(change.child.name, "unnamed")}: ${displayValue(change.patch.expected)} → ${displayValue(change.patch.replacement)}`,
      )
      .join("; "),
  };
}

function menuMappingDescription(
  patches: DataValuePatch[],
  before: Data,
  after: Data,
): OperationDescription | undefined {
  const index = patches.find(
    (patch) => patch.path[0] === "menu" && typeof patch.path[1] === "number",
  )?.path[1];
  if (typeof index !== "number") return undefined;
  // index came from diffing menu entries that exist on both sides (see
  // diffValues: arrays only diff element-wise, so this shape, when
  // matched, is only ever produced for an unchanged array length).
  const previous = before.menu[index];
  const current = after.menu[index];
  return {
    operation: "Retarget",
    title: `Retarget root menu ${previous.name} to ${current.name}`,
    description: `Form ${previous.formId} → ${current.formId}.`,
  };
}

const movedRefPath = /^forms\.\d+\.children$/;

function operationDescription(
  patches: DataValuePatch[],
  before: Data,
  after: Data,
): OperationDescription {
  const paths = patches.map((patch) => pathLabel(patch.path));
  if (paths.some((path) => path.startsWith("rootVisibilityEdits"))) {
    const description = rootVisibilityDescription(before, after);
    if (description) return description;
  }
  if (paths.some((path) => movedRefPath.test(path))) {
    const description = structuralDescription(before, after);
    if (description) return description;
  }
  if (paths.some((path) => path.startsWith("suppressions"))) {
    const description = suppressionDescription(patches, after);
    if (description) return description;
  }
  const value = valueDescription(patches, after);
  if (value) return value;
  if (paths.some((path) => path.startsWith("menu"))) {
    const description = menuMappingDescription(patches, before, after);
    if (description) return description;
  }
  // Only called by createDataChangeEntry once patches.length > 0 is
  // already established.
  const first = patches[0];
  return {
    operation: "Edit",
    title: `Update ${pathLabel(first.path)}`,
    description:
      patches.length === 1
        ? `${displayValue(first.expected)} → ${displayValue(first.replacement)}.`
        : `${String(patches.length)} explicit fields changed: ${patches
            .slice(0, 4)
            .map((patch) => pathLabel(patch.path))
            .join(", ")}${patches.length > 4 ? ", …" : ""}.`,
  };
}

export function createDataChangeEntry(
  before: Data,
  after: Data,
  id: string,
): ChangeQueueEntry<DataChangePayload> | null {
  const patches = diffData(before, after);
  if (patches.length === 0) return null;
  const description = operationDescription(patches, before, after);
  return {
    id,
    family: after.firmwareFamily,
    operation: description.operation,
    targetKey: patches
      .map((patch) => pathLabel(patch.path))
      .sort()
      .join("|"),
    title: description.title,
    description: description.description,
    enabled: true,
    patches: [],
    payload: { patches },
  };
}

export function appendDataChangeEntry(
  entries: ChangeQueueEntry<DataChangePayload>[],
  next: ChangeQueueEntry<DataChangePayload>,
) {
  return [...entries, next];
}

// Replays every enabled entry's logical patches on top of `base`, in
// queue order, to get the Data the editor should currently render - and
// validates each entry's own patches still match what's actually there
// first (an earlier entry paused or removed after a later one was queued
// on top of it leaves that later one referencing stale expected values).
export function projectDataChangeQueue(
  base: Data,
  entries: ChangeQueueEntry<DataChangePayload>[],
): DataQueueProjection {
  const data = clone(base);
  const selectedEntries = entries.filter((entry) => entry.enabled);
  const issues: ChangeQueueAnalysis<DataChangePayload>["issues"] = [];
  let logicalPatchCount = 0;

  for (const entry of selectedEntries) {
    let coherent = true;
    for (const patch of entry.payload.patches) {
      const current = readPath(data, patch.path);
      if (
        current.exists !== patch.expectedExists ||
        (current.exists && !equal(current.value, patch.expected))
      ) {
        coherent = false;
        issues.push({
          severity: "error",
          code: "stale-logical-state",
          message: `${entry.title} expects a different value at ${pathLabel(patch.path)}. It depends on a removed, paused or reordered operation.`,
          entryIds: [entry.id],
        });
        break;
      }
    }
    if (!coherent) continue;
    for (const patch of entry.payload.patches) writePath(data, patch);
    logicalPatchCount += entry.payload.patches.length;
  }

  const netPatches = diffData(base, data);
  if (selectedEntries.length > 0 && netPatches.length === 0) {
    issues.push({
      severity: "warning",
      code: "no-net-change",
      message:
        "The selected operations cancel each other; applying them would leave the firmware plan unchanged.",
      entryIds: selectedEntries.map((entry) => entry.id),
    });
  }
  const fingerprint = selectedEntries.map((entry) => entry.id).join(";");
  return {
    data,
    analysis: {
      selectedEntries,
      patches: [],
      issues,
      fingerprint,
      canApply:
        selectedEntries.length > 0 &&
        netPatches.length > 0 &&
        !issues.some((issue) => issue.severity === "error"),
      stats: {
        selectedChanges: selectedEntries.length,
        patchSpans: netPatches.length,
        changedBytes: netPatches.length,
        buffers: 0,
        deduplicatedSpans: Math.max(0, logicalPatchCount - netPatches.length),
      },
    },
  };
}
