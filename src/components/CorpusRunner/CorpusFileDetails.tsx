import React from "react";
import s from "./CorpusRunner.module.css";
import { Alert, Badge, Button, Divider, Group, ScrollArea, SimpleGrid, Stack, Table, Text } from "@mantine/core";
import { IconDownload } from "@tabler/icons-react";
import { saveAs } from "file-saver";
import { type CorpusRunEntry } from "../scripts/corpusDashboard";
import { caseFilePath, caseFromEntry, serializeCase } from "../../knowledge/caseFromEntry";
import { fingerprintFieldLabels } from "../../knowledge/fingerprint";
import { classifyEntry } from "../../knowledge/corpusKnowledge";
import { knownCases } from "../../knowledge";
import { entryTotals, stageColor, tabOperationRows } from "./corpusRunnerFormat";

// The detail panel of one analysed image in the corpus runner.
export function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className={s.summary}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={700}>{value}</Text>
    </div>
  );
}


// Downloads this image's metadata as a firmware case file (see
// src/knowledge). The file holds the SHA-256, sizes, counts and stage
// outcomes only; no firmware byte is included and nothing leaves the browser.
export function AddCase({ entry }: { entry: CorpusRunEntry }) {
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);
  const verdict = classifyEntry(entry, knownCases);
  if (verdict.kind === "exact") {
    return (
      <Text size="xs" c="dimmed">
        This image is already the recorded case {verdict.case.id}.
      </Text>
    );
  }
  const add = () => {
    const result = caseFromEntry(entry);
    if (!result.ok) {
      setMessage({ ok: false, text: result.errors.join(" ") });
      return;
    }
    saveAs(
      new Blob([serializeCase(result.value)], { type: "application/json" }),
      `${result.value.id}.json`,
    );
    setMessage({
      ok: true,
      text: `Saved ${result.value.id}.json (metadata only). Add it to the repository as ${caseFilePath(result.value)} and run npm run cases:check.`,
    });
  };
  return (
    <Stack gap="xs">
      <Group gap="xs">
        <Button size="xs" variant="light" leftSection={<IconDownload size={14} />} onClick={add}>
          Add case
        </Button>
        <Text size="xs" c="dimmed">
          Downloads this image&apos;s metadata as a case file. No firmware is included.
        </Text>
      </Group>
      {message && (
        <Alert color={message.ok ? "teal" : "red"} p="xs">
          {message.text}
        </Alert>
      )}
    </Stack>
  );
}


// Why this image is similar to, or different from, the recorded cases: the
// closest case, the fields they agree on and the fields where they differ,
// with both values. It says where to look when an image is new; it is not a
// verdict on the image.
export function KnowledgeNote({ entry }: { entry: CorpusRunEntry }) {
  const verdict = classifyEntry(entry, knownCases);
  if (verdict.kind === "exact") return null;
  const nearest = verdict.kind === "similar" ? verdict : verdict.nearest;
  if (!nearest) {
    return (
      <Text size="xs" c="dimmed">
        No recorded case shares enough observed fields with this image to be compared.
      </Text>
    );
  }
  const label = (field: keyof typeof fingerprintFieldLabels) => fingerprintFieldLabels[field];
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">
        {`Closest recorded case: ${nearest.case.id} · ${String(Math.round(nearest.similarity * 100))}% over ${String(nearest.compared)} comparable field(s)`}
      </Text>
      {nearest.agreeing.length > 0 && (
        <Text size="xs" c="dimmed">
          {`Agree: ${nearest.agreeing.map(label).join(", ")}`}
        </Text>
      )}
      {nearest.differing.length > 0 && (
        <Text size="xs">
          {`Differ: ${nearest.differing.map((difference) => `${label(difference.field)} (${String(difference.image)} here, ${String(difference.recorded)} in the case)`).join("; ")}`}
        </Text>
      )}
      {verdict.kind === "novel" && nearest.blocking.length > 0 && (
        <Text size="xs" c="dimmed">
          {`Not called similar because it is built differently in: ${nearest.blocking.map(label).join(", ")}`}
        </Text>
      )}
    </Stack>
  );
}


