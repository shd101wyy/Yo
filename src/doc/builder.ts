// Doc model builder — combines doc comment extraction with evaluator type info
// to produce structured documentation.
//
// The builder takes:
//   1. A ModuleValue from the evaluator (types + exported declarations)
//   2. A DocExtractionResult from the extractor (doc comments)
//   3. Tokens from the lexer (for position matching)
// And produces a DocModule with fully resolved type signatures and doc text.

import type { Token } from "../token";
import { TokenType } from "../token";
import type { ModuleValue } from "../value";
import { valueToString, isTypeValue } from "../value";
import { ValueTag } from "../value-tag";
import type { FunctionValue } from "../function-value";
import type {
  EnumType,
  FunctionType,
  ModuleField,
  ModuleType,
  StructType,
  TraitType,
  Type,
  TypeField,
  UnionType,
} from "../types/definitions";
import { TypeTag } from "../types/tags";
import {
  isFunctionType,
  isStructType,
  isEnumType,
  isTraitType,
  isModuleType,
  isUnionType,
  isFunctionTypeAndIsTypeFunction,
  isTypeHierarchyType,
} from "../types/guards";
import { typeToString } from "../types/utils";
import type { DocExtractionResult } from "./extractor";
import { parseDocComment } from "./sections";
import type {
  DocModule,
  DocFunction,
  DocParam,
  DocField,
  DocVariant,
  DocAssociatedType,
  DocItemKind,
} from "./model";

// ── Helper: resolve the "inner" type of a type constructor ───────────

/**
 * Many Yo types are defined as `Name :: (fn(comptime(T): Type) -> comptime(Type))(struct(...))`.
 * The evaluator stores the Value as a FunctionValue whose return type resolves to the inner type.
 * For documentation, we want the inner struct/enum/trait, not the wrapper function.
 *
 * This function extracts the "real" type behind a type-constructor function.
 * If the field is a plain type (not a type constructor function), returns it as-is.
 */
function resolveInnerType(
  field: ModuleField,
  value: ModuleValue["fields"][number]
): Type {
  const type = field.type;

  // If it's a function that returns a type (type constructor),
  // check if we have a FunctionValue whose body produced a concrete type
  if (isFunctionType(type) && isFunctionTypeAndIsTypeFunction(type)) {
    // The FunctionValue's specializedType or the return type holds the inner type
    if (value && value.tag === ValueTag.Function) {
      const funcValue = value as FunctionValue;
      if (funcValue.type.return.type.tag !== TypeTag.Type) {
        return funcValue.type.return.type;
      }
    }
    // For generic type constructors, the return type is Type — use the function type itself
    return type;
  }

  return type;
}

// ── Helper: build doc comment lookup from extraction result ──────────

type DocLookup = Map<string, string>;

/** Parsed section fields shared by DocType, DocTrait, and DocConstant. */
interface DocSections {
  deprecated?: string;
  examples?: string;
}

/** Extract deprecated/examples sections from a doc comment string. */
function extractDocSections(doc: string | undefined): DocSections {
  if (!doc) return {};
  const parsed = parseDocComment(doc);
  return {
    deprecated: parsed.sections.get("deprecated"),
    examples: parsed.sections.get("examples"),
  };
}

/**
 * Build a lookup map from declaration name → doc comment content.
 * This is used to match extracted doc comments with evaluator fields.
 */
function buildDocLookup(extraction: DocExtractionResult): DocLookup {
  const lookup: DocLookup = new Map();
  for (const assoc of extraction.declarations) {
    if (assoc.declarationName) {
      lookup.set(assoc.declarationName, assoc.comment.content);
    }
  }
  return lookup;
}

// ── Helper: convert function parameters to DocParam[] ────────────────

function functionParamsToDocParams(
  params: FunctionType["parameters"],
  docLookup?: DocLookup
): DocParam[] {
  return params.map((p) => ({
    name: p.label,
    type: typeToString(p.type),
    isComptime: p.isCompileTimeOnly,
    isImplicit: p.isImplicit,
    defaultValue: p.exprs.defaultValueExpr
      ? String(p.exprs.defaultValueExpr)
      : undefined,
    doc: docLookup?.get(p.label),
  }));
}

