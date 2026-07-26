// Doc model builder — combines doc comment extraction with evaluator type info
// to produce structured documentation.
//
// The builder takes:
//   1. A StructValue from the evaluator (types + exported declarations)
//   2. A DocExtractionResult from the extractor (doc comments)
//   3. Tokens from the lexer (for position matching)
// And produces a DocModule with fully resolved type signatures and doc text.

import type { Token } from "../token";
import { TokenType } from "../token";
import type { Environment } from "../env";
import type { StructValue } from "../value";
import { valueToString, isTypeValue } from "../value";
import { ValueTag } from "../value-tag";
import type { FunctionValue } from "../function-value";
import type {
  EnumType,
  FunctionType,
  TypeField,
  SourceNamespaceType,
  StructType,
  TraitType,
  Type,
  UnionType,
} from "../types/definitions";
import { TypeTag } from "../types/tags";
import {
  isFunctionType,
  isStructType,
  isEnumType,
  isTraitType,
  isSourceNamespaceType,
  isUnionType,
  isFunctionTypeAndIsTypeFunction,
  isTypeHierarchyType,
} from "../types/guards";
import { typeToString } from "../types/utils";
import { getGenericImplDocEntries } from "../evaluator/values/impl";
import type { DocExtractionResult } from "./extractor";
import { parseDocComment } from "./sections";
import type {
  DocImpl,
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
  field: TypeField,
  value: StructValue["fields"][number]
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
    effects: undefined,
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

function mergeMethods(
  primary: DocFunction[],
  secondary: DocFunction[]
): DocFunction[] {
  const seen = new Set(primary.map((method) => method.name));
  const merged = [...primary];

  for (const method of secondary) {
    if (seen.has(method.name)) continue;
    seen.add(method.name);
    merged.push(method);
  }

  return merged;
}

function mergeTraitImplNames(primary: string[], secondary: string[]): string[] {
  return [...new Set([...primary, ...secondary])];
}

function extractGenericImplInfo({
  concreteType,
  typeName,
  docLookup,
  env,
}: {
  concreteType: Type;
  typeName: string;
  docLookup: DocLookup;
  env: Environment | undefined;
}): { methods: DocFunction[]; impls: DocImpl[]; traitImpls: string[] } {
  if (!env) {
    return { methods: [], impls: [], traitImpls: [] };
  }

  const implEntries = getGenericImplDocEntries({
    concreteType,
    env,
    receiverTypeName: typeName,
  });
  const methods: DocFunction[] = [];
  const traitImpls = new Set<string>();
  const seenMethodNames = new Set<string>();

  for (const impl of implEntries) {
    if (impl.traitName) {
      traitImpls.add(impl.traitName);
    }

    for (const method of impl.methods) {
      const methodName = method.name;
      if (seenMethodNames.has(methodName)) continue;
      seenMethodNames.add(methodName);

      methods.push(
        buildDocFunction(
          methodName,
          method.type,
          docLookup.get(methodName),
          true,
          typeName,
          docLookup
        )
      );
    }
  }

  return {
    methods,
    impls: implEntries,
    traitImpls: [...traitImpls],
  };
}

// ── Helper: determine DocItemKind from a type ────────────────────────

function getTypeKind(type: Type): DocItemKind {
  if (isStructType(type)) {
    if (type.isNewtype) return "newtype";
    if (type.isAtomicRc) return "atomic object";
    if (type.isReferenceSemantics) return "object";
    return "struct";
  }
  if (isEnumType(type)) return "enum";
  if (isUnionType(type)) return "union";
  if (isTraitType(type)) return "trait";
  if (isSourceNamespaceType(type)) return "module";
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

// ── Helper: get generic type params from a type-constructor function ──

function getTypeConstructorParams(field: TypeField): DocParam[] | undefined {
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
 *   impl(generic(...), TypeName, TraitName(...))
 *   impl(generic(...), where(...), TypeName, TraitName(...))
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

    // Skip `generic(...)` if present
    if (
      j < toks.length &&
      toks[j]!.type === TokenType.Identifier &&
      toks[j]!.value === "generic"
    ) {
      j = skipBalancedParens(toks, j + 1);
      // Skip comma after generic(...)
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

function isTriviaToken(token: Token): boolean {
  return (
    token.type === TokenType.Whitespace ||
    token.type === TokenType.SingleLineComment ||
    token.type === TokenType.MultiLineComment ||
    token.type === TokenType.DocLineComment ||
    token.type === TokenType.InnerDocLineComment ||
    token.type === TokenType.DocBlockComment ||
    token.type === TokenType.InnerDocBlockComment
  );
}

function sliceTokenText(
  toks: Token[],
  startIndex: number,
  endIndex: number
): string {
  if (startIndex > endIndex || startIndex < 0 || endIndex >= toks.length) {
    return "";
  }
  const start = toks[startIndex]!.position.character;
  const endToken = toks[endIndex]!;
  const end = endToken.position.character + endToken.value.length;
  return endToken.inputString.slice(start, end).trim();
}

function skipDelimitedArgument(toks: Token[], start: number): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let index = start;

  while (index < toks.length) {
    const token = toks[index]!;
    if (token.type === TokenType.LParen) parenDepth++;
    else if (token.type === TokenType.RParen) {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) break;
      parenDepth--;
    } else if (token.type === TokenType.LBracket) bracketDepth++;
    else if (token.type === TokenType.RBracket) bracketDepth--;
    else if (token.type === TokenType.LCurlyBracket) braceDepth++;
    else if (token.type === TokenType.RCurlyBracket) braceDepth--;
    else if (
      token.type === TokenType.Comma &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      break;
    }
    index++;
  }

  return index;
}

function extractReceiverTypeName(
  toks: Token[],
  start: number,
  end: number
): string {
  for (let i = start; i <= end; i++) {
    if (toks[i]!.type === TokenType.Identifier) {
      return toks[i]!.value;
    }
  }
  return "";
}

function extractReturnTypeFromSignature(signature: string): string {
  const arrowIndex = signature.lastIndexOf("->");
  if (arrowIndex === -1) return "unknown";
  let returnType = signature.slice(arrowIndex + 2).trim();

  // Only strip unbalanced trailing closing parens (from outer fn(...) wrapper).
  // Balanced parens like Option(Slice(T)) must be preserved.
  let balance = 0;
  for (const ch of returnType) {
    if (ch === "(") balance++;
    else if (ch === ")") balance--;
  }
  while (balance < 0 && returnType.endsWith(")")) {
    returnType = returnType.slice(0, -1);
    balance++;
  }

  return returnType.trim();
}

function parenContainsTraitBody(toks: Token[], lParenIndex: number): boolean {
  const end = skipBalancedParens(toks, lParenIndex);
  for (let i = lParenIndex + 1; i < end - 1; i++) {
    if (
      toks[i]!.type === TokenType.Identifier &&
      i + 1 < end - 1 &&
      toks[i + 1]!.type === TokenType.Operator &&
      toks[i + 1]!.value === ":"
    ) {
      return true;
    }
  }
  return false;
}

interface TraitBodyExtraction {
  methodNames: string[];
  associatedTypes: Array<{ name: string; type: string; doc?: string }>;
  /** Full DocFunction entries extracted from the impl body. */
  methods: DocFunction[];
}

/** Collect doc comment lines (///) preceding `pos` in the full token array. */
function collectDocCommentBefore(
  fullTokens: Token[],
  pos: { row: number; column: number; character: number }
): string | undefined {
  // Find the token in fullTokens at or just before `pos`
  let idx = -1;
  for (let i = 0; i < fullTokens.length; i++) {
    const t = fullTokens[i]!;
    if (
      t.position.row > pos.row ||
      (t.position.row === pos.row && t.position.character >= pos.character)
    ) {
      idx = i;
      break;
    }
  }
  if (idx <= 0) return undefined;

  // Walk backwards from idx-1 collecting doc comments and whitespace
  const docLines: string[] = [];
  for (let i = idx - 1; i >= 0; i--) {
    const t = fullTokens[i]!;
    if (t.type === TokenType.Whitespace) continue;
    if (
      t.type === TokenType.DocLineComment ||
      t.type === TokenType.DocBlockComment
    ) {
      if (t.type === TokenType.DocLineComment) {
        // Strip leading "/// " or "///"
        const text = t.value.replace(/^\/\/\/\s?/, "");
        docLines.unshift(text);
      } else {
        // Block comment: strip /** ... */
        const text = t.value
          .replace(/^\/\*\*\s*/, "")
          .replace(/\s*\*\/$/, "")
          .split("\n")
          .map((line) => line.replace(/^\s*\*\s?/, ""))
          .join("\n")
          .trim();
        docLines.unshift(text);
      }
    } else {
      break;
    }
  }
  return docLines.length > 0 ? docLines.join("\n").trim() : undefined;
}

/** Extract method names, associated types, and full method info from a trait impl body. */
function extractTraitBodyMembers(
  toks: Token[],
  lParenIndex: number,
  fullTokens?: Token[]
): TraitBodyExtraction {
  const end = skipBalancedParens(toks, lParenIndex);
  const methodNames: string[] = [];
  const associatedTypes: Array<{ name: string; type: string; doc?: string }> =
    [];
  const methods: DocFunction[] = [];
  let i = lParenIndex + 1;
  while (i < end - 1) {
    if (
      toks[i]!.type === TokenType.Identifier &&
      i + 1 < end - 1 &&
      toks[i + 1]!.type === TokenType.Operator &&
      toks[i + 1]!.value === ":"
    ) {
      const name = toks[i]!.value;
      const namePos = toks[i]!.position;
      const doc = fullTokens
        ? collectDocCommentBefore(fullTokens, namePos)
        : undefined;
      // Check if the type after ":" is a function type (method) or a simple type (associated type)
      const typeStart = i + 2;
      if (typeStart < end - 1) {
        const typeToken = toks[typeStart]!;
        const isFnType =
          typeToken.type === TokenType.LParen &&
          typeStart + 1 < end - 1 &&
          toks[typeStart + 1]!.type === TokenType.Identifier &&
          toks[typeStart + 1]!.value === "fn";
        if (isFnType) {
          methodNames.push(name);
          // Extract the fn type signature: (fn(...) -> ReturnType)
          const fnParenEnd = skipBalancedParens(toks, typeStart);
          const fnSignature = sliceTokenText(toks, typeStart, fnParenEnd - 1);
          const returnType = extractReturnTypeFromSignature(fnSignature);

          // Extract parameters from fn(...) — between the inner parens
          const params: DocParam[] = [];
          // Find inner paren after "fn"
          const paramStart = typeStart + 2; // skip ( and fn
          if (
            paramStart < fnParenEnd &&
            toks[paramStart]!.type === TokenType.LParen
          ) {
            const paramEnd = skipBalancedParens(toks, paramStart);
            let p = paramStart + 1;
            while (p < paramEnd - 1) {
              if (toks[p]!.type === TokenType.Identifier) {
                const paramName = toks[p]!.value;
                if (paramName !== "self" || params.length === 0) {
                  // Find the type after ":"
                  if (
                    p + 1 < paramEnd - 1 &&
                    toks[p + 1]!.type === TokenType.Operator &&
                    toks[p + 1]!.value === ":"
                  ) {
                    const typeArgStart = p + 2;
                    const typeArgEnd = skipDelimitedArgument(
                      toks,
                      typeArgStart
                    );
                    const paramType = sliceTokenText(
                      toks,
                      typeArgStart,
                      typeArgEnd - 1
                    );
                    if (paramName !== "self") {
                      params.push({
                        name: paramName,
                        type: paramType,
                        isComptime: false,
                      });
                    }
                    p = typeArgEnd;
                    if (p < paramEnd - 1 && toks[p]!.type === TokenType.Comma)
                      p++;
                    continue;
                  }
                }
              }
              p++;
            }
          }

          methods.push({
            name,
            doc,
            signature: fnSignature,
            parameters: params,
            returnType,
            isMethod: true,
          });
        } else {
          // Collect the type expression text
          const typeEnd =
            typeToken.type === TokenType.LParen
              ? skipBalancedParens(toks, typeStart)
              : skipDelimitedArgument(toks, typeStart);
          associatedTypes.push({
            name,
            type: sliceTokenText(toks, typeStart, typeEnd - 1),
            doc,
          });
        }
      }
    }
    // Skip balanced nested parens to avoid false matches inside type exprs
    if (toks[i]!.type === TokenType.LParen) {
      i = skipBalancedParens(toks, i);
    } else {
      i++;
    }
  }
  return { methodNames, associatedTypes, methods };
}

function extractImplInfoFromTokens(
  tokens: Token[],
  docLookup: DocLookup
): Map<
  string,
  { traitImpls: string[]; impls: DocImpl[]; methods: DocFunction[] }
> {
  const result = new Map<
    string,
    { traitImpls: string[]; impls: DocImpl[]; methods: DocFunction[] }
  >();
  const toks = tokens.filter((token) => !isTriviaToken(token));

  function ensureEntry(typeName: string): {
    traitImpls: string[];
    impls: DocImpl[];
    methods: DocFunction[];
  } {
    let entry = result.get(typeName);
    if (!entry) {
      entry = { traitImpls: [], impls: [], methods: [] };
      result.set(typeName, entry);
    }
    return entry;
  }

  for (let i = 0; i < toks.length; i++) {
    const token = toks[i]!;
    if (token.type !== TokenType.Identifier || token.value !== "impl") continue;
    if (i + 1 >= toks.length || toks[i + 1]!.type !== TokenType.LParen)
      continue;

    const implEnd = skipBalancedParens(toks, i + 1);
    let current = i + 2;
    const signatureParts: string[] = [];

    if (
      current < toks.length &&
      toks[current]!.type === TokenType.Identifier &&
      toks[current]!.value === "generic"
    ) {
      const forallEnd = skipBalancedParens(toks, current + 1);
      signatureParts.push(sliceTokenText(toks, current, forallEnd - 1));
      current = forallEnd;
      if (current < toks.length && toks[current]!.type === TokenType.Comma)
        current++;
    }

    if (
      current < toks.length &&
      toks[current]!.type === TokenType.Identifier &&
      toks[current]!.value === "where"
    ) {
      const whereEnd = skipBalancedParens(toks, current + 1);
      signatureParts.push(sliceTokenText(toks, current, whereEnd - 1));
      current = whereEnd;
      if (current < toks.length && toks[current]!.type === TokenType.Comma)
        current++;
    }

    const receiverStart = current;
    const receiverEnd = skipDelimitedArgument(toks, receiverStart);
    const receiverTypeName = extractReceiverTypeName(
      toks,
      receiverStart,
      receiverEnd - 1
    );
    if (!receiverTypeName) {
      i = implEnd - 1;
      continue;
    }
    signatureParts.push(sliceTokenText(toks, receiverStart, receiverEnd - 1));
    current = receiverEnd;

    if (current < toks.length && toks[current]!.type === TokenType.Comma)
      current++;

    if (
      current < toks.length &&
      toks[current]!.type === TokenType.Identifier &&
      toks[current]!.value === "where"
    ) {
      const whereEnd = skipBalancedParens(toks, current + 1);
      signatureParts.splice(
        signatureParts.length - 1,
        0,
        sliceTokenText(toks, current, whereEnd - 1)
      );
      current = whereEnd;
      if (current < toks.length && toks[current]!.type === TokenType.Comma)
        current++;
    }

    const entry = ensureEntry(receiverTypeName);
    const anonymousMethodNames: string[] = [];

    while (current < implEnd - 1) {
      const argStart = current;
      const argEnd = skipDelimitedArgument(toks, argStart);
      const first = toks[argStart]!;
      const second = toks[argStart + 1];

      if (
        first.type === TokenType.Identifier &&
        second?.type === TokenType.Operator &&
        second.value === ":"
      ) {
        const methodName = first.value;
        anonymousMethodNames.push(methodName);
        const typeStart = argStart + 2;
        const typeEnd =
          typeStart < toks.length && toks[typeStart]!.type === TokenType.LParen
            ? skipBalancedParens(toks, typeStart)
            : typeStart + 1;
        const signature = sliceTokenText(toks, typeStart, typeEnd - 1);
        entry.methods.push({
          name: methodName,
          doc: docLookup.get(methodName),
          signature,
          parameters: [],
          returnType: extractReturnTypeFromSignature(signature),
          isMethod: true,
          selfType: receiverTypeName,
        });
      } else if (first.type === TokenType.Identifier) {
        let traitSignature = first.value;
        let traitMethodNames: string[] = [];
        let traitAssocTypes: Array<{
          name: string;
          type: string;
          doc?: string;
        }> = [];
        let traitMethods: DocFunction[] = [];
        if (
          argStart + 1 < toks.length &&
          toks[argStart + 1]!.type === TokenType.LParen
        ) {
          const firstParenEnd = skipBalancedParens(toks, argStart + 1);
          if (
            !parenContainsTraitBody(toks, argStart + 1) &&
            firstParenEnd <= argEnd &&
            firstParenEnd < toks.length &&
            toks[firstParenEnd]?.type === TokenType.LParen
          ) {
            // e.g., Index(usize)(body...) — type args in first parens, body in second
            traitSignature = sliceTokenText(toks, argStart, firstParenEnd - 1);
            if (parenContainsTraitBody(toks, firstParenEnd)) {
              const extracted = extractTraitBodyMembers(
                toks,
                firstParenEnd,
                tokens
              );
              traitMethodNames = extracted.methodNames;
              traitAssocTypes = extracted.associatedTypes;
              traitMethods = extracted.methods;
              traitSignature += "(...)";
            }
          } else if (!parenContainsTraitBody(toks, argStart + 1)) {
            traitSignature = sliceTokenText(toks, argStart, firstParenEnd - 1);
          } else {
            const extracted = extractTraitBodyMembers(
              toks,
              argStart + 1,
              tokens
            );
            traitMethodNames = extracted.methodNames;
            traitAssocTypes = extracted.associatedTypes;
            traitMethods = extracted.methods;
            traitSignature = `${first.value}(...)`;
          }
        }
        // Add extracted trait methods to the entry's method list
        for (const m of traitMethods) {
          m.selfType = receiverTypeName;
          entry.methods.push(m);
        }
        entry.traitImpls.push(first.value);
        entry.impls.push({
          signature: `impl(${[...signatureParts, traitSignature].join(", ")})`,
          traitName: first.value,
          methodNames: traitMethodNames,
          associatedTypes:
            traitAssocTypes.length > 0 ? traitAssocTypes : undefined,
        });
      }

      current = argEnd;
      if (current < toks.length && toks[current]!.type === TokenType.Comma)
        current++;
    }

    if (anonymousMethodNames.length > 0) {
      entry.impls.push({
        signature: `impl(${signatureParts.join(", ")}, ...)`,
        methodNames: anonymousMethodNames,
      });
    }

    i = implEnd - 1;
  }

  return result;
}

// ── Main builder ─────────────────────────────────────────────────────

export interface BuildDocModuleOptions {
  /** The module name (e.g., "array_list") */
  name: string;
  /** The module path (e.g., "std/collections/array_list") */
  path: string;
  /** The evaluated module value */
  moduleValue: StructValue;
  /** The extracted doc comments */
  extraction: DocExtractionResult;
  /** The raw tokens (for future position-based matching) */
  tokens: Token[];
  /** Final evaluation environment for impl/method lookup */
  env?: Environment;
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
  const { name, path, moduleValue, extraction, tokens, env } = options;
  const docLookup = buildDocLookup(extraction);
  const traitImplMap = extractTraitImplsFromTokens(tokens);
  const tokenImplInfoMap = extractImplInfoFromTokens(tokens, docLookup);

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

  const sourceNamespaceType = moduleValue.type;
  if (!isSourceNamespaceType(sourceNamespaceType)) return result;

  for (let i = 0; i < sourceNamespaceType.fields.length; i++) {
    const field = sourceNamespaceType.fields[i]!;
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
        const directMethods = extractMethods(
          structType.trait,
          fieldName,
          docLookup
        );
        const tokenImplInfo = tokenImplInfoMap.get(fieldName);
        const genericImplInfo = extractGenericImplInfo({
          concreteType: structType,
          typeName: fieldName,
          docLookup,
          env,
        });
        result.types.push({
          name: fieldName,
          doc,
          kind,
          signature: typeToString(actualType),
          typeParams: getTypeConstructorParams(field),
          fields: typeFieldsToDocFields(structType.fields, docLookup),
          methods: mergeMethods(
            mergeMethods(directMethods, genericImplInfo.methods),
            tokenImplInfo?.methods ?? []
          ),
          traitImpls: mergeTraitImplNames(
            mergeTraitImplNames(
              traitImplMap.get(fieldName) ?? [],
              genericImplInfo.traitImpls
            ),
            tokenImplInfo?.traitImpls ?? []
          ),
          impls: [...genericImplInfo.impls, ...(tokenImplInfo?.impls ?? [])],
          ...extractDocSections(doc),
        });
        continue;
      }

      if (isEnumType(actualType)) {
        const enumType = actualType as EnumType;
        const directMethods = extractMethods(
          enumType.trait,
          fieldName,
          docLookup
        );
        const tokenImplInfo = tokenImplInfoMap.get(fieldName);
        const genericImplInfo = extractGenericImplInfo({
          concreteType: enumType,
          typeName: fieldName,
          docLookup,
          env,
        });
        result.types.push({
          name: fieldName,
          doc,
          kind: "enum",
          signature: typeToString(actualType),
          typeParams: getTypeConstructorParams(field),
          variants: enumVariantsToDocVariants(enumType.variants, docLookup),
          methods: mergeMethods(
            mergeMethods(directMethods, genericImplInfo.methods),
            tokenImplInfo?.methods ?? []
          ),
          traitImpls: mergeTraitImplNames(
            mergeTraitImplNames(
              traitImplMap.get(fieldName) ?? [],
              genericImplInfo.traitImpls
            ),
            tokenImplInfo?.traitImpls ?? []
          ),
          impls: [...genericImplInfo.impls, ...(tokenImplInfo?.impls ?? [])],
          ...extractDocSections(doc),
        });
        continue;
      }

      if (isUnionType(actualType)) {
        const unionType = actualType as UnionType;
        const tokenImplInfo = tokenImplInfoMap.get(fieldName);
        const genericImplInfo = extractGenericImplInfo({
          concreteType: unionType,
          typeName: fieldName,
          docLookup,
          env,
        });
        result.types.push({
          name: fieldName,
          doc,
          kind: "union",
          signature: typeToString(actualType),
          typeParams: getTypeConstructorParams(field),
          fields: typeFieldsToDocFields(unionType.fields, docLookup),
          methods: mergeMethods(
            genericImplInfo.methods,
            tokenImplInfo?.methods ?? []
          ),
          traitImpls: mergeTraitImplNames(
            mergeTraitImplNames(
              traitImplMap.get(fieldName) ?? [],
              genericImplInfo.traitImpls
            ),
            tokenImplInfo?.traitImpls ?? []
          ),
          impls: [...genericImplInfo.impls, ...(tokenImplInfo?.impls ?? [])],
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

      if (isSourceNamespaceType(actualType)) {
        const directNamespaceType = actualType as SourceNamespaceType;
        const moduleMethods: DocFunction[] = [];
        for (const mField of directNamespaceType.fields) {
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
          const directMethods = extractMethods(
            structType.trait,
            fieldName,
            docLookup
          );
          const tokenImplInfo = tokenImplInfoMap.get(fieldName);
          const genericImplInfo = extractGenericImplInfo({
            concreteType: structType,
            typeName: fieldName,
            docLookup,
            env,
          });
          result.types.push({
            name: fieldName,
            doc,
            kind: getTypeKind(structType),
            signature: typeToString(field.type),
            typeParams: getTypeConstructorParams(field),
            fields: typeFieldsToDocFields(structType.fields, docLookup),
            methods: mergeMethods(
              mergeMethods(directMethods, genericImplInfo.methods),
              tokenImplInfo?.methods ?? []
            ),
            traitImpls: mergeTraitImplNames(
              mergeTraitImplNames(
                traitImplMap.get(fieldName) ?? [],
                genericImplInfo.traitImpls
              ),
              tokenImplInfo?.traitImpls ?? []
            ),
            impls: [...genericImplInfo.impls, ...(tokenImplInfo?.impls ?? [])],
            ...extractDocSections(doc),
          });
        } else if (isEnumType(innerType)) {
          const enumType = innerType as EnumType;
          const directMethods = extractMethods(
            enumType.trait,
            fieldName,
            docLookup
          );
          const tokenImplInfo = tokenImplInfoMap.get(fieldName);
          const genericImplInfo = extractGenericImplInfo({
            concreteType: enumType,
            typeName: fieldName,
            docLookup,
            env,
          });
          result.types.push({
            name: fieldName,
            doc,
            kind: "enum",
            signature: typeToString(field.type),
            typeParams: getTypeConstructorParams(field),
            variants: enumVariantsToDocVariants(enumType.variants, docLookup),
            methods: mergeMethods(
              mergeMethods(directMethods, genericImplInfo.methods),
              tokenImplInfo?.methods ?? []
            ),
            traitImpls: mergeTraitImplNames(
              mergeTraitImplNames(
                traitImplMap.get(fieldName) ?? [],
                genericImplInfo.traitImpls
              ),
              tokenImplInfo?.traitImpls ?? []
            ),
            impls: [...genericImplInfo.impls, ...(tokenImplInfo?.impls ?? [])],
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
        } else if (isSourceNamespaceType(innerType)) {
          const resolvedNamespaceType = innerType as SourceNamespaceType;
          const moduleMethods: DocFunction[] = [];
          for (const mField of resolvedNamespaceType.fields) {
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
          // Check if the function returns comptime(Trait) or another comptime type record.
          const funcType = field.type as FunctionType;
          const retType = funcType.return.type;
          if (
            isTypeHierarchyType(retType) &&
            retType.level >= 1 &&
            (!retType.baseType ||
              isTraitType(retType.baseType) ||
              isSourceNamespaceType(retType.baseType))
          ) {
            result.traits.push({
              name: fieldName,
              doc,
              kind:
                retType.baseType && isSourceNamespaceType(retType.baseType)
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
            const tokenImplInfo = tokenImplInfoMap.get(fieldName);
            const genericImplInfo = extractGenericImplInfo({
              concreteType: field.type,
              typeName: fieldName,
              docLookup,
              env,
            });
            result.types.push({
              name: fieldName,
              doc,
              kind: "type-function",
              signature: typeToString(field.type),
              typeParams: getTypeConstructorParams(field),
              methods: mergeMethods(
                genericImplInfo.methods,
                tokenImplInfo?.methods ?? []
              ),
              traitImpls: mergeTraitImplNames(
                mergeTraitImplNames(
                  traitImplMap.get(fieldName) ?? [],
                  genericImplInfo.traitImpls
                ),
                tokenImplInfo?.traitImpls ?? []
              ),
              impls: [
                ...genericImplInfo.impls,
                ...(tokenImplInfo?.impls ?? []),
              ],
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
