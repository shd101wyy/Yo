// Documentation model types for Yo.
//
// These interfaces represent the structured documentation IR produced by
// combining doc comment extraction with evaluator type information.

// ── Documentable item kinds ──────────────────────────────────────────

export type DocItemKind =
  | "function"
  | "struct"
  | "object"
  | "enum"
  | "newtype"
  | "union"
  | "trait"
  | "module"
  | "constant"
  | "type-alias";

// ── Parameter & field documentation ──────────────────────────────────

export interface DocParam {
  name: string;
  type: string;
  isComptime: boolean;
  isImplicit: boolean;
  defaultValue?: string;
  /** Doc comment from inline `///` above this parameter */
  doc?: string;
}

export interface DocField {
  name: string;
  type: string;
  doc?: string;
  defaultValue?: string;
}

export interface DocVariant {
  name: string;
  fields?: DocField[];
  doc?: string;
  discriminant?: string;
}

export interface DocAssociatedType {
  name: string;
  doc?: string;
  constraint?: string;
}

// ── Function documentation ───────────────────────────────────────────

export interface DocFunction {
  name: string;
  doc?: string;
  signature: string;
  parameters: DocParam[];
  returnType: string;
  typeParams?: DocParam[];
  effects?: DocParam[];
  isMethod: boolean;
  /** The type this method belongs to (for methods only) */
  selfType?: string;
  /** From ## Returns section */
  returns?: string;
  /** From ## Errors section */
  errors?: string;
  /** From ## Deprecated section */
  deprecated?: string;
  /** From ## Examples section (raw markdown) */
  examples?: string;
}

// ── Type documentation ───────────────────────────────────────────────

export interface DocType {
  name: string;
  doc?: string;
  kind: DocItemKind;
  signature: string;
  typeParams?: DocParam[];
  fields?: DocField[];
  variants?: DocVariant[];
  methods: DocFunction[];
  traitImpls: string[];
  /** From ## Deprecated section */
  deprecated?: string;
  /** From ## Examples section (raw markdown) */
  examples?: string;
}

// ── Trait documentation ──────────────────────────────────────────────

export interface DocTrait {
  name: string;
  doc?: string;
  signature: string;
  typeParams?: DocParam[];
  associatedTypes?: DocAssociatedType[];
  methods: DocFunction[];
  implementors: string[];
  /** From ## Deprecated section */
  deprecated?: string;
  /** From ## Examples section (raw markdown) */
  examples?: string;
}

// ── Constant documentation ───────────────────────────────────────────

export interface DocConstant {
  name: string;
  doc?: string;
  type: string;
  value?: string;
  /** From ## Deprecated section */
  deprecated?: string;
}

// ── Module documentation ─────────────────────────────────────────────

export interface DocModule {
  /** Module name (e.g., "array_list") */
  name: string;
  /** Full module path (e.g., "std/collections/array_list") */
  path: string;
  /** Module-level doc comment (from //! or inner block doc comments) */
  doc?: string;
  functions: DocFunction[];
  types: DocType[];
  traits: DocTrait[];
  constants: DocConstant[];
  /** Submodules (for nested module declarations) */
  submodules: DocModule[];
}

// ── Top-level documentation model ────────────────────────────────────

export interface DocModel {
  /** Project/package name */
  name: string;
  /** All documented modules */
  modules: DocModule[];
}
