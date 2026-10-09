// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Footer from "./Footer";
import { useDataChangeQueue } from "../ChangeQueue/useDataChangeQueue";
import type { PopulatedFiles } from "../FileUploads/fileModel";
import { parseData } from "../scripts/ifrParser";
import { buildFixtureFiles } from "../scripts/testFixtures";
import type { AptioIvArtifacts } from "../scripts/aptioIvExtractor";
import type { Data } from "../scripts/types";

beforeAll(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});
afterEach(cleanup);

function Harness({ files, data }: { files: PopulatedFiles; data: Data }) {
  const queue = useDataChangeQueue(data);
  return (
    <MantineProvider>
      <button
        type="button"
        onClick={() => {
          queue.enqueueData((draft) => {
            draft.suppressions[0].active = false;
          });
        }}
      >
        stage a change
      </button>
      <button
        type="button"
        onClick={() => {
          queue.apply();
        }}
      >
        apply the queue
      </button>
      <Footer
        files={files}
        data={queue.previewData}
        appliedData={queue.appliedData}
        changeQueue={queue}
        setData={queue.enqueueData}
        currentFormIndex={-1}
      />
    </MantineProvider>
  );
}

async function fromImage() {
  const files = await buildFixtureFiles();
  const artifacts = {
    provenance: { rootBufferId: 0, sourceSize: 0, buffers: [], artifacts: [] },
    selectedArtifactSetId: "set",
  } as unknown as AptioIvArtifacts;
  const withSource: PopulatedFiles = { ...files, firmwareSource: { fileName: "board.rom", artifacts, generation: "unresolved" } };
  return { files, withSource, data: await parseData(withSource) };
}

describe("Footer", () => {
  it("offers the firmware image only for a session opened from a complete image, and only for an applied plan", async () => {
    const { withSource, data } = await fromImage();
    render(<Harness files={withSource} data={data} />);

    const button = screen.getByRole("button", { name: /Firmware image/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Apply the change queue before checking the firmware output");

    fireEvent.click(screen.getByRole("button", { name: "stage a change" }));
    expect(screen.getByRole("button", { name: /Firmware image/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "apply the queue" }));

    expect(screen.getByRole("button", { name: /Firmware image/ })).toBeEnabled();
  });

  it("points a session from a complete image at the firmware image instead of loose files", async () => {
    const { withSource, data } = await fromImage();
    render(<Harness files={withSource} data={data} />);
    fireEvent.click(screen.getByRole("button", { name: "stage a change" }));
    fireEvent.click(screen.getByRole("button", { name: "apply the queue" }));

    const loose = screen.getByRole("button", { name: /UEFI files/ });

    expect(loose).toBeDisabled();
    expect(loose.getAttribute("title")).toMatch(/Firmware image/);
  });

  it("has no firmware image button for the manual four-file mode", async () => {
    const { files, data } = await fromImage();
    render(<Harness files={files} data={data} />);

    expect(screen.queryByRole("button", { name: /Firmware image/ })).not.toBeInTheDocument();
  });
});
