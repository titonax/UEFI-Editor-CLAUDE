// @vitest-environment jsdom
// Adapted from titonax/uefi-editor-gpt's own
// ChangeQueue/dataChangeQueue.test.ts. Fixture builders are local (this
// repo has no ../../test/fixtures helpers) and mirror the same pattern
// already used by FormUi/tabVisibility.test.ts's makeRef/makeForm.
//
// Two of GPT's original cases don't carry over as-is: their "structural
// move" case relied on an `ifrEdits` field this codebase doesn't have (the
// port's trigger is purely structural instead - see dataChangeQueue.ts's
// header comment), and their "structural hide" case expected `operation:
// "Hide"` from a `uefiHiiVisibilityEdits` log this codebase also doesn't
// have. Both are rewritten below to assert what this port actually,
// deliberately does: describe a relocation-based Hide/Show the same way as
// a generic cross-Form Move.
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { CheckBoxPrompt, Data, Form, RefPrompt, Suppression } from "../scripts/types";
import {
  appendDataChangeEntry,
  createDataChangeEntry,
  projectDataChangeQueue,
} from "./dataChangeQueue";
import { useDataChangeQueue } from "./useDataChangeQueue";

const GUID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

function checkboxPrompt(overrides: Partial<CheckBoxPrompt> = {}): CheckBoxPrompt {
  return {
    name: "Option",
    description: "",
    type: "CheckBox",
    questionId: "0x1",
    varStoreId: "0x1",
    varStoreName: "Setup",
    varOffset: "0x0",
    flags: "0x0",
    accessLevel: null,
    failsafe: null,
    optimal: null,
    offsets: null,
    sctOffset: "0x0",
    ...overrides,
  };
}

function refPrompt(overrides: Partial<RefPrompt> = {}): RefPrompt {
  return {
    name: "Go to page",
    description: "",
    type: "Ref",
    questionId: "0x1",
    varStoreId: "0x1",
    formId: "0x2",
    formIdOffset: "0x0",
    pageId: null,
    accessLevel: null,
    failsafe: null,
    optimal: null,
    offsets: null,
    sctOffset: "0x0",
    ...overrides,
  };
}

function form(overrides: Partial<Form> = {}): Form {
  return {
    name: "Main",
    type: "Form",
    formId: "0x1",
    formSetGuid: GUID,
    referencedIn: [],
    children: [],
    endOffset: "0x0",
    ...overrides,
  };
}

function condition(overrides: Partial<Suppression> = {}): Suppression {
  return {
    offset: "0x0",
    active: true,
    start: "0x0",
    end: "0x2",
    kind: "SuppressIf",
    source: "setup",
    ...overrides,
  };
}

function firmwareData(overrides: Partial<Data> = {}): Data {
  return {
    firmwareFamily: "ami-aptio",
    menu: [],
    forms: [form()],
    varStores: [],
    suppressions: [],
    version: "0.0.0-test",
    hashes: {
      setupTxt: "txt",
      setupSct: "sct",
      amitseSct: "amitse",
      setupdataBin: "setupdata",
      offsetChecksum: "offsets",
    },
    ...overrides,
  };
}