export function FileDetails({ entry }: { entry: CorpusRunEntry }) {
  const report = entry.report;
  const totals = entryTotals(entry);
  return (
    <Stack gap="md">
      <Text size="xs" c="dimmed" className={s.hash}>
        SHA-256: {entry.sha256 || "not calculated"}
      </Text>
      <KnowledgeNote entry={entry} />
      <AddCase entry={entry} />
      <ScrollArea>
        <Table striped withColumnBorders className={s.detailsTable}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Stage</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Detail</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {entry.stages.map((stage) => (
              <Table.Tr key={stage.id}>
                <Table.Td>{stage.id}</Table.Td>
                <Table.Td>
                  <Badge variant="light" color={stageColor(stage.status)}>
                    {stage.status}
                  </Badge>
                </Table.Td>
                <Table.Td>{stage.detail}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>
      {entry.failureMessage && (
        <Alert
          color={entry.status === "unsupported" ? "gray" : "red"}
          title={entry.status === "unsupported" ? "not AMI Aptio" : "failed"}
        >
          {entry.failureMessage}
        </Alert>
      )}
      {entry.vendorGuess && (
        <Stack gap={4}>
          <Group gap="xs">
            <Badge variant="light" color="gray">
              Vendor guess: {entry.vendorGuess.label}
            </Badge>
          </Group>
          {entry.vendorGuess.evidence.length > 0 && (
            <Text size="xs" c="dimmed">
              Evidence: {entry.vendorGuess.evidence.join(", ")}
            </Text>
          )}
        </Stack>
      )}
      {entry.brand?.brand && (
        <Stack gap={4}>
          <Group gap="xs">
            <Badge variant="light" color="indigo">
              Manufacturer: {entry.brand.brand} ({entry.brand.basis})
            </Badge>
            {entry.brand.navigationOutcome !== "unmeasured" && (
              <Badge
                variant="light"
                color={entry.brand.navigationOutcome === "matches-prior" ? "green" : "yellow"}
              >
                Navigation {entry.brand.navigationOutcome}
              </Badge>
            )}
          </Group>
          {entry.brand.documentedSamples > 0 && (
            <Text size="xs" c="dimmed">
              {String(entry.brand.documentedSamples)} documented sample(s) for this brand.
            </Text>
          )}
        </Stack>
      )}
      {(entry.phoenixLegacy ?? entry.phoenixUefi) && (
        <Stack gap="xs">
          {entry.phoenixLegacy && (
            <>
              <Group gap="xs">
                <Badge variant="light" color="grape">
                  Phoenix {entry.phoenixLegacy.format === "phoenix-ffv" ? "FFV" : "module chain"}:{" "}
                  {String(entry.phoenixLegacy.modules.length)} module(s)
                </Badge>
                <Badge variant="light" color="gray">
                  build {entry.phoenixLegacy.buildCode || "?"} · {entry.phoenixLegacy.buildDate || "?"}
                </Badge>
              </Group>
              <Text size="xs" c="dimmed">
                Read-only inventory (offsets, sizes, compression); no module is decoded or
                edited. See docs/phoenix/README.md.
              </Text>
              {entry.phoenixLegacy.warnings.map((warning) => (
                <Text size="xs" c="orange" key={warning}>
                  {warning}
                </Text>
              ))}
              {entry.phoenixLegacy.modules.length > 0 && (
                <ScrollArea>
                  <Table striped withColumnBorders className={s.detailsTable}>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Module</Table.Th>
                        <Table.Th>Offset</Table.Th>
                        <Table.Th>Size</Table.Th>
                        <Table.Th>Compression</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {entry.phoenixLegacy.modules.map((module, index) => (
                        <Table.Tr key={`${module.name}:${String(index)}`}>
                          <Table.Td>{module.name}</Table.Td>
                          <Table.Td>0x{module.offset.toString(16).toUpperCase()}</Table.Td>
                          <Table.Td>{module.size}</Table.Td>
                          <Table.Td>{module.compression}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </ScrollArea>
              )}
            </>
          )}
          {entry.phoenixUefi && (
            <Stack gap={4}>
              <Group gap="xs">
                <Badge variant="light" color="grape">
                  Phoenix PDB provenance: {entry.phoenixUefi.debugModules.join(", ")}
                </Badge>
              </Group>
              <Text size="xs" c="dimmed">
                Module provenance, not a Setup-format verdict - a debug path never overrides
                independently verified AMI evidence.
              </Text>
            </Stack>
          )}
        </Stack>
      )}
      {report && (
        <>
          <Divider />
          <Stack gap="sm">
            <Group gap="xs">
              <Badge
                variant="light"
                color={report.navigation.status === "detected" ? "green" : "yellow"}
              >
                single-FormSet: {report.navigation.mechanism ?? report.navigation.status}
              </Badge>
              {report.rootVisibility && (
                <Badge
                  variant="light"
                  color={report.rootVisibility.status === "detected" ? "green" : "yellow"}
                >
                  root vector: {report.rootVisibility.status}
                </Badge>
              )}
              <Badge
                variant="light"
                color={entry.reconstructionComplete ? "blue" : "orange"}
              >
                provenance {entry.reconstructionComplete ? "complete" : "incomplete"}
              </Badge>
            </Group>
            <SimpleGrid cols={{ base: 2, sm: 4, lg: 7 }} spacing="xs">
              <Metric label="Forms" value={report.counts.forms} />
              <Metric label="FormSets" value={report.counts.formSets} />
              <Metric label="Refs" value={report.counts.refs} />
              <Metric label="Conditions" value={report.counts.conditions} />
              <Metric label="Direct tabs" value={report.navigation.directTabs} />
              <Metric label="Suppressed tabs" value={report.navigation.suppressedTabs} />
              <Metric label="Registered only" value={report.navigation.registeredOnly} />
            </SimpleGrid>
            {report.navigation.reason && (
              <Text size="xs" c="dimmed">
                Single-FormSet navigation: {report.navigation.status} — {report.navigation.reason}
              </Text>
            )}
            {report.rootVisibility && (
              <Text size="xs" c="dimmed">
                Root visibility: {report.rootVisibility.status} — {report.rootVisibility.reason}
              </Text>
            )}
            {report.tabOperations.length > 0 && (
              <ScrollArea>
                <Table striped withColumnBorders className={s.detailsTable}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Page</Table.Th>
                      <Table.Th>Operation</Table.Th>
                      <Table.Th>Availability</Table.Th>
                      <Table.Th>Reason</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {tabOperationRows(report.tabOperations).map((row, index) => (
                      <Table.Tr key={`${row.formId}:${row.kind}:${String(index)}`}>
                        <Table.Td>
                          {row.page}{" "}
                          <Text span c="dimmed" size="xs">
                            {row.formId}
                          </Text>
                        </Table.Td>
                        <Table.Td>{row.kind}</Table.Td>
                        <Table.Td>
                          <Badge color={row.result.available ? "green" : "gray"} variant="light">
                            {row.result.available ? "available" : "blocked"}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs">{row.result.reason}</Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            )}
            {totals.hide + totals.show === 0 && (
              <Text size="xs" c="dimmed">
                No Hide/Show operations are available for this image.
              </Text>
            )}
            <Alert color="gray" title="Full-image output remains blocked">
              {entry.reconstructionBlockers.join(" ")}
            </Alert>
          </Stack>
        </>
      )}
    </Stack>
  );
}

