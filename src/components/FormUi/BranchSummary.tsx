import { Badge, Group, Stack, Text, Tooltip } from "@mantine/core";
import type { ConditionSource, VisibilityStatus } from "../scripts/types";
import type { FormBranchVisibility } from "../scripts/visibility";
import type { MenuProfile, MenuTreeNode } from "../Navigation/menuTree";
import { visibilityColors } from "./visibilityColors";
import s from "./FormUi.module.css";

function summaryBadges(counts: Record<VisibilityStatus, number>) {
  return (
    <>
      <Badge color="green">{counts.visible} ungated</Badge>
      <Badge color="red">{counts.hidden} hidden / affected</Badge>
      <Badge color="orange">
        {counts.conditional} unavailable / affected
      </Badge>
      {counts.orphaned > 0 && (
        <Badge color="red">{counts.orphaned} orphaned</Badge>
      )}
      {counts.broken > 0 && (
        <Badge color="pink">{counts.broken} broken</Badge>
      )}
      {counts.unknown > 0 && (
        <Badge color="gray">{counts.unknown} unresolved</Badge>
      )}
    </>
  );
}

function sourceBadges(counts: Record<ConditionSource, number>) {
  return (
    <>
      {counts.hardware > 0 && (
        <Badge color="yellow" variant="outline">
          {counts.hardware} HW capability
        </Badge>
      )}
      {counts.access > 0 && (
        <Badge color="violet" variant="outline">
          {counts.access} access policy
        </Badge>
      )}
      {counts.ui > 0 && (
        <Badge color="cyan" variant="outline">
          {counts.ui} UI state
        </Badge>
      )}
      {counts.setup > 0 && (
        <Badge color="blue" variant="outline">
          {counts.setup} Setup value
        </Badge>
      )}
      {counts.runtime > 0 && (
        <Badge color="orange" variant="outline">
          {counts.runtime} other runtime
        </Badge>
      )}
    </>
  );
}

interface BranchSummaryProps {
  pageNode: MenuTreeNode;
  activeProfile: MenuProfile | undefined;
  pageStatus: VisibilityStatus;
  visibilitySummary: FormBranchVisibility;
}

export default function BranchSummary({
  pageNode,
  activeProfile,
  pageStatus,
  visibilitySummary,
}: BranchSummaryProps) {
  return (
    <Stack gap={4} className={s.visibilitySummary}>
      <Group gap="xs">
        <Text size="sm" fw={600}>Selected path:</Text>
        <Tooltip
          label={pageNode.conditionSummary ?? pageNode.reachabilityLabel}
          multiline
          w={420}
        >
          <Badge
            color={pageNode.reachability === "detached" ? "gray" : "blue"}
            variant="light"
          >
            {pageNode.reachabilityLabel}
          </Badge>
        </Tooltip>
        {activeProfile && (
          <Tooltip label={activeProfile.evidence.join(" ")} multiline w={460}>
            <Badge
              color={
                activeProfile.assessment === "probable-live"
                  ? "green"
                  : activeProfile.assessment === "probable-fallback"
                    ? "orange"
                    : "gray"
              }
              variant="outline"
            >
              {activeProfile.label}
            </Badge>
          </Tooltip>
        )}
        {(pageStatus === "hidden" || pageStatus === "conditional") && (
          <Tooltip label={pageNode.conditionSummary} multiline w={420}>
            <Badge color={visibilityColors[pageStatus]} variant="light">
              {pageNode.statusLabel}
            </Badge>
          </Tooltip>
        )}
        {pageNode.hardwareDependent && (
          <Badge color="yellow" variant="outline">HW capability</Badge>
        )}
        {pageNode.accessDependent && (
          <Badge color="violet" variant="outline">Access policy</Badge>
        )}
        {pageNode.uiStateDependent && (
          <Badge color="cyan" variant="outline">AMI UI state</Badge>
        )}
      </Group>
      <Group gap="xs" wrap="nowrap">
        <Text size="sm" fw={600}>Parentage:</Text>
        <Tooltip
          label={`${String(pageNode.incomingReferenceCount)} incoming IFR Ref(s); ${String(pageNode.outgoingReferenceCount)} outgoing IFR Ref(s).`}
        >
          <Text size="xs" c="dimmed">
            {pageNode.parentageLabel}
          </Text>
        </Tooltip>
      </Group>
      <Group gap="xs">
        <Text size="sm" fw={600}>This page:</Text>
        {summaryBadges(visibilitySummary.direct)}
        {sourceBadges(visibilitySummary.directSources)}
      </Group>
      <Group gap="xs">
        <Tooltip label="Includes controls and Ref targets in every nested page">
          <Text size="sm" fw={600}>Whole branch:</Text>
        </Tooltip>
        {summaryBadges(visibilitySummary.branch)}
        {sourceBadges(visibilitySummary.branchSources)}
        <Text size="xs" c="dimmed">
          {visibilitySummary.descendantForms} nested pages
        </Text>
      </Group>
    </Stack>
  );
}
