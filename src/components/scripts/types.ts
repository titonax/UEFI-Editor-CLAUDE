export interface Data {
  firmwareFamily: "aptio-v" | "aptio-iv";
  menu: Menu;
  formSetRoots?: Menu;
  varStores: VarStores;
  forms: Forms;
  suppressions: Suppression[];
  version: string;
  hashes: {
    setupTxt: string;
    setupSct: string;
    amitseSct: string;
    setupdataBin: string;
    offsetChecksum: string;
  };
}

export interface Suppression {
  offset: string;
  active: boolean;
  start: string;
  end: string;
  kind?: ConditionKind;
  expression?: string;
  questionIds?: string[];
  varStoreIds?: string[];
  varStoreNames?: string[];
  source?: ConditionSource;
  constant?: boolean | null;
  formSetGuid?: string;
}

export type ConditionKind = "SuppressIf" | "GrayOutIf" | "DisableIf";
export type ConditionSource =
  | "setup"
  | "hardware"
  | "access"
  | "ui"
  | "runtime"
  | "constant"
  | "unknown";
export type VisibilityStatus =
  | "visible"
  | "hidden"
  | "conditional"
  | "unknown"
  | "orphaned"
  | "broken";

export type Menu = {
  name: string;
  formId: string;
  offset: string | null;
  formSetGuid?: string;
  source?: "amitse" | "setupdata" | "formset";
  pageMask?: string;
  pageInfoOffset?: string;
}[];

export type Forms = Form[];

export interface Form {
  name: string;
  type: "Form";
  formId: string;
  formSetGuid?: string;
  formSetTitle?: string;
  referencedIn: string[];
  children: FormChildren[];
  // Byte offset of this Form's own closing End opcode in the original HII
  // binary. Bounds the last child's/block's byte extent when reordering
  // children - see childOrdering.ts.
  endOffset: string;
}

export interface Offsets {
  accessLevel: string;
  failsafe: string;
  optimal: string;
  pageId?: string;
}

export interface FormChild {
  name: string;
  description: string;
  questionId: string;
  varStoreId: string;
  varStoreName?: string;
  accessLevel: string | null;
  failsafe: string | null;
  optimal: string | null;
  offsets: Offsets | null;
  suppressIf?: string[];
  conditions?: string[];
  // Byte offset of this opcode's own start (its OpCode+Length header) in the
  // original HII binary. Pristine and never rewritten in place - reordering
  // this Form's children uses it (and the enclosing condition's own offset,
  // when `conditions` is set) to find each child's original bytes, without
  // needing to track a separately-mutated "current position" anywhere.
  sctOffset: string;
}

export type FormChildren =
  | RefPrompt
  | NumericPrompt
  | CheckBoxPrompt
  | OneOfPrompt
  | StringPrompt;

export interface RefPrompt extends FormChild {
  type: "Ref";
  formId: string;
  // Absolute byte offset of the FormId field within the opcode itself, in
  // the original HII binary - always Header(2) + QuestionHeader(11) bytes
  // into the opcode regardless of the Ref1/Ref2/Ref3/Ref4 variant, since
  // FormId always immediately follows QuestionHeader before any
  // variant-specific tail (a FormSetGuid, an extra QuestionId, ...).
  // Lets a future edit retarget this Ref by overwriting just these 2 bytes.
  formIdOffset: string;
  targetFormSetGuid?: string;
  pageId: string | null;
}

export interface NumericPrompt extends FormChild {
  type: "Numeric";
  varOffset: string;
  size: string;
  min: string;
  max: string;
  step: string;
  defaults?: Default[];
}

export interface CheckBoxPrompt extends FormChild {
  type: "CheckBox";
  varOffset: string;
  flags: string;
  defaults?: Default[];
}

export interface OneOfPrompt extends FormChild {
  type: "OneOf";
  varOffset: string;
  size: string;
  options: { option: string; value: string }[];
  defaults?: Default[];
}

export interface StringPrompt extends FormChild {
  type: "String";
}

export type VarStores = {
  varStoreId: string;
  size: string;
  name: string;
  formSetGuid?: string;
}[];

export interface Default {
  defaultId: string;
  value: string;
}

export type Scopes = {
  type:
    | "Form"
    | "Numeric"
    | "CheckBox"
    | "OneOf"
    | "String"
    | ConditionKind;
  indentations: number;
  offset?: string;
}[];
