import type {
  AmiRootVisibilityEdit,
  AmiRootVisibilityEntry,
  AmiRootVisibilityReport,
  Data,
} from "./types";

// The detected root vector (data.rootVisibility) is immutable evidence
// about the source BIOS. A desired change to a root is recorded separately
// as a pending edit plan that names the exact byte it would flip and the
// value it expects to find there, so the plan can be verified against a
// re-opened firmware before it is ever applied. Toggling a root back to its
// original state simply drops its plan.

type RootVisibilityState = Pick<Data, "rootVisibility" | "rootVisibilityEdits">;

type DetectedReport = AmiRootVisibilityReport & {
  status: "detected";
  vector: NonNullable<AmiRootVisibilityReport["vector"]>;
};

function sameGuid(left?: string, right?: string) {
  return (left ?? "").toLowerCase() === (right ?? "").toLowerCase();
}

function isDetected(report: AmiRootVisibilityReport | undefined): report is DetectedReport {
  return report?.status === "detected" && report.vector !== undefined;
}

export function desiredAmiRootVisibility(
  data: RootVisibilityState,
  entry: AmiRootVisibilityEntry,
): 0 | 1 {
  return (
    data.rootVisibilityEdits?.find((edit) => edit.rootIndex === entry.rootIndex)
      ?.replacement ?? entry.value
  );
}

export function toggleAmiRootVisibility(
  data: RootVisibilityState,
  rootIndex: number,
): AmiRootVisibilityEdit[] | undefined {
  const report = data.rootVisibility;
  if (!isDetected(report)) {
    throw new Error(
      "Root visibility cannot be changed without a unique code-corroborated vector.",
    );
  }
  assertAmiRootVisibilityEditsMatch(data.rootVisibilityEdits, report);
  const entry = report.entries.find((candidate) => candidate.rootIndex === rootIndex);
  if (!entry) {
    throw new Error(`Root visibility entry ${String(rootIndex)} was not found.`);
  }

  const replacement: 0 | 1 = desiredAmiRootVisibility(data, entry) === 1 ? 0 : 1;
  const remaining = (data.rootVisibilityEdits ?? []).filter(
    (edit) => edit.rootIndex !== rootIndex,
  );
  if (replacement === entry.value) {
    return remaining.length > 0 ? remaining : undefined;
  }

  const edit: AmiRootVisibilityEdit = {
    kind: "set-root-visibility",
    rootIndex: entry.rootIndex,
    formId: entry.formId,
    formSetGuid: entry.formSetGuid,
    bufferId: report.vector.bufferId,
    bufferOffset: entry.bufferOffset,
    expected: entry.value,
    replacement,
    description: `${replacement === 1 ? "Show" : "Hide"} root FormSet ${entry.name}`,
  };
  return [...remaining, edit].sort((left, right) => left.rootIndex - right.rootIndex);
}

// Saved plans (e.g. from a data.json) are only accepted when every byte
// they name still matches the vector detected in the firmware that is
// actually open now.
export function assertAmiRootVisibilityEditsMatch(
  edits: AmiRootVisibilityEdit[] | undefined,
  report: AmiRootVisibilityReport | undefined,
): void {
  if (!edits || edits.length === 0) return;
  if (!isDetected(report)) {
    throw new Error(
      "Saved root visibility changes do not have a detected vector in the opened firmware.",
    );
  }

  const seenRoots = new Set<number>();
  for (const edit of edits) {
    if (seenRoots.has(edit.rootIndex)) {
      throw new Error(
        `Saved root visibility changes contain duplicate root ${String(edit.rootIndex)}.`,
      );
    }
    seenRoots.add(edit.rootIndex);

    const entry = report.entries.find((candidate) => candidate.rootIndex === edit.rootIndex);
    if (
      !entry ||
      edit.bufferId !== report.vector.bufferId ||
      edit.bufferOffset !== entry.bufferOffset ||
      edit.formId !== entry.formId ||
      !sameGuid(edit.formSetGuid, entry.formSetGuid) ||
      edit.expected !== entry.value ||
      edit.replacement === edit.expected
    ) {
      throw new Error(
        `Saved root visibility change ${String(edit.rootIndex)} does not match the opened firmware.`,
      );
    }
  }
}
