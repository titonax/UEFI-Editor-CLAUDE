import type { PopulatedFiles } from "../FileUploads/fileModel";
import { inspectAmiRootVisibility } from "./amiRootVisibility";
import {
  expressionMetadata,
  humanizeExpression,
  readableExpressionLine,
} from "./expressionFormatter";
import { calculateJsonChecksum, hashFile } from "./hashing";
import { parseHexId, sameGuidOrBothUndefined, sameHexId } from "./hexId";
import { decToHexString } from "./binaryPatcher";
import { getAdditionalData, indexSetupData, type SetupDataIndex } from "./setupData";
import {
  inspectSingleFormSetNavigation,
  singleFormSetHubMenu,
} from "./singleFormSetNavigation";
import type {
  CheckBoxPrompt,
  ConditionKind,
  Data,
  Form,
  FormChildren,
  Forms,
  Menu,
  NumericPrompt,
  OneOfPrompt,
  RefPrompt,
  Scopes,
  StringPrompt,
  Suppression,
  VarStores,
} from "./types";

export const version = "0.5.0";
const wantedIFRExtractorVersions = ["1.6.1"];

function hasScope(hexString: string) {
  const header = hexString.split(" ")[1];

  return parseInt(header, 16).toString(2).padStart(8, "0").startsWith("1");
}

function formReferenceKey(formId: string, formSetGuid?: string) {
  return `${formSetGuid ?? ""}:${String(parseHexId(formId))}`;
}

function reversedHexBytes(value: string) {
  return value.match(/../g)?.reverse().join("") ?? "";
}

function guidToUefiHex(value: string) {
  const parts = value.split("-");
  if (parts.length !== 5) {
    return "";
  }
  return (
    reversedHexBytes(parts[0]) +
    reversedHexBytes(parts[1]) +
    reversedHexBytes(parts[2]) +
    parts[3] +
    parts[4]
  ).toUpperCase();
}

function littleEndianUint32(value: string) {
  const normalized = reversedHexBytes(value);
  return normalized.length === 8 ? parseInt(normalized, 16) : Number.NaN;
}

function discoverSetupDataMenu(formSetRoots: Menu, setupData: string): Menu {
  const normalizedSetupData = setupData.toUpperCase();
  const candidates: {
    entry: Menu[number];
    start: number;
    pageValue: number;
  }[] = [];

  for (const entry of formSetRoots) {
    if (!entry.formSetGuid) {
      continue;
    }
    const encodedGuid = guidToUefiHex(entry.formSetGuid);
    let guidIndex = normalizedSetupData.indexOf(encodedGuid);
    while (guidIndex !== -1) {
      if (guidIndex >= 8) {
        const start = guidIndex - 8;
        const pageValue = littleEndianUint32(
          normalizedSetupData.slice(start, guidIndex),
        );
        if (Number.isSafeInteger(pageValue)) {
          candidates.push({ entry, start, pageValue });
        }
      }
      guidIndex = normalizedSetupData.indexOf(encodedGuid, guidIndex + 2);
    }
  }

  candidates.sort((left, right) => left.start - right.start);
  const runs: (typeof candidates)[] = [];
  for (const candidate of candidates) {
    if (runs.length === 0) {
      runs.push([candidate]);
      continue;
    }
    const current = runs[runs.length - 1];
    const previous = current[current.length - 1];
    if (candidate.start === previous.start + 40) {
      current.push(candidate);
    } else {
      runs.push([candidate]);
    }
  }

  if (runs.length === 0) {
    return [];
  }
  const pageList = runs.sort((left, right) => right.length - left.length)[0];
  if (pageList.length < 3) {
    return [];
  }

  return pageList.map(({ entry, start, pageValue }) => ({
    ...entry,
    offset: null,
    source: "setupdata",
    pageMask: decToHexString(pageValue),
    pageInfoOffset: decToHexString(start / 2),
  }));
}

function findVarStoreName(
  varStores: VarStores,
  varStoreId: string,
  formSetGuid?: string,
) {
  return (
    varStores.find(
      (varStore) =>
        varStore.formSetGuid === formSetGuid &&
        sameHexId(varStore.varStoreId, varStoreId),
    ) ?? varStores.find((varStore) => sameHexId(varStore.varStoreId, varStoreId))
  )?.name;
}

