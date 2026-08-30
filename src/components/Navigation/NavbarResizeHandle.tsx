import React from "react";
import {
  DEFAULT_NAVBAR_WIDTH,
  MAX_NAVBAR_WIDTH,
  MIN_NAVBAR_WIDTH,
} from "../../navbarWidth";
import s from "./NavbarResizeHandle.module.css";

interface NavbarResizeHandleProps {
  width: number;
  setWidth: (width: number) => void;
}

export default function NavbarResizeHandle({
  width,
  setWidth,
}: NavbarResizeHandleProps) {
  // Read via a ref inside the move handler instead of closing over `width`
  // directly, so a single pointer-down doesn't need to re-bind its handlers
  // on every width change mid-drag.
  const dragStart = React.useRef<{ pointerX: number; width: number } | null>(
    null,
  );

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = { pointerX: event.clientX, width };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragStart.current) {
      return;
    }
    const next =
      dragStart.current.width + (event.clientX - dragStart.current.pointerX);
    setWidth(Math.min(MAX_NAVBAR_WIDTH, Math.max(MIN_NAVBAR_WIDTH, next)));
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    event.currentTarget.releasePointerCapture(event.pointerId);
    dragStart.current = null;
  }

  return (
    <div
      className={s.handle}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the menu tree panel"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={() => {
        setWidth(DEFAULT_NAVBAR_WIDTH);
      }}
    />
  );
}
