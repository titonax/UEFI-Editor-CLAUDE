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
    // Still a real Ref opcode - a "move" action should be able to fix a
    // dangling reference just like it can retarget a working one.
    expect(child.sourceFormIndex).toBe(0);
    expect(child.refChildIndex).toBe(0);
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
