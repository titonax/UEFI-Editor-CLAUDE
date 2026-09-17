// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import SingleFormSetNavigation from "./SingleFormSetNavigation";
import { movableNodeForPage } from "./tabPlacement";
import { buildMenuTree } from "../Navigation/menuTree";
import {
  inspectSingleFormSetNavigation,
  singleFormSetHubMenu,
} from "../scripts/singleFormSetNavigation";
import type { Data, Form, Menu, RefPrompt } from "../scripts/types";

const GUID = "7B59104A-C00D-4158-87FF-F04D6396A915";

function makeRef(overrides: Partial<RefPrompt>): RefPrompt {
  return {
    name: "Go to page",
    description: "",
    type: "Ref",
    questionId: "0x0001",
    varStoreId: "0x0001",
    formId: "0x2",
    formIdOffset: "0x0",
    pageId: null,
    accessLevel: null,
    failsafe: null,
    optimal: null,
    offsets: null,
    sctOffset: "0x0",
    ...overrides,
  };
}

function makeForm(overrides: Partial<Form>): Form {
  return {
    name: "A form",
    type: "Form",
    formId: "0x1",
    formSetGuid: GUID,
    referencedIn: [],
    children: [],
    endOffset: "0x0",
    ...overrides,
  };
}

// Setup hub with two tabs; Security is registered in AMITSE but hangs off
// Main; Exit is registered but reached by nothing.
function hubGraph() {
  const forms = [
    makeForm({
      name: "Setup",
      formId: "0x2711",
      children: [
        makeRef({ name: "Main", formId: "0x2714", sctOffset: "0x44953", questionId: "0x1" }),
        makeRef({ name: "Boot", formId: "0x271F", sctOffset: "0x44962", questionId: "0x2" }),
      ],
    }),
    makeForm({
      name: "Main",
      formId: "0x2714",
      referencedIn: ["0x2711"],
      children: [makeRef({ name: "Security", formId: "0x2716", sctOffset: "0x45000", questionId: "0x3" })],
    }),
    makeForm({ name: "Boot", formId: "0x271F", referencedIn: ["0x2711"] }),
    makeForm({ name: "Security", formId: "0x2716", referencedIn: ["0x2714"] }),
    makeForm({ name: "Exit", formId: "0x2722" }),
  ];
  const registrations: Menu = forms.map((form, index) => ({
    name: form.name,
    formId: form.formId,
    formSetGuid: GUID,
    offset: `0x${(0x100 + index * 0x20).toString(16).toUpperCase()}`,
    source: "amitse",
  }));
  const formSetRoots: Menu = [
    { name: "Setup", formId: "0x2711", offset: null, formSetGuid: GUID, source: "formset" },
  ];
  return { forms, registrations, formSetRoots };
}

function hubData(): Data {
  const { forms, registrations, formSetRoots } = hubGraph();
  const report = inspectSingleFormSetNavigation(formSetRoots, forms, registrations);
  return {
    firmwareFamily: "aptio-iv",
    menu: singleFormSetHubMenu(report),
    formSetRoots,
    forms,
    varStores: [],
    suppressions: [],
    singleFormSetNavigation: report,
    version: "test",
    hashes: { setupTxt: "", setupSct: "", amitseSct: "", setupdataBin: "", offsetChecksum: "" },
  };
}

beforeAll(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
});

afterEach(cleanup);

describe("SingleFormSetNavigation", () => {
  it("separates direct IFR tabs from registered descendants and offers the right control", () => {
    const data = hubData();
    const tree = buildMenuTree(data);
    const onMovePage = vi.fn();
    render(
      <MantineProvider>
        <SingleFormSetNavigation data={data} tree={tree} onMovePage={onMovePage} />
      </MantineProvider>,
    );

    expect(screen.getByText("Single-FormSet navigation — IFR hub detected")).toBeInTheDocument();
    expect(screen.getByText("Hub 0x2711")).toBeInTheDocument();
    expect(screen.getByText("2 current tabs")).toBeInTheDocument();
    expect(screen.getByText("5 AMITSE pages")).toBeInTheDocument();
    expect(screen.getByText("3 registered non-tabs")).toBeInTheDocument();
    expect(screen.getAllByText("Current top-level tab")).toHaveLength(2);
    expect(screen.getByText("Registered descendant")).toBeInTheDocument();
    expect(screen.getByText("Registered only")).toBeInTheDocument();
    expect(screen.getByText("Direct Ref 0x44953")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Navigation hub" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "No IFR Ref" })).toBeDisabled();
    const promote = screen.getByRole("button", { name: "Promote or relocate Security as top-level tab" });
    expect(promote).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Hide or relocate Main top-level tab" }));
    expect(onMovePage).toHaveBeenCalledOnce();
    const [page, node] = onMovePage.mock.calls[0] as [{ formId: string }, { sourceFormIndex: number; refChildIndex: number }];
    expect(page.formId).toBe("0x2714");
    expect(node).toMatchObject({ sourceFormIndex: 0, refChildIndex: 0 });

    fireEvent.click(promote);
    const [, securityNode] = onMovePage.mock.calls[1] as [unknown, { sourceFormIndex: number; refChildIndex: number }];
    expect(securityNode).toMatchObject({ sourceFormIndex: 1, refChildIndex: 0 });
  });

  it("explains an ambiguous or unresolved layout instead of a table", () => {
    const data = hubData();
    data.singleFormSetNavigation = {
      status: "ambiguous",
      mechanism: "single-formset-ifr-hub",
      confidence: "unresolved",
      reason: "Direct hub Ref 0x9 has no target Form.",
      pages: [],
    };
    render(
      <MantineProvider>
        <SingleFormSetNavigation data={data} tree={buildMenuTree(data)} onMovePage={vi.fn()} />
      </MantineProvider>,
    );

    expect(screen.getByText("Single-FormSet navigation — ambiguous")).toBeInTheDocument();
    expect(screen.getByText("Direct hub Ref 0x9 has no target Form.")).toBeInTheDocument();
  });

  it("renders nothing for a multi-FormSet firmware", () => {
    const data = hubData();
    data.singleFormSetNavigation = {
      status: "not-applicable",
      mechanism: "single-formset-ifr-hub",
      confidence: "unresolved",
      reason: "several",
      pages: [],
    };
    const { container } = render(
      <MantineProvider>
        <SingleFormSetNavigation data={data} tree={buildMenuTree(data)} onMovePage={vi.fn()} />
      </MantineProvider>,
    );

    expect(container.querySelector("table")).toBeNull();
  });
});

describe("movableNodeForPage", () => {
  it("gives no node when several Refs could be meant", () => {
    const data = hubData();
    const { registrations } = hubGraph();
    // A second Ref to Security from Boot makes the descendant's parent ambiguous.
    data.forms[2].children.push(makeRef({ name: "Security", formId: "0x2716", sctOffset: "0x46000", questionId: "0x4" }));
    data.forms[3].referencedIn.push("0x271F");
    const report = inspectSingleFormSetNavigation(data.formSetRoots ?? [], data.forms, registrations);
    data.singleFormSetNavigation = report;
    const tree = buildMenuTree(data);
    const security = report.pages.find((page) => page.formId === "0x2716");
    if (!security) throw new Error("Security page missing");

    expect(security.parentFormIds).toEqual(["0x2714", "0x271F"]);
    expect(movableNodeForPage(data, tree, security)).toBeUndefined();
  });
});
