// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Header from "./Header";
import { buildMenuTree } from "../Navigation/menuTree";
import { buildMoveFixture } from "../scripts/testFixtures";
import { TOP_LEVEL_MENU_VIEW } from "../../formNavigation";

beforeAll(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
});

afterEach(cleanup);

describe("Header", () => {
  it("names the loaded firmware while the top-level menu is shown", () => {
    const tree = buildMenuTree(buildMoveFixture().data);
    render(
      <MantineProvider>
        <Header
          tree={tree}
          fileName="ROG-STRIX-Z390-E-GAMING.CAP"
          currentFormIndex={TOP_LEVEL_MENU_VIEW}
          setCurrentFormIndex={vi.fn()}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Loaded firmware")).toBeInTheDocument();
    expect(screen.getByText("ROG-STRIX-Z390-E-GAMING.CAP")).toBeInTheDocument();
    expect(screen.queryByText(">")).not.toBeInTheDocument();
  });

  it("adds the breadcrumb of the open page and navigates back through it", () => {
    const { data } = buildMoveFixture();
    const tree = buildMenuTree(data);
    const setCurrentFormIndex = vi.fn();
    render(
      <MantineProvider>
        <Header
          tree={tree}
          fileName="Setup.sct"
          currentFormIndex={1}
          setCurrentFormIndex={setCurrentFormIndex}
        />
      </MantineProvider>,
    );

    expect(screen.getByText("Setup.sct")).toBeInTheDocument();
    expect(screen.getByText("Go to Sub")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Main"));
    expect(setCurrentFormIndex).toHaveBeenCalledWith(0);
  });
});
