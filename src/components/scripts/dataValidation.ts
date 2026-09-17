import type {
  AmiRootVisibilityEdit,
  CheckBoxPrompt,
  Data,
  Default,
  Form,
  FormChild,
  FormChildren,
  Menu,
  NumericPrompt,
  Offsets,
  OneOfPrompt,
  RefPrompt,
  StringPrompt,
  Suppression,
  VarStores,
} from "./types";

// A data.json is user-supplied input: everything the editor later indexes
// into (offsets, children, suppressions) is checked here so a truncated or
// hand-edited file fails with a clear message instead of a crash deep in a
// patch. Only the fields this app knows are kept.

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || isStringArray(value);
}

function isOffsets(value: unknown): value is Offsets {
  return (
    isRecord(value) &&
    isString(value.accessLevel) &&
    isString(value.failsafe) &&
    isString(value.optimal) &&
    isOptionalString(value.pageId)
  );
}

function isMenu(value: unknown): value is Menu {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        isString(entry.name) &&
        isString(entry.formId) &&
        isNullableString(entry.offset) &&
        isOptionalString(entry.formSetGuid) &&
        (entry.source === undefined ||
          entry.source === "amitse" ||
          entry.source === "setupdata" ||
          entry.source === "formset" ||
          entry.source === "ifr-hub") &&
        isOptionalString(entry.pageMask) &&
        isOptionalString(entry.pageInfoOffset),
    )
  );
}

function isDefault(value: unknown): value is Default {
  return isRecord(value) && isString(value.defaultId) && isString(value.value);
}

function isDefaults(value: unknown): value is Default[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every(isDefault));
}

function isFormChildBase(value: UnknownRecord): value is UnknownRecord & FormChild {
  return (
    isString(value.name) &&
    isString(value.description) &&
    isString(value.questionId) &&
    isString(value.varStoreId) &&
    isOptionalString(value.varStoreName) &&
    isNullableString(value.accessLevel) &&
    isNullableString(value.failsafe) &&
    isNullableString(value.optimal) &&
    (value.offsets === null || isOffsets(value.offsets)) &&
    isOptionalStringArray(value.suppressIf) &&
    isOptionalStringArray(value.conditions) &&
    isString(value.sctOffset)
  );
}

function isRefPrompt(value: UnknownRecord): value is UnknownRecord & RefPrompt {
  return (
    value.type === "Ref" &&
    isFormChildBase(value) &&
    isString(value.formId) &&
    isString(value.formIdOffset) &&
    isOptionalString(value.targetFormSetGuid) &&
    isNullableString(value.pageId)
  );
}

function isNumericPrompt(value: UnknownRecord): value is UnknownRecord & NumericPrompt {
  return (
    value.type === "Numeric" &&
    isFormChildBase(value) &&
    isString(value.varOffset) &&
    isString(value.size) &&
    isString(value.min) &&
    isString(value.max) &&
    isString(value.step) &&
    isDefaults(value.defaults)
  );
}

function isCheckBoxPrompt(
  value: UnknownRecord,
): value is UnknownRecord & CheckBoxPrompt {
  return (
    value.type === "CheckBox" &&
    isFormChildBase(value) &&
    isString(value.varOffset) &&
    isString(value.flags) &&
    isDefaults(value.defaults)
  );
}

function isOneOfPrompt(value: UnknownRecord): value is UnknownRecord & OneOfPrompt {
  return (
    value.type === "OneOf" &&
    isFormChildBase(value) &&
    isString(value.varOffset) &&
    isString(value.size) &&
    Array.isArray(value.options) &&
    value.options.every(
      (option) => isRecord(option) && isString(option.option) && isString(option.value),
    ) &&
    isDefaults(value.defaults)
  );
}

function isStringPrompt(value: UnknownRecord): value is UnknownRecord & StringPrompt {
  return value.type === "String" && isFormChildBase(value);
}

function isFormChild(value: unknown): value is FormChildren {
  return (
    isRecord(value) &&
    (isRefPrompt(value) ||
      isNumericPrompt(value) ||
      isCheckBoxPrompt(value) ||
      isOneOfPrompt(value) ||
      isStringPrompt(value))
  );
}

function isForm(value: unknown): value is Form {
  return (
    isRecord(value) &&
    value.type === "Form" &&
    isString(value.name) &&
    isString(value.formId) &&
    isOptionalString(value.formSetGuid) &&
    isOptionalString(value.formSetTitle) &&
    isStringArray(value.referencedIn) &&
    Array.isArray(value.children) &&
    value.children.every(isFormChild) &&
    isString(value.endOffset)
  );
}

