import type { AmiSingleFormSetPage, Data, RefPrompt } from "../scripts/types";
import { sameGuidOrBothUndefined, sameHexId } from "../scripts/hexId";
import type { MenuTree, MenuTreeNode } from "../Navigation/menuTree";

function sameFormIdentity(
  formId: string,
  formSetGuid: string | undefined,
  expectedFormId: string,
  expectedFormSetGuid: string | undefined,
) {
  return sameHexId(formId, expectedFormId) && sameGuidOrBothUndefined(formSetGuid, expectedFormSetGuid);
}

// The one tree node whose Ref moves this page: for a direct tab, the hub's
// Ref at the page's recorded opcode offset; for a page with a single IFR
// parent, that parent's Ref. Anything ambiguous yields no node, so the
// control stays disabled rather than moving the wrong opcode.
export function movableNodeForPage(data: Data, tree: MenuTree, page: AmiSingleFormSetPage) {
  const formIndex = data.forms.findIndex((form) =>
    sameFormIdentity(form.formId, form.formSetGuid, page.formId, page.formSetGuid),
  );
  if (formIndex < 0) return undefined;

  const candidates: MenuTreeNode[] = [];
  const visit = (nodes: MenuTreeNode[]) => {
    for (const node of nodes) {
      if (
        node.formIndex === formIndex &&
        node.sourceFormIndex !== undefined &&
        node.refChildIndex !== undefined
      ) {
        candidates.push(node);
      }
      visit(node.children);
    }
  };
  visit([...tree.roots, ...tree.orphans]);

  const refOf = (node: MenuTreeNode): RefPrompt | undefined => {
    if (node.sourceFormIndex === undefined || node.refChildIndex === undefined) return undefined;
    const child = data.forms[node.sourceFormIndex].children[node.refChildIndex];
    return child.type === "Ref" ? child : undefined;
  };
  const matches =
    page.ifrReferenceOffset !== undefined
      ? candidates.filter((node) => refOf(node)?.sctOffset === page.ifrReferenceOffset)
      : page.parentFormIds.length === 1
        ? candidates.filter((node) =>
            node.sourceFormIndex === undefined
              ? false
              : sameHexId(data.forms[node.sourceFormIndex].formId, page.parentFormIds[0]),
          )
        : candidates;
  return matches.length === 1 ? matches[0] : undefined;
}
