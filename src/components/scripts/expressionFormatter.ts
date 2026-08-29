export function readableExpressionLine(line: string) {
  return line
    .replace(/^0x[0-9A-F]+:\s*/i, "")
    .replace(/\s*\{ [0-9A-F ]+ \}\s*$/i, "")
    .trim();
}

export function expressionMetadata(expression: string) {
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

export function humanizeExpression(expression: string) {
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
