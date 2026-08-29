import { saveAs } from "file-saver";
import type { PopulatedFiles } from "../FileUploads/FileUploads";
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

async function sha256Hex(data: BufferSource) {
  const digest = await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function hashFile(file: File) {
  return sha256Hex(await file.arrayBuffer());
}

export function validateByteInput(value: string) {
  return (
    value.length <= 2 &&
    (value.length === 0 ||
      value.split("").every((char) => /[a-fA-F0-9]/.test(char)))
  );
}

function hasScope(hexString: string) {
  const header = hexString.split(" ")[1];

  return parseInt(header, 16).toString(2).padStart(8, "0").startsWith("1");
}

export async function calculateJsonChecksum(
  menu: Menu,
  forms: Forms,
  suppressions: Suppression[],
) {
  let offsetChecksum = "";

  for (const menuItem of menu) {
    offsetChecksum += menuItem.offset ?? "";
  }

  for (const form of forms) {
    for (const child of form.children) {
      offsetChecksum += JSON.stringify(child.offsets);
    }
  }

  for (const suppression of suppressions) {
    offsetChecksum += suppression.offset + suppression.start + suppression.end;
  }

  return sha256Hex(new TextEncoder().encode(offsetChecksum));
}

function replaceAt(
  string: string,
  index: number,
  length: number,
  replacement: string,
) {
  return string.slice(0, index) + replacement + string.slice(index + length);
}

function offsetToIndex(offset: string) {
  return parseInt(offset, 16) * 2;
}

function decToHexString(decimal: number) {
  return `0x${decimal.toString(16).toUpperCase()}`;
}

function formReferenceKey(formId: string, formSetGuid?: string) {
  return `${formSetGuid ?? ""}:${String(parseInt(formId))}`;
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
        parseInt(varStore.varStoreId) === parseInt(varStoreId),
    ) ??
    varStores.find(
      (varStore) => parseInt(varStore.varStoreId) === parseInt(varStoreId),
    )
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
      ".{20}(....).{4}(..).{6}" +
      byteArray[4] +
      byteArray[5] +
      ".{52}" +
      byteArray[2] +
      byteArray[3] +
      ".{4}(..)(..)",
    "g",
  );

  const matches = [...hexSetupdataBin.matchAll(regex)].filter(
    (element) => element.index % 2 === 0,
  );

  if (matches.length === 1) {
    const match = matches[0];
    const index = match.index;

    const offsets: Offsets = {
      accessLevel: decToHexString((index + 32) / 2),
      failsafe: decToHexString((index + 104) / 2),
      optimal: decToHexString((index + 106) / 2),
    };

    if (isRef) {
      offsets.pageId = decToHexString((index + 24) / 2);
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

function getUint8Array(string: string) {
  const array = [];
  for (let i = 0, len = string.length; i < len; i += 2) {
    array[i / 2] = parseInt(string.slice(i, i + 2), 16);
  }

  return array;
}

export async function downloadModifiedFiles(data: Data, files: PopulatedFiles) {
  let wasSetupSctModified = false;
  let wasAmitseSctModified = false;
  let wasSetupdataBinModified = false;

  let changeLog = "";

  let modifiedSetupSct = files.setupSctContainer.textContent;
  let setupSctChangeLog = "";

  const suppressions = JSON.parse(
    JSON.stringify(data.suppressions),
  ) as Suppression[];

  for (const suppression of suppressions) {
    if ((suppression.kind ?? "SuppressIf") !== "SuppressIf") {
      continue;
    }
    if (!suppression.active) {
      if (
        modifiedSetupSct.slice(
          offsetToIndex(suppression.end),
          offsetToIndex(suppression.end) + 4,
        ) !== "2902"
      ) {
        alert("Something went wrong. Please file a bug report on Github.");
        return;
      }

      modifiedSetupSct = replaceAt(
        modifiedSetupSct,
        offsetToIndex(suppression.end),
        4,
        "",
      );

      modifiedSetupSct = replaceAt(
        modifiedSetupSct,
        offsetToIndex(suppression.start),
        0,
        "2902",
      );

      for (const suppressionToUpdate of suppressions) {
        if (suppressionToUpdate.offset !== suppression.offset) {
          if (
            parseInt(suppression.start, 16) <
              parseInt(suppressionToUpdate.start, 16) &&
            parseInt(suppressionToUpdate.start, 16) <
              parseInt(suppression.end, 16)
          ) {
            suppressionToUpdate.start = decToHexString(
              (offsetToIndex(suppressionToUpdate.start) + 8) / 2,
            );
          }

          if (
            parseInt(suppression.start, 16) <
              parseInt(suppressionToUpdate.end, 16) &&
            parseInt(suppressionToUpdate.end, 16) <
              parseInt(suppression.end, 16)
          ) {
            suppressionToUpdate.end = decToHexString(
              (offsetToIndex(suppressionToUpdate.end) + 8) / 2,
            );
          }
        }
      }

      setupSctChangeLog += `Unsuppressed ${suppression.offset}\n`;

      wasSetupSctModified = true;
    }
  }

  let modifiedAmitseSct = files.amitseSctContainer.textContent;
  let amitseSctChangeLog = "";

  for (const entry of data.menu) {
    if (entry.offset === null) {
      continue;
    }

    const padded = entry.formId.split("x")[1].padStart(4, "0");
    const newValue = padded.slice(2) + padded.slice(0, 2);
    const index = offsetToIndex(entry.offset);
    const oldValue = modifiedAmitseSct.slice(index, index + 4);

    if (newValue !== oldValue) {
      modifiedAmitseSct = replaceAt(modifiedAmitseSct, index, 4, newValue);

      const oldFormId = decToHexString(
        parseInt(oldValue.slice(-2) + oldValue.slice(-4, -2), 16),
      );

      amitseSctChangeLog += `${
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        data.forms.find(
          (form) => parseInt(form.formId) === parseInt(oldFormId),
        )!.name
      } | FormId ${oldFormId} -> ${
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        data.forms.find(
          (form) => parseInt(form.formId) === parseInt(entry.formId),
        )!.name
      } | FormId ${entry.formId}\n`;

      wasAmitseSctModified = true;
    }
  }

  let modifiedSetupdataBin = files.setupdataBinContainer.textContent;
  let setupdataBinChangeLog = "";

  for (const form of data.forms) {
    for (const child of form.children) {
      if (
        child.offsets &&
        child.accessLevel &&
        child.failsafe &&
        child.optimal
      ) {
        const accessLevelIndex = offsetToIndex(child.offsets.accessLevel);
        const oldAccessLevel = modifiedSetupdataBin.slice(
          accessLevelIndex,
          accessLevelIndex + 2,
        );
        const newAccessLevel = child.accessLevel.padStart(2, "0");
        if (oldAccessLevel !== newAccessLevel) {
          modifiedSetupdataBin = replaceAt(
            modifiedSetupdataBin,
            accessLevelIndex,
            2,
            newAccessLevel,
          );
          setupdataBinChangeLog += `${child.name} | QuestionId ${child.questionId}: Access Level ${oldAccessLevel} -> ${newAccessLevel}\n`;

          wasSetupdataBinModified = true;
        }

        const failsafeIndex = offsetToIndex(child.offsets.failsafe);
        const oldFailsafe = modifiedSetupdataBin.slice(
          failsafeIndex,
          failsafeIndex + 2,
        );
        const newFailsafe = child.failsafe.padStart(2, "0");
        if (oldFailsafe !== newFailsafe) {
          modifiedSetupdataBin = replaceAt(
            modifiedSetupdataBin,
            failsafeIndex,
            2,
            newFailsafe,
          );
          setupdataBinChangeLog += `${child.name} | QuestionId ${child.questionId}: Failsafe ${oldFailsafe} -> ${newFailsafe}\n`;

          wasSetupdataBinModified = true;
        }

        const optimalIndex = offsetToIndex(child.offsets.optimal);
        const oldOptimal = modifiedSetupdataBin.slice(
          optimalIndex,
          optimalIndex + 2,
        );
        const newOptimal = child.optimal.padStart(2, "0");
        if (oldOptimal !== newOptimal) {
          modifiedSetupdataBin = replaceAt(
            modifiedSetupdataBin,
            optimalIndex,
            2,
            newOptimal,
          );
          setupdataBinChangeLog += `${child.name} | QuestionId ${child.questionId}: Optimal ${oldOptimal} -> ${newOptimal}\n`;

          wasSetupdataBinModified = true;
        }
      }
    }
  }

  if (wasSetupSctModified) {
    changeLog += `========== ${files.setupSctContainer.file.name} ==========\n\n${setupSctChangeLog}\n\n\n`;

    saveAs(
      new Blob([new Uint8Array(getUint8Array(modifiedSetupSct))], {
        type: "application/octet-stream",
      }),
      files.setupSctContainer.file.name,
    );
  }

  if (wasAmitseSctModified) {
    changeLog += `========== ${files.amitseSctContainer.file.name} ==========\n\n${amitseSctChangeLog}\n\n\n`;

    saveAs(
      new Blob([new Uint8Array(getUint8Array(modifiedAmitseSct))], {
        type: "application/octet-stream",
      }),
      files.amitseSctContainer.file.name,
    );
  }

  if (wasSetupdataBinModified) {
    changeLog += `========== ${files.setupdataBinContainer.file.name} ==========\n\n${setupdataBinChangeLog}\n\n\n`;

    saveAs(
      new Blob([new Uint8Array(getUint8Array(modifiedSetupdataBin))], {
        type: "application/octet-stream",
      }),
      files.setupdataBinContainer.file.name,
    );
  }

  if (wasSetupSctModified || wasAmitseSctModified || wasSetupdataBinModified) {
    saveAs(
      new Blob([changeLog], {
        type: "text/plain",
      }),
      "changelog.txt",
    );
  } else {
    alert("No modifications have been done.");
  }

  return Promise.resolve();
}

function readableExpressionLine(line: string) {
  return line
    .replace(/^0x[0-9A-F]+:\s*/i, "")
    .replace(/\s*\{ [0-9A-F ]+ \}\s*$/i, "")
    .trim();
}

function expressionMetadata(expression: string) {
  return {
    questionIds: [
      ...expression.matchAll(
        /\b(?:QuestionId(?:1|2)?|OtherQuestionId):\s*(0x[0-9A-F]+)/gi,
      ),
    ].map((match) => match[1]),
    varStoreIds: [
      ...expression.matchAll(/\bVarStoreId:\s*(0x[0-9A-F]+)/gi),
    ].map((match) => match[1]),
  };
}

function humanizeExpression(expression: string) {
  const operators: Record<string, string> = {
    And: "AND",
    Or: "OR",
    Not: "NOT",
    Equal: "==",
    NotEqual: "!=",
    GreaterThan: ">",
    GreaterEqual: ">=",
    LessThan: "<",
    LessEqual: "<=",
  };

  return expression
    .split(" → ")
    .map((part) => {
      const eqValue =
        /^EqIdVal\s+QuestionId:\s*(.+?),\s*Value:\s*(\S+)$/i.exec(part);
      if (eqValue) {
        return `${eqValue[1]} == ${eqValue[2]}`;
      }

      const eqQuestion =
        /^EqIdId\s+QuestionId:\s*(.+?),\s*OtherQuestionId:\s*(.+)$/i.exec(
          part,
        );
      if (eqQuestion) {
        return `${eqQuestion[1]} == ${eqQuestion[2]}`;
      }

      const inList =
        /^EqIdValList\s+QuestionId:\s*(.+?),\s*Values:\s*(.+)$/i.exec(part);
      if (inList) {
        return `${inList[1]} is one of ${inList[2]}`;
      }

      return operators[part] ?? part;
    })
    .join(" → ");
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
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  if (!hasScope(/\{ (.*) \}/.exec(setupTxtArray[index + 1])![1])) {
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
        `${form.formSetGuid ?? ""}:${String(parseInt(child.questionId))}`,
        child,
      );
    }
  }

  for (const condition of conditions) {
    const referenced = (condition.questionIds ?? [])
      .map((questionId) =>
        prompts.get(
          `${condition.formSetGuid ?? ""}:${String(parseInt(questionId))}`,
        ),
      )
      .filter((child): child is FormChildren => child !== undefined);
    const directVarStores = (condition.varStoreIds ?? []).flatMap(
      (varStoreId) => {
        const varStore = varStores.find(
          (candidate) =>
            candidate.formSetGuid === condition.formSetGuid &&
            parseInt(candidate.varStoreId) === parseInt(varStoreId),
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
    alert(
      `Wrong IFRExtractor-RS version. Compatible versions: ${wantedIFRExtractorVersions.join(
        ", ",
      )}.`,
    );
    window.location.reload();
    return {} as Data;
  }

  if (!setupTxt.includes("Extraction mode: UEFI")) {
    alert("Only UEFI is supported.");
    window.location.reload();
    return {} as Data;
  }

  if (!/\{ .* \}/.test(setupTxt)) {
    alert(`Use the "verbose" option of IFRExtractor.`);
    window.location.reload();
    return {} as Data;
  }

  if (!setupTxt.includes(`SHA256: ${setupSctHash}`)) {
    alert("Setup SCT and IFR Extractor output TXT SHA256 mismatch");
    window.location.reload();
    return {} as Data;
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
  let currentForm: Form = {} as Form;
  let currentString: StringPrompt = {} as StringPrompt;
  let currentOneOf: OneOfPrompt = {} as OneOfPrompt;
  let currentNumeric: NumericPrompt = {} as NumericPrompt;
  let currentCheckBox: CheckBoxPrompt = {} as CheckBoxPrompt;

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

      currentForm.children.push(currentRef);

      const referenceKey = formReferenceKey(
        formId,
        targetFormSetGuid ?? currentForm.formSetGuid,
      );
      if (referenceKey in references) {
        references[referenceKey].add(currentForm.formId);
      } else {
        references[referenceKey] = new Set([currentForm.formId]);
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
      currentOneOf.options.push({
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
          currentNumeric.defaults ??= [];
          currentNumeric.defaults.push(oneDefault);
        } else if (currentScope.type === "CheckBox") {
          currentCheckBox.defaults ??= [];
          currentCheckBox.defaults.push(oneDefault);
        } else if (currentScope.type === "OneOf") {
          currentOneOf.defaults ??= [];
          currentOneOf.defaults.push(oneDefault);
        }
      }

      if (end && currentScope.indentations === indentations) {
        const scopeType = currentScope.type;

        if (scopeType === "Form") {
          forms.push(currentForm);
        } else if (scopeType === "Numeric") {
          currentForm.children.push(currentNumeric);
        } else if (scopeType === "CheckBox") {
          currentForm.children.push(currentCheckBox);
        } else if (scopeType === "OneOf") {
          currentForm.children.push(currentOneOf);
        } else if (scopeType === "String") {
          currentForm.children.push(currentString);
        } else {
          const latestSuppression = currentSuppressions.pop();

          if (!latestSuppression) {
            alert("Something went wrong. Please file a bug report on Github.");
            window.location.reload();
            return {} as Data;
          }

          suppressions.push({ ...latestSuppression, end: offset });
        }

        scopes.pop();
      }
    }
  }

  if (scopes.length !== 0 || currentSuppressions.length !== 0) {
    alert("Something went wrong. Please file a bug report on Github.");
    window.location.reload();
    return {} as Data;
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
            parseInt(form.formId) === parseInt(hexEntry),
        ) ??
        forms.find(
          (form) => parseInt(form.formId) === parseInt(hexEntry),
        );
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

  return Promise.resolve(dataJson);
}
