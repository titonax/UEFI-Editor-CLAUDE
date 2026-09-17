// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NavigationResizer from "./NavigationResizer";

afterEach(cleanup);

function renderResizer() {
  const onChange = vi.fn();
  const onReset = vi.fn();
  render(
    <NavigationResizer
      width={360}
      minWidth={200}
      maxWidth={800}
      onChange={onChange}
      onReset={onReset}
    />,
  );
  const separator = screen.getByRole("separator", {
    name: "Resize BIOS menu tree",
  });
  // jsdom has no pointer capture; the handle only tracks a captured pointer.
  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  Object.assign(separator, {
    setPointerCapture,
    hasPointerCapture: () => true,
    releasePointerCapture,
  });
  return { separator, onChange, onReset, setPointerCapture, releasePointerCapture };
}

describe("NavigationResizer", () => {
  it("describes itself as a vertical separator with the current range", () => {
    const { separator } = renderResizer();

    expect(separator).toHaveAttribute("aria-orientation", "vertical");
    expect(separator).toHaveAttribute("aria-valuemin", "200");
    expect(separator).toHaveAttribute("aria-valuemax", "800");
    expect(separator).toHaveAttribute("aria-valuenow", "360");
    expect(separator).toHaveAttribute(
      "title",
      "Drag to resize the menu tree. Double-click to reset.",
    );
  });

  it("follows a captured pointer with its absolute X and locks the page cursor meanwhile", () => {
    const { separator, onChange, setPointerCapture, releasePointerCapture } =
      renderResizer();

    fireEvent(separator, new MouseEvent("pointerdown", { bubbles: true, clientX: 480 }));
    expect(setPointerCapture).toHaveBeenCalledOnce();
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    fireEvent(separator, new MouseEvent("pointermove", { bubbles: true, clientX: 520 }));
    fireEvent(separator, new MouseEvent("pointerup", { bubbles: true }));
    expect(onChange.mock.calls).toEqual([[480], [520]]);
    expect(releasePointerCapture).toHaveBeenCalledOnce();
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("ignores pointer movement that was never captured", () => {
    const { separator, onChange } = renderResizer();

    fireEvent(separator, new MouseEvent("pointermove", { bubbles: true, clientX: 520 }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("steps with the arrow keys and jumps to the range ends with Home and End", () => {
    const { separator, onChange } = renderResizer();

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    fireEvent.keyDown(separator, { key: "Home" });
    fireEvent.keyDown(separator, { key: "End" });
    fireEvent.keyDown(separator, { key: "Enter" });
    expect(onChange.mock.calls).toEqual([[384], [336], [200], [800]]);
  });

  it("resets on double-click", () => {
    const { separator, onReset } = renderResizer();

    fireEvent.doubleClick(separator);
    expect(onReset).toHaveBeenCalledOnce();
  });
});