function forallParamsToDocParams(
  params: FunctionType["forallParameters"],
  docLookup?: DocLookup
): DocParam[] {
  return params.map((p) => ({
    name: p.label,
    type: typeToString(p.type),
    isComptime: true,
    isImplicit: false,
    doc: docLookup?.get(p.label),
  }));
}

function implicitParamsToDocParams(
  params: FunctionType["implicitParameters"],
  docLookup?: DocLookup
): DocParam[] {
  return params.map((p) => ({
    name: p.label,
    type: typeToString(p.type),
    isComptime: true,
    isImplicit: true,
    doc: docLookup?.get(p.label),
  }));
}

// ── Helper: build DocFunction from a FunctionType ────────────────────

function buildDocFunction(
  name: string,
  funcType: FunctionType,
  doc: string | undefined,
  isMethod: boolean,
  selfType?: string,
  docLookup?: DocLookup
): DocFunction {
  const signature = typeToString(funcType);

  // Parse sections from doc comment
  const parsed = doc ? parseDocComment(doc) : undefined;

  return {
    name,
    doc,
    signature,
    parameters: functionParamsToDocParams(funcType.parameters, docLookup),
    returnType: typeToString(funcType.return.type),
    typeParams:
      funcType.forallParameters.length > 0
        ? forallParamsToDocParams(funcType.forallParameters, docLookup)
        : undefined,
    effects:
      funcType.implicitParameters.length > 0
        ? implicitParamsToDocParams(funcType.implicitParameters, docLookup)
        : undefined,
    isMethod,
    selfType,
    returns: parsed?.sections.get("returns"),
    errors: parsed?.sections.get("errors"),
    deprecated: parsed?.sections.get("deprecated"),
    examples: parsed?.sections.get("examples"),
  };
}

// ── Helper: extract methods from a type's trait ──────────────────────

function extractMethods(
  trait: TraitType | undefined,
  typeName: string,
  docLookup: DocLookup
): DocFunction[] {
  if (!trait || !trait.fields) return [];

  const methods: DocFunction[] = [];
  for (const field of trait.fields) {
    if (isFunctionType(field.type)) {
      // Methods are the function-typed fields on the trait
      // Skip internal/compiler-generated methods (prefixed with ___)
      if (field.label.startsWith("___")) continue;

      methods.push(
        buildDocFunction(
          field.label,
          field.type,
          docLookup.get(field.label),
          true,
          typeName,
          docLookup
        )
      );
    }
  }
  return methods;
}

// ── Helper: determine DocItemKind from a type ────────────────────────

function getTypeKind(type: Type): DocItemKind {
  if (isStructType(type)) {
    if (type.isNewtype) return "newtype";
    if (type.isReferenceSemantics) return "object";
    return "struct";
  }
  if (isEnumType(type)) return "enum";
  if (isUnionType(type)) return "union";
  if (isTraitType(type)) return "trait";
  if (isModuleType(type)) return "module";
  return "type-alias";
}

// ── Helper: convert TypeField[] to DocField[] ────────────────────────

function typeFieldsToDocFields(
  fields: TypeField[],
  docLookup: DocLookup
): DocField[] {
  return fields.map((f) => ({
    name: f.label,
    type: typeToString(f.type),
    doc: docLookup.get(f.label),
    defaultValue: f.defaultValue ? valueToString(f.defaultValue) : undefined,
  }));
}

// ── Helper: convert EnumVariant[] to DocVariant[] ────────────────────

function enumVariantsToDocVariants(
  variants: EnumType["variants"],
  docLookup: DocLookup
): DocVariant[] {
  return variants.map((v) => ({
    name: v.name,
    fields: v.fields
      ? v.fields.map((f) => ({
          name: f.label,
          type: typeToString(f.type),
          doc: docLookup.get(f.label),
          defaultValue: f.defaultValue
            ? valueToString(f.defaultValue)
            : undefined,
        }))
      : undefined,
    doc: docLookup.get(v.name),
    discriminant:
      v.discriminant !== undefined ? String(v.discriminant) : undefined,
  }));
}

// ── Helper: get forall type params from a type-constructor function ──

function getTypeConstructorParams(field: ModuleField): DocParam[] | undefined {
  if (
    isFunctionType(field.type) &&
    isFunctionTypeAndIsTypeFunction(field.type)
  ) {
    const funcType = field.type as FunctionType;
    if (funcType.forallParameters.length > 0) {
      return forallParamsToDocParams(funcType.forallParameters);
    }
    // Also check regular comptime params used as type params
    const comptimeParams = funcType.parameters.filter(
      (p) => p.isCompileTimeOnly
    );
    if (comptimeParams.length > 0) {
      return functionParamsToDocParams(comptimeParams);
    }
  }
  return undefined;
}

