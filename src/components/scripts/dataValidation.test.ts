import { describe, expect, it } from "vitest";
import { DATA_SCHEMA_VERSION, parseDataFile } from "./dataValidation";
import { parseData } from "./ifrParser";
import { buildFixtureFiles } from "./testFixtures";

type JsonObject = Record<string, unknown>;

async function fixtureData() {
  return parseData(await buildFixtureFiles());
}

// A data.json as an untyped object tree, so a test can corrupt any field
// the way a hand edit would. Includes schemaVersion, since a real export
// always goes through Footer.tsx's wrapping - a raw parseData() result
// never carries it on its own (see the schemaVersion-specific tests below,
// which exercise that boundary directly).
async function fixtureJson(): Promise<JsonObject> {
  return {
    ...(JSON.parse(JSON.stringify(await fixtureData())) as JsonObject),
    schemaVersion: DATA_SCHEMA_VERSION,
  };
}

function firstChild(json: JsonObject): JsonObject {
  const forms = json.forms as JsonObject[];
  return (forms[0].children as JsonObject[])[0];
}

const pendingEdit = {
  kind: "set-root-visibility",
  rootIndex: 0,
  formId: "0x1",
  bufferId: 3,
  bufferOffset: 0x40,
  expected: 0,
  replacement: 1,
  description: "Show root FormSet Main Setup",
};

describe("parseDataFile", () => {
  it("round-trips a data.json the app itself exported, minus the rebuilt evidence", async () => {
    const data = await fixtureData();

    expect(
      parseDataFile(JSON.stringify({ ...data, schemaVersion: DATA_SCHEMA_VERSION })),
    ).toEqual({
      ...data,
      singleFormSetNavigation: undefined,
    });
  });

  it("rejects a data.json with no schemaVersion at all, as an export from before this guard existed would have", async () => {
    const data = await fixtureData();

    expect(() => parseDataFile(JSON.stringify(data))).toThrow(
      "data.json was exported by an older version of this editor and can no longer be imported safely - redo the edit against a freshly opened firmware.",
    );
  });

  it("rejects a data.json from a different schema version", async () => {
    const data = await fixtureData();

    expect(() =>
      parseDataFile(JSON.stringify({ ...data, schemaVersion: DATA_SCHEMA_VERSION + 1 })),
    ).toThrow(
      `data.json was exported by a different version of this editor (schema ${String(DATA_SCHEMA_VERSION + 1)}, this build expects ${String(DATA_SCHEMA_VERSION)}).`,
    );
  });

  it("accepts an IFR hub menu root but never the imported tab inventory", async () => {
    const json = await fixtureJson();
    json.menu = [
      { name: "Setup", formId: "0x1", offset: null, formSetGuid: "A", source: "ifr-hub" },
    ];
    json.singleFormSetNavigation = { status: "detected", pages: [] };

    const parsed = parseDataFile(JSON.stringify(json));

    expect(parsed.menu[0].source).toBe("ifr-hub");
    expect(parsed.singleFormSetNavigation).toBeUndefined();
  });

  it("keeps pending root visibility plans but never the detected report", async () => {
    const json = await fixtureJson();
    json.rootVisibility = { status: "detected", entries: [] };
    json.rootVisibilityEdits = [pendingEdit];

    const parsed = parseDataFile(JSON.stringify(json));

    expect(parsed.rootVisibilityEdits).toEqual([pendingEdit]);
    expect(parsed.rootVisibility).toBeUndefined();
  });

  it("rejects text that is not JSON", () => {
    expect(() => parseDataFile("{not json")).toThrow("data.json is not valid JSON.");
  });

  it("rejects a non-object document", () => {
    expect(() => parseDataFile("[]")).toThrow("data.json does not contain an object.");
  });

  it("rejects an unknown firmwareFamily", async () => {
    const json = await fixtureJson();
    json.firmwareFamily = "aptio-vi";

    expect(() => parseDataFile(JSON.stringify(json))).toThrow(
      "data.json has an invalid firmwareFamily.",
    );
  });

  it("rejects a form child missing the fields the patcher relies on", async () => {
    const json = await fixtureJson();
    delete firstChild(json).sctOffset;

    expect(() => parseDataFile(JSON.stringify(json))).toThrow(
      "data.json has invalid forms.",
    );
  });

  it("rejects a suppression with an unknown condition kind", async () => {
    const json = await fixtureJson();
    (json.suppressions as JsonObject[])[0].kind = "HideIf";

    expect(() => parseDataFile(JSON.stringify(json))).toThrow(
      "data.json has invalid suppressions.",
    );
  });

  it("rejects incomplete hashes", async () => {
    const json = await fixtureJson();
    delete (json.hashes as JsonObject).offsetChecksum;

    expect(() => parseDataFile(JSON.stringify(json))).toThrow(
      "data.json has invalid hashes.",
    );
  });

  it("rejects root visibility plans that change nothing or repeat a root", async () => {
    const json = await fixtureJson();

    json.rootVisibilityEdits = [{ ...pendingEdit, replacement: 0 }];
    expect(() => parseDataFile(JSON.stringify(json))).toThrow(
      "data.json has invalid rootVisibilityEdits.",
    );

    json.rootVisibilityEdits = [pendingEdit, pendingEdit];
    expect(() => parseDataFile(JSON.stringify(json))).toThrow(
      "data.json has invalid rootVisibilityEdits.",
    );
  });
});