const conditionKinds = new Set<ConditionKind>([
  "SuppressIf",
  "GrayOutIf",
  "DisableIf",
]);

function isConditionKind(value: Scopes[number]["type"]): value is ConditionKind {
  return conditionKinds.has(value as ConditionKind);
}

function checkConditions(scopes: Scopes, formChild: FormChildren) {
  const conditions = scopes
    .filter((scope) => isConditionKind(scope.type))
    .map((scope) => scope.offset) as string[];

  if (conditions.length !== 0) {
    formChild.conditions = [...conditions];
    const suppressions = scopes
      .filter((scope) => scope.type === "SuppressIf")
      .map((scope) => scope.offset) as string[];
    if (suppressions.length !== 0) {
      formChild.suppressIf = suppressions;
    }
  }
}

function determineCondition(
  setupTxtArray: string[],
  index: number,
): {
  start: string;
  expression: string;
  questionIds: string[];
  varStoreIds: string[];
  constant: boolean | null;
} {
  const firstExpressionOpcode = /\{ (.*) \}/.exec(setupTxtArray[index + 1]);
  if (!firstExpressionOpcode) {
    throw new Error(
      "Something went wrong. Please file a bug report on Github.",
    );
  }

  if (!hasScope(firstExpressionOpcode[1])) {
    const expression = readableExpressionLine(setupTxtArray[index + 1]);
    const metadata = expressionMetadata(expression);
    return {
      start: setupTxtArray[index + 2].split(" ")[0].slice(0, -1),
      expression,
      ...metadata,
      constant: /^(True)(?:\s|$)/i.test(expression)
        ? true
        : /^(False)(?:\s|$)/i.test(expression)
          ? false
          : null,
    };
  }

  let openScopes = 1;
  let currentIndex = index + 2;
  while (openScopes !== 0) {
    const line = setupTxtArray[currentIndex];

    const anyOpcode = /\{ (.*) \}/.exec(line);
    const end = /\{ 29 02 \}/.exec(line);

    if (anyOpcode && hasScope(anyOpcode[1])) {
      openScopes++;
    }

    if (end) {
      openScopes--;
    }

    currentIndex++;
  }

  const expression = setupTxtArray
    .slice(index + 1, currentIndex)
    .map(readableExpressionLine)
    .filter((line) => line.length > 0 && !/^End(?:\s|$)/i.test(line))
    .join(" → ");
  const metadata = expressionMetadata(expression);
  return {
    start: setupTxtArray[currentIndex].split(" ")[0].slice(0, -1),
    expression,
    ...metadata,
    constant: /^(True)(?:\s|$)/i.test(expression)
      ? true
      : /^(False)(?:\s|$)/i.test(expression)
        ? false
        : null,
  };
}