function isVarStores(value: unknown): value is VarStores {
  return (
    Array.isArray(value) &&
    value.every(
      (varStore) =>
        isRecord(varStore) &&
        isString(varStore.varStoreId) &&
        isString(varStore.size) &&
        isString(varStore.name) &&
        isOptionalString(varStore.formSetGuid),
    )
  );
}

const conditionKinds = new Set(["SuppressIf", "GrayOutIf", "DisableIf"]);
const conditionSources = new Set([
  "setup",
  "hardware",
  "access",
  "ui",
  "runtime",
  "constant",
  "unknown",
]);

function isSuppression(value: unknown): value is Suppression {
  return (
    isRecord(value) &&
    isString(value.offset) &&
    isBoolean(value.active) &&
    isString(value.start) &&
    isString(value.end) &&
    (value.kind === undefined ||
      (isString(value.kind) && conditionKinds.has(value.kind))) &&
    isOptionalString(value.expression) &&
    isOptionalStringArray(value.questionIds) &&
    isOptionalStringArray(value.varStoreIds) &&
    isOptionalStringArray(value.varStoreNames) &&
    (value.source === undefined ||
      (isString(value.source) && conditionSources.has(value.source))) &&
    (value.constant === undefined ||
      value.constant === null ||
      isBoolean(value.constant)) &&
    isOptionalString(value.formSetGuid)
  );
}

function isHashes(value: unknown): value is Data["hashes"] {
  return (
    isRecord(value) &&
    isString(value.setupTxt) &&
    isString(value.setupSct) &&
    isString(value.amitseSct) &&
    isString(value.setupdataBin) &&
    isString(value.offsetChecksum)
  );
}

function isRootVisibilityValue(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}

function isRootVisibilityEdit(value: unknown): value is AmiRootVisibilityEdit {
  return (
    isRecord(value) &&
    value.kind === "set-root-visibility" &&
    isNonNegativeInteger(value.rootIndex) &&
    isString(value.formId) &&
    isOptionalString(value.formSetGuid) &&
    isNonNegativeInteger(value.bufferId) &&
    isNonNegativeInteger(value.bufferOffset) &&
    isRootVisibilityValue(value.expected) &&
    isRootVisibilityValue(value.replacement) &&
    value.expected !== value.replacement &&
    isString(value.description)
  );
}

function isRootVisibilityEdits(
  value: unknown,
): value is AmiRootVisibilityEdit[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value) || !value.every(isRootVisibilityEdit)) return false;
  const roots = value.map((edit) => edit.rootIndex);
  return new Set(roots).size === roots.length;
}

function invalidData(message: string): never {
  throw new Error(`data.json ${message}.`);
}

// Parses and structurally validates a data.json. The root visibility
// report is deliberately not read back: it is evidence about the firmware
// that is open right now, and is re-attached from there by the caller.
export function parseDataFile(text: string): Data {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("data.json is not valid JSON.");
  }

  if (!isRecord(value)) invalidData("does not contain an object");
  if (
    value.firmwareFamily !== "aptio-v" &&
    value.firmwareFamily !== "aptio-iv" &&
    value.firmwareFamily !== "ami-aptio"
  ) {
    invalidData("has an invalid firmwareFamily");
  }
  if (!isString(value.version)) invalidData("is missing version");
  if (!isMenu(value.menu)) invalidData("has an invalid menu");
  if (value.formSetRoots !== undefined && !isMenu(value.formSetRoots)) {
    invalidData("has invalid formSetRoots");
  }
  if (!Array.isArray(value.forms) || !value.forms.every(isForm)) {
    invalidData("has invalid forms");
  }
  if (!isVarStores(value.varStores)) invalidData("has invalid varStores");
  if (!Array.isArray(value.suppressions) || !value.suppressions.every(isSuppression)) {
    invalidData("has invalid suppressions");
  }
  if (!isHashes(value.hashes)) invalidData("has invalid hashes");
  if (!isRootVisibilityEdits(value.rootVisibilityEdits)) {
    invalidData("has invalid rootVisibilityEdits");
  }

  return {
    firmwareFamily: value.firmwareFamily,
    menu: value.menu,
    formSetRoots: value.formSetRoots,
    forms: value.forms,
    varStores: value.varStores,
    suppressions: value.suppressions,
    rootVisibilityEdits: value.rootVisibilityEdits,
    version: value.version,
    hashes: value.hashes,
  };
}
