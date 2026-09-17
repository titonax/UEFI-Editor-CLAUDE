import { Alert, Badge, Button, Group, Stack, Table, Text, Tooltip } from "@mantine/core";
import type { AmiSingleFormSetPage, Data } from "../scripts/types";
import type { MenuTree, MenuTreeNode } from "../Navigation/menuTree";
import { movableNodeForPage } from "./tabPlacement";

const roleMeta = {
  hub: { label: "IFR navigation hub", color: "blue" },
  "direct-tab": { label: "Current top-level tab", color: "green" },
  descendant: { label: "Registered descendant", color: "violet" },
  "registered-only": { label: "Registered only", color: "gray" },
} as const;

const placementControls = {
  hub: {
    label: "Navigation hub",
    color: "blue",
    explanation: "The hub itself cannot be hidden through its own child Ref list.",
  },
  "direct-tab": {
    label: "Visible tab · hide/move",
    color: "green",
    explanation:
      "Move this existing Ref away from the Setup hub to remove it from the top-level tabs.",
  },
  descendant: {
    label: "Not a tab · promote/move",
    color: "violet",
    explanation:
      "Move this existing Ref to the Setup hub to make it a top-level tab, or choose another proven parent.",
  },
  "registered-only": {
    label: "No IFR Ref",
    color: "gray",
    explanation:
      "AMITSE registers this page, but no unique existing IFR Ref is available to move safely.",
  },
} as const;

interface SingleFormSetNavigationProps {
  data: Data;
  tree: MenuTree;
  onMovePage: (page: AmiSingleFormSetPage, node: MenuTreeNode) => void;
}

// The tab inventory of a single-FormSet hub layout: every page the IFR hub
// or the AMITSE table knows about, with its structural role and a control
// that opens the move dialog to promote or demote it.
export default function SingleFormSetNavigation({
  data,
  tree,
  onMovePage,
}: SingleFormSetNavigationProps) {
  const report = data.singleFormSetNavigation;
  if (!report || report.status === "not-applicable") return null;
  if (report.status !== "detected") {
    return (
      <Alert
        color={report.status === "ambiguous" ? "orange" : "gray"}
        title={
          report.status === "ambiguous"
            ? "Single-FormSet navigation — ambiguous"
            : "Single-FormSet navigation — unresolved"
        }
      >
        {report.reason}
      </Alert>
    );
  }

  const tabs = report.pages.filter((page) => page.role === "direct-tab");
  const registrations = report.pages.filter((page) => page.registeredInAmitse);
  const registeredNonTabs = registrations.filter((page) => page.role !== "direct-tab");
  return (
    <Alert
      color={report.confidence === "corroborated" ? "blue" : "cyan"}
      title="Single-FormSet navigation — IFR hub detected"
    >
      <Stack gap="xs">
        <Text size="sm">{report.reason}</Text>
        <Group gap="xs">
          <Badge color="blue">Hub {report.hubFormId}</Badge>
          <Badge color="green">{String(tabs.length)} current tabs</Badge>
          <Badge color="cyan">{String(registrations.length)} AMITSE pages</Badge>
          {registeredNonTabs.length > 0 && (
            <Badge color="gray">{String(registeredNonTabs.length)} registered non-tabs</Badge>
          )}
        </Group>
        <Table striped withColumnBorders>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Page</Table.Th>
              <Table.Th>Form Id</Table.Th>
              <Table.Th>IFR role</Table.Th>
              <Table.Th>AMITSE evidence</Table.Th>
              <Table.Th>Tab placement</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {report.pages.map((page) => {
              const role = roleMeta[page.role];
              const control = placementControls[page.role];
              const movableNode = movableNodeForPage(data, tree, page);
              return (
                <Table.Tr key={`${page.formSetGuid}:${page.formId}`}>
                  <Table.Td>{page.name}</Table.Td>
                  <Table.Td>{page.formId}</Table.Td>
                  <Table.Td>
                    <Badge color={role.color} variant="light">
                      {role.label}
                    </Badge>
                    {page.ifrReferenceOffset && (
                      <Text size="xs" c="dimmed" mt={3}>
                        Direct Ref {page.ifrReferenceOffset}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {page.registeredInAmitse ? (
                      <>
                        <Badge color="cyan" variant="outline">
                          Registered
                        </Badge>
                        <Text size="xs" c="dimmed" mt={3}>
                          {page.registrationOffsets.join(", ")}
                        </Text>
                      </>
                    ) : (
                      <Badge color="gray" variant="outline">
                        Not found
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={control.explanation} multiline w={340}>
                      <Button
                        size="compact-xs"
                        color={control.color}
                        variant={page.role === "direct-tab" ? "filled" : "light"}
                        disabled={page.role === "hub" || movableNode === undefined}
                        aria-label={
                          page.role === "direct-tab"
                            ? `Hide or relocate ${page.name} top-level tab`
                            : page.role === "descendant"
                              ? `Promote or relocate ${page.name} as top-level tab`
                              : control.label
                        }
                        onClick={() => {
                          if (movableNode) onMovePage(page, movableNode);
                        }}
                      >
                        {control.label}
                      </Button>
                    </Tooltip>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
        <Text size="xs" c="dimmed">
          Here, “visible as a tab” is structural. Use Visible tab · hide/move to
          relocate a direct hub Ref under another existing Form, or Not a tab ·
          promote/move to return an existing descendant Ref to the hub. The tree and
          this inventory update from the pending IFR graph. No FormSet or new menu is
          created, and AMITSE registration by itself never promotes a page.
        </Text>
      </Stack>
    </Alert>
  );
}
