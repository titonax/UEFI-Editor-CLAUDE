import { expressionMetadata, humanizeExpression, readableExpressionLine } from "./expressionFormatter";
import { parseHexId, sameHexId } from "./hexId";
import { type ConditionKind, type FormChildren, type Forms, type Scopes, type Suppression, type VarStores } from "./types";

// Condition scopes of the IFR dump: which SuppressIf / GrayOutIf / DisableIf
// scope a prompt sits in, and the expression text each condition becomes.
export function hasScope(hexString: string) {
  const header = hexString.split(" ")[1];

  return parseInt(header, 16).toString(2).padStart(8, "0").startsWith("1");
}


export const conditionKinds = new Set<ConditionKind>([
  "SuppressIf",
  "GrayOutIf",
  "DisableIf",
]);


export function isConditionKind(value: Scopes[number]["type"]): value is ConditionKind {
  return conditionKinds.has(value as ConditionKind);
}


export function checkConditions(scopes: Scopes, formChild: FormChildren) {
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


export function determineCondition(
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
    if (currentIndex >= setupTxtArray.length) {
      throw new Error(
        `Unterminated condition scope starting at IFR line ${String(index + 1)}: no matching "{ 29 02 }" before the end of the dump.`,
      );
    }
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


export function enrichConditions(
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

