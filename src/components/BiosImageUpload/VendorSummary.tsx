import { Alert, Badge, Group, Table, Text } from "@mantine/core";
import { type AmiFirmwareImageReport, type FirmwareVendorGuess } from "../scripts/amiFirmwareImage";
import { containerLabel, offsets, vendorSummaryColor } from "./biosImageLabels";

// The vendor and brand lead card of the firmware upload screen.
// The non-AMI counterpart to the AMI generation/Setup-profile panel below:
// this editor only ever parses/edits AMI Aptio HII, so a definitively
// non-AMI image gets its vendor guess and outer-container evidence instead
// of AMI-specific fields (Setup FFS, AMITSE FFS, $SPF, HII Forms layout)
// that were never going to be found in it.
export function VendorSummary({
  report,
  vendorGuess,
}: {
  report: AmiFirmwareImageReport;
  vendorGuess: FirmwareVendorGuess;
}) {
  return (
    <>
      <Alert color={vendorSummaryColor(vendorGuess.family)} title={vendorGuess.label}>
        This editor only parses and edits AMI Aptio HII. This image was identified as{" "}
        {vendorGuess.label} from its own byte signatures - nothing below is parsed any
        further.
      </Alert>
      <Group gap="xs">
        <Badge variant="light">{containerLabel(report.container)}</Badge>
      </Group>
      {vendorGuess.evidence.length > 0 && (
        <Text size="xs" c="dimmed">
          Evidence: {vendorGuess.evidence.join(", ")}
        </Text>
      )}
      <Table striped withColumnBorders>
        <Table.Tbody>
          <Table.Tr>
            <Table.Th>Image size</Table.Th>
            <Table.Td>{report.size.toLocaleString()} bytes</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Th>Intel descriptor</Table.Th>
            <Table.Td>{report.intelDescriptor ? "Present" : "Not detected"}</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Th>Firmware volumes</Table.Th>
            <Table.Td>{offsets(report.firmwareVolumes)}</Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>
    </>
  );
}