function enrichConditions(
  forms: Forms,
  varStores: VarStores,
  conditions: Suppression[],
) {
  const prompts = new Map<string, FormChildren>();
  for (const form of forms) {
    for (const child of form.children) {
      prompts.set(
        `${form.formSetGuid ?? ""}:${String(parseHexId(child.questionId))}`,
        child,
      );
    }
  }

  for (const condition of conditions) {
    const referenced = (condition.questionIds ?? [])
      .map((questionId) =>
        prompts.get(
          `${condition.formSetGuid ?? ""}:${String(parseHexId(questionId))}`,
        ),
      )
      .filter((child): child is FormChildren => child !== undefined);
    const directVarStores = (condition.varStoreIds ?? []).flatMap(
      (varStoreId) => {
        const varStore = varStores.find(
          (candidate) =>
            candidate.formSetGuid === condition.formSetGuid &&
            sameHexId(candidate.varStoreId, varStoreId),
        );
        return varStore !== undefined ? [{ varStoreId, varStore }] : [];
      },
    );
    const varStoreNames = [
      ...new Set([
        ...referenced
          .map((child) => child.varStoreName)
          .filter((name): name is string => Boolean(name)),
        ...directVarStores.map(({ varStore }) => varStore.name),
      ]),
    ];
    condition.varStoreNames = varStoreNames;

    const normalizedNames = varStoreNames.map((name) =>
      name.trim().toLowerCase(),
    );
    if (condition.constant !== null && condition.constant !== undefined) {
      condition.source = "constant";
    } else if (normalizedNames.length === 0) {
      condition.source = "unknown";
    } else if (
      normalizedNames.some((name) =>
        ["systemaccess", "secvolatiledata"].includes(name),
      )
    ) {
      condition.source = "access";
    } else if (
      normalizedNames.some((name) =>
        /^(setupcpufeatures|setupsnbppmfeatures|setupdptffeatures|setupplatformdata|sbplatformdata|nbplatformdata|tdtadvancedsetupdatavar|iccadvancedsetupdatavar|usbmassdevvalid)$/.test(
          name,
        ),
      )
    ) {
      condition.source = "hardware";
    } else if (
      normalizedNames.some((name) =>
        /^(amitsesetup|amicallback|dynamicpagecount|driverhlthenable|driverhealthcount|drvhealthctrlcnt)$/.test(
          name,
        ),
      )
    ) {
      condition.source = "ui";
    } else if (normalizedNames.every((name) => name === "setup")) {
      condition.source = "setup";
    } else {
      condition.source = "runtime";
    }

    for (const child of referenced) {
      const questionIdPattern = new RegExp(
        `\\b${child.questionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
        "gi",
      );
      const offset = "varOffset" in child ? child.varOffset : undefined;
      const questionName = child.name.trim();
      const literal = questionName
        ? `“${questionName}” (${child.questionId})`
        : child.varStoreName
          ? `${child.varStoreName}${offset ? `[${offset}]` : ""} (${child.questionId})`
          : `Unnamed question (${child.questionId})`;
      condition.expression = (condition.expression ?? "").replace(
        questionIdPattern,
        literal,
      );
    }
    for (const { varStoreId, varStore } of directVarStores) {
      const varStoreIdPattern = new RegExp(
        `\\bVarStoreId:\\s*${varStoreId.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        )}\\b`,
        "gi",
      );
      condition.expression = (condition.expression ?? "").replace(
        varStoreIdPattern,
        `VarStore: “${varStore.name}” (${varStore.varStoreId})`,
      );
    }
    condition.expression = humanizeExpression(condition.expression ?? "");
  }
}

// The line-by-line loop below tracks "the opcode currently being built" for
// each prompt kind in a `current*` variable, reassigned whenever its own
// opcode line is matched and read only while a corresponding scope sits on
// `scopes` - which is only pushed right after the matching assignment. That
// makes them non-null by construction at every read, but TypeScript can't
// see across the scope stack to prove it; this turns a violation into a
// clear error instead of a confusing "reading property of null" crash.
function requireCurrent<T>(value: T | null): T {
  if (value === null) {
    throw new Error(
      "Something went wrong. Please file a bug report on Github.",
    );
  }
  return value;
}

// Bundles everything the line-by-line loop below accumulates as it scans
// the IFR dump, so each opcode type's handling can live in its own
// function instead of one ~430-line loop body.
interface ParserState {
  formSetIds: Set<string>;
  formSetMetadata: Map<string, { guid: string; title: string }>;
  formSetRoots: Menu;
  pendingFormSetTitle: string | null;
  currentFormSetGuid: string | undefined;
  currentFormSetTitle: string | undefined;
  varStores: VarStores;
  forms: Forms;
  suppressions: Suppression[];
  scopes: Scopes;
  currentForm: Form | null;
  currentString: StringPrompt | null;
  currentOneOf: OneOfPrompt | null;
  currentNumeric: NumericPrompt | null;
  currentCheckBox: CheckBoxPrompt | null;
  currentSuppressions: Suppression[];
  references: Record<string, Set<string>>;
}

function createParserState(): ParserState {
  return {
    formSetIds: new Set(),
    formSetMetadata: new Map(),
    formSetRoots: [],
    pendingFormSetTitle: null,
    currentFormSetGuid: undefined,
    currentFormSetTitle: undefined,
    varStores: [],
    forms: [],
    suppressions: [],
    scopes: [],
    currentForm: null,
    currentString: null,
    currentOneOf: null,
    currentNumeric: null,
    currentCheckBox: null,
    currentSuppressions: [],
    references: {},
  };
}

function handleFormSetLine(state: ParserState, formSet: RegExpExecArray) {
  const formSetId = formSet[4] + formSet[5];
  state.currentFormSetGuid = [
    formSet[1],
    formSet[2],
    formSet[3],
    formSet[4],
    formSet[5],
  ].join("-");
  state.currentFormSetTitle = formSet[6];
  state.formSetIds.add(formSetId);
  state.formSetMetadata.set(formSetId, {
    guid: state.currentFormSetGuid,
    title: state.currentFormSetTitle,
  });
  state.pendingFormSetTitle = state.currentFormSetTitle;
}

function handleVarStoreLine(state: ParserState, varStore: RegExpExecArray) {
  state.varStores.push({
    varStoreId: varStore[2],
    size: varStore[3],
    name: varStore[4],
    formSetGuid: state.currentFormSetGuid,
  });
}

function handleFormLine(
  state: ParserState,
  form: RegExpExecArray,
  indentations: number,
) {
  if (state.pendingFormSetTitle !== null) {
    state.formSetRoots.push({
      name: state.pendingFormSetTitle,
      formId: form[1],
      offset: null,
      formSetGuid: state.currentFormSetGuid,
      source: "formset",
    });
    state.pendingFormSetTitle = null;
  }

  state.currentForm = {
    name: form[2],
    type: "Form",
    formId: form[1],
    formSetGuid: state.currentFormSetGuid,
    formSetTitle: state.currentFormSetTitle,
    referencedIn: [],
    children: [],
    // Overwritten with the real value once this Form's own End line is
    // reached (see handleEndLine) - every well-formed dump closes every
    // Form it opens, checked at the end of parseSetupTxt.
    endOffset: "",
  };

  if (hasScope(form[3])) {
    state.scopes.push({ type: "Form", indentations });
  }
}

function handleConditionLine(
  state: ParserState,
  condition: RegExpExecArray,
  setupTxtArray: string[],
  index: number,
  indentations: number,
  offset: string,
) {
  const kind = condition[1] as ConditionKind;
  const conditionInfo = determineCondition(setupTxtArray, index);
  state.scopes.push({
    type: kind,
    indentations,
    offset,
  });

  state.currentSuppressions.push({
    offset,
    kind,
    active: true,
    start: conditionInfo.start,
    expression: conditionInfo.expression,
    questionIds: conditionInfo.questionIds,
    varStoreIds: conditionInfo.varStoreIds,
    constant: conditionInfo.constant,
    formSetGuid: state.currentFormSetGuid,
  } as Suppression);
}

// A Ref opcode's FormId field always sits right after its OpCode+Length
// header (2 bytes) and its EFI_IFR_QUESTION_HEADER (Prompt/Help StringIds +
// QuestionId + VarStoreId + VarStoreInfo + QuestionFlags = 11 bytes), before
// any variant-specific tail (Ref2's DevicePath, Ref3/Ref4's QuestionId,
// Ref4's FormSetGuid). Verified against a real dump: FormId always lands on
// the opcode's last two bytes when there's no FormSetGuid tail.
const REF_FORM_ID_RELATIVE_OFFSET = 13;

function handleRefLine(
  state: ParserState,
  ref: RegExpExecArray,
  refFormId: RegExpExecArray,
  refFormSetGuid: RegExpExecArray | null,
  setupData: SetupDataIndex,
  offset: string,
) {
  const formId = refFormId[1];
  const targetFormSetGuid = refFormSetGuid?.[1];

  const currentRef: RefPrompt = {
    name: ref[1],
    description: ref[2],
    type: "Ref",
    questionId: ref[4],
    varStoreId: ref[5],
    varStoreName: findVarStoreName(
      state.varStores,
      ref[5],
      state.currentFormSetGuid,
    ),
    formId,
    formIdOffset: decToHexString(
      parseHexId(offset) + REF_FORM_ID_RELATIVE_OFFSET,
    ),
    targetFormSetGuid,
    sctOffset: offset,
    ...getAdditionalData(ref[8], setupData, true),
  };

  checkConditions(state.scopes, currentRef);

  const form = requireCurrent(state.currentForm);
  form.children.push(currentRef);

  const referenceKey = formReferenceKey(
    formId,
    targetFormSetGuid ?? form.formSetGuid,
  );
  if (referenceKey in state.references) {
    state.references[referenceKey].add(form.formId);
  } else {
    state.references[referenceKey] = new Set([form.formId]);
  }
}

function handleStringLine(
  state: ParserState,
  string: RegExpExecArray,
  setupData: SetupDataIndex,
  indentations: number,
  offset: string,
) {
  const { accessLevel, failsafe, optimal, offsets } = getAdditionalData(
    string[10],
    setupData,
    false,
  );

  state.currentString = {
    name: string[1],
    description: string[2],
    type: "String",
    questionId: string[4],
    varStoreId: string[5],
    varStoreName: findVarStoreName(
      state.varStores,
      string[5],
      state.currentFormSetGuid,
    ),
    accessLevel,
    failsafe,
    optimal,
    offsets,
    sctOffset: offset,
  };

  checkConditions(state.scopes, state.currentString);

  if (hasScope(string[10])) {
    state.scopes.push({ type: "String", indentations });
  }
}

function handleNumericLine(
  state: ParserState,
  numeric: RegExpExecArray,
  setupData: SetupDataIndex,
  indentations: number,
  offset: string,
) {
  const { accessLevel, failsafe, optimal, offsets } = getAdditionalData(
    numeric[12],
    setupData,
    false,
  );

  state.currentNumeric = {
    name: numeric[1],
    description: numeric[2],
    type: "Numeric",
    questionId: numeric[4],
    varStoreId: numeric[5],
    varStoreName: findVarStoreName(
      state.varStores,
      numeric[5],
      state.currentFormSetGuid,
    ),
    varOffset: numeric[6],
    size: numeric[8],
    min: numeric[9],
    max: numeric[10],
    step: numeric[11],
    accessLevel,
    failsafe,
    optimal,
    offsets,
    sctOffset: offset,
  };

  checkConditions(state.scopes, state.currentNumeric);

  if (hasScope(numeric[12])) {
    state.scopes.push({ type: "Numeric", indentations });
  }
}

function handleCheckBoxLine(
  state: ParserState,
  checkBox: RegExpExecArray,
  setupData: SetupDataIndex,
  indentations: number,
  offset: string,
) {
  const { accessLevel, failsafe, optimal, offsets } = getAdditionalData(
    checkBox[8],
    setupData,
    false,
  );

  state.currentCheckBox = {
    name: checkBox[1],
    description: checkBox[2],
    type: "CheckBox",
    questionId: checkBox[4],
    varStoreId: checkBox[5],
    varStoreName: findVarStoreName(
      state.varStores,
      checkBox[5],
      state.currentFormSetGuid,
    ),
    varOffset: checkBox[6],
    flags: checkBox[7],
    accessLevel,
    failsafe,
    optimal,
    offsets,
    sctOffset: offset,
  };

  checkConditions(state.scopes, state.currentCheckBox);

  if (hasScope(checkBox[8])) {
    state.scopes.push({ type: "CheckBox", indentations });
  }
}

function handleOneOfLine(
  state: ParserState,
  oneOf: RegExpExecArray,
  setupData: SetupDataIndex,
  indentations: number,
  offset: string,
) {
  const { accessLevel, failsafe, optimal, offsets } = getAdditionalData(
    oneOf[12],
    setupData,
    false,
  );

  state.currentOneOf = {
    name: oneOf[1],
    description: oneOf[2],
    type: "OneOf",
    questionId: oneOf[4],
    varStoreId: oneOf[5],
    varStoreName: findVarStoreName(
      state.varStores,
      oneOf[5],
      state.currentFormSetGuid,
    ),
    varOffset: oneOf[6],
    size: oneOf[8],
    options: [],
    accessLevel,
    failsafe,
    optimal,
    offsets,
    sctOffset: offset,
  };

  checkConditions(state.scopes, state.currentOneOf);

  if (hasScope(oneOf[12])) {
    state.scopes.push({ type: "OneOf", indentations });
  }
}

function handleOneOfOptionLine(
  state: ParserState,
  oneOfOption: RegExpExecArray,
  currentScope: Scopes[number],
) {
  if (currentScope.type === "OneOf" || isConditionKind(currentScope.type)) {
    requireCurrent(state.currentOneOf).options.push({
      option: oneOfOption[1],
      value: oneOfOption[2],
    });
  }
}

function handleDefaultLine(
  state: ParserState,
  defaultId: RegExpExecArray,
  currentScope: Scopes[number],
) {
  const oneDefault = {
    defaultId: defaultId[1],
    value: defaultId[2],
  };

  if (currentScope.type === "Numeric") {
    const numeric = requireCurrent(state.currentNumeric);
    numeric.defaults ??= [];
    numeric.defaults.push(oneDefault);
  } else if (currentScope.type === "CheckBox") {
    const checkBoxPrompt = requireCurrent(state.currentCheckBox);
    checkBoxPrompt.defaults ??= [];
    checkBoxPrompt.defaults.push(oneDefault);
  } else if (currentScope.type === "OneOf") {
    const oneOfPrompt = requireCurrent(state.currentOneOf);
    oneOfPrompt.defaults ??= [];
    oneOfPrompt.defaults.push(oneDefault);
  }
}

// Commits the value built for the scope that just closed (Form/Numeric/
// CheckBox/OneOf/String) into its permanent home, or - for a condition
// scope - finalizes the matching suppression with its end offset.
function handleEndLine(
  state: ParserState,
  currentScope: Scopes[number],
  offset: string,
) {
  const scopeType = currentScope.type;

  if (scopeType === "Form") {
    const form = requireCurrent(state.currentForm);
    form.endOffset = offset;
    state.forms.push(form);
  } else if (scopeType === "Numeric") {
    requireCurrent(state.currentForm).children.push(
      requireCurrent(state.currentNumeric),
    );
  } else if (scopeType === "CheckBox") {
    requireCurrent(state.currentForm).children.push(
      requireCurrent(state.currentCheckBox),
    );
  } else if (scopeType === "OneOf") {
    requireCurrent(state.currentForm).children.push(
      requireCurrent(state.currentOneOf),
    );
  } else if (scopeType === "String") {
    requireCurrent(state.currentForm).children.push(
      requireCurrent(state.currentString),
    );
  } else {
    const latestSuppression = state.currentSuppressions.pop();

    if (!latestSuppression) {
      throw new Error(
        "Something went wrong. Please file a bug report on Github.",
      );
    }

    state.suppressions.push({ ...latestSuppression, end: offset });
  }

  state.scopes.pop();
}

function parseSetupTxt(setupTxt: string, setupdataBin: string): ParserState {
  const state = createParserState();
  const setupData = indexSetupData(setupdataBin);
  const setupTxtArray = setupTxt.split("\n");

  for (const [index, line] of setupTxtArray.entries()) {
    const formSet =
      /FormSet Guid: (.*)-(.*)-(.*)-(.*)-(.*), Title: "(.*)", Help:/.exec(
        line,
      );
    const varStore =
      /VarStore Guid: (.*), VarStoreId: (.*), Size: (.*), Name: "(.*)" \{/.exec(
        line,
      );
    const form = /Form FormId: (.*), Title: "(.*)" \{ (.*) \}/.exec(line);
    const condition = /\b(SuppressIf|GrayOutIf|DisableIf)\b.*\{ [0-9A-F ]+ \}/.exec(
      line,
    );
    const ref =
      /Ref Prompt: "(.*)", Help: "(.*)", QuestionFlags: ([^,]*), QuestionId: ([^,]*), VarStoreId: ([^,]*), VarStoreInfo: ([^,{]*)(.*?) \{ ([0-9A-F ]+) \}/.exec(
        line,
      );
    const refFormId = ref
      ? /(?:^|, )FormId: ([^, {]+)/.exec(ref[7])
      : null;
    const refFormSetGuid = ref
      ? /(?:^|, )FormSetGuid: ([^, {]+)/.exec(ref[7])
      : null;
    const string =
      /String Prompt: "(.*)", Help: "(.*)", QuestionFlags: (.*), QuestionId: (.*), VarStoreId: (.*), VarStoreInfo: (.*), MinSize: (.*), MaxSize: (.*), Flags: (.*) \{ (.*) \}/.exec(
        line,
      );
    const numeric =
      /Numeric Prompt: "(.*)", Help: "(.*)", QuestionFlags: (.*), QuestionId: (.*), VarStoreId: (.*), VarOffset: (.*), Flags: (.*), Size: (.*), Min: (.*), Max: (.*), Step: (.*) \{ (.*) \}/.exec(
        line,
      );
    const checkBox =
      /CheckBox Prompt: "(.*)", Help: "(.*)", QuestionFlags: (.*), QuestionId: (.*), VarStoreId: (.*), VarOffset: (.*), Flags: (.*) \{ (.*) \}/.exec(
        line,
      );
    const oneOf =
      /OneOf Prompt: "(.*)", Help: "(.*)", QuestionFlags: (.*), QuestionId: (.*), VarStoreId: (.*), VarOffset: (.*), Flags: (.*), Size: (.*), Min: (.*), Max: (.*), Step: (.*) \{ (.*) \}/.exec(
        line,
      );
    const oneOfOption = /OneOfOption Option: "(.*)" Value: (.*) \{/.exec(line);
    const defaultId = /Default DefaultId: (.*) Value: (.*) \{/.exec(line);
    const end = /\{ 29 02 \}/.exec(line);
    const indentations = (line.match(/\t/g) ?? []).length;
    const offset = line.split(" ")[0].slice(0, -1);
    const currentScope = state.scopes[state.scopes.length - 1];

    if (formSet) {
      handleFormSetLine(state, formSet);
    }

    if (varStore) {
      handleVarStoreLine(state, varStore);
    }

    if (form) {
      handleFormLine(state, form, indentations);
    }

    if (condition) {
      handleConditionLine(
        state,
        condition,
        setupTxtArray,
        index,
        indentations,
        offset,
      );
    }

    if (ref && refFormId) {
      handleRefLine(state, ref, refFormId, refFormSetGuid, setupData, offset);
    }

    if (string) {
      handleStringLine(state, string, setupData, indentations, offset);
    }

    if (numeric) {
      handleNumericLine(state, numeric, setupData, indentations, offset);
    }

    if (checkBox) {
      handleCheckBoxLine(state, checkBox, setupData, indentations, offset);
    }

    if (oneOf) {
      handleOneOfLine(state, oneOf, setupData, indentations, offset);
    }

    if (oneOfOption) {
      handleOneOfOptionLine(state, oneOfOption, currentScope);
    }

    if (state.scopes.length !== 0) {
      if (defaultId) {
        handleDefaultLine(state, defaultId, currentScope);
      }

      if (end && currentScope.indentations === indentations) {
        handleEndLine(state, currentScope, offset);
      }
    }
  }

  if (state.scopes.length !== 0 || state.currentSuppressions.length !== 0) {
    throw new Error(
      "Something went wrong. Please file a bug report on Github.",
    );
  }

  return state;
}

export async function parseData(files: PopulatedFiles) {
  const [setupTxtHash, setupSctHash, amitseSctHash, setupdataBinHash] =
    await Promise.all([
      hashFile(files.setupTxtContainer.file),
      hashFile(files.setupSctContainer.file),
      hashFile(files.amitseSctContainer.file),
      hashFile(files.setupdataBinContainer.file),
    ]);

  let setupTxt = files.setupTxtContainer.textContent;
  const amitseSct = files.amitseSctContainer.textContent;
  const setupdataBin = files.setupdataBinContainer.textContent;

  if (
    !wantedIFRExtractorVersions.some((version) =>
      setupTxt.includes(`Program version: ${version}`),
    )
  ) {
    throw new Error(
      `Wrong IFRExtractor-RS version. Compatible versions: ${wantedIFRExtractorVersions.join(
        ", ",
      )}.`,
    );
  }

  if (!setupTxt.includes("Extraction mode: UEFI")) {
    throw new Error("Only UEFI is supported.");
  }

  if (!/\{ .* \}/.test(setupTxt)) {
    throw new Error(`Use the "verbose" option of IFRExtractor.`);
  }

  if (!setupTxt.includes(`SHA256: ${setupSctHash}`)) {
    throw new Error("Setup SCT and IFR Extractor output TXT SHA256 mismatch");
  }

  setupTxt = setupTxt.replace(/[\r\n|\n|\r](?!0x[0-9A-F]{3})/g, "<br>");

  const {
    formSetIds,
    formSetMetadata,
    formSetRoots,
    varStores,
    forms,
    suppressions,
    references,
  } = parseSetupTxt(setupTxt, setupdataBin);

  enrichConditions(forms, varStores, suppressions);

  const matches = [...formSetIds].flatMap((formSetId) =>
    [...amitseSct.matchAll(new RegExp(formSetId + "(.{4})", "gi"))].map(
      (match) => ({ match, formSetId }),
    ),
  );
  // An AMITSE table entry names a FormSet and a FormId; only a Form with
  // that FormId inside that very FormSet counts. A same-numbered Form in
  // another FormSet is a different page, and inventing an entry from the
  // FormSet's title alone would claim a root that no Form backs.
  const discoveredMenu: Menu = matches.flatMap(({ match, formSetId }) => {
    const hexEntry = decToHexString(
      parseInt(match[1].slice(2) + match[1].slice(0, 2), 16),
    );
    const formSet = formSetMetadata.get(formSetId);
    const matchedForm = formSet
      ? forms.find(
          (form) =>
            sameGuidOrBothUndefined(form.formSetGuid, formSet.guid) &&
            sameHexId(form.formId, hexEntry),
        )
      : undefined;
    if (!formSet || !matchedForm) {
      return [];
    }
    return [
      {
        name: matchedForm.name,
        formId: hexEntry,
        offset: decToHexString((match.index + formSetId.length) / 2),
        formSetGuid: formSet.guid,
        source: "amitse" as const,
      },
    ];
  });
  const setupDataMenu = discoverSetupDataMenu(formSetRoots, setupdataBin).map(
    (entry) => {
      const executableEntry = discoveredMenu.find(
        (candidate) =>
          candidate.formSetGuid?.toLowerCase() ===
          entry.formSetGuid?.toLowerCase(),
      );
      return {
        ...entry,
        offset: executableEntry?.offset ?? null,
      };
    },
  );
  // A single FormSet whose entry Form fans out into the tabs is its own
  // menu: the hub is the only root and its direct Refs are the tabs, so the
  // AMITSE table and SetupData page list only serve as corroboration there.
  const singleFormSetNavigation = inspectSingleFormSetNavigation(
    formSetRoots,
    forms,
    discoveredMenu,
  );
  const hubMenu = singleFormSetHubMenu(singleFormSetNavigation);
  const menu =
    hubMenu.length > 0
      ? hubMenu
      : setupDataMenu.length > 0
        ? setupDataMenu
        : discoveredMenu.length > 0
          ? discoveredMenu
          : formSetRoots;

  for (const form of forms) {
    const referenceKey = formReferenceKey(form.formId, form.formSetGuid);
    if (referenceKey in references) {
      form.referencedIn = [...references[referenceKey]];
    }
  }

  const dataJson: Data = {
    firmwareFamily: setupdataBin.startsWith("24535046")
      ? "aptio-iv"
      : "aptio-v",
    menu,
    formSetRoots,
    forms,
    varStores,
    suppressions,
    // The root byte vector lives in the Setup PE32 inside the image, so it
    // can only be looked for when the image itself was opened.
    rootVisibility: files.firmwareSource
      ? inspectAmiRootVisibility(formSetRoots, files.firmwareSource.artifacts.provenance)
      : undefined,
    singleFormSetNavigation,
    version,
    hashes: {
      setupTxt: setupTxtHash,
      setupSct: setupSctHash,
      amitseSct: amitseSctHash,
      setupdataBin: setupdataBinHash,
      offsetChecksum: await calculateJsonChecksum(menu, forms, suppressions),
    },
  };

  return dataJson;
}
