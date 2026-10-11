import { parseHexId, sameHexId } from "./hexId";
import { decToHexString } from "./binaryPatcher";
import { type SetupDataIndex, getAdditionalData, indexSetupData } from "./setupData";
import { type CheckBoxPrompt, type ConditionKind, type Form, type Forms, type Menu, type NumericPrompt, type OneOfPrompt, type RefPrompt, type Scopes, type StringPrompt, type Suppression, type VarStores } from "./types";
import { checkConditions, determineCondition, hasScope, isConditionKind } from "./ifrConditions";

// The line-by-line scan of the IFRExtractor-RS text dump: one handler per
// opcode kind, all mutating a shared `ParserState`.
export function formReferenceKey(formId: string, formSetGuid?: string) {
  return `${formSetGuid ?? ""}:${String(parseHexId(formId))}`;
}


export function findVarStoreName(
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


// The line-by-line loop below tracks "the opcode currently being built" for
// each prompt kind in a `current*` variable, reassigned whenever its own
// opcode line is matched and read only while a corresponding scope sits on
// `scopes` - which is only pushed right after the matching assignment. That
// makes them non-null by construction at every read, but TypeScript can't
// see across the scope stack to prove it; this turns a violation into a
// clear error instead of a confusing "reading property of null" crash.
export function requireCurrent<T>(value: T | null): T {
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
export interface ParserState {
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


export function createParserState(): ParserState {
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


export function handleFormSetLine(state: ParserState, formSet: RegExpExecArray) {
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


export function handleVarStoreLine(state: ParserState, varStore: RegExpExecArray) {
  state.varStores.push({
    varStoreId: varStore[2],
    size: varStore[3],
    name: varStore[4],
    formSetGuid: state.currentFormSetGuid,
  });
}


export function handleFormLine(
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


export function handleConditionLine(
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
export const REF_FORM_ID_RELATIVE_OFFSET = 13;


export function handleRefLine(
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


export function handleStringLine(
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


export function handleNumericLine(
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


export function handleCheckBoxLine(
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


export function handleOneOfLine(
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


export function handleOneOfOptionLine(
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


export function handleDefaultLine(
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
export function handleEndLine(
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


export function parseSetupTxt(setupTxt: string, setupdataBin: string): ParserState {
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

