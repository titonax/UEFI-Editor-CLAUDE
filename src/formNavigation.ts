// Sentinel values for the "which view is showing" state threaded through
// App -> FormUi/Navigation/Header as `currentFormIndex`. Any value >= 0 is
// a real index into `data.forms`.
export const TOP_LEVEL_MENU_VIEW = -1;
export const SEARCH_VIEW = -2;