// ── Helper: collect trait implementations from global impl state ─────

/**
 * Extract trait implementation names per type from the token stream.
 *
 * Scans for patterns like:
 *   impl(TypeName, TraitName(...))
 *   impl(forall(...), TypeName, TraitName(...))
 *   impl(forall(...), where(...), TypeName, TraitName(...))
 *
 * Returns a map from type name to deduplicated list of trait names.
 */
function extractTraitImplsFromTokens(tokens: Token[]): Map<string, string[]> {
  const result = new Map<string, Set<string>>();

  // Filter to non-whitespace, non-comment tokens for easier scanning
  const toks = tokens.filter(
    (t) =>
      t.type !== TokenType.Whitespace &&
      t.type !== TokenType.SingleLineComment &&
      t.type !== TokenType.MultiLineComment &&
      t.type !== TokenType.DocLineComment &&
      t.type !== TokenType.InnerDocLineComment &&
      t.type !== TokenType.DocBlockComment &&
      t.type !== TokenType.InnerDocBlockComment
  );

  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]!;
    // Look for `impl` `(`
    if (tok.type !== TokenType.Identifier || tok.value !== "impl") continue;
    if (i + 1 >= toks.length || toks[i + 1]!.type !== TokenType.LParen)
      continue;

    // Skip past `impl(`
    let j = i + 2;

    // Skip `forall(...)` if present
    if (
      j < toks.length &&
      toks[j]!.type === TokenType.Identifier &&
      toks[j]!.value === "forall"
    ) {
      j = skipBalancedParens(toks, j + 1);
      // Skip comma after forall(...)
      if (j < toks.length && toks[j]!.type === TokenType.Comma) j++;
    }

    // Skip `where(...)` if present
    if (
      j < toks.length &&
      toks[j]!.type === TokenType.Identifier &&
      toks[j]!.value === "where"
    ) {
      j = skipBalancedParens(toks, j + 1);
      // Skip comma after where(...)
      if (j < toks.length && toks[j]!.type === TokenType.Comma) j++;
    }

    // Now we expect the receiver type name (e.g., `String`, `Array`)
    if (j >= toks.length || toks[j]!.type !== TokenType.Identifier) continue;
    const typeName = toks[j]!.value;
    j++;

    // Skip type parameters like `(T)` or `(T, U)` after the type name
    if (j < toks.length && toks[j]!.type === TokenType.LParen) {
      j = skipBalancedParens(toks, j);
    }

    // If next is comma, the item after is the trait name
    if (j >= toks.length || toks[j]!.type !== TokenType.Comma) continue;
    j++; // skip comma

    // The trait name
    if (j >= toks.length || toks[j]!.type !== TokenType.Identifier) continue;
    const traitName = toks[j]!.value;

    // Verify it's followed by `(` to confirm it's a trait (not another arg)
    if (j + 1 >= toks.length || toks[j + 1]!.type !== TokenType.LParen)
      continue;

    // Add to result
    let set = result.get(typeName);
    if (!set) {
      set = new Set<string>();
      result.set(typeName, set);
    }
    set.add(traitName);
  }

  // Convert sets to arrays
  const out = new Map<string, string[]>();
  for (const [typeName, set] of result) {
    out.set(typeName, [...set]);
  }
  return out;
}

/** Skip past balanced parentheses starting at `(`. Returns index after `)`. */
function skipBalancedParens(toks: Token[], start: number): number {
  if (start >= toks.length || toks[start]!.type !== TokenType.LParen)
    return start;
  let depth = 1;
  let j = start + 1;
  while (j < toks.length && depth > 0) {
    if (toks[j]!.type === TokenType.LParen) depth++;
    else if (toks[j]!.type === TokenType.RParen) depth--;
    j++;
  }
  return j;
}

// ── Main builder ─────────────────────────────────────────────────────

