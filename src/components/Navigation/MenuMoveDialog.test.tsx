// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import React from "react";
import { useImmer } from "use-immer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import MenuMoveDialog from "./MenuMoveDialog";
import { buildMenuTree, type MenuTreeNode } from "./menuTree";
import { buildMoveFixture } from "../scripts/testFixtures";
import type { Data } from "../scripts/types";

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join("");
}

// Typed as possibly-undefined on purpose: after the move the source root
// has no children any more (a plain index read would be narrowed to a
// present node by assignment).
function firstChild(nodes: MenuTreeNode[]): MenuTreeNode | undefined {
  return nodes[0];
}

function Harness({
  initial,
  setupSct,
  onClose,
}: {
  initial: Data;
  setupSct: string;
  onClose: () => void;
}) {
  const [data, setData] = useImmer(initial);
  // Mirrors Navigation: the dialog is unmounted on close, and it only ever
  // renders for a node that exists in the current tree.
  const [open, setOpen] = React.useState(true);
  const tree = React.useMemo(() => buildMenuTree(data), [data]);
  const node = firstChild(tree.roots[0].children);
  return (
    <MantineProvider>
      {open && node && (
        <MenuMoveDialog
          data={data}
          tree={tree}
          node={node}
          opened
          originalSetupSct={setupSct}
          setData={setData}
          onClose={() => {
            setOpen(false);
            onClose();
          }}
        />
      )}
      <div data-testid="children">
        {data.forms.map((form) => form.children.length).join(",")}
      </div>
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

describe("MenuMoveDialog", () => {
  it("lists every Form with its verdict and moves the Ref to a safe destination", async () => {
    const { bytes, data } = buildMoveFixture({ explicitTargetGuid: true });
    const onClose = vi.fn();
    render(<Harness initial={data} setupSct={toHex(bytes)} onClose={onClose} />);

    expect(screen.getByText("Move HII menu")).toBeInTheDocument();
    expect(screen.getByText("Go to Sub")).toBeInTheDocument();
    expect(screen.getByText("Current parent: Main")).toBeInTheDocument();
    expect(screen.getByText("1 safe destination")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move menu" })).toBeDisabled();

    fireEvent.click(screen.getByPlaceholderText("Choose the new parent menu"));
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Unavailable · Main · 0x1 · Setup A · visible · no incoming Ref — The Ref is already in this Form.",
      "Unavailable · Sub · 0x3 · Setup A · visible — Moving this Ref there would create a cycle in the HII menu graph.",
      "Safe across packages · Other · 0x2 · Setup B · visible · no incoming Ref",
    ]);
    expect(options[0]).toHaveAttribute("data-combobox-disabled", "true");
    expect(options[2]).not.toHaveAttribute("data-combobox-disabled");

    fireEvent.click(options[2]);
    expect(screen.getByText("Validated destination")).toBeInTheDocument();
    expect(
      screen.getByText("Safe fixed-size move; Forms Package lengths will be rebalanced."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Move menu" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByTestId("children").textContent).toBe("0,0,1");
  });

  it("counts destinations that would need REF3 conversion", () => {
    const { bytes, data } = buildMoveFixture();
    render(<Harness initial={data} setupSct={toHex(bytes)} onClose={vi.fn()} />);

    expect(
      screen.getByText("0 safe destinations · 1 require REF3 conversion"),
    ).toBeInTheDocument();
  });
});
