import type { PopulatedFiles } from "../FileUploads/FileUploads";
import {
  expressionMetadata,
  humanizeExpression,
  readableExpressionLine,
} from "./expressionFormatter";
import { calculateJsonChecksum, hashFile } from "./hashing";
import { parseHexId, sameHexId } from "./hexId";
import { decToHexString } from "./binaryPatcher";
import type {
  CheckBoxPrompt,
  ConditionKind,
  Data,
  Form,
  FormChildren,
  Forms,
  Menu,
  NumericPrompt,
  Offsets,
  OneOfPrompt,
  RefPrompt,
  Scopes,
  StringPrompt,
  Suppression,
  VarStores,
} from "./types";

export const version = "0.4.0";
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

function isPageMask(value: number) {
  return value === 0 || (value > 0 && (value & (value - 1)) === 0);
}

function discoverSetupDataMenu(formSetRoots: Menu, setupData: string): Menu {
  const candidates: {
    entry: Menu[number];
    start: number;
    mask: number;
  }[] = [];

  for (const entry of formSetRoots) {
    if (!entry.formSetGuid) {
      continue;
    }
    const encodedGuid = guidToUefiHex(entry.formSetGuid);
    let guidIndex = setupData.indexOf(encodedGuid);
    while (guidIndex !== -1) {
      if (guidIndex >= 8) {
        const start = guidIndex - 8;
        const mask = littleEndianUint32(setupData.slice(start, guidIndex));
        if (isPageMask(mask)) {
          candidates.push({ entry, start, mask });
        }
      }
      guidIndex = setupData.indexOf(encodedGuid, guidIndex + 2);
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

  return pageList.map(({ entry, start, mask }) => ({
    ...entry,
    offset: null,
    source: "setupdata",
    pageMask: decToHexString(mask),
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

// The AMI SetupData "question metadata" record for a HII question is
// anchored by that question's own VarOffset/QuestionId byte pairs (passed
// in as `bytes`, taken from byteArray[2..3]/[4..5]/[6..7]). Relative to
// where that anchor pattern starts in SetupData, the record also carries a
// page id, the AMI access-level byte, and further along the failsafe and
// optimal default bytes. These gaps were reverse-engineered from firmware
// images (there is no public spec for this layout); they are expressed as
// named lengths so the regex and the resulting byte offsets can never
// drift out of sync with each other.
const ANCHOR_PAIR_HEX_CHARS = 4; // two hex bytes, e.g. byteArray[6] + byteArray[7]
const PAGE_ID_HEX_CHARS = 4;
const ACCESS_LEVEL_HEX_CHARS = 2;
const FAILSAFE_HEX_CHARS = 2;

const GAP_ANCHOR67_TO_PAGE_ID = 20;
const GAP_PAGE_ID_TO_ACCESS_LEVEL = 4;
const GAP_ACCESS_LEVEL_TO_ANCHOR45 = 6;
const GAP_ANCHOR45_TO_ANCHOR23 = 52;
const GAP_ANCHOR23_TO_FAILSAFE = 4;

const PAGE_ID_OFFSET = ANCHOR_PAIR_HEX_CHARS + GAP_ANCHOR67_TO_PAGE_ID;
const ACCESS_LEVEL_OFFSET =
  PAGE_ID_OFFSET + PAGE_ID_HEX_CHARS + GAP_PAGE_ID_TO_ACCESS_LEVEL;
const ANCHOR45_OFFSET =
  ACCESS_LEVEL_OFFSET + ACCESS_LEVEL_HEX_CHARS + GAP_ACCESS_LEVEL_TO_ANCHOR45;
const ANCHOR23_OFFSET =
  ANCHOR45_OFFSET + ANCHOR_PAIR_HEX_CHARS + GAP_ANCHOR45_TO_ANCHOR23;
const FAILSAFE_OFFSET =
  ANCHOR23_OFFSET + ANCHOR_PAIR_HEX_CHARS + GAP_ANCHOR23_TO_FAILSAFE;
const OPTIMAL_OFFSET = FAILSAFE_OFFSET + FAILSAFE_HEX_CHARS;

function getAdditionalData(
  bytes: string,
  hexSetupdataBin: string,
  isRef: boolean,
): {
  pageId: string | null;
  accessLevel: string | null;
  failsafe: string | null;
  optimal: string | null;
  offsets: Offsets | null;
} {
  const byteArray = bytes.split(" ");
  const regex = new RegExp(
    byteArray[6] +
      byteArray[7] +
      `.{${String(GAP_ANCHOR67_TO_PAGE_ID)}}(....).{${String(
        GAP_PAGE_ID_TO_ACCESS_LEVEL,
      )}}(..).{${String(GAP_ACCESS_LEVEL_TO_ANCHOR45)}}` +
      byteArray[4] +
      byteArray[5] +
      `.{${String(GAP_ANCHOR45_TO_ANCHOR23)}}` +
      byteArray[2] +
      byteArray[3] +
      `.{${String(GAP_ANCHOR23_TO_FAILSAFE)}}(..)(..)`,
    "g",
  );

  const matches = [...hexSetupdataBin.matchAll(regex)].filter(
    (element) => element.index % 2 === 0,
  );

  if (matches.length === 1) {
    const match = matches[0];
    const index = match.index;

    const offsets: Offsets = {
      accessLevel: decToHexString((index + ACCESS_LEVEL_OFFSET) / 2),
      failsafe: decToHexString((index + FAILSAFE_OFFSET) / 2),
      optimal: decToHexString((index + OPTIMAL_OFFSET) / 2),
    };

    if (isRef) {
      offsets.pageId = decToHexString((index + PAGE_ID_OFFSET) / 2);
    }

    return {
      pageId: match[1],
      accessLevel: match[2],
      failsafe: match[3],
      optimal: match[4],
      offsets,
    };
  }

  return {
    pageId: null,
    accessLevel: null,
    failsafe: null,
    optimal: null,
    offsets: null,
  };
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

  const formSetIds = new Set<string>();
  const formSetMetadata = new Map<
    string,
    { guid: string; title: string }
  >();
  const formSetRoots: Menu = [];
  let pendingFormSetTitle: string | null = null;
  let currentFormSetGuid: string | undefined;
  let currentFormSetTitle: string | undefined;
  const varStores: VarStores = [];
  const forms: Forms = [];
  const suppressions: Suppression[] = [];
  const scopes: Scopes = [];
  let currentForm: Form | null = null;
  let currentString: StringPrompt | null = null;
  let currentOneOf: OneOfPrompt | null = null;
  let currentNumeric: NumericPrompt | null = null;
  let currentCheckBox: CheckBoxPrompt | null = null;

  const currentSuppressions: Suppression[] = [];

  const references: Record<string, Set<string>> = {};

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
    const currentScope = scopes[scopes.length - 1];

    if (formSet) {
      const formSetId = formSet[4] + formSet[5];
      currentFormSetGuid = [
        formSet[1],
        formSet[2],
        formSet[3],
        formSet[4],
        formSet[5],
      ].join("-");
      currentFormSetTitle = formSet[6];
      formSetIds.add(formSetId);
      formSetMetadata.set(formSetId, {
        guid: currentFormSetGuid,
        title: currentFormSetTitle,
      });
      pendingFormSetTitle = currentFormSetTitle;
    }

    if (varStore) {
      varStores.push({
        varStoreId: varStore[2],
        size: varStore[3],
        name: varStore[4],
        formSetGuid: currentFormSetGuid,
      });
    }

    if (form) {
      if (pendingFormSetTitle !== null) {
        formSetRoots.push({
          name: pendingFormSetTitle,
          formId: form[1],
          offset: null,
          formSetGuid: currentFormSetGuid,
          source: "formset",
        });
        pendingFormSetTitle = null;
      }

      currentForm = {
        name: form[2],
        type: "Form",
        formId: form[1],
        formSetGuid: currentFormSetGuid,
        formSetTitle: currentFormSetTitle,
        referencedIn: [],
        children: [],
      };

      if (hasScope(form[3])) {
        scopes.push({ type: "Form", indentations });
      }
    }

    if (condition) {
      const kind = condition[1] as ConditionKind;
      const conditionInfo = determineCondition(setupTxtArray, index);
      scopes.push({
        type: kind,
        indentations,
        offset,
      });

      currentSuppressions.push({
        offset,
        kind,
        active: true,
        start: conditionInfo.start,
        expression: conditionInfo.expression,
        questionIds: conditionInfo.questionIds,
        varStoreIds: conditionInfo.varStoreIds,
        constant: conditionInfo.constant,
        formSetGuid: currentFormSetGuid,
      } as Suppression);
    }

    if (ref && refFormId) {
      const formId = refFormId[1];
      const targetFormSetGuid = refFormSetGuid?.[1];

      const currentRef: RefPrompt = {
        name: ref[1],
        description: ref[2],
        type: "Ref",
        questionId: ref[4],
        varStoreId: ref[5],
        varStoreName: findVarStoreName(
          varStores,
          ref[5],
          currentFormSetGuid,
        ),
        formId,
        targetFormSetGuid,
        ...getAdditionalData(ref[8], setupdataBin, true),
      };

      checkConditions(scopes, currentRef);

      const form = requireCurrent(currentForm);
      form.children.push(currentRef);

      const referenceKey = formReferenceKey(
        formId,
        targetFormSetGuid ?? form.formSetGuid,
      );
      if (referenceKey in references) {
        references[referenceKey].add(form.formId);
      } else {
        references[referenceKey] = new Set([form.formId]);
      }
    }

    if (string) {
      const { accessLevel, failsafe, optimal, offsets } = getAdditionalData(
        string[10],
        setupdataBin,
        false,
      );

      currentString = {
        name: string[1],
        description: string[2],
        type: "String",
        questionId: string[4],
        varStoreId: string[5],
        varStoreName: findVarStoreName(
          varStores,
          string[5],
          currentFormSetGuid,
        ),
        accessLevel,
        failsafe,
        optimal,
        offsets,
      };

      checkConditions(scopes, currentString);

      if (hasScope(string[10])) {
        scopes.push({ type: "String", indentations });
      }
    }

    if (numeric) {
      const { accessLevel, failsafe, optimal, offsets } = getAdditionalData(
        numeric[12],
        setupdataBin,
        false,
      );

      currentNumeric = {
        name: numeric[1],
        description: numeric[2],
        type: "Numeric",
        questionId: numeric[4],
        varStoreId: numeric[5],
        varStoreName: findVarStoreName(
          varStores,
          numeric[5],
          currentFormSetGuid,
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
      };

      checkConditions(scopes, currentNumeric);

      if (hasScope(numeric[12])) {
        scopes.push({ type: "Numeric", indentations });
      }
    }

    if (checkBox) {
      const { accessLevel, failsafe, optimal, offsets } = getAdditionalData(
        checkBox[8],
        setupdataBin,
        false,
      );

      currentCheckBox = {
        name: checkBox[1],
        description: checkBox[2],
        type: "CheckBox",
        questionId: checkBox[4],
        varStoreId: checkBox[5],
        varStoreName: findVarStoreName(
          varStores,
          checkBox[5],
          currentFormSetGuid,
        ),
        varOffset: checkBox[6],
        flags: checkBox[7],
        accessLevel,
        failsafe,
        optimal,
        offsets,
      };

      checkConditions(scopes, currentCheckBox);

      if (hasScope(checkBox[8])) {
        scopes.push({ type: "CheckBox", indentations });
      }
    }

    if (oneOf) {
      const { accessLevel, failsafe, optimal, offsets } = getAdditionalData(
        oneOf[12],
        setupdataBin,
        false,
      );

      currentOneOf = {
        name: oneOf[1],
        description: oneOf[2],
        type: "OneOf",
        questionId: oneOf[4],
        varStoreId: oneOf[5],
        varStoreName: findVarStoreName(
          varStores,
          oneOf[5],
          currentFormSetGuid,
        ),
        varOffset: oneOf[6],
        size: oneOf[8],
        options: [],
        accessLevel,
        failsafe,
        optimal,
        offsets,
      };

      checkConditions(scopes, currentOneOf);

      if (hasScope(oneOf[12])) {
        scopes.push({ type: "OneOf", indentations });
      }
    }

    if (
      oneOfOption &&
      (currentScope.type === "OneOf" || isConditionKind(currentScope.type))
    ) {
      requireCurrent(currentOneOf).options.push({
        option: oneOfOption[1],
        value: oneOfOption[2],
      });
    }

    if (scopes.length !== 0) {
      if (defaultId) {
        const oneDefault = {
          defaultId: defaultId[1],
          value: defaultId[2],
        };

        if (currentScope.type === "Numeric") {
          const numeric = requireCurrent(currentNumeric);
          numeric.defaults ??= [];
          numeric.defaults.push(oneDefault);
        } else if (currentScope.type === "CheckBox") {
          const checkBoxPrompt = requireCurrent(currentCheckBox);
          checkBoxPrompt.defaults ??= [];
          checkBoxPrompt.defaults.push(oneDefault);
        } else if (currentScope.type === "OneOf") {
          const oneOfPrompt = requireCurrent(currentOneOf);
          oneOfPrompt.defaults ??= [];
          oneOfPrompt.defaults.push(oneDefault);
        }
      }

      if (end && currentScope.indentations === indentations) {
        const scopeType = currentScope.type;

        if (scopeType === "Form") {
          forms.push(requireCurrent(currentForm));
        } else if (scopeType === "Numeric") {
          requireCurrent(currentForm).children.push(
            requireCurrent(currentNumeric),
          );
        } else if (scopeType === "CheckBox") {
          requireCurrent(currentForm).children.push(
            requireCurrent(currentCheckBox),
          );
        } else if (scopeType === "OneOf") {
          requireCurrent(currentForm).children.push(
            requireCurrent(currentOneOf),
          );
        } else if (scopeType === "String") {
          requireCurrent(currentForm).children.push(
            requireCurrent(currentString),
          );
        } else {
          const latestSuppression = currentSuppressions.pop();

          if (!latestSuppression) {
            throw new Error(
              "Something went wrong. Please file a bug report on Github.",
            );
          }

          suppressions.push({ ...latestSuppression, end: offset });
        }

        scopes.pop();
      }
    }
  }

  if (scopes.length !== 0 || currentSuppressions.length !== 0) {
    throw new Error(
      "Something went wrong. Please file a bug report on Github.",
    );
  }

  enrichConditions(forms, varStores, suppressions);

  const matches = [...formSetIds].flatMap((formSetId) =>
    [...amitseSct.matchAll(new RegExp(formSetId + "(.{4})", "g"))].map(
      (match) => ({ match, formSetId }),
    ),
  );
  const discoveredMenu: Menu = matches
    .map(({ match, formSetId }) => {
      const hexEntry = decToHexString(
        parseInt(match[1].slice(2) + match[1].slice(0, 2), 16),
      );
      const formSet = formSetMetadata.get(formSetId);
      const matchedForm =
        forms.find(
          (form) =>
            form.formSetGuid === formSet?.guid &&
            sameHexId(form.formId, hexEntry),
        ) ?? forms.find((form) => sameHexId(form.formId, hexEntry));
      return {
        name: matchedForm?.name ?? formSet?.title ?? "",
        formId: hexEntry,
        offset: decToHexString((match.index + formSetId.length) / 2),
        formSetGuid: formSet?.guid,
        source: "amitse" as const,
      };
    })
    .filter((x) => x.name);
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
  const menu =
    setupDataMenu.length > 0
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