export interface BuildDocModuleOptions {
  /** The module name (e.g., "array_list") */
  name: string;
  /** The module path (e.g., "std/collections/array_list") */
  path: string;
  /** The evaluated module value */
  moduleValue: ModuleValue;
  /** The extracted doc comments */
  extraction: DocExtractionResult;
  /** The raw tokens (for future position-based matching) */
  tokens: Token[];
  /** Whether to include non-exported (private) items */
  includePrivate?: boolean;
}

/**
 * Build a DocModule from evaluator output and extracted doc comments.
 *
 * This is the main entry point for Phase 2. It:
 * 1. Builds a lookup map from declaration names to doc comments
 * 2. Iterates over exported module fields
 * 3. Classifies each field (function, type, trait, constant, etc.)
 * 4. Produces structured documentation with resolved type signatures
 */
export function buildDocModule(options: BuildDocModuleOptions): DocModule {
  const { name, path, moduleValue, extraction, tokens } = options;
  const docLookup = buildDocLookup(extraction);
  const traitImplMap = extractTraitImplsFromTokens(tokens);

  const result: DocModule = {
    name,
    path,
    doc: extraction.moduleDoc?.content,
    functions: [],
    types: [],
    traits: [],
    constants: [],
    submodules: [],
  };

  const moduleType = moduleValue.type;
  if (!isModuleType(moduleType)) return result;

  for (let i = 0; i < moduleType.fields.length; i++) {
    const field = moduleType.fields[i]!;
    const value = moduleValue.fields[i];
    const fieldName = field.label;
    const doc = docLookup.get(fieldName);

    // Skip empty-label fields (anonymous impl blocks)
    if (!fieldName) continue;

    // Skip compiler-internal names (triple underscore prefix)
    if (fieldName.startsWith("___")) continue;

    // Skip internal __yo_* symbols (compiler builtins)
    if (fieldName.startsWith("__yo_")) continue;

    // ── Type declarations (value holds the actual type) ──
    // When `Point :: struct(...)`, the evaluator stores:
    //   field.type = Type (the metatype)
    //   value = TypeValue { value: StructType }
    if (value && isTypeValue(value)) {
      const actualType = value.value;

      if (isStructType(actualType)) {
        const structType = actualType as StructType;
        const kind = getTypeKind(structType);
        result.types.push({
          name: fieldName,
          doc,
          kind,
          signature: typeToString(actualType),
          typeParams: getTypeConstructorParams(field),
          fields: typeFieldsToDocFields(structType.fields, docLookup),
          methods: extractMethods(structType.trait, fieldName, docLookup),
          traitImpls: traitImplMap.get(fieldName) ?? [],
          ...extractDocSections(doc),
        });
        continue;
      }

      if (isEnumType(actualType)) {
        const enumType = actualType as EnumType;
        result.types.push({
          name: fieldName,
          doc,
          kind: "enum",
          signature: typeToString(actualType),
          typeParams: getTypeConstructorParams(field),
          variants: enumVariantsToDocVariants(enumType.variants, docLookup),
          methods: extractMethods(enumType.trait, fieldName, docLookup),
          traitImpls: traitImplMap.get(fieldName) ?? [],
          ...extractDocSections(doc),
        });
        continue;
      }

      if (isUnionType(actualType)) {
        const unionType = actualType as UnionType;
        result.types.push({
          name: fieldName,
          doc,
          kind: "union",
          signature: typeToString(actualType),
          typeParams: getTypeConstructorParams(field),
          fields: typeFieldsToDocFields(unionType.fields, docLookup),
          methods: [],
          traitImpls: traitImplMap.get(fieldName) ?? [],
          ...extractDocSections(doc),
        });
        continue;
      }

      if (isTraitType(actualType)) {
        const traitType = actualType as TraitType;

        const traitMethods: DocFunction[] = [];
        const associatedTypes: DocAssociatedType[] = [];

        for (const traitField of traitType.fields) {
          if (traitField.unassignedSomeType) {
            associatedTypes.push({
              name: traitField.label,
              doc: docLookup.get(traitField.label),
              constraint: typeToString(traitField.type),
            });
          } else if (isFunctionType(traitField.type)) {
            if (!traitField.label.startsWith("___")) {
              traitMethods.push(
                buildDocFunction(
                  traitField.label,
                  traitField.type,
                  docLookup.get(traitField.label),
                  true,
                  fieldName,
                  docLookup
                )
              );
            }
          }
        }

        result.traits.push({
          name: fieldName,
          doc,
          kind: "trait",
          signature: typeToString(actualType),
          typeParams: getTypeConstructorParams(field),
          associatedTypes:
            associatedTypes.length > 0 ? associatedTypes : undefined,
          methods: traitMethods,
          implementors: [],
          ...extractDocSections(doc),
        });
        continue;
      }

      if (isModuleType(actualType)) {
        const directModuleType = actualType as ModuleType;
        const moduleMethods: DocFunction[] = [];
        for (const mField of directModuleType.fields) {
          if (
            isFunctionType(mField.type) &&
            !mField.label.startsWith("___") &&
            mField.label
          ) {
            moduleMethods.push(
              buildDocFunction(
                mField.label,
                mField.type,
                docLookup.get(mField.label),
                true,
                fieldName,
                docLookup
              )
            );
          }
        }
        result.traits.push({
          name: fieldName,
          doc,
          kind: "module",
          signature: typeToString(actualType),
          typeParams: getTypeConstructorParams(field),
          methods: moduleMethods,
          implementors: [],
          ...extractDocSections(doc),
        });
        continue;
      }

      // Other TypeValue — document as a type alias
      result.types.push({
        name: fieldName,
        doc,
        kind: "type-alias",
        signature: typeToString(actualType),
        methods: [],
        traitImpls: traitImplMap.get(fieldName) ?? [],
        ...extractDocSections(doc),
      });
      continue;
    }

    // ── Function declarations ──
    if (isFunctionType(field.type)) {
      // Type constructors (fn returning Type) — try to resolve the inner type
      if (isFunctionTypeAndIsTypeFunction(field.type)) {
        const innerType = resolveInnerType(field, value);

        if (isStructType(innerType)) {
          const structType = innerType as StructType;
          result.types.push({
            name: fieldName,
            doc,
            kind: getTypeKind(structType),
            signature: typeToString(field.type),
            typeParams: getTypeConstructorParams(field),
            fields: typeFieldsToDocFields(structType.fields, docLookup),
            methods: extractMethods(structType.trait, fieldName, docLookup),
            traitImpls: traitImplMap.get(fieldName) ?? [],
            ...extractDocSections(doc),
          });
        } else if (isEnumType(innerType)) {
          const enumType = innerType as EnumType;
          result.types.push({
            name: fieldName,
            doc,
            kind: "enum",
            signature: typeToString(field.type),
            typeParams: getTypeConstructorParams(field),
            variants: enumVariantsToDocVariants(enumType.variants, docLookup),
            methods: extractMethods(enumType.trait, fieldName, docLookup),
            traitImpls: traitImplMap.get(fieldName) ?? [],
            ...extractDocSections(doc),
          });
        } else if (isTraitType(innerType)) {
          const traitType = innerType as TraitType;
          const traitMethods: DocFunction[] = [];
          const associatedTypes: DocAssociatedType[] = [];
          for (const traitField of traitType.fields) {
            if (traitField.unassignedSomeType) {
              associatedTypes.push({
                name: traitField.label,
                doc: docLookup.get(traitField.label),
                constraint: typeToString(traitField.type),
              });
            } else if (
              isFunctionType(traitField.type) &&
              !traitField.label.startsWith("___")
            ) {
              traitMethods.push(
                buildDocFunction(
                  traitField.label,
                  traitField.type,
                  docLookup.get(traitField.label),
                  true,
                  fieldName,
                  docLookup
                )
              );
            }
          }
          result.traits.push({
            name: fieldName,
            doc,
            kind: "trait-function",
            signature: typeToString(field.type),
            typeParams: getTypeConstructorParams(field),
            associatedTypes:
              associatedTypes.length > 0 ? associatedTypes : undefined,
            methods: traitMethods,
            implementors: [],
            ...extractDocSections(doc),
          });
        } else if (isModuleType(innerType)) {
          const resolvedModuleType = innerType as ModuleType;
          const moduleMethods: DocFunction[] = [];
          for (const mField of resolvedModuleType.fields) {
            if (
              isFunctionType(mField.type) &&
              !mField.label.startsWith("___") &&
              mField.label
            ) {
              moduleMethods.push(
                buildDocFunction(
                  mField.label,
                  mField.type,
                  docLookup.get(mField.label),
                  true,
                  fieldName,
                  docLookup
                )
              );
            }
          }
          result.traits.push({
            name: fieldName,
            doc,
            kind: "module-function",
            signature: typeToString(field.type),
            typeParams: getTypeConstructorParams(field),
            methods: moduleMethods,
            implementors: [],
            ...extractDocSections(doc),
          });
        } else {
          // Check if the function returns comptime(Trait) or comptime(Module)
          const funcType = field.type as FunctionType;
          const retType = funcType.return.type;
          if (
            isTypeHierarchyType(retType) &&
            retType.level >= 1 &&
            (!retType.baseType ||
              isTraitType(retType.baseType) ||
              isModuleType(retType.baseType))
          ) {
            result.traits.push({
              name: fieldName,
              doc,
              kind:
                retType.baseType && isModuleType(retType.baseType)
                  ? "module-function"
                  : "trait-function",
              signature: typeToString(field.type),
              typeParams: getTypeConstructorParams(field),
              methods: [],
              implementors: [],
              ...extractDocSections(doc),
            });
          } else {
            // Generic type constructor that we can't resolve
            result.types.push({
              name: fieldName,
              doc,
              kind: "type-function",
              signature: typeToString(field.type),
              typeParams: getTypeConstructorParams(field),
              methods: [],
              traitImpls: traitImplMap.get(fieldName) ?? [],
              ...extractDocSections(doc),
            });
          }
        }
        continue;
      }

      // Regular function or comptime function
      result.functions.push(
        buildDocFunction(
          fieldName,
          field.type,
          doc,
          false,
          undefined,
          docLookup
        )
      );
      continue;
    }

    // ── Constant ──
    result.constants.push({
      name: fieldName,
      doc,
      type: typeToString(field.type),
      value: value ? valueToString(value) : undefined,
      ...extractDocSections(doc),
    });
  }

  return result;
}