describe("firmware data change queue", () => {
  it("combines independent edits and permits either one to be paused", () => {
    const base = firmwareData({
      suppressions: [condition()],
      forms: [
        form({
          children: [
            checkboxPrompt({
              accessLevel: "00",
              failsafe: "00",
              optimal: "00",
              offsets: { accessLevel: "0x0", failsafe: "0x1", optimal: "0x2" },
            }),
          ],
        }),
      ],
    });
    const visible = structuredClone(base);
    visible.suppressions[0].active = false;
    const visibility = createDataChangeEntry(base, visible, "visibility");
    const defaults = structuredClone(visible);
    defaults.forms[0].children[0].accessLevel = "05";
    const access = createDataChangeEntry(visible, defaults, "access");
    if (!visibility || !access) throw new Error("Expected two queue entries.");

    const combined = projectDataChangeQueue(base, [visibility, access]);
    expect(combined.analysis.canApply).toBe(true);
    expect(combined.data.suppressions[0].active).toBe(false);
    expect(combined.data.forms[0].children[0].accessLevel).toBe("05");

    const accessOnly = projectDataChangeQueue(base, [
      { ...visibility, enabled: false },
      access,
    ]);
    expect(accessOnly.analysis.canApply).toBe(true);
    expect(accessOnly.data.suppressions[0].active).toBe(true);
    expect(accessOnly.data.forms[0].children[0].accessLevel).toBe("05");
  });

  it("blocks a later operation when its required earlier state is removed", () => {
    const base = firmwareData({ suppressions: [condition()] });
    const hidden = structuredClone(base);
    hidden.suppressions[0].active = false;
    const first = createDataChangeEntry(base, hidden, "hide");
    const restored = structuredClone(hidden);
    restored.suppressions[0].active = true;
    const second = createDataChangeEntry(hidden, restored, "restore");
    if (!first || !second) throw new Error("Expected two queue entries.");

    const projection = projectDataChangeQueue(base, [
      { ...first, enabled: false },
      second,
    ]);
    expect(projection.analysis.canApply).toBe(false);
    expect(projection.analysis.issues).toContainEqual(
      expect.objectContaining({ code: "stale-logical-state", severity: "error" }),
    );
  });

  it("optimizes opposite selected operations to no net firmware change", () => {
    const base = firmwareData({ suppressions: [condition()] });
    const hidden = structuredClone(base);
    hidden.suppressions[0].active = false;
    const first = createDataChangeEntry(base, hidden, "hide");
    const restored = structuredClone(hidden);
    restored.suppressions[0].active = true;
    const second = createDataChangeEntry(hidden, restored, "restore");
    if (!first || !second) throw new Error("Expected two queue entries.");

    const projection = projectDataChangeQueue(base, [first, second]);
    expect(projection.analysis.canApply).toBe(false);
    expect(projection.analysis.stats.patchSpans).toBe(0);
    expect(projection.analysis.issues).toContainEqual(
      expect.objectContaining({ code: "no-net-change", severity: "warning" }),
    );
  });

  it("keeps consecutive user actions visible while optimizing their net result", () => {
    const base = firmwareData({ suppressions: [condition()] });
    const hidden = structuredClone(base);
    hidden.suppressions[0].active = false;
    const first = createDataChangeEntry(base, hidden, "hide");
    const restored = structuredClone(hidden);
    restored.suppressions[0].active = true;
    const second = createDataChangeEntry(hidden, restored, "restore");
    if (!first || !second) throw new Error("Expected two queue entries.");

    const entries = appendDataChangeEntry([first], second);
    expect(entries.map((entry) => entry.title)).toEqual([first.title, second.title]);
    expect(projectDataChangeQueue(base, entries).analysis).toMatchObject({
      canApply: false,
      stats: { selectedChanges: 2, patchSpans: 0 },
    });
  });

  it("names the exact menu and direction of a structural move", () => {
    const base = firmwareData({
      forms: [
        form({
          name: "Advanced",
          formId: "0x100",
          children: [
            refPrompt({ name: "Debug Settings", questionId: "0x10", formId: "0x200" }),
          ],
        }),
        form({ name: "Security", formId: "0x300" }),
        form({ name: "Debug Settings", formId: "0x200" }),
      ],
    });
    const moved = structuredClone(base);
    const [reference] = moved.forms[0].children.splice(0, 1);
    moved.forms[1].children.push(reference);

    expect(createDataChangeEntry(base, moved, "move")).toMatchObject({
      operation: "Move",
      title: "Move menu Debug Settings",
      description: "Advanced (0x100) → Security (0x300).",
    });
  });

  it("names the menu affected by a suppression visibility action", () => {
    const base = firmwareData({
      suppressions: [condition({ offset: "0x20", active: true })],
      forms: [
        form({
          name: "Advanced",
          children: [
            refPrompt({
              name: "Trusted Computing",
              formId: "0x200",
              suppressIf: ["0x20"],
            }),
          ],
        }),
      ],
    });
    const shown = structuredClone(base);
    shown.suppressions[0].active = false;

    expect(createDataChangeEntry(base, shown, "show")).toMatchObject({
      operation: "Show",
      title: "Show menu Trusted Computing",
      description: "Disable SuppressIf 0x20 in Advanced.",
    });
  });

  it("describes a relocation-based hide with the shared Move wording (documented scope cut)", () => {
    const reference = refPrompt({
      name: "Trusted Computing",
      questionId: "0x10",
      formId: "0x200",
      targetFormSetGuid: GUID,
    });
    const base = firmwareData({
      forms: [
        form({ name: "Advanced", formId: "0x100", formSetGuid: GUID, children: [reference] }),
        form({ name: "Trusted Computing", formId: "0x200", formSetGuid: GUID }),
        form({ name: "Suppression host", formId: "0x300", formSetGuid: GUID }),
      ],
    });
    const hidden = structuredClone(base);
    const [movedReference] = hidden.forms[0].children.splice(0, 1);
    if (movedReference.type !== "Ref") {
      throw new Error("Expected the Ref fixture.");
    }
    movedReference.suppressIf = ["0x90"];
    movedReference.conditions = ["0x90"];
    movedReference.hiddenByTabToggle = "0x90";
    hidden.forms[2].children.push(movedReference);

    // Unlike GPT's fork - which tags this "Hide" via a separate
    // uefiHiiVisibilityEdits log this codebase doesn't have - the port
    // describes it exactly like a generic cross-Form Move. See
    // dataChangeQueue.ts's header comment for why that's an accepted scope
    // cut: the diff shape (a Ref changes which Form's children array owns
    // it) is identical either way.
    expect(createDataChangeEntry(base, hidden, "hide")).toMatchObject({
      operation: "Move",
      title: "Move menu Trusted Computing",
      description: "Advanced (0x100) → Suppression host (0x300).",
    });
  });

  it("shows the exact option field and old/new values", () => {
    const base = firmwareData({
      forms: [
        form({
          name: "Power & Performance",
          children: [checkboxPrompt({ name: "Turbo Mode", accessLevel: "00" })],
        }),
      ],
    });
    const changed = structuredClone(base);
    changed.forms[0].children[0].accessLevel = "05";

    expect(createDataChangeEntry(base, changed, "access")).toMatchObject({
      operation: "Change",
      title: "Set access level for Turbo Mode",
      description: "00 → 05 in Power & Performance.",
    });
  });

  it("keeps export data immutable until apply and invalidates it after a mutation", () => {
    const base = firmwareData({ suppressions: [condition()] });
    const { result } = renderHook(() => useDataChangeQueue(base));

    act(() => {
      result.current.enqueueData((draft) => {
        draft.suppressions[0].active = false;
      });
    });
    expect(result.current.previewData.suppressions[0].active).toBe(false);
    expect(result.current.appliedData.suppressions[0].active).toBe(true);

    act(() => {
      result.current.apply();
    });
    expect(result.current.appliedData.suppressions[0].active).toBe(false);

    act(() => {
      result.current.enqueueData((draft) => {
        draft.forms[0].name = "Advanced";
      });
    });
    expect(result.current.appliedFingerprint).toBeNull();
    expect(result.current.appliedData.suppressions[0].active).toBe(true);

    act(() => {
      result.current.clear();
    });
    expect(result.current.entries).toHaveLength(0);
    expect(result.current.previewData.suppressions[0].active).toBe(true);
  });
});
