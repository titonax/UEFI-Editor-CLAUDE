import React from "react";
import { Badge, Spoiler, Stack, TextInput, Tooltip } from "@mantine/core";
import type { Updater } from "use-immer";
import type { Data, FormChildren } from "../scripts/types";
import { validateByteInput } from "../scripts/binaryPatcher";
import { childVisibility } from "../scripts/visibility";
import ConditionDetails from "./ConditionDetails";
import { visibilityColors } from "./visibilityColors";
import s from "./FormUi.module.css";

interface TableRowProps {
  child: FormChildren;
  index: number;
  handleRefClick: (formId: string, formSetGuid?: string) => void;
  data: Data;
  setData: Updater<Data>;
  currentFormIndex: number;
}

const TableRow = React.memo(
  function TableRow({
    child,
    index,
    handleRefClick,
    data,
    setData,
    currentFormIndex,
  }: TableRowProps) {
    const type = child.type;
    const visibility = childVisibility(data, child);
    const info = [];

    if (type === "CheckBox" || type === "OneOf" || type === "Numeric") {
      if (type === "OneOf") {
        for (const option of child.options) {
          info.push([option.option, option.value]);
        }

        info.push(["newline"]);
      }

      if (type === "Numeric") {
        info.push(
          ["Min", child.min],
          ["Max", child.max],
          ["Step", child.step],
          ["newline"]
        );
      }

      if (child.defaults) {
        for (const def of child.defaults) {
          info.push([`DefaultId ${def.defaultId}`, def.value]);
        }

        if (type !== "CheckBox") {
          info.push(["newline"]);
        }
      }

      if (type === "CheckBox") {
        const def = /\bDefault: (Enabled|Disabled)/.exec(child.flags);
        if (def) {
          info.push(["Default", def[1] === "Enabled" ? "1" : "0"]);
        }

        const mfgDef = /MfgDefault: (Enabled|Disabled)/.exec(child.flags);
        if (mfgDef) {
          info.push(["MfgDefault", mfgDef[1] === "Enabled" ? "1" : "0"]);
        }

        if (def ?? mfgDef ?? child.defaults) {
          info.push(["newline"]);
        }
      }

      info.push(
        ["QuestionId", child.questionId],
        ["VarStoreId", child.varStoreId],
        ["VarStoreName", child.varStoreName],
        ["VarOffset", child.varOffset]
      );

      if (type !== "CheckBox") {
        info.push(["Size (bits)", child.size]);
      }
    }

    return (
      <tr className={s.memoRow}>
        <td
          className={type === "Ref" ? s.pointer : undefined}
          onClick={() => {
            if (type === "Ref") {
              handleRefClick(child.formId, child.targetFormSetGuid);
            }
          }}
        >
          {child.name}
        </td>
        <td>{type}</td>
        <td>
          <Tooltip label={visibility.explanation} multiline w={320}>
            <Badge color={visibilityColors[visibility.status]} variant="light">
              {visibility.label}
            </Badge>
          </Tooltip>
        </td>
        <td className={s.width}>
          {child.accessLevel !== null && (
            <TextInput
              value={child.accessLevel}
              onChange={(ev) => {
                const value = ev.target.value.toUpperCase();

                if (validateByteInput(value)) {
                  setData((draft) => {
                    draft.forms[currentFormIndex].children[index].accessLevel =
                      value;
                  });
                }
              }}
            />
          )}
        </td>
        <td className={s.width}>
          {child.failsafe !== null && (
            <TextInput
              value={child.failsafe}
              onChange={(ev) => {
                const value = ev.target.value.toUpperCase();

                if (validateByteInput(value)) {
                  setData((draft) => {
                    draft.forms[currentFormIndex].children[index].failsafe =
                      value;
                  });
                }
              }}
            />
          )}
        </td>
        <td className={s.width}>
          {child.optimal !== null && (
            <TextInput
              value={child.optimal}
              onChange={(ev) => {
                const value = ev.target.value.toUpperCase();

                if (validateByteInput(value)) {
                  setData((draft) => {
                    draft.forms[currentFormIndex].children[index].optimal =
                      value;
                  });
                }
              }}
            />
          )}
        </td>
        <td><ConditionDetails child={child} data={data} setData={setData} /></td>
        <td>
          <Spoiler
            transitionDuration={0}
            maxHeight={70}
            showLabel=".........."
            hideLabel="....."
          >
            <Stack>
              {child.description && (
                <div>
                  {child.description
                    .split("<br>")
                    .filter((line) => line !== "")
                    .map((line, index) => (
                      // Static, stateless text rows recomputed from `child`
                      // on every render - never reordered or animated, so
                      // an index key is safe here.
                      // eslint-disable-next-line react-x/no-array-index-key
                      <div key={index}>{line}</div>
                    ))}
                </div>
              )}
              {info.length > 0 && (
                <div>
                  {info.map((item, index) => (
                    // eslint-disable-next-line react-x/no-array-index-key -- static, stateless rows recomputed on every render
                    <div key={index} className={s.infoRow}>
                      {item[0] === "newline" ? (
                        <br />
                      ) : (
                        <>
                          <div>{item[0]}</div>
                          <div>{item[1]}</div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Stack>
          </Spoiler>
        </td>
      </tr>
    );
  },
  (oldProps: TableRowProps, newProps: TableRowProps) => {
    const oldChild =
      oldProps.data.forms[oldProps.currentFormIndex].children[oldProps.index];
    const newChild =
      newProps.data.forms[newProps.currentFormIndex].children[newProps.index];

    if (
      oldChild.accessLevel !== newChild.accessLevel ||
      oldChild.failsafe !== newChild.failsafe ||
      oldChild.optimal !== newChild.optimal
    ) {
      return false;
    }

    // The offset list itself is fixed at parse time; only a referenced
    // suppression's `active` flag can change between renders.
    const offsets = oldChild.conditions ?? oldChild.suppressIf ?? [];
    return offsets.every((offset) => {
      const wasActive = oldProps.data.suppressions.find(
        (suppression) => suppression.offset === offset,
      )?.active;
      const isActive = newProps.data.suppressions.find(
        (suppression) => suppression.offset === offset,
      )?.active;
      return wasActive === isActive;
    });
  }
);

export default TableRow;