// ── Token-only fallback builder ──────────────────────────────────────

export interface BuildDocModuleFromTokensOptions {
  name: string;
  path: string;
  extraction: DocExtractionResult;
  tokens: Token[];
}

/**
 * Build a minimal DocModule from token extraction only (no evaluator).
 * Used as a fallback when module evaluation fails (circular imports, etc.).
 * Produces module doc + documented declarations as constants with their doc text.
 */
export function buildDocModuleFromTokens(
  options: BuildDocModuleFromTokensOptions
): DocModule {
  const { name, path, extraction, tokens } = options;
  const traitImplMap = extractTraitImplsFromTokens(tokens);

  const result: DocModule = {
    name,
    path,
    doc: extraction.moduleDoc?.content,
    functions: [],
    types: [],
    traits: [],
    constants: [],
    submodules: [],
  };

  // Extract documented declarations as constants with their doc text.
  // Without evaluator info we can't classify them, but we preserve the docs.
  for (const assoc of extraction.declarations) {
    if (!assoc.declarationName) continue;
    const declName = assoc.declarationName;
    const sections = extractDocSections(assoc.comment.content);

    // Look at the trait impl map to detect type names
    const traitImpls = traitImplMap.get(declName);
    if (traitImpls) {
      // Likely a type — add as a type with trait impls
      result.types.push({
        name: declName,
        kind: "struct",
        signature: declName,
        typeParams: undefined,
        fields: undefined,
        variants: undefined,
        methods: [],
        traitImpls,
        ...sections,
      });
    } else {
      // Add as a constant (generic fallback)
      result.constants.push({
        name: declName,
        type: "(unknown)",
        value: undefined,
        ...sections,
      });
    }
  }

  return result;
}

/**
 * Build a cross-reference map: trait name → list of type names that implement it.
 * Call this after building all DocModules to fill in trait.implementors.
 */
export function buildCrossReferences(modules: DocModule[]): void {
  // Collect all trait → implementor relationships
  const traitImplementors = new Map<string, Set<string>>();

  for (const mod of modules) {
    for (const type of mod.types) {
      for (const traitName of type.traitImpls) {
        let implementors = traitImplementors.get(traitName);
        if (!implementors) {
          implementors = new Set();
          traitImplementors.set(traitName, implementors);
        }
        implementors.add(type.name);
      }
    }
  }

  // Fill in implementors on traits
  for (const mod of modules) {
    for (const trait of mod.traits) {
      const implementors = traitImplementors.get(trait.name);
      if (implementors) {
        trait.implementors = Array.from(implementors).sort();
      }
    }
  }
}
