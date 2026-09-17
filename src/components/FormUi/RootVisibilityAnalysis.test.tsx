// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { useImmer } from "use-immer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import RootVisibilityAnalysis from "./RootVisibilityAnalysis";
import type { AmiRootVisibilityReport, Data } from "../scripts/types";

function detectedReport(): AmiRootVisibilityReport {
  return {
    status: "detected",
    mechanism: "setup-pe32-root-byte-vector",
    confidence: "corroborated",
    reason: "Setup code consumes one Boolean byte per IFR FormSet.",
    vector: {
      bufferId: 68,
      offset: 0x9764,
      length: 2,
      codeReferenceOffset: 0x6d5,
      pageTableOffset: 0x961c,
      countEvidence: "immediate",
    },
    entries: [
      {
        rootIndex: 0,
        name: "Main",
        formId: "0x400",
        formSetGuid: "985EEE91-BCAC-4238-8778-57EFDC93F24E",
        value: 0,
        visible: false,
        bufferOffset: 0x9764,
      },
      {
        rootIndex: 1,
        name: "File",
        formId: "0x407",
        formSetGuid: "242F9DE3-DA59-4B0D-878D-898B4D463AEA",
        value: 1,
        visible: true,
        bufferOffset: 0x9765,
      },
    ],
  };
}

function makeData(rootVisibility: AmiRootVisibilityReport): Data {
  return {
    firmwareFamily: "aptio-iv",
    menu: [],
    forms: [],
    varStores: [],
    suppressions: [],
    rootVisibility,
    version: "test",
    hashes: { setupTxt: "", setupSct: "", amitseSct: "", setupdataBin: "", offsetChecksum: "" },
  };
}

function Harness({ initial }: { initial: Data }) {
  const [data, setData] = useImmer(initial);
  return (
    <MantineProvider>
      <RootVisibilityAnalysis data={data} setData={setData} />
      <div data-testid="edits">{JSON.stringify(data.rootVisibilityEdits ?? null)}</div>
    </MantineProvider>
  );
}

beforeAll(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
});

afterEach(cleanup);

describe("RootVisibilityAnalysis", () => {
  it("renders nothing without a report", () => {
    const { container } = render(
      <MantineProvider>
        <RootVisibilityAnalysis
          data={{ ...makeData(detectedReport()), rootVisibility: undefined }}
          setData={() => undefined}
        />
      </MantineProvider>,
    );
    expect(container.querySelector(".mantine-Alert-root")).toBeNull();
  });

  it("explains a single-FormSet or unresolved layout without a table", () => {
    render(
      <Harness
        initial={makeData({
          ...detectedReport(),
          status: "not-applicable",
          vector: undefined,
          entries: [],
          reason: "The HII uses one FormSet.",
        })}
      />,
    );
    expect(screen.getByText("Root visibility — single-FormSet layout")).toBeInTheDocument();
    expect(screen.getByText("The HII uses one FormSet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows the detected vector and records a reversible desired state", () => {
    render(<Harness initial={makeData(detectedReport())} />);

    expect(screen.getByText("Root visibility vector — code corroborated")).toBeInTheDocument();
    expect(screen.getByText("1 desired shown")).toBeInTheDocument();
    expect(screen.getByText("1 desired hidden")).toBeInTheDocument();
    expect(screen.getByText("Buffer 68 @ 0x9764")).toBeInTheDocument();
    expect(screen.queryByText("Pending change")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Desired root state for Main: hidden" }));

    expect(screen.getByText("2 desired shown")).toBeInTheDocument();
    expect(screen.getByText("1 pending")).toBeInTheDocument();
    expect(screen.getByText("Pending change")).toBeInTheDocument();
    expect(
      screen.getByText("Desired state differs from the original BIOS in 1 root."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Desired root state for Main: visible" })).toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId("edits").textContent ?? "null")).toEqual([
      expect.objectContaining({ rootIndex: 0, expected: 0, replacement: 1, bufferOffset: 0x9764 }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Reset root changes" }));

    expect(screen.queryByText("Pending change")).toBeNull();
    expect(screen.getByTestId("edits").textContent).toBe("null");
  });

  it("warns when the plan would hide every root", () => {
    render(<Harness initial={makeData(detectedReport())} />);

    fireEvent.click(screen.getByRole("button", { name: "Desired root state for File: visible" }));

    expect(screen.getByText(/hides every root FormSet/)).toBeInTheDocument();
  });
});
