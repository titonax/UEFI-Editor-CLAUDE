import { describe, expect, it } from "vitest";
import { analyzeMoveDestinations, applyMoveToDraft } from "./relocating";
import { buildRefLocation } from "./reparenting";
import {
  inspectSingleFormSetNavigation,
  singleFormSetHubMenu,
} from "../scripts/singleFormSetNavigation";
import { buildMoveFixture, MOVE_FIXTURE_GUID_A } from "../scripts/testFixtures";
import type { RefPrompt } from "../scripts/types";

// Fixture form indices: 0 = Main (source), 1 = Sub (the Ref's target, same
// package), 2 = Other (a different FormSet in a different Forms Package).
function analyze(options: Parameters<typeof buildMoveFixture>[0] = {}) {
  const { bytes, data } = buildMoveFixture(options);
  return { bytes, data, results: analyzeMoveDestinations(data, buildRefLocation(data, 0, 0), bytes) };
}

describe("analyzeMoveDestinations", () => {
  it("labels the source, a cycle and a proven cross-package destination", () => {
    const { results } = analyze({ explicitTargetGuid: true });

    expect(results).toEqual([
      { formIndex: 0, compatibility: "unavailable", reason: "The Ref is already in this Form." },
      {
        formIndex: 1,
        compatibility: "unavailable",
        reason: "Moving this Ref there would create a cycle in the HII menu graph.",
      },
      {
        formIndex: 2,
        compatibility: "safe-cross-package",
        reason: "Safe fixed-size move; Forms Package lengths will be rebalanced.",
      },
    ]);
  });

  it("requires REF3 conversion for a Ref without an explicit FormSet crossing FormSets", () => {
    const { results } = analyze();

    expect(results[2]).toEqual({
      formIndex: 2,
      compatibility: "requires-ref3",
      reason: "This REF/REF2 needs conversion to REF3 before it can cross FormSets.",
    });
  });

  it("allows a same-package move when the target is elsewhere", () => {
    const { bytes, data } = buildMoveFixture();
    // Point the Ref at Other (a different form) so Sub becomes a plain
    // destination inside the same package.
    const ref = data.forms[0].children[0] as RefPrompt;
    ref.formId = "0x2";
    ref.targetFormSetGuid = "BBBBBBBB-1111-2222-3333-444444444444";
    bytes[Number.parseInt(ref.formIdOffset, 16)] = 0x02;

    const results = analyzeMoveDestinations(data, buildRefLocation(data, 0, 0), bytes);

    expect(results[1]).toEqual({
      formIndex: 1,
      compatibility: "safe-same-package",
      reason: "Safe fixed-size move inside the existing Forms Package.",
    });
  });

  it("carries a Ref's sole-occupant condition wrapper along as one block", () => {
    const { results } = analyze({ explicitTargetGuid: true, hiddenRef: true });

    expect(results[2].compatibility).toBe("safe-cross-package");
  });

  it("blocks every destination for a Ref parked by the tab visibility toggle", () => {
    const { bytes, data } = buildMoveFixture({ explicitTargetGuid: true });
    (data.forms[0].children[0] as RefPrompt).hiddenByTabToggle = "0x16";

    const results = analyzeMoveDestinations(data, buildRefLocation(data, 0, 0), bytes);

    expect(results.every((result) => result.compatibility === "unavailable")).toBe(true);
    expect(results[2].reason).toBe(
      "This item is currently hidden by the top-level tab visibility toggle; use Show to restore it to the navigation hub before moving it elsewhere.",
    );
  });

  it("blocks every destination for a Ref sharing its condition with a sibling", () => {
    const { bytes, data } = buildMoveFixture({ explicitTargetGuid: true, hiddenRef: true });
    const ref = data.forms[0].children[0] as RefPrompt;
    data.forms[0].children.push({ ...ref, questionId: "0x0002", formId: "0x2" });

    const results = analyzeMoveDestinations(data, buildRefLocation(data, 0, 0), bytes);

    expect(results.every((result) => result.compatibility === "unavailable")).toBe(true);
    expect(results[2].reason).toMatch(/shares its hide condition/);
  });

  it("blocks every destination for a scoped Ref", () => {
    const { results } = analyze({ explicitTargetGuid: true, scopedRef: true });

    expect(results.map((result) => result.reason)).toEqual(
      new Array<string>(3).fill("Only a non-scoped IFR Ref opcode can be moved."),
    );
  });

  it("blocks every destination when the Ref's target is missing", () => {
    const { bytes, data } = buildMoveFixture({ explicitTargetGuid: true });
    (data.forms[0].children[0] as RefPrompt).formId = "0x9";

    const results = analyzeMoveDestinations(data, buildRefLocation(data, 0, 0), bytes);

    expect(results[2]).toMatchObject({
      compatibility: "unavailable",
      reason: "The selected Ref has a missing target and cannot be moved safely.",
    });
  });

  it("blocks every destination when the pristine bytes no longer hold a Ref", () => {
    const { bytes, data, offsets } = buildMoveFixture({ explicitTargetGuid: true });
    bytes[offsets.ref] = 0x03;

    const results = analyzeMoveDestinations(data, buildRefLocation(data, 0, 0), bytes);

    expect(results[2].reason).toBe("The source bytes no longer match the decoded IFR Ref span.");
  });

  it("blocks every destination when no Forms Package can be proven", () => {
    const { data } = buildMoveFixture({ explicitTargetGuid: true });
    const junk = new Uint8Array(200);
    junk[Number.parseInt((data.forms[0].children[0] as RefPrompt).sctOffset, 16)] = 0x0f;
    junk[Number.parseInt((data.forms[0].children[0] as RefPrompt).sctOffset, 16) + 1] = 0x0f;

    const results = analyzeMoveDestinations(data, buildRefLocation(data, 0, 0), junk);

    expect(results[2].reason).toBe(
      "No valid HII Forms Package was found in the Setup binary stream.",
    );
  });

  it("blocks a destination that already links to the same target", () => {
    const { bytes, data } = buildMoveFixture({ explicitTargetGuid: true });
    const ref = data.forms[0].children[0] as RefPrompt;
    data.forms[2].children.push({ ...ref, questionId: "0x0002", targetFormSetGuid: MOVE_FIXTURE_GUID_A });

    const results = analyzeMoveDestinations(data, buildRefLocation(data, 0, 0), bytes);

    expect(results[2].reason).toBe("The destination Form already contains a Ref to the same target.");
  });

  it("blocks a destination whose End opcode is not where the model says", () => {
    const { bytes, data } = buildMoveFixture({ explicitTargetGuid: true });
    data.forms[2].endOffset = "0x2";

    const results = analyzeMoveDestinations(data, buildRefLocation(data, 0, 0), bytes);

    expect(results[2].reason).toBe(
      "The destination Form End opcode no longer matches the binary model.",
    );
  });

  it("blocks a cross-package move between packages of different provenance", () => {
    const { results } = analyze({ explicitTargetGuid: true, bareSecondPackage: true });

    expect(results[2]).toMatchObject({
      compatibility: "unavailable",
      reason: "The Forms Packages have incompatible container provenance.",
    });
  });
});

