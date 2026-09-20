import { Badge, Group, ScrollArea, SimpleGrid, Stack, Table, Tabs, Text, Title } from "@mantine/core";
import type {
  CorpusDashboardCohort,
  CorpusDashboardData,
  CorpusStageId,
  RecognitionBlocker,
} from "../scripts/corpusDashboard";
import s from "./CorpusRunner.module.css";

const stageLabels: Record<CorpusStageId, string> = {
  preflight: "Preflight",
  extraction: "Extraction",
  hii: "HII parsing",
  navigation: "Navigation",
  editability: "Editability",
  reconstruction: "Full-image reconstruction",
};

const blockerLabels: Record<RecognitionBlocker, string> = {
  reading: "Read input",
  preflight: "Preflight",
  extraction: "Extraction",
  hii: "HII parsing",
  navigation: "Navigation",
  none: "Navigation proven",
};

function fraction(value: number, total: number) {
  return `${String(value)} / ${String(total)}`;
}

function CohortTable({ cohorts }: { cohorts: CorpusDashboardCohort[] }) {
  return (
    <ScrollArea>
      <Table striped withColumnBorders className={s.dashboardTable}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Group</Table.Th>
            <Table.Th>Cases</Table.Th>
            <Table.Th>Extraction / cases</Table.Th>
            <Table.Th>Navigation / extracted</Table.Th>
            <Table.Th>HII edit / extracted</Table.Th>
            <Table.Th>Full image / extracted</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {cohorts.map((cohort) => (
            <Table.Tr key={cohort.label}>
              <Table.Td>{cohort.label}</Table.Td>
              <Table.Td>{cohort.cases}</Table.Td>
              <Table.Td>{fraction(cohort.extracted, cohort.cases)}</Table.Td>
              <Table.Td>{fraction(cohort.navigationResolved, cohort.extracted)}</Table.Td>
              <Table.Td>{fraction(cohort.hiiEditable, cohort.extracted)}</Table.Td>
              <Table.Td>{fraction(cohort.fullImageReady, cohort.extracted)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
}

// A fuller analytical read on a finished corpus run than the top-level
// summary tiles give: per-stage pass/warning/failed/blocked/not-run
// eligibility, which stage first blocked each distinct case, a rough
// failure taxonomy, and a per-cohort (family/IFR format/manufacturer/
// container/generation) breakdown of the same four capability rates. See
// corpusDashboard.ts for how each of these is computed.
export default function CorpusDashboard({ dashboard }: { dashboard: CorpusDashboardData }) {
  return (
    <Stack gap="md">
      <div>
        <Title order={4}>Compatibility by layer</Title>
        <Text size="sm" c="dimmed">
          {String(dashboard.completed)} of {String(dashboard.selected)} selected files
          analysed · {String(dashboard.uniqueCases)} distinct cases (SHA-256; unreadable
          files counted separately). Rates describe this selected corpus.
        </Text>
      </div>
      <Group gap="xs">
        <Badge variant="light">{String(dashboard.duplicateHashes)} duplicate hashes</Badge>
        <Badge variant="light" color="orange">
          {String(dashboard.unhashedCases)} without hash
        </Badge>
        <Badge variant="light" color="orange">
          {String(dashboard.unknownManufacturer)} unknown manufacturer
        </Badge>
      </Group>
      <ScrollArea>
        <Table striped withColumnBorders className={s.dashboardTable}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Layer</Table.Th>
              <Table.Th>Passed / eligible</Table.Th>
              <Table.Th>Warning</Table.Th>
              <Table.Th>Failed</Table.Th>
              <Table.Th>Blocked</Table.Th>
              <Table.Th>Not run</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {dashboard.stages.map((stage) => (
              <Table.Tr key={stage.id}>
                <Table.Td>{stageLabels[stage.id]}</Table.Td>
                <Table.Td>
                  {fraction(stage.passed, stage.eligible)}{" "}
                  {stage.eligible > 0 &&
                    `(${String(Math.round((stage.passed / stage.eligible) * 100))}%)`}
                </Table.Td>
                <Table.Td>{stage.warning}</Table.Td>
                <Table.Td>{stage.failed}</Table.Td>
                <Table.Td>{stage.blocked}</Table.Td>
                <Table.Td>{stage.notRun}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>
      <Text size="xs" c="dimmed">
        Eligibility: preflight uses all cases; extraction requires preflight; HII requires
        extraction; navigation, editability and reconstruction require HII. Later stages
        measure separate capabilities.
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
        <div className={s.summary}>
          <Text size="xs" c="dimmed">
            Extracted contexts with no HII edit
          </Text>
          <Text fw={700}>{dashboard.noHiiEdit}</Text>
        </div>
        <div className={s.summary}>
          <Text size="xs" c="dimmed">
            Extracted contexts with incomplete provenance
          </Text>
          <Text fw={700}>{dashboard.fullImageBlocked}</Text>
        </div>
      </SimpleGrid>
      <Title order={5}>First recognition blocker</Title>
      <Text size="xs" c="dimmed">
        One category per distinct case. Editability and full-image output are measured
        separately above.
      </Text>
      <ScrollArea>
        <Table striped withColumnBorders className={s.dashboardTable}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Category</Table.Th>
              <Table.Th>Cases / total</Table.Th>
              <Table.Th>Example files</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {dashboard.recognitionBlockers
              .filter((entry) => entry.cases > 0)
              .map((entry) => (
                <Table.Tr key={entry.category}>
                  <Table.Td>{blockerLabels[entry.category]}</Table.Td>
                  <Table.Td>{fraction(entry.cases, dashboard.uniqueCases)}</Table.Td>
                  <Table.Td className={s.fileName}>
                    {entry.fileNames.slice(0, 3).join(", ")}
                    {entry.fileNames.length > 3 ? " …" : ""}
                  </Table.Td>
                </Table.Tr>
              ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>
      {dashboard.failureCodes.length > 0 && (
        <>
          <Title order={5}>Failure taxonomy</Title>
          <ScrollArea>
            <Table striped withColumnBorders className={s.dashboardTable}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Blocked at</Table.Th>
                  <Table.Th>Code</Table.Th>
                  <Table.Th>Cases / total</Table.Th>
                  <Table.Th>Example reason</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {dashboard.failureCodes.map((entry) => (
                  <Table.Tr key={`${entry.stage}:${entry.code}`}>
                    <Table.Td>{blockerLabels[entry.stage]}</Table.Td>
                    <Table.Td>{entry.code}</Table.Td>
                    <Table.Td>{fraction(entry.cases, dashboard.uniqueCases)}</Table.Td>
                    <Table.Td className={s.fileName}>{entry.example}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </>
      )}
      <Title order={5}>Distribution of cases</Title>
      <Tabs defaultValue="family">
        <Tabs.List>
          <Tabs.Tab value="family">Firmware family</Tabs.Tab>
          <Tabs.Tab value="ifr">IFR format</Tabs.Tab>
          <Tabs.Tab value="manufacturer">Manufacturer</Tabs.Tab>
          <Tabs.Tab value="container">Container</Tabs.Tab>
          <Tabs.Tab value="generation">Aptio generation</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="family" pt="sm">
          <CohortTable cohorts={dashboard.families} />
        </Tabs.Panel>
        <Tabs.Panel value="ifr" pt="sm">
          <CohortTable cohorts={dashboard.ifrFormats} />
        </Tabs.Panel>
        <Tabs.Panel value="manufacturer" pt="sm">
          <CohortTable cohorts={dashboard.manufacturers} />
        </Tabs.Panel>
        <Tabs.Panel value="container" pt="sm">
          <CohortTable cohorts={dashboard.containers} />
        </Tabs.Panel>
        <Tabs.Panel value="generation" pt="sm">
          <CohortTable cohorts={dashboard.generations} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
