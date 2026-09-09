import type { Form, FormChildren } from "./types";

// A Ref can only be moved to a different Form together with whatever hides
// it - splitting a shared condition wrapper apart would mean synthesizing a
// brand new SuppressIf/GrayOutIf/DisableIf around just the moved item,
// which means inserting opcodes (a resize), or leaving the old wrapper
// behind hiding whatever happens to end up in its place instead (silent
// corruption). So a Ref sharing its outermost condition with sibling
// children is not movable on its own; only a Ref that's the sole occupant
// of its condition (or has none at all) can carry that condition along as
// one atomic block.
export function isSoleOwnerOfCondition(form: Form, ref: FormChildren) {
  const conditionOffset = ref.conditions?.[0];
  if (conditionOffset === undefined) {
    return true;
  }
  return form.children.every(
    (child) => child === ref || child.conditions?.[0] !== conditionOffset,
  );
}
