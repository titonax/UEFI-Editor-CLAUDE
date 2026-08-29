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
    pageId: null,
    accessLevel: null,
    failsafe: null,
    optimal: null,
    offsets: null,
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

  it("marks a Ref to a nonexistent form as missing/broken", () => {
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
    expect(child.status).toBe("broken");
    expect(child.formIndex).toBeNull();
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