describe("applyMoveToDraft", () => {
  it("refreshes the single-FormSet tab inventory when a hub Ref leaves the hub", () => {
    const { data } = buildMoveFixture();
    const ref = data.forms[0].children[0] as RefPrompt;
    data.forms[0].children.push({ ...ref, questionId: "0x0002", formId: "0x2" });
    data.forms[2].formSetGuid = data.forms[0].formSetGuid;
    data.forms[2].formSetTitle = data.forms[0].formSetTitle;
    data.formSetRoots = [
      { name: "Main", formId: "0x1", offset: null, formSetGuid: data.forms[0].formSetGuid, source: "formset" },
    ];
    data.singleFormSetNavigation = inspectSingleFormSetNavigation(data.formSetRoots, data.forms, []);
    data.menu = singleFormSetHubMenu(data.singleFormSetNavigation);
    expect(data.singleFormSetNavigation.status).toBe("detected");

    applyMoveToDraft(data, 0, 0, 2);

    expect(data.singleFormSetNavigation.pages.map((page) => [page.formId, page.role])).toEqual([
      ["0x1", "hub"],
      ["0x2", "direct-tab"],
    ]);
    expect(data.menu[0]).toMatchObject({ source: "ifr-hub", formId: "0x1" });
  });

  it("splices the Ref out of its source and appends it to the destination", () => {
    const { data } = buildMoveFixture();
    const ref = data.forms[0].children[0] as RefPrompt;
    data.forms[0].children.push({ ...ref, questionId: "0x0002", formId: "0x2" });
    data.forms[2].children.push({ ...ref, questionId: "0x0003", formId: "0x1" });

    applyMoveToDraft(data, 0, 0, 2);

    expect(data.forms[0].children.map((child) => child.questionId)).toEqual(["0x0002"]);
    expect(data.forms[2].children.map((child) => child.questionId)).toEqual([
      "0x0003",
      "0x0001",
    ]);
  });
});
