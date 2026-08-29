import { describe, expect, it } from "vitest";
import {
  expressionMetadata,
  humanizeExpression,
  readableExpressionLine,
} from "./expressionFormatter";

describe("readableExpressionLine", () => {
  it("strips the offset prefix and trailing opcode bytes", () => {
    expect(readableExpressionLine("0x0000001A: \t\tTrue { 01 06 }")).toBe(
      "True",
    );
  });
});

describe("expressionMetadata", () => {
  it("extracts QuestionId and VarStoreId references", () => {
    expect(
      expressionMetadata(
        "EqIdVal QuestionId: 0x0001, Value: 0x01 → VarStoreId: 0x0002",
      ),
    ).toEqual({
      questionIds: ["0x0001"],
      varStoreIds: ["0x0002"],
    });
  });

  it("returns empty arrays when nothing is referenced", () => {
    expect(expressionMetadata("True")).toEqual({
      questionIds: [],
      varStoreIds: [],
    });
  });
});

describe("humanizeExpression", () => {
  it("translates known operator tokens", () => {
    expect(humanizeExpression("A → And → B")).toBe("A → AND → B");
    expect(humanizeExpression("Not")).toBe("NOT");
  });

  it("rewrites EqIdVal into a readable comparison", () => {
    expect(
      humanizeExpression("EqIdVal QuestionId: 0x0001, Value: 0x01"),
    ).toBe("0x0001 == 0x01");
  });

  it("rewrites EqIdId into a readable comparison", () => {
    expect(
      humanizeExpression(
        "EqIdId QuestionId: 0x0001, OtherQuestionId: 0x0002",
      ),
    ).toBe("0x0001 == 0x0002");
  });

  it("rewrites EqIdValList into a readable membership check", () => {
    expect(
      humanizeExpression(
        "EqIdValList QuestionId: 0x0001, Values: 0x01 0x02",
      ),
    ).toBe("0x0001 is one of 0x01 0x02");
  });

  it("leaves unrecognized tokens untouched", () => {
    expect(humanizeExpression("SomethingElse")).toBe("SomethingElse");
  });
});
