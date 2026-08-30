export const DEFAULT_NAVBAR_WIDTH = 320;
export const MIN_NAVBAR_WIDTH = 200;
export const MAX_NAVBAR_WIDTH = 720;

const STORAGE_KEY = "uefi-editor:navbar-width";

function clampNavbarWidth(width: number) {
  return Math.min(MAX_NAVBAR_WIDTH, Math.max(MIN_NAVBAR_WIDTH, width));
}

export function loadNavbarWidth(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const parsed = stored === null ? Number.NaN : Number(stored);
    return Number.isFinite(parsed) ? clampNavbarWidth(parsed) : DEFAULT_NAVBAR_WIDTH;
  } catch {
    // Private browsing / storage disabled - just fall back to the default.
    return DEFAULT_NAVBAR_WIDTH;
  }
}

export function saveNavbarWidth(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(clampNavbarWidth(width)));
  } catch {
    // Ignore - the width just won't persist across reloads.
  }
}
