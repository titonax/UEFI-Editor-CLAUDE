import React from "react";
import { NAVIGATION_WIDTH_STEP } from "./navigationWidth";
import s from "./NavigationResizer.module.css";

interface NavigationResizerProps {
  width: number;
  minWidth: number;
  maxWidth: number;
  // Called with the wanted width; the owner clamps it to the viewport.
  onChange: (width: number) => void;
  onReset: () => void;
}

// While a drag is in progress the whole page shows the resize cursor and
// refuses text selection, so a pointer that outruns the 12px handle
// neither flickers nor starts highlighting the tree.
function useDragBodyStyles(dragging: boolean) {
  React.useEffect(() => {
    if (!dragging) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [dragging]);
}

function keyboardTarget(
  key: string,
  width: number,
  minWidth: number,
  maxWidth: number,
) {
  switch (key) {
    case "ArrowLeft":
      return width - NAVIGATION_WIDTH_STEP;
    case "ArrowRight":
      return width + NAVIGATION_WIDTH_STEP;
    case "Home":
      return minWidth;
    case "End":
      return maxWidth;
    default:
      return null;
  }
}

// The drag handle on the navbar's right edge: a focusable separator that
// also resizes from the keyboard and resets on double-click. The navbar
// starts at the viewport's left edge, so the pointer's absolute X *is* the
// wanted width - no drag-start bookkeeping, and a pointer that outruns the
// handle still lands exactly where it is.
export default function NavigationResizer({
  width,
  minWidth,
  maxWidth,
  onChange,
  onReset,
}: NavigationResizerProps) {
  const [dragging, setDragging] = React.useState(false);
  useDragBodyStyles(dragging);

  return (
    <button
      type="button"
      role="separator"
      aria-label="Resize BIOS menu tree"
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      title="Drag to resize the menu tree. Double-click to reset."
      className={dragging ? `${s.handle} ${s.dragging}` : s.handle}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        onChange(event.clientX);
      }}
      onPointerMove={(event) => {
        if (dragging && event.currentTarget.hasPointerCapture(event.pointerId)) {
          onChange(event.clientX);
        }
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        setDragging(false);
      }}
      onLostPointerCapture={() => {
        setDragging(false);
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const target = keyboardTarget(event.key, width, minWidth, maxWidth);
        if (target !== null) {
          event.preventDefault();
          onChange(target);
        }
      }}
    />
  );
}
