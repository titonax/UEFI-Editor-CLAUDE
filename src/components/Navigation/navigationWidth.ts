// The menu tree's width model: the responsive defaults the fixed navbar
// had before it became resizable, the room the content pane always keeps,
// and the persisted user choice. Everything is a pure function of the
// viewport width so each rule is unit-testable on its own; only the two
// storage helpers touch localStorage, which may be missing or throwing
// (private browsing, storage disabled) without the layout caring.

export const MIN_NAVIGATION_WIDTH = 200;
export const MAX_NAVIGATION_WIDTH = 1200;
export const MIN_CONTENT_WIDTH = 360;
export const NAVIGATION_WIDTH_STEP = 24;
export const NAVIGATION_WIDTH_STORAGE_KEY = "uefi-editor.navigation-width";

// Mantine's xl / lg / md / sm breakpoints.
export function defaultNavigationWidth(viewportWidth: number) {
  if (viewportWidth >= 1200) return 360;
  if (viewportWidth >= 992) return 320;
  if (viewportWidth >= 768) return 280;
  if (viewportWidth >= 576) return 240;
  return 220;
}

// The widest the tree may get on this viewport: the content pane keeps at
// least MIN_CONTENT_WIDTH, but the tree never drops below its own minimum
// even on a viewport too narrow for both.
export function maxNavigationWidth(viewportWidth: number) {
  return Math.max(
    MIN_NAVIGATION_WIDTH,
    Math.min(MAX_NAVIGATION_WIDTH, viewportWidth - MIN_CONTENT_WIDTH),
  );
}

export function clampNavigationWidth(width: number, viewportWidth: number) {
  const rounded = Number.isFinite(width)
    ? Math.round(width)
    : defaultNavigationWidth(viewportWidth);
  return Math.min(
    Math.max(rounded, MIN_NAVIGATION_WIDTH),
    maxNavigationWidth(viewportWidth),
  );
}

// A previously stored width (the raw localStorage string, or null when
// nothing was stored), clamped for the current viewport.
export function storedNavigationWidth(
  stored: string | null,
  viewportWidth: number,
) {
  if (stored === null || stored.trim().length === 0) {
    return defaultNavigationWidth(viewportWidth);
  }
  return clampNavigationWidth(Number(stored), viewportWidth);
}

export function readStoredNavigationWidth(viewportWidth: number) {
  try {
    return storedNavigationWidth(
      localStorage.getItem(NAVIGATION_WIDTH_STORAGE_KEY),
      viewportWidth,
    );
  } catch {
    return defaultNavigationWidth(viewportWidth);
  }
}

export function persistNavigationWidth(width: number) {
  try {
    localStorage.setItem(NAVIGATION_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // The layout still works without storage; the width just won't
    // survive a reload.
  }
}
