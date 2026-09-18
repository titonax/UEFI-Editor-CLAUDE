import { describe, expect, it, vi } from "vitest";
import { decToHexString, downloadModifiedFiles, validateByteInput } from "./binaryPatcher";
import { parseData } from "./ifrParser";
import { buildFixtureFiles, buildMoveFixture } from "./testFixtures";
import type { PopulatedFiles } from "../FileUploads/fileModel";
import type { Data, RefPrompt } from "./types";

const saveAsMock = vi.fn();
vi.mock("file-saver", () => ({
  saveAs: (blob: Blob, name: string) => {
    saveAsMock(blob, name);
  },
}));

describe("validateByteInput", () => {
  it("accepts an empty string", () => {
    expect(validateByteInput("")).toBe(true);
  });

  it("accepts one or two hex digits, any case", () => {
    expect(validateByteInput("A")).toBe(true);
    expect(validateByteInput("ab")).toBe(true);
    expect(validateByteInput("F0")).toBe(true);
  });

  it("rejects more than two characters", () => {
    expect(validateByteInput("ABC")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(validateByteInput("G0")).toBe(false);
    expect(validateByteInput("Z")).toBe(false);
  });
});

describe("downloadModifiedFiles", () => {
  it("reports no changes when every suppression stays active", async () => {
    const files = await buildFixtureFiles();
    const data = await parseData(files);

    saveAsMock.mockClear();
    const result = downloadModifiedFiles(data, files);

    expect(result).toEqual({ status: "no-changes" });
    expect(saveAsMock).not.toHaveBeenCalled();
  });

  it("refuses to export extracted files while a root visibility plan is pending", async () => {
    const files = await buildFixtureFiles();
    const data = await parseData(files);
    data.rootVisibilityEdits = [
      {
        kind: "set-root-visibility",
        rootIndex: 0,
        formId: "0x1",
        bufferId: 0,
        bufferOffset: 0x40,
        expected: 0,
        replacement: 1,
        description: "Show root FormSet Main Setup",
      },
    ];

    saveAsMock.mockClear();
    expect(() => downloadModifiedFiles(data, files)).toThrow(
      /verified full-image reconstruction path/,
    );
    expect(saveAsMock).not.toHaveBeenCalled();
  });

  // The move fixture's AMITSE table holds each root's FormId at the offset
  // its menu entry names, so the AMITSE loop sees nothing to change.
  function moveFixtureFiles(bytes: Uint8Array): PopulatedFiles {
    const toHex = (value: Uint8Array) =>
      Array.from(value, (byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join("");
    const amitse = new Uint8Array(0x20);
    amitse[0x10] = 0x01;
    amitse[0x12] = 0x02;
    const setupData = new Uint8Array(4);
    return {
      setupSctContainer: { file: new File([bytes], "Setup.sct"), textContent: toHex(bytes), isWrongFile: false },
      setupTxtContainer: { file: new File([""], "setup.ifr.txt"), textContent: "", isWrongFile: false },
      amitseSctContainer: { file: new File([amitse], "AmiTse.sct"), textContent: toHex(amitse), isWrongFile: false },
      setupdataBinContainer: { file: new File([setupData], "SetupData.bin"), textContent: toHex(setupData), isWrongFile: false },
    };
  }

  async function savedBytes(name: string) {
    const call = saveAsMock.mock.calls.find((candidate) => candidate[1] === name);
    if (!call) throw new Error(`expected ${name} to be saved`);
    return new Uint8Array(await (call[0] as Blob).arrayBuffer());
  }

  async function changelogText() {
    const call = saveAsMock.mock.calls.find((candidate) => candidate[1] === "changelog.txt");
    if (!call) throw new Error("expected changelog.txt to be saved");
    return (call[0] as Blob).text();
  }

  function required(offset: number | undefined) {
    if (offset === undefined) throw new Error("fixture offset missing");
    return offset;
  }

  const REF_LENGTH = 15;

  it("rebalances both Forms Package lengths when a Ref moves across packages", async () => {
    const { bytes, data, offsets } = buildMoveFixture({ explicitTargetGuid: true });
    const [moved] = data.forms[0].children.splice(0, 1);
    data.forms[2].children.push(moved);
    const files = moveFixtureFiles(bytes);

    saveAsMock.mockClear();
    downloadModifiedFiles(data, files);

    // Expected layout: the 15-byte Ref leaves package A and lands right
    // before Other's End; A shrinks and B (whose header shifted left by
    // the Ref's length) grows by the same 15 bytes; the shared package
    // list keeps its total length.
    const expected = [...bytes];
    const refBytes = expected.splice(offsets.ref, 15);
    expected.splice(offsets.form2End - 15, 0, ...refBytes);
    const readUint24 = (source: number[], offset: number) =>
      source[offset] | (source[offset + 1] << 8) | (source[offset + 2] << 16);
    const writeUint24 = (target: number[], offset: number, value: number) => {
      target[offset] = value & 0xff;
      target[offset + 1] = (value >>> 8) & 0xff;
      target[offset + 2] = (value >>> 16) & 0xff;
    };
    writeUint24(expected, offsets.packageA, readUint24(expected, offsets.packageA) - 15);
    writeUint24(expected, offsets.packageB - 15, readUint24(expected, offsets.packageB - 15) + 15);

    expect(Array.from(await savedBytes("Setup.sct"))).toEqual(expected);
    expect(await changelogText()).toContain(
      'Moved Go to Sub from "Main" to "Other" across HII Forms Packages',
    );
    expect(Array.from(await savedBytes("Setup.sct")).length).toBe(bytes.length);
  });

  it("moves a Ref's bytes forward to a later Form inside one package, leaving package lengths untouched", async () => {
    // The Ref (pointing at Other, so Sub is a plain destination) leaves
    // Main and lands right before Sub's End: Sub's old body slides left
    // into the gap, the Ref becomes its new last child, and nothing before
    // the Ref's old position or after Sub's End moves.
    const { bytes, data, offsets } = buildMoveFixture({ refTarget: "other" });
    const [moved] = data.forms[0].children.splice(0, 1);
    data.forms[1].children.push(moved);
    const files = moveFixtureFiles(bytes);

    saveAsMock.mockClear();
    downloadModifiedFiles(data, files);

    const expected = [...bytes];
    const refBytes = expected.splice(offsets.ref, REF_LENGTH);
    expected.splice(offsets.form3End - REF_LENGTH, 0, ...refBytes);
    expect(Array.from(await savedBytes("Setup.sct"))).toEqual(expected);
    const changelog = await changelogText();
    expect(changelog).toContain('Moved Go to Other from "Main" to "Sub"');
    expect(changelog).not.toContain("across HII Forms Packages");
  });

  it("moves a Ref's bytes backward to an earlier Form", async () => {
    // The Ref pristinely sits in Sub; moving it into Main lands its bytes
    // right at Main's old End boundary, and everything between that
    // boundary and the Ref's old position slides right by the Ref's length
    // to make room. Nothing at or after Sub's End moves.
    const { bytes, data, offsets } = buildMoveFixture({ refHome: "sub", refTarget: "other" });
    const [moved] = data.forms[1].children.splice(0, 1);
    data.forms[0].children.push(moved);
    const files = moveFixtureFiles(bytes);

    saveAsMock.mockClear();
    downloadModifiedFiles(data, files);

    const expected = [...bytes];
    const refBytes = expected.splice(offsets.ref, REF_LENGTH);
    expected.splice(offsets.form1End, 0, ...refBytes);
    expect(Array.from(await savedBytes("Setup.sct"))).toEqual(expected);
    expect(await changelogText()).toContain('Moved Go to Other from "Sub" to "Main"');
  });

  it("moves a hidden Ref together with its whole condition wrapper", async () => {
    // The movable block is the SuppressIf opcode, its True expression, the
    // Ref and the SuppressIf's own End marker, as one unit - so the item
    // stays hidden in its new Form instead of arriving unconditionally
    // visible. The suppression's own offsets are remapped along with it,
    // so nothing is reported as unsuppressed.
    const { bytes, data, offsets } = buildMoveFixture({
      refHome: "sub",
      refTarget: "other",
      hiddenRef: true,
    });
    const [moved] = data.forms[1].children.splice(0, 1);
    data.forms[0].children.push(moved);
    const files = moveFixtureFiles(bytes);

    saveAsMock.mockClear();
    downloadModifiedFiles(data, files);

    const wrapperLength = 4 + REF_LENGTH + 2;
    const expected = [...bytes];
    const block = expected.splice(required(offsets.suppressIf), wrapperLength);
    expected.splice(offsets.form1End, 0, ...block);
    expect(Array.from(await savedBytes("Setup.sct"))).toEqual(expected);
    expect(await changelogText()).not.toContain("Unsuppressed");
  });

  // A minimal single-package, single-FormSet buffer for the tab visibility
  // toggle: Setup (the hub) holds one unconditioned Ref to Advanced;
  // Chipset - an unrelated Form elsewhere in the same package - already
  // holds a Ref to Legacy parked inside a genuine, pre-existing
  // constant-true SuppressIf scope. That scope is the reusable "parking
  // bin" Hide is expected to park the hub's Ref inside, alongside the
  // existing seed, without ever touching the wrapper itself.
  const TAB_VISIBILITY_GUID = "CCCCCCCC-1111-2222-3333-444444444444";
  // `alreadyHidden` places the same 15-byte Ref opcode inside Chipset's
  // SuppressIf scope (after the seed) instead of inside Setup, and gives it
  // that scope's condition - the pristine shape a fresh parse would produce
  // for a tab a previous session already hid (hiddenByTabToggle itself is
  // never something a parse can recover from bytes alone, since a toggle-
  // parked Ref is byte-for-byte indistinguishable from an ordinary shared
  // condition; callers that want to simulate "still mid-session" set it by
  // hand after construction).
  function buildTabVisibilityFixture(options: { alreadyHidden?: boolean } = {}) {
    const parts: number[] = [];
    const marks = new Map<string, number>();
    const push = (mark: string | null, values: number[]) => {
      if (mark) marks.set(mark, parts.length);
      parts.push(...values);
    };
    const writeUint24 = (offset: number, value: number) => {
      parts[offset] = value & 0xff;
      parts[offset + 1] = (value >>> 8) & 0xff;
      parts[offset + 2] = (value >>> 16) & 0xff;
    };
    const END = [0x29, 0x02];
    const SUPPRESS_IF_TRUE = [0x0a, 0x82, 0x46, 0x02];
    const guidBytes = (guid: string) => {
      const segments = guid.split("-");
      const reverse = (hex: string) => hex.match(/../g)?.reverse().join("") ?? "";
      const encoded =
        reverse(segments[0]) + reverse(segments[1]) + reverse(segments[2]) + segments[3] + segments[4];
      return Array.from(encoded.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
    };
    const formSet = (guid: string) => [0x0e, 0x97, ...guidBytes(guid), 0, 0, 0, 0, 0];
    const form = (id: number) => [0x01, 0x86, id & 0xff, id >> 8, 0, 0];
    const ref = (targetId: number) => [0x0f, 0x0f, ...new Array<number>(11).fill(0), targetId & 0xff, targetId >> 8];

    push("list", new Array<number>(20).fill(0));
    const packageAStart = parts.length;
    push("packageA", [0, 0, 0, 0x02]);
    push(null, formSet(TAB_VISIBILITY_GUID));
    push("form1", form(1));
    if (!options.alreadyHidden) push("refHub", ref(2));
    push("form1End", END);
    push("form3", form(3));
    push("suppressIf", SUPPRESS_IF_TRUE);
    push("refSeed", ref(4));
    if (options.alreadyHidden) push("refHub", ref(2));
    push("suppressEnd", END);
    push("form3End", END);
    push("form2", form(2));
    push("form2End", END);
    push("form4", form(4));
    push("form4End", END);
    push(null, END);
    writeUint24(packageAStart, parts.length - packageAStart);
    push(null, [4, 0, 0, 0xdf]);
    const listLength = parts.length;
    parts[16] = listLength & 0xff;
    parts[17] = (listLength >>> 8) & 0xff;
    parts[18] = (listLength >>> 16) & 0xff;
    parts[19] = 0;

    const at = (mark: string) => {
      const offset = marks.get(mark);
      if (offset === undefined) throw new Error(`fixture mark ${mark} missing`);
      return offset;
    };
    const hex = (value: number) => `0x${value.toString(16).toUpperCase()}`;

    const refHub: RefPrompt = {
      name: "Advanced",
      description: "",
      type: "Ref",
      questionId: "0x0001",
      varStoreId: "0x0001",
      formId: "0x2",
      formIdOffset: hex(at("refHub") + 13),
      pageId: null,
      accessLevel: null,
      failsafe: null,
      optimal: null,
      offsets: null,
      sctOffset: hex(at("refHub")),
      conditions: options.alreadyHidden ? [hex(at("suppressIf"))] : undefined,
      suppressIf: options.alreadyHidden ? [hex(at("suppressIf"))] : undefined,
    };
    const refSeed: RefPrompt = {
      name: "Legacy",
      description: "",
      type: "Ref",
      questionId: "0x0002",
      varStoreId: "0x0001",
      formId: "0x4",
      formIdOffset: hex(at("refSeed") + 13),
      pageId: null,
      accessLevel: null,
      failsafe: null,
      optimal: null,
      offsets: null,
      sctOffset: hex(at("refSeed")),
      conditions: [hex(at("suppressIf"))],
      suppressIf: [hex(at("suppressIf"))],
    };

    const data: Data = {
      firmwareFamily: "aptio-v",
      menu: [],
      forms: [
        {
          name: "Setup",
          type: "Form",
          formId: "0x1",
          formSetGuid: TAB_VISIBILITY_GUID,
          referencedIn: [],
          children: options.alreadyHidden ? [] : [refHub],
          endOffset: hex(at("form1End")),
        },
        {
          name: "Chipset",
          type: "Form",
          formId: "0x3",
          formSetGuid: TAB_VISIBILITY_GUID,
          referencedIn: ["0x1"],
          children: options.alreadyHidden ? [refSeed, refHub] : [refSeed],
          endOffset: hex(at("form3End")),
        },
        {
          name: "Advanced",
          type: "Form",
          formId: "0x2",
          formSetGuid: TAB_VISIBILITY_GUID,
          referencedIn: ["0x1"],
          children: [],
          endOffset: hex(at("form2End")),
        },
        {
          name: "Legacy",
          type: "Form",
          formId: "0x4",
          formSetGuid: TAB_VISIBILITY_GUID,
          referencedIn: ["0x3"],
          children: [],
          endOffset: hex(at("form4End")),
        },
      ],
      varStores: [],
      suppressions: [
        {
          offset: hex(at("suppressIf")),
          active: true,
          start: hex(at("suppressIf")),
          end: hex(at("suppressEnd")),
          kind: "SuppressIf",
          constant: true,
          source: "constant",
          expression: "True",
          varStoreNames: [],
          formSetGuid: TAB_VISIBILITY_GUID,
        },
      ],
      version: "test",
      hashes: { setupTxt: "", setupSct: "", amitseSct: "", setupdataBin: "", offsetChecksum: "" },
    };

    return {
      bytes: Uint8Array.from(parts),
      data,
      offsets: { refHub: at("refHub"), form1End: at("form1End"), suppressEnd: at("suppressEnd") },
    };
  }

  it("hides a top-level tab into an existing SuppressIf scope, leaving the wrapper untouched", async () => {
    const { bytes, data, offsets } = buildTabVisibilityFixture();
    const hub = data.forms[0];
    const chipset = data.forms[1];

    // The bare 15-byte Ref opcode alone (never the wrapper) moves from
    // Setup to right before Chipset's existing SuppressIf scope's own End,
    // becoming that scope's second parked Ref alongside the seed.
    const [hidden] = hub.children.splice(0, 1) as [RefPrompt];
    hidden.conditions = [data.suppressions[0].offset];
    hidden.suppressIf = [data.suppressions[0].offset];
    hidden.hiddenByTabToggle = data.suppressions[0].offset;
    chipset.children.push(hidden);
    const files = moveFixtureFiles(bytes);

    saveAsMock.mockClear();
    downloadModifiedFiles(data, files);

    const expected = [...bytes];
    const refBytes = expected.splice(offsets.refHub, REF_LENGTH);
    expected.splice(offsets.suppressEnd - REF_LENGTH, 0, ...refBytes);
    expect(Array.from(await savedBytes("Setup.sct"))).toEqual(expected);
    expect(await changelogText()).toContain(
      'Hid top-level tab Advanced inside an existing SuppressIf scope in "Chipset"',
    );
  });

  it("shows a previously-hidden tab back on the hub, appending it at the hub's own end", async () => {
    // Starts from the pristine shape a fresh parse would produce for a tab
    // a previous session already hid: the Ref's bytes already sit inside
    // Chipset's SuppressIf scope, sharing it with the seed, and
    // hiddenByTabToggle is never set - a parse alone can never recover it
    // (see its comment on RefPrompt). applyTabVisibilityToggle's Show reads
    // the Ref's live conditions/suppressIf instead, so this is exactly what
    // it acts on when a tab hidden in an earlier session is shown again
    // after reopening an export or a data.json missing that marker.
    const { bytes, data, offsets } = buildTabVisibilityFixture({ alreadyHidden: true });
    const hub = data.forms[0];
    const chipset = data.forms[1];
    const parkedIndex = chipset.children.findIndex(
      (child) => child.type === "Ref" && child.formId === "0x2",
    );
    const [shown] = chipset.children.splice(parkedIndex, 1) as [RefPrompt];
    delete shown.conditions;
    delete shown.suppressIf;
    hub.children.push(shown);
    const files = moveFixtureFiles(bytes);

    saveAsMock.mockClear();
    downloadModifiedFiles(data, files);

    // The Ref leaves its spot inside the SuppressIf scope - the seed and
    // the scope's own wrapper close up around the gap exactly as an
    // ordinary move would - and lands right before Setup's own End, with
    // no sibling to anchor next to.
    const expected = [...bytes];
    const refBytes = expected.splice(offsets.refHub, REF_LENGTH);
    expected.splice(offsets.form1End, 0, ...refBytes);
    expect(Array.from(await savedBytes("Setup.sct"))).toEqual(expected);
    expect(await changelogText()).toContain('Moved Advanced from "Chipset" to "Setup"');
  });

  // A minimal single-Form fixture for the same-hub tab visibility case: the
  // hub holds both the live Ref to Advanced AND, inside its own constant-true
  // SuppressIf scope, nothing else at all - the scope is reusable purely by
  // sitting there, with no seed required (see findVisibilityHost's own
  // comment on why a seed is no longer needed). Hide/Show never move this
  // Ref to a different Form, only to a different position inside the SAME
  // one - exactly the case detectRefMoves' pristineOwner comparison alone
  // cannot see, which repositionedWithinForm exists to say explicitly.
  function buildSameHubTabVisibilityFixture(options: { alreadyHidden?: boolean } = {}) {
    const parts: number[] = [];
    const marks = new Map<string, number>();
    const push = (mark: string | null, values: number[]) => {
      if (mark) marks.set(mark, parts.length);
      parts.push(...values);
    };
    const writeUint24 = (offset: number, value: number) => {
      parts[offset] = value & 0xff;
      parts[offset + 1] = (value >>> 8) & 0xff;
      parts[offset + 2] = (value >>> 16) & 0xff;
    };
    const END = [0x29, 0x02];
    const SUPPRESS_IF_TRUE = [0x0a, 0x82, 0x46, 0x02];
    const guidBytes = (guid: string) => {
      const segments = guid.split("-");
      const reverse = (hex: string) => hex.match(/../g)?.reverse().join("") ?? "";
      const encoded =
        reverse(segments[0]) + reverse(segments[1]) + reverse(segments[2]) + segments[3] + segments[4];
      return Array.from(encoded.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
    };
    const formSet = (guid: string) => [0x0e, 0x97, ...guidBytes(guid), 0, 0, 0, 0, 0];
    const form = (id: number) => [0x01, 0x86, id & 0xff, id >> 8, 0, 0];
    const ref = (targetId: number) => [0x0f, 0x0f, ...new Array<number>(11).fill(0), targetId & 0xff, targetId >> 8];

    push("list", new Array<number>(20).fill(0));
    const packageAStart = parts.length;
    push("packageA", [0, 0, 0, 0x02]);
    push(null, formSet(TAB_VISIBILITY_GUID));
    push("form1", form(1));
    if (!options.alreadyHidden) push("refAdvanced", ref(2));
    push("suppressIf", SUPPRESS_IF_TRUE);
    if (options.alreadyHidden) push("refAdvanced", ref(2));
    push("suppressEnd", END);
    push("form1End", END);
    push("form2", form(2));
    push("form2End", END);
    push(null, END);
    writeUint24(packageAStart, parts.length - packageAStart);
    push(null, [4, 0, 0, 0xdf]);
    const listLength = parts.length;
    parts[16] = listLength & 0xff;
    parts[17] = (listLength >>> 8) & 0xff;
    parts[18] = (listLength >>> 16) & 0xff;
    parts[19] = 0;

    const at = (mark: string) => {
      const offset = marks.get(mark);
      if (offset === undefined) throw new Error(`fixture mark ${mark} missing`);
      return offset;
    };
    const hex = (value: number) => `0x${value.toString(16).toUpperCase()}`;

    const refAdvanced: RefPrompt = {
      name: "Advanced",
      description: "",
      type: "Ref",
      questionId: "0x0001",
      varStoreId: "0x0001",
      formId: "0x2",
      formIdOffset: hex(at("refAdvanced") + 13),
      pageId: null,
      accessLevel: null,
      failsafe: null,
      optimal: null,
      offsets: null,
      sctOffset: hex(at("refAdvanced")),
      conditions: options.alreadyHidden ? [hex(at("suppressIf"))] : undefined,
      suppressIf: options.alreadyHidden ? [hex(at("suppressIf"))] : undefined,
    };

    const data: Data = {
      firmwareFamily: "aptio-v",
      menu: [],
      forms: [
        {
          name: "Setup",
          type: "Form",
          formId: "0x1",
          formSetGuid: TAB_VISIBILITY_GUID,
          referencedIn: [],
          children: [refAdvanced],
          endOffset: hex(at("form1End")),
        },
        {
          name: "Advanced",
          type: "Form",
          formId: "0x2",
          formSetGuid: TAB_VISIBILITY_GUID,
          referencedIn: ["0x1"],
          children: [],
          endOffset: hex(at("form2End")),
        },
      ],
      varStores: [],
      suppressions: [
        {
          offset: hex(at("suppressIf")),
          active: true,
          start: hex(at("suppressIf")),
          end: hex(at("suppressEnd")),
          kind: "SuppressIf",
          constant: true,
          source: "constant",
          expression: "True",
          varStoreNames: [],
          formSetGuid: TAB_VISIBILITY_GUID,
        },
      ],
      version: "test",
      hashes: { setupTxt: "", setupSct: "", amitseSct: "", setupdataBin: "", offsetChecksum: "" },
    };

    return {
      bytes: Uint8Array.from(parts),
      data,
      offsets: { refAdvanced: at("refAdvanced"), form1End: at("form1End"), suppressEnd: at("suppressEnd") },
    };
  }

  it("hides a top-level tab into the hub's own SuppressIf scope, without leaving the Ref's bytes untouched", async () => {
    // The scope lives directly inside the hub (Setup) itself - the same Form
    // the Ref already belongs to - so this is the one case
    // detectRefMoves' plain pristineOwner-vs-current-Form comparison cannot
    // tell apart from no move at all. Without repositionedWithinForm this
    // Ref's bytes would stay exactly where they started even though the
    // declarative model says it's hidden now.
    const { bytes, data, offsets } = buildSameHubTabVisibilityFixture();
    const hub = data.forms[0];

    const [hidden] = hub.children.splice(0, 1) as [RefPrompt];
    hidden.conditions = [data.suppressions[0].offset];
    hidden.suppressIf = [data.suppressions[0].offset];
    hidden.hiddenByTabToggle = data.suppressions[0].offset;
    hidden.repositionedWithinForm = true;
    hub.children.push(hidden);
    const files = moveFixtureFiles(bytes);

    saveAsMock.mockClear();
    downloadModifiedFiles(data, files);

    // The bare 15-byte Ref opcode relocates forward, from right after
    // form1's header to right before the scope's own End - the scope's
    // wrapper itself (SuppressIf...End) never moves.
    const expected = [...bytes];
    const refBytes = expected.splice(offsets.refAdvanced, REF_LENGTH);
    expected.splice(offsets.suppressEnd - REF_LENGTH, 0, ...refBytes);
    expect(Array.from(await savedBytes("Setup.sct"))).toEqual(expected);
    expect(await changelogText()).toContain(
      'Hid top-level tab Advanced inside an existing SuppressIf scope in "Setup"',
    );
  });

  it("shows a same-hub tab back out of the hub's own SuppressIf scope", async () => {
    // Starts from the pristine shape a vendor-hidden (or earlier-session-
    // hidden) same-hub tab has: the Ref's bytes already sit inside the
    // hub's own SuppressIf scope, and hiddenByTabToggle is never set (see
    // buildTabVisibilityFixture's own comment on why a parse alone can
    // never recover it). Show reads the Ref's live conditions/suppressIf
    // instead, exactly as it does for the cross-Form case.
    const { bytes, data, offsets } = buildSameHubTabVisibilityFixture({ alreadyHidden: true });
    const hub = data.forms[0];
    const parkedIndex = hub.children.findIndex(
      (child) => child.type === "Ref" && child.formId === "0x2",
    );
    const [shown] = hub.children.splice(parkedIndex, 1) as [RefPrompt];
    delete shown.conditions;
    delete shown.suppressIf;
    shown.repositionedWithinForm = true;
    hub.children.push(shown);
    const files = moveFixtureFiles(bytes);

    saveAsMock.mockClear();
    downloadModifiedFiles(data, files);

    // The Ref leaves its spot inside the SuppressIf scope - the scope's own
    // wrapper closes up around the gap exactly as an ordinary move would -
    // and lands right before the hub's own End, with no live sibling to
    // anchor next to.
    const expected = [...bytes];
    const refBytes = expected.splice(offsets.refAdvanced, REF_LENGTH);
    expected.splice(offsets.form1End - REF_LENGTH, 0, ...refBytes);
    expect(Array.from(await savedBytes("Setup.sct"))).toEqual(expected);
    expect(await changelogText()).toContain('Showed top-level tab Advanced back on "Setup"');
  });

  it("remaps an unrelated suppression caught in the gap a move shifts, so a same-download unsuppress still finds its End marker", async () => {
    // Main pristinely holds the Ref followed by an unrelated SuppressIf-
    // wrapped Subtitle. Moving the Ref forward into Sub shifts that whole
    // wrapper left by the Ref's length; the deactivation applied in the
    // same download must then find the wrapper's End marker at its shifted
    // position and move it to the shifted start - exposing the Subtitle
    // unconditionally - rather than patching the stale pristine offsets.
    const { bytes, data, offsets } = buildMoveFixture({
      refTarget: "other",
      trailingHiddenSubtitle: true,
    });
    const [moved] = data.forms[0].children.splice(0, 1);
    data.forms[1].children.push(moved);
    data.suppressions[0].active = false;
    const files = moveFixtureFiles(bytes);

    saveAsMock.mockClear();
    downloadModifiedFiles(data, files);

    const expected = [...bytes];
    const refBytes = expected.splice(offsets.ref, REF_LENGTH);
    expected.splice(offsets.form3End - REF_LENGTH, 0, ...refBytes);
    const endMarker = expected.splice(required(offsets.trailingEnd) - REF_LENGTH, 2);
    expected.splice(required(offsets.trailingStart) - REF_LENGTH, 0, ...endMarker);
    expect(Array.from(await savedBytes("Setup.sct"))).toEqual(expected);
    const shiftedSuppressIf = required(offsets.trailingSuppressIf) - REF_LENGTH;
    expect(await changelogText()).toContain(
      `Unsuppressed 0x${shiftedSuppressIf.toString(16).toUpperCase()}`,
    );
  });

  it("leaves an unmoved Ref that shares its hide condition with a sibling alone", () => {
    // Nothing moved: the export must not even look at the block such a Ref
    // would need, since a shared wrapper is only a problem when moving.
    const { bytes, data, offsets } = buildMoveFixture({ hiddenRef: true });
    const ref = data.forms[0].children[0] as RefPrompt;
    data.forms[0].children.push({
      name: "Sibling",
      description: "",
      type: "CheckBox",
      questionId: "0x0009",
      varStoreId: "0x0001",
      varOffset: "0x0000",
      flags: "0x00",
      accessLevel: null,
      failsafe: null,
      optimal: null,
      offsets: null,
      sctOffset: decToHexString(required(offsets.suppressEnd) + 2),
      conditions: ref.conditions,
      suppressIf: ref.suppressIf,
    });

    saveAsMock.mockClear();
    expect(downloadModifiedFiles(data, moveFixtureFiles(bytes))).toEqual({ status: "no-changes" });
  });

  it("refuses a cross-package move between packages of different provenance", () => {
    const { bytes, data } = buildMoveFixture({ explicitTargetGuid: true, bareSecondPackage: true });
    const [moved] = data.forms[0].children.splice(0, 1);
    data.forms[2].children.push(moved);

    saveAsMock.mockClear();
    expect(() => downloadModifiedFiles(data, moveFixtureFiles(bytes))).toThrow(
      /Something went wrong/,
    );
    expect(saveAsMock).not.toHaveBeenCalled();
  });

  it("patches the SuppressIf end marker when a suppression is deactivated", async () => {
    const files = await buildFixtureFiles();
    const data = await parseData(files);

    // suppression.start = 0x0000001A (byte 26 -> hex index 52),
    // suppression.end   = 0x0000001E (byte 30 -> hex index 60).
    const beforeStart = "AA".repeat(26);
    const startToEndGap = "BB".repeat(4);
    const endMarker = "2902";
    // Padded through byte 60 (0x3C) so the fixture's Ref FormId bytes (0x2,
    // little-endian, at formIdOffset 0x3B - see testFixtures.ts) fall
    // within this buffer and read as unchanged, instead of an out-of-range
    // read that would look like a spurious Ref retarget. afterEnd starts at
    // byte 32; bytes 59-60 need to be "02 00", so that's 27 filler bytes
    // then the two FormId bytes.
    const afterEnd = `${"CC".repeat(27)}0200`;
    files.setupSctContainer.textContent =
      beforeStart + startToEndGap + endMarker + afterEnd;

    data.suppressions[0].active = false;

    saveAsMock.mockClear();
    const result = downloadModifiedFiles(data, files);

    expect(result).toEqual({ status: "downloaded" });
    expect(saveAsMock).toHaveBeenCalledTimes(2);

    const [patchedBlob, patchedName] = saveAsMock.mock.calls[0] as [
      Blob,
      string,
    ];
    expect(patchedName).toBe(files.setupSctContainer.file.name);
    const patchedBytes = new Uint8Array(await patchedBlob.arrayBuffer());
    const patchedHex = Array.from(patchedBytes, (byte) =>
      byte.toString(16).toUpperCase().padStart(2, "0"),
    ).join("");
    // The end marker moves to where the suppression starts, and the old
    // end position collapses - the SuppressIf's guarded bytes become
    // unconditionally reachable instead of being skipped.
    expect(patchedHex).toBe(beforeStart + endMarker + startToEndGap + afterEnd);

    const [changelogBlob, changelogName] = saveAsMock.mock.calls[1] as [
      Blob,
      string,
    ];
    expect(changelogName).toBe("changelog.txt");
    const changelogText = await changelogBlob.text();
    expect(changelogText).toContain("Unsuppressed 0x00000016");
  });

  it("throws when the expected end marker bytes are missing (corrupted state)", async () => {
    const files = await buildFixtureFiles();
    const data = await parseData(files);

    // No "2902" bytes anywhere near the suppression's recorded end offset.
    // Padded through byte 60 with the fixture's correct, unchanged Ref
    // FormId bytes at 59-60 (see testFixtures.ts) so the Ref check finds
    // nothing to retarget, leaving the missing end-marker as the only
    // reason this should throw.
    files.setupSctContainer.textContent = `${"00".repeat(59)}0200`;
    data.suppressions[0].active = false;

    expect(() => downloadModifiedFiles(data, files)).toThrow(
      /Something went wrong/,
    );
  });

  it("patches a Ref's FormId bytes when it's retargeted", async () => {
    const files = await buildFixtureFiles();
    const data = await parseData(files);

    const ref = data.forms[0].children.find((child) => child.type === "Ref");
    if (!ref) throw new Error("expected a Ref child");
    expect(ref.formId).toBe("0x2");
    expect(ref.formIdOffset).toBe("0x3B");

    ref.formId = "0x1"; // the user retargeted this Ref to Form 0x1 instead

    saveAsMock.mockClear();
    const result = downloadModifiedFiles(data, files);

    expect(result).toEqual({ status: "downloaded" });
    const [patchedBlob, patchedName] = saveAsMock.mock.calls[0] as [
      Blob,
      string,
    ];
    expect(patchedName).toBe(files.setupSctContainer.file.name);
    const patchedBytes = new Uint8Array(await patchedBlob.arrayBuffer());
    // formIdOffset 0x3B = byte 59, little-endian 0x0001.
    expect([...patchedBytes.slice(0x3b, 0x3d)]).toEqual([0x01, 0x00]);

    const changelogText = await (
      saveAsMock.mock.calls[1] as [Blob, string]
    )[0].text();
    expect(changelogText).toContain(
      'Go to Advanced in "Main Page" | FormId 0x2 (Advanced Page) -> 0x1 (Main Page)',
    );
  });

  it("carries a retargeted Ref's new FormId through a suppression shift it falls inside", async () => {
    // The Ref's formIdOffset (byte 20) sits inside a SuppressIf's guarded
    // range (start=10, end=30) that gets deactivated in the same download.
    // Ref-patching must run before the shift so the new FormId - not the
    // old one - is what the shift's copyWithin carries to its new position.
    const beforeStart = "AA".repeat(10); // bytes 0-9
    const startToFormId = "BB".repeat(10); // bytes 10-19
    const oldFormIdBytes = "0100"; // bytes 20-21: old FormId 0x1, little-endian
    const formIdToEnd = "CC".repeat(8); // bytes 22-29
    const endMarker = "2902"; // bytes 30-31: the SuppressIf's own End opcode
    const afterEnd = "DD".repeat(8); // bytes 32-39

    const files = await buildFixtureFiles();
    files.setupSctContainer.textContent =
      beforeStart +
      startToFormId +
      oldFormIdBytes +
      formIdToEnd +
      endMarker +
      afterEnd;

    const data: Data = {
      firmwareFamily: "aptio-v",
      menu: [],
      forms: [
        {
          name: "Main Page",
          type: "Form",
          formId: "0x1",
          referencedIn: [],
          endOffset: "0x28",
          children: [
            {
              name: "Go to Advanced",
              description: "",
              type: "Ref",
              questionId: "0x0004",
              varStoreId: "0x0001",
              formId: "0x2", // retargeted from 0x1 to 0x2
              formIdOffset: "0x14", // byte 20
              pageId: null,
              accessLevel: null,
              failsafe: null,
              optimal: null,
              offsets: null,
              sctOffset: "0x7",
            },
          ],
        },
        {
          name: "Advanced Page",
          type: "Form",
          formId: "0x2",
          referencedIn: [],
          endOffset: "0x28",
          children: [],
        },
      ],
      varStores: [],
      version: "test",
      hashes: {
        setupTxt: "",
        setupSct: "",
        amitseSct: "",
        setupdataBin: "",
        offsetChecksum: "",
      },
      suppressions: [
        {
          offset: "0x0",
          start: "0xA", // byte 10
          end: "0x1E", // byte 30
          kind: "SuppressIf",
          active: false,
        },
      ],
    };

    saveAsMock.mockClear();
    const result = downloadModifiedFiles(data, files);

    expect(result).toEqual({ status: "downloaded" });
    const patchedBlob = (saveAsMock.mock.calls[0] as [Blob, string])[0];
    const patchedBytes = new Uint8Array(await patchedBlob.arrayBuffer());
    const patchedHex = Array.from(patchedBytes, (byte) =>
      byte.toString(16).toUpperCase().padStart(2, "0"),
    ).join("");

    // The End opcode moves to where the suppression starts (byte 10). The
    // Ref's new FormId (0x0002, already written in place at byte 20/21
    // before the shift ran) is carried along by that shift like any other
    // guarded byte, landing at byte 22/23 instead of being lost or left
    // holding the pre-shift value.
    expect(patchedHex).toBe(
      beforeStart + endMarker + startToFormId + "0200" + formIdToEnd + afterEnd,
    );

    const changelogText = await (
      saveAsMock.mock.calls[1] as [Blob, string]
    )[0].text();
    expect(changelogText).toContain(
      'Go to Advanced in "Main Page" | FormId 0x1 (Main Page) -> 0x2 (Advanced Page)',
    );
    expect(changelogText).toContain("Unsuppressed 0x0");
  });

  it("patches the AMITSE menu table's little-endian FormId bytes", async () => {
    const files = await buildFixtureFiles();
    const data = await parseData(files);

    // Byte-swapped (little-endian) 0x0001, i.e. the executable table
    // currently points at form 0x1 ("Main Page").
    files.amitseSctContainer.textContent = "0100";
    data.menu = [
      {
        name: "Main Page",
        formId: "0x2", // the user retargeted this root to form 0x2
        offset: "0x0",
        formSetGuid: "12345678-1234-1234-1234-123456789ABC",
        source: "amitse",
      },
    ];

    saveAsMock.mockClear();
    const result = downloadModifiedFiles(data, files);

    expect(result).toEqual({ status: "downloaded" });
    const [patchedBlob, patchedName] = saveAsMock.mock.calls[0] as [
      Blob,
      string,
    ];
    expect(patchedName).toBe(files.amitseSctContainer.file.name);
    const patchedBytes = new Uint8Array(await patchedBlob.arrayBuffer());
    // Little-endian 0x0002.
    expect([...patchedBytes]).toEqual([0x02, 0x00]);

    const changelogText = await (
      saveAsMock.mock.calls[1] as [Blob, string]
    )[0].text();
    expect(changelogText).toContain(
      "Main Page | FormId 0x1 -> Advanced Page | FormId 0x2",
    );
  });

  it("patches SetupData access-level/failsafe/optimal bytes", async () => {
    const files = await buildFixtureFiles();
    const data = await parseData(files);

    files.setupdataBinContainer.textContent = "000000";
    const checkBox = data.forms[0].children.find(
      (child) => child.type === "CheckBox",
    );
    if (!checkBox) throw new Error("expected a CheckBox child");
    checkBox.offsets = {
      accessLevel: "0x0",
      failsafe: "0x1",
      optimal: "0x2",
    };
    checkBox.accessLevel = "05";
    checkBox.failsafe = "0A";
    checkBox.optimal = "0F";

    saveAsMock.mockClear();
    const result = downloadModifiedFiles(data, files);

    expect(result).toEqual({ status: "downloaded" });
    const [patchedBlob, patchedName] = saveAsMock.mock.calls[0] as [
      Blob,
      string,
    ];
    expect(patchedName).toBe(files.setupdataBinContainer.file.name);
    const patchedBytes = new Uint8Array(await patchedBlob.arrayBuffer());
    expect([...patchedBytes]).toEqual([0x05, 0x0a, 0x0f]);

    const changelogText = await (
      saveAsMock.mock.calls[1] as [Blob, string]
    )[0].text();
    expect(changelogText).toContain("Access Level 00 -> 05");
    expect(changelogText).toContain("Failsafe 00 -> 0A");
    expect(changelogText).toContain("Optimal 00 -> 0F");
  });

  it("shifts a nested suppression's offsets by exactly one End opcode's width", async () => {
    // A SuppressIf ("outer", bytes 10..26) that itself guards a second,
    // fully nested SuppressIf ("child", bytes 14..20). Both are toggled
    // inactive, and the suppressions array is deliberately given in
    // parent-before-child order - the opposite of what parseData() would
    // ever produce (it always closes the inner scope first) - so that
    // outer's bookkeeping for "other suppressions nested inside me" is
    // actually exercised instead of being dead code.
    const beforeOuterStart = "AA".repeat(10); // 0..9
    const outerStartToChildStart = "BB".repeat(4); // 10..13
    const childGuarded = "CC".repeat(6); // 14..19
    const childEndMarker = "2902"; // 20..21
    const childEndToOuterEnd = "DD".repeat(4); // 22..25
    const outerEndMarker = "2902"; // 26..27
    const afterOuterEnd = "EE".repeat(6); // 28..33

    const files = await buildFixtureFiles();
    files.setupSctContainer.textContent =
      beforeOuterStart +
      outerStartToChildStart +
      childGuarded +
      childEndMarker +
      childEndToOuterEnd +
      outerEndMarker +
      afterOuterEnd;

    const data: Data = {
      firmwareFamily: "aptio-v",
      menu: [],
      forms: [],
      varStores: [],
      version: "test",
      hashes: {
        setupTxt: "",
        setupSct: "",
        amitseSct: "",
        setupdataBin: "",
        offsetChecksum: "",
      },
      suppressions: [
        {
          offset: "0x0",
          start: "0xA",
          end: "0x1A",
          kind: "SuppressIf",
          active: false,
        },
        {
          offset: "0x1",
          start: "0xE",
          end: "0x14",
          kind: "SuppressIf",
          active: false,
        },
      ],
    };

    saveAsMock.mockClear();
    const result = downloadModifiedFiles(data, files);

    expect(result).toEqual({ status: "downloaded" });
    const patchedBlob = (saveAsMock.mock.calls[0] as [Blob, string])[0];
    const patchedBytes = new Uint8Array(await patchedBlob.arrayBuffer());
    const patchedHex = Array.from(patchedBytes, (byte) =>
      byte.toString(16).toUpperCase().padStart(2, "0"),
    ).join("");

    // Both End opcodes move to where their own suppression starts; the
    // child's marker now sits right after outer's, exposing both
    // previously-guarded regions.
    expect(patchedHex).toBe(
      beforeOuterStart +
        "2902" +
        outerStartToChildStart +
        "2902" +
        childGuarded +
        childEndToOuterEnd +
        afterOuterEnd,
    );
  });
});
