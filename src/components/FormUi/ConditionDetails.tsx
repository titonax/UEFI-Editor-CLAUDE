import { Badge, Button, Group, Stack, Text, Tooltip } from "@mantine/core";
import type { Updater } from "use-immer";
import type { ConditionSource, Data, FormChildren } from "../scripts/types";
import { conditionsForChild } from "../scripts/visibility";
import s from "./FormUi.module.css";

const conditionSourceMeta: Record<
  ConditionSource,
  { label: string; color: string; explanation: string }
> = {
  setup: {
    label: "Setup value",
    color: "blue",
    explanation: "The condition reads a user-configurable Setup value.",
  },
  hardware: {
    label: "HW capability",
    color: "yellow",
    explanation:
      "The condition reads a firmware-populated platform or CPU capability flag.",
  },
  access: {
    label: "Access policy",
    color: "violet",
    explanation:
      "The condition depends on AMI user/admin access or security state, not hardware.",
  },
  ui: {
    label: "AMI UI state",
    color: "cyan",
    explanation: "The condition depends on AMITSE navigation or UI state.",
  },
  runtime: {
    label: "Runtime variable",
    color: "orange",
    explanation:
      "The variable is evaluated at runtime but is not classified as hardware, access, or UI state.",
  },
  constant: {
    label: "Constant",
    color: "gray",
    explanation: "The IFR expression has a constant result.",
  },
  unknown: {
    label: "Unknown source",
    color: "gray",
    explanation: "The variable source could not be resolved.",
  },
};

export default function ConditionDetails({
  child,
  data,
  setData,
}: {
  child: FormChildren;
  data: Data;
  setData: Updater<Data>;
}) {
  const conditions = conditionsForChild(data, child);
  if (conditions.length === 0 && child.accessLevel === null) {
    return <Text size="xs" c="dimmed">No condition</Text>;
  }

  return (
    <Stack gap={5} className={s.conditionList}>
      {conditions.map((condition) => {
        const index = data.suppressions.indexOf(condition);
        const kind = condition.kind ?? "SuppressIf";
        const source = condition.source ?? "unknown";
        const sourceMeta = conditionSourceMeta[source];
        return (
          <div key={condition.offset} className={s.conditionCard}>
            <Group gap={5} justify="space-between" wrap="nowrap">
              <Group gap={5} wrap="wrap">
                <Badge size="xs" color={kind === "SuppressIf" ? "red" : "orange"}>
                  {kind}
                </Badge>
                <Tooltip
                  label={
                    `${sourceMeta.explanation}${
                      condition.varStoreNames?.length
                        ? ` VarStore: ${condition.varStoreNames.join(", ")}.`
                        : ""
                    }`
                  }
                  multiline
                  w={340}
                >
                  <Badge
                    size="xs"
                    variant="outline"
                    color={sourceMeta.color}
                  >
                    {sourceMeta.label}
                  </Badge>
                </Tooltip>
              </Group>
              {kind === "SuppressIf" ? (
                <Tooltip label="Disable this suppression in the generated change set">
                  <Button
                    size="compact-xs"
                    color={condition.active ? "red" : "green"}
                    variant={condition.active ? "light" : "filled"}
                    onClick={() => {
                      if (index < 0) {
                        return;
                      }
                      setData((draft) => {
                        draft.suppressions[index].active = !condition.active;
                      });
                    }}
                  >
                    {condition.active ? "Force visible" : "Visibility forced"}
                  </Button>
                </Tooltip>
              ) : (
                <Badge size="xs" color="gray" variant="light">Read-only</Badge>
              )}
            </Group>
            <Text size="xs" mt={4} className={s.conditionExpression}>
              {condition.expression ?? `Condition at ${condition.offset}`}
            </Text>
            <Text size="xs" c="dimmed" mt={3}>
              {kind === "SuppressIf"
                ? "This expression hides the item when true."
                : "This expression disables or grays the item when true."}
              {" "}IFR condition offset: {condition.offset}
            </Text>
            {condition.varStoreNames?.length ? (
              <Text size="xs" c="dimmed" mt={3}>
                VarStore: {condition.varStoreNames.join(", ")}
              </Text>
            ) : null}
          </div>
        );
      })}
      {child.accessLevel !== null ? (
        <div className={s.conditionCard}>
          <Badge size="xs" color="gray" variant="outline">
            AMI access policy
          </Badge>
          <Text size="xs" mt={4} className={s.conditionExpression}>
            SetupData AccessLevel == 0x{child.accessLevel}
          </Text>
          <Text size="xs" c="dimmed" mt={3}>
            Shown as evidence only; this byte is not classified as hidden or
            visible without model-specific proof.
          </Text>
        </div>
      ) : null}
    </Stack>
  );
}
