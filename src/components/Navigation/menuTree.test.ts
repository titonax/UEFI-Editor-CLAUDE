import { describe, expect, it } from "vitest";
import { buildMenuTree, findNodePath } from "./menuTree";
import type { Data, Form, Menu, RefPrompt } from "../scripts/types";

function makeRef(overrides: Partial<RefPrompt> = {}): RefPrompt {
  return {
    name: "Go to page",
    description: "",
    type: "Ref",
    questionId: "0x0001",
    varStoreId: "0x0001",
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

function makeForm(overrides: Partial<Form> = {}): Form {
  return {
    name: "A form",
    type: "Form",
    formId: "0x1",
    referencedIn: [],
    children: [],
    endOffset: "0x0",
    ...overrides,
  };
}

function makeData(overrides: Partial<Data> = {}): Data {
  return {
    firmwareFamily: "aptio-v",
    menu: [],
    forms: [],
    varStores: [],
    suppressions: [],
    version: "test",
    hashes: {
      setupTxt: "",
      setupSct: "",
      amitseSct: "",
      setupdataBin: "",
      offsetChecksum: "",
    },
    ...overrides,
  };
}

// A menu entry with a non-null offset (or an explicit amitse/setupdata
// source) is what marks it as real AMITSE-menu evidence, as opposed to a
// bare structural HII FormSet entry.
function makeMenuRoot(overrides: Partial<Menu[number]> = {}): Menu[number] {
  return {
    name: "Main",
    formId: "0x1",
    offset: "0x10",
    source: "amitse",
    ...overrides,
  };
}

describe("buildMenuTree", () => {
  it("builds a single root with no children", () => {
    const forms = [makeForm({ formId: "0x1", name: "Main" })];
    const data = makeData({ forms, menu: [makeMenuRoot()] });

    const tree = buildMenuTree(data);

    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0].formIndex).toBe(0);
    expect(tree.roots[0].reachability).toBe("root");
    expect(tree.orphans).toHaveLength(0);
  });

  it("follows a Ref into a nested child node", () => {
    const forms = [
      makeForm({ formId: "0x1", name: "Main", children: [makeRef({ formId: "0x2" })] }),
      makeForm({ formId: "0x2", name: "Sub", referencedIn: ["0x1"] }),
    ];
    const data = makeData({ forms, menu: [makeMenuRoot()] });

    const tree = buildMenuTree(data);

    expect(tree.roots[0].children).toHaveLength(1);
    expect(tree.roots[0].children[0].formIndex).toBe(1);
    expect(tree.roots[0].children[0].formName).toBe("Sub");
  });

  it("tags a Ref child with the exact opcode it came from, but not a root", () => {
    const forms = [
      makeForm({ formId: "0x1", name: "Main", children: [makeRef({ formId: "0x2" })] }),
      makeForm({ formId: "0x2", name: "Sub" }),
    ];
    const data = makeData({ forms, menu: [makeMenuRoot()] });

    const tree = buildMenuTree(data);

    expect(tree.roots[0].sourceFormIndex).toBeUndefined();
    expect(tree.roots[0].refChildIndex).toBeUndefined();
    expect(tree.roots[0].children[0].sourceFormIndex).toBe(0);
    expect(tree.roots[0].children[0].refChildIndex).toBe(0);
  });

  it("marks a Ref whose target is absent from the loaded HII as unresolved", () => {
    const forms = [
      makeForm({
        formId: "0x1",
        children: [makeRef({ formId: "0xDEAD" })],
      }),
    ];
    const data = makeData({ forms, menu: [makeMenuRoot()] });

    const tree = buildMenuTree(data);
    const child = tree.roots[0].children[0];

    expect(child.missing).toBe(true);
    expect(child.external).toBe(false);
    expect(child.status).toBe("unknown");
    expect(child.reachability).toBe("unresolved");
    expect(child.reachabilityLabel).toBe("Unresolved Ref target");
    expect(child.statusLabel).toBe("Target absent from static Setup HII");
    expect(child.formName).toBe("Referenced form was not found");
    expect(child.formIndex).toBeNull();
    // Still a real Ref opcode - a "move" action should be able to relocate
    // a dangling reference just like a working one.
    expect(child.sourceFormIndex).toBe(0);
    expect(child.refChildIndex).toBe(0);
  });

  it("marks a Ref into a FormSet that is not loaded as external", () => {
    const forms = [
      makeForm({
        formId: "0x1",
        formSetGuid: "AAAAAAAA-0000-0000-0000-000000000000",
        children: [
          makeRef({ formId: "0x2", targetFormSetGuid: "BBBBBBBB-0000-0000-0000-000000000000" }),
        ],
      }),
    ];
    const data = makeData({
      forms,
      menu: [makeMenuRoot({ formSetGuid: "AAAAAAAA-0000-0000-0000-000000000000" })],
    });

    const child = buildMenuTree(data).roots[0].children[0];

    expect(child.missing).toBe(true);
    expect(child.external).toBe(true);
    expect(child.reachability).toBe("external");
    expect(child.reachabilityLabel).toBe("External HII FormSet");
    expect(child.statusLabel).toBe("Requires an external HII package");
    expect(child.formName).toBe("Referenced FormSet is not loaded");
    expect(child.parentageLabel).toContain("BBBBBBBB-0000-0000-0000-000000000000");
  });

  it("never guesses a same-id Form from another FormSet", () => {
    const forms = [
      makeForm({
        formId: "0x1",
        formSetGuid: "AAAAAAAA-0000-0000-0000-000000000000",
        children: [makeRef({ formId: "0x2" })],
      }),
      makeForm({
        formId: "0x2",
        name: "Other FormSet's page",
        formSetGuid: "BBBBBBBB-0000-0000-0000-000000000000",
      }),
    ];
    const data = makeData({
      forms,
      menu: [makeMenuRoot({ formSetGuid: "AAAAAAAA-0000-0000-0000-000000000000" })],
    });

    const child = buildMenuTree(data).roots[0].children[0];

    expect(child.formIndex).toBeNull();
    expect(child.reachability).toBe("unresolved");
  });

  it("resolves a GUID-less reference only when its id is unambiguous", () => {
    const ambiguous = makeData({
      forms: [
        makeForm({ formId: "0x1", children: [makeRef({ formId: "0x2" })] }),
        makeForm({ formId: "0x2", name: "First" }),
        makeForm({ formId: "0x2", name: "Second" }),
      ],
      menu: [makeMenuRoot()],
    });
    const unique = makeData({
      forms: [
        makeForm({ formId: "0x1", children: [makeRef({ formId: "0x2" })] }),
        makeForm({ formId: "0x2", name: "Only" }),
      ],
      menu: [makeMenuRoot()],
    });

    expect(buildMenuTree(ambiguous).roots[0].children[0].formIndex).toBeNull();
    expect(buildMenuTree(unique).roots[0].children[0].formIndex).toBe(1);
  });

  it("applies the detected AMITSE root vector and pending plans to root nodes", () => {
    const guidA = "AAAAAAAA-0000-0000-0000-000000000000";
    const guidB = "BBBBBBBB-0000-0000-0000-000000000000";
    const forms = [
      makeForm({
        formId: "0x1",
        name: "Main",
        formSetGuid: guidA,
        children: [makeRef({ formId: "0x3" })],
      }),
      makeForm({ formId: "0x2", name: "File", formSetGuid: guidB }),
      makeForm({ formId: "0x3", name: "Sub", formSetGuid: guidA, referencedIn: ["0x1"] }),
    ];
    const rootVisibility: Data["rootVisibility"] = {
      status: "detected",
      mechanism: "setup-pe32-root-byte-vector",
      confidence: "corroborated",
      reason: "vector",
      vector: {
        bufferId: 5,
        offset: 0x10,
        length: 2,
        codeReferenceOffset: 0x1,
        pageTableOffset: 0x20,
        countEvidence: "immediate",
      },
      entries: [
        { rootIndex: 0, name: "Main", formId: "0x1", formSetGuid: guidA, value: 0, visible: false, bufferOffset: 0x10 },
        { rootIndex: 1, name: "File", formId: "0x2", formSetGuid: guidB, value: 1, visible: true, bufferOffset: 0x11 },
      ],
    };
    const menu = [
      makeMenuRoot({ formId: "0x1", name: "Main", formSetGuid: guidA }),
      makeMenuRoot({ formId: "0x2", name: "File", formSetGuid: guidB }),
    ];

    const original = buildMenuTree(makeData({ forms, menu, rootVisibility }));

    expect(original.roots[0]).toMatchObject({
      status: "hidden",
      statusLabel: "Hidden by AMITSE root vector",
      rootVisibilityOriginal: 0,
      rootVisibilityDesired: 0,
      rootVisibilityPending: false,
    });
    // A root removed from the page list takes its whole branch with it.
    expect(original.roots[0].children[0].status).toBe("hidden");
    expect(original.roots[1]).toMatchObject({
      status: "visible",
      statusLabel: "Visible in AMITSE root vector",
      rootVisibilityOriginal: 1,
    });

    const planned = buildMenuTree(
      makeData({
        forms,
        menu,
        rootVisibility,
        rootVisibilityEdits: [
          {
            kind: "set-root-visibility",
            rootIndex: 0,
            formId: "0x1",
            formSetGuid: guidA,
            bufferId: 5,
            bufferOffset: 0x10,
            expected: 0,
            replacement: 1,
            description: "Show root FormSet Main",
          },
        ],
      }),
    );

    expect(planned.roots[0]).toMatchObject({
      status: "visible",
      statusLabel: "Pending: root will be visible",
      rootVisibilityDesired: 1,
      rootVisibilityPending: true,
    });
    expect(planned.roots[0].children[0].status).toBe("visible");
  });

  it("detects a Ref cycle without recursing forever", () => {
    const forms = [
      makeForm({ formId: "0x1", children: [makeRef({ formId: "0x2" })] }),
      makeForm({ formId: "0x2", children: [makeRef({ formId: "0x1" })] }),
    ];
    const data = makeData({ forms, menu: [makeMenuRoot()] });

    const tree = buildMenuTree(data);

    const sub = tree.roots[0].children[0];
    expect(sub.formIndex).toBe(1);
    const backRef = sub.children[0];
    expect(backRef.formIndex).toBe(0);
    expect(backRef.cycle).toBe(true);
    // A cycle stops expansion right there instead of looping.
    expect(backRef.children).toHaveLength(0);
  });

  it("collects unreferenced forms as orphans", () => {
    const forms = [
      makeForm({ formId: "0x1", name: "Main" }),
      makeForm({ formId: "0x2", name: "Unreferenced" }),
    ];
    const data = makeData({ forms, menu: [makeMenuRoot()] });

    const tree = buildMenuTree(data);

    expect(tree.orphans).toHaveLength(1);
    expect(tree.orphans[0].formIndex).toBe(1);
  });

  it("falls back to every menu entry as a root when there's no AMITSE/SetupData evidence", () => {
    const forms = [makeForm({ formId: "0x1", name: "Main" })];
    const data = makeData({
      forms,
      menu: [
        makeMenuRoot({ offset: null, source: "formset" }),
      ],
    });

    const tree = buildMenuTree(data);

    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0].formIndex).toBe(0);
  });

  it("assigns every root to a menu profile", () => {
    const forms = [makeForm({ formId: "0x1", name: "Main Page" })];
    const data = makeData({ forms, menu: [makeMenuRoot()] });

    const tree = buildMenuTree(data);

    expect(tree.profiles).toHaveLength(1);
    expect(tree.roots[0].profileId).toBe(tree.profiles[0].id);
  });

  it("is deterministic: the same data produces the same signature", () => {
    const forms = [makeForm({ formId: "0x1", name: "Main" })];
    const data = makeData({ forms, menu: [makeMenuRoot()] });

    expect(buildMenuTree(data).signature).toBe(buildMenuTree(data).signature);
  });

  // Real AMI setups share sub-pages across many parent menus: the same form
  // is reached via several different Ref paths, and buildFormNode
  // deliberately re-expands it once per incoming path (each path can carry
  // its own inherited visibility). Chaining diamonds (a fan-out into two
  // branches that reconverge on a shared form) doubles the number of paths
  // to everything past it at each stage, so a chain of just a few dozen
  // diamonds blows up to millions of node builds - this must terminate in
  // bounded time and report itself as truncated instead of hanging.
  function buildDiamondChain(stages: number) {
    const forms: Form[] = [];
    for (let stage = 0; stage < stages; stage++) {
      const entryIndex = stage * 3;
      forms.push(
        makeForm({
          formId: `0x${entryIndex.toString(16)}`,
          name: `Entry ${String(stage)}`,
          children: [
            makeRef({ formId: `0x${(entryIndex + 1).toString(16)}` }),
            makeRef({ formId: `0x${(entryIndex + 2).toString(16)}` }),
          ],
        }),
      );
      forms.push(
        makeForm({
          formId: `0x${(entryIndex + 1).toString(16)}`,
          name: `Left ${String(stage)}`,
          children: [makeRef({ formId: `0x${(entryIndex + 3).toString(16)}` })],
        }),
      );
      forms.push(
        makeForm({
          formId: `0x${(entryIndex + 2).toString(16)}`,
          name: `Right ${String(stage)}`,
          children: [makeRef({ formId: `0x${(entryIndex + 3).toString(16)}` })],
        }),
      );
    }
    forms.push(
      makeForm({
        formId: `0x${(stages * 3).toString(16)}`,
        name: "Leaf",
      }),
    );
    return forms;
  }

  it("caps a diamond-shaped Ref graph instead of exploding into millions of nodes", () => {
    const forms = buildDiamondChain(30);
    const data = makeData({
      forms,
      menu: [makeMenuRoot({ formId: "0x0" })],
    });

    const tree = buildMenuTree(data);

    expect(tree.truncated).toBe(true);
  });

  it("does not truncate a small, ordinary graph", () => {
    const forms = [
      makeForm({ formId: "0x1", children: [makeRef({ formId: "0x2" })] }),
      makeForm({ formId: "0x2" }),
    ];
    const data = makeData({ forms, menu: [makeMenuRoot()] });

    const tree = buildMenuTree(data);

    expect(tree.truncated).toBe(false);
  });

  it("does not restart a menu profile on Main right after Exit unless Main/SysInfo already appeared", () => {
    const forms = [
      makeForm({ formId: "0x1", name: "Boot" }),
      makeForm({ formId: "0x2", name: "Exit" }),
      makeForm({ formId: "0x3", name: "Main" }),
    ];
    const data = makeData({
      forms,
      menu: [
        makeMenuRoot({ formId: "0x1", name: "Boot" }),
        makeMenuRoot({ formId: "0x2", name: "Exit" }),
        makeMenuRoot({ formId: "0x3", name: "Main" }),
      ],
    });

    const tree = buildMenuTree(data);

    // "Main" is this menu's very first Main/SysInfo root, so it can't be
    // restarting a sequence that never started - this must stay one group.
    expect(tree.profiles).toHaveLength(1);
  });

  it("recognizes a vendor File/Storage/Power page sequence as an OEM profile distinct from the AMI fallback", () => {
    const definitions = [
      ["File", "0x40A", "0x0"],
      ["Storage", "0x40F", "0x40"],
      ["Security", "0x412", "0x50"],
      ["Power", "0x41B", "0x60"],
      ["Advanced", "0x41F", "0x70"],
      ["Advanced", "0x402", "0x80"],
      ["Boot", "0x406", "0x2"],
      ["Chipset", "0x405", "0x8"],
      ["Save & Exit", "0x409", "0x4"],
      ["Main", "0x400", "0x20"],
      ["Security", "0x408", "0x1"],
    ] as const;
    const roots = definitions.map(([name, formId, pageMask], index) => ({
      name,
      formId,
      formSetGuid: `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
      pageMask,
    }));
    const forms = roots.map((root) =>
      makeForm({
        formId: root.formId,
        name: root.name,
        formSetGuid: root.formSetGuid,
        formSetTitle: root.name,
      }),
    );
    const menu: Menu = roots.map((root) => ({
      name: root.name,
      formId: root.formId,
      offset: null,
      formSetGuid: root.formSetGuid,
      source: "setupdata",
      pageMask: root.pageMask,
    }));
    const data = makeData({ forms, menu });

    const tree = buildMenuTree(data);

    expect(tree.orphans).toHaveLength(0);
    expect(tree.profiles).toHaveLength(2);
    expect(tree.profiles[0]).toMatchObject({
      label: "OEM menu profile · probable live",
      assessment: "probable-live",
    });
    expect(tree.profiles[0].roots.map((root) => root.formId)).toEqual([
      "0x40A",
      "0x40F",
      "0x412",
      "0x41B",
      "0x41F",
    ]);
    expect(tree.profiles[1]).toMatchObject({
      label: "AMI full profile · probable fallback",
      assessment: "probable-fallback",
    });
    expect(tree.profiles[1].roots.map((root) => root.formId)).toEqual([
      "0x402",
      "0x406",
      "0x405",
      "0x409",
      "0x400",
      "0x408",
    ]);
    expect(tree.profiles[0].roots[0].reachabilityLabel).toBe(
      "Probable live SetupData root",
    );
    expect(tree.profiles[1].roots[0].reachabilityLabel).toBe(
      "Probable fallback SetupData root",
    );
  });

  it("changes signature when a Ref target changes", () => {
    const withoutRef = makeData({
      forms: [
        makeForm({ formId: "0x1" }),
        makeForm({ formId: "0x2" }),
        makeForm({ formId: "0x3" }),
      ],
      menu: [makeMenuRoot()],
    });
    const withRef = makeData({
      forms: [
        makeForm({ formId: "0x1", children: [makeRef({ formId: "0x2" })] }),
        makeForm({ formId: "0x2" }),
        makeForm({ formId: "0x3" }),
      ],
      menu: [makeMenuRoot()],
    });

    expect(buildMenuTree(withoutRef).signature).not.toBe(
      buildMenuTree(withRef).signature,
    );
  });
});

describe("findNodePath", () => {
  it("returns the path from root to the target form", () => {
    const forms = [
      makeForm({ formId: "0x1", children: [makeRef({ formId: "0x2" })] }),
      makeForm({ formId: "0x2" }),
    ];
    const data = makeData({ forms, menu: [makeMenuRoot()] });
    const tree = buildMenuTree(data);

    const path = findNodePath(tree.roots, 1);

    expect(path.map((node) => node.formIndex)).toEqual([0, 1]);
  });

  it("returns an empty path when the form isn't in the tree", () => {
    const forms = [makeForm({ formId: "0x1" })];
    const data = makeData({ forms, menu: [makeMenuRoot()] });
    const tree = buildMenuTree(data);

    expect(findNodePath(tree.roots, 99)).toEqual([]);
  });
});
