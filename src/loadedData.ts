import type { Draft } from "immer";
import type { Data } from "./components/scripts/types";

// The producer passed to setData(useImmer<Data | null>). `recipe` is either
// a plain Data value - the initial parse result, or a wholesale reset - or
// an in-place edit function supplied by child UI that only ever renders
// once `data` is already loaded. A plain value must apply even on the very
// first call, when `draft` is still null; only the function form needs an
// already-loaded draft to mutate.
export function applyLoadedData(
  recipe: Data | ((draft: Draft<Data>) => void),
  draft: Draft<Data> | null,
): Data | undefined {
  if (typeof recipe !== "function") {
    return recipe;
  }
  if (draft === null) {
    return undefined;
  }
  recipe(draft);
  return undefined;
}
