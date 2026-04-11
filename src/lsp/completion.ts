import type { CompletionItem } from "vscode-languageserver";
import { CompletionItemKind, MarkupKind } from "vscode-languageserver";
import { getVariablesFromEnv, type Environment } from "../env";
import { enumerateMethodNamesFromGenericImpls } from "../evaluator/values/impl";
import {
  type AtomExpr,
  type Expr,
  type FnCallExpr,
  BuiltinFunctions,
  BuiltinKeywords,
  exprIsAtom,
  exprIsFunctionCall,
} from "../expr";
import { TokenType, type Token } from "../token";
import type { Type } from "../types/definitions";
import {
  isArrayType,
  isEnumType,
  isFunctionType,
  isModuleType,
  isPtrType,
  isSliceType,
  isStructType,
  isTypeHierarchyType,
  isUnionType,
} from "../types/guards";
import { TypeTag } from "../types/tags";
import { typeToString } from "../types/utils";
import {
  isFunctionValue,
  isTraitValue,
  isTypeValue,
  valueToString,
} from "../value";
import type { Value } from "../value";
import type { LspDocumentManager } from "./document-manager";

/** Cached set of basic keywords */
let cachedBasicKeywords: string[] | null = null;

function getBasicKeywords(): string[] {
  if (cachedBasicKeywords) return cachedBasicKeywords;
  const keywords: string[] = [];
  for (const keyword of Object.keys(BuiltinKeywords) as Array<
    keyof typeof BuiltinKeywords
  >) {
    keywords.push(...BuiltinKeywords[keyword]);
  }
  for (const keyword of Object.keys(BuiltinFunctions) as Array<
    keyof typeof BuiltinFunctions
  >) {
    keywords.push(...BuiltinFunctions[keyword]);
  }
  for (const key of Object.keys(TypeTag) as Array<keyof typeof TypeTag>) {
    keywords.push(TypeTag[key]);
  }
  cachedBasicKeywords = keywords;
  return keywords;
}

/**
 * Handle textDocument/completion requests.
 */
export function handleCompletion(
  uri: string,
  line: number,
  character: number,
  lineText: string,
  docManager: LspDocumentManager
): CompletionItem[] {
  const module = docManager.getModule(uri);
  if (!module) {
    return getKeywordCompletions("");
  }

  // Check for dot-completion — allow even when module has errors,
  // since the error is often caused by the incomplete `expr.` being typed
  const textUpToCursor = lineText.substring(0, character);
  const isDotCompletion = textUpToCursor.endsWith(".");

  if (isDotCompletion) {
    // Try current module first
    const items = handleDotCompletion(module, line, character, lineText);
    if (items.length > 0) return items;

    // Fall back to last good module — the current evaluation may have lost
    // inner scope type info due to the incomplete `expr.` expression
    const lastGood = docManager.getLastGoodModule(uri);
    if (lastGood && lastGood !== module) {
      return handleDotCompletion(lastGood, line, character, lineText);
    }
    return items;
  }

  // For non-dot completion, bail if module has errors
  if (module.moduleError) {
    return getKeywordCompletions("");
  }

  // Regular completion: collect variables in scope + keywords
  const prefix = extractPrefix(lineText, character);
  return handleIdentifierCompletion(module, line, character, prefix);
}

/**
 * Extract the word prefix at the cursor position.
 */
function extractPrefix(lineText: string, character: number): string {
  let start = character;
  while (start > 0 && /[a-zA-Z0-9_]/.test(lineText[start - 1]!)) {
    start--;
  }
  return lineText.substring(start, character);
}

/**
 * Provide basic keyword completion items.
 */
function getKeywordCompletions(prefix: string): CompletionItem[] {
  const items: CompletionItem[] = [];
  const lowerPrefix = prefix.toLowerCase();
  for (const keyword of getBasicKeywords()) {
    if (keyword.toLowerCase().includes(lowerPrefix)) {
      items.push({
        label: keyword,
        kind: CompletionItemKind.Keyword,
        sortText: keyword.toLowerCase().startsWith(lowerPrefix)
          ? `0_${keyword}`
          : `1_${keyword}`,
      });
    }
  }
  return items;
}

/**
 * Handle identifier (non-dot) completion.
 */
function handleIdentifierCompletion(
  module: { evaluator: { getProgram(): Expr[]; getTokens(): Token[] } },
  line: number,
  character: number,
  prefix: string
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const lowerPrefix = prefix.toLowerCase();

  try {
    const program = module.evaluator.getProgram();
    const candidateVariables = new Map<string, AtomExpr[]>();

    const extractVariables = (expr: Expr) => {
      if (exprIsAtom(expr)) {
        if (expr.token.type === TokenType.Identifier) {
          const tokenLine = expr.token.position.row;
          const tokenColumn = expr.token.position.column;
          const isBeforeCursor =
            tokenLine < line || (tokenLine === line && tokenColumn < character);
          if (!isBeforeCursor) return;

          const name = expr.token.value;
          if (name.toLowerCase().includes(lowerPrefix)) {
            if (!candidateVariables.has(name)) {
              candidateVariables.set(name, []);
            }
            candidateVariables.get(name)!.push(expr);
          }
        }
      } else if (exprIsFunctionCall(expr)) {
        const funcCallExpr = expr as FnCallExpr;
        extractVariables(funcCallExpr.func);
        for (const arg of funcCallExpr.args) {
          extractVariables(arg);
        }
      }
    };

    for (const expr of program) {
      extractVariables(expr);
    }

    for (const [varName, candidates] of candidateVariables) {
      // Select best candidate: prefer with eval info, closest to cursor
      candidates.sort((a, b) => {
        const aBeforeCursor = a.token.position.row < line;
        const bBeforeCursor = b.token.position.row < line;
        if (aBeforeCursor && bBeforeCursor) {
          return b.token.position.row - a.token.position.row;
        }
        if (aBeforeCursor !== bBeforeCursor) {
          return bBeforeCursor ? 1 : -1;
        }
        const aHasEval = a.$ ? 1 : 0;
        const bHasEval = b.$ ? 1 : 0;
        return bHasEval - aHasEval;
      });

      const best = candidates[0]!;
      const kind = isFunctionType(best.$?.type)
        ? CompletionItemKind.Function
        : CompletionItemKind.Variable;

      let detail = "";
      if (best.$?.type) {
        try {
          detail = typeToString(best.$.type);
        } catch {
          /* ignore */
        }
      }

      let docComment: string | undefined;
      if (best.$?.env) {
        try {
          const variables = getVariablesFromEnv(best.$.env, varName);
          if (variables && variables.length > 0) {
            docComment = variables[variables.length - 1]?.docComment;
          }
        } catch {
          /* ignore */
        }
      }
      if (!docComment) {
        docComment = best.$?.docComment;
      }

      const item: CompletionItem = {
        label: varName,
        kind,
        detail: detail || undefined,
        sortText: varName.toLowerCase().startsWith(lowerPrefix)
          ? `0_${varName}`
          : `1_${varName}`,
      };

      if (docComment) {
        item.documentation = { kind: MarkupKind.Markdown, value: docComment };
      } else if (best.$?.value) {
        try {
          item.documentation = `Value: ${valueToString(best.$.value)}`;
        } catch {
          /* ignore */
        }
      }

      items.push(item);
    }

    // Add keywords
    items.push(...getKeywordCompletions(prefix));
  } catch {
    return getKeywordCompletions(prefix);
  }

  return items;
}

/**
 * Handle dot-completion (method and field access).
 */
function handleDotCompletion(
  module: { evaluator: { getProgram(): Expr[]; getTokens(): Token[] } },
  line: number,
  character: number,
  lineText: string
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const dotPosition = character - 1;

  try {
    const tokens = module.evaluator.getTokens();
    const program = module.evaluator.getProgram();

    // Find the token right before the dot
    let tokenBeforeDot = tokens.find((token) => {
      const tokenEnd = token.position.column + token.value.length;
      return (
        token.position.row === line &&
        token.type !== TokenType.Whitespace &&
        token.type !== TokenType.SingleLineComment &&
        token.type !== TokenType.MultiLineComment &&
        tokenEnd === dotPosition
      );
    });

    if (!tokenBeforeDot) {
      // Fallback: parse the identifier before the dot from the text
      const textBeforeDot = lineText.substring(0, dotPosition).trim();
      if (textBeforeDot && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(textBeforeDot)) {
        const candidateTokens = tokens.filter(
          (t) =>
            t.value === textBeforeDot &&
            t.type === TokenType.Identifier &&
            t.position.row < line
        );
        if (candidateTokens.length > 0) {
          candidateTokens.sort((a, b) => b.position.row - a.position.row);
          tokenBeforeDot = candidateTokens[0];
        }
      }
      if (!tokenBeforeDot) return items;
    }

    // Find the expression for this token
    let targetExpr: Expr | null = null;
    const findExprByToken = (expr: Expr): boolean => {
      if (exprIsAtom(expr)) {
        if (
          expr.token.position.row === tokenBeforeDot!.position.row &&
          expr.token.position.column === tokenBeforeDot!.position.column &&
          expr.token.value === tokenBeforeDot!.value
        ) {
          targetExpr = expr;
          return true;
        }
      } else if (exprIsFunctionCall(expr)) {
        const funcCallExpr = expr as FnCallExpr;
        if (findExprByToken(funcCallExpr.func)) return true;
        for (const arg of funcCallExpr.args) {
          if (findExprByToken(arg)) return true;
        }
      }
      return false;
    };

    for (const expr of program) {
      if (findExprByToken(expr)) break;
    }

    // Fallback: search by variable name
    if (!targetExpr && tokenBeforeDot.type === TokenType.Identifier) {
      for (const expr of program) {
        const result = findVariableInScope(expr, tokenBeforeDot.value, line);
        if (result) {
          targetExpr = result;
          break;
        }
      }
    }

    // Extract the type
    const variableType = extractTypeFromExpr(
      targetExpr,
      tokenBeforeDot,
      line,
      program
    );
    if (!variableType) return items;

    const originalReceiverType = variableType;

    // Auto-dereference pointer types for field access
    let fieldAccessType = variableType;
    while (isPtrType(fieldAccessType)) {
      fieldAccessType = fieldAccessType.childType;
    }

    // Collect methods/fields
    const members: {
      name: string;
      detail: string;
      documentation: string;
      kind: CompletionItemKind;
    }[] = [];

    if (isArrayType(fieldAccessType)) {
      members.push({
        name: "len",
        detail: "comptime(usize)",
        documentation: "Get the compile-time known length of the array",
        kind: CompletionItemKind.Property,
      });
    } else if (isSliceType(fieldAccessType)) {
      members.push({
        name: "len",
        detail: "usize",
        documentation: "Get the runtime length of the slice",
        kind: CompletionItemKind.Property,
      });
    } else if (isStructType(fieldAccessType)) {
      for (const element of fieldAccessType.fields) {
        const docComment = element.docComment;
        members.push({
          name: element.label,
          detail: typeToString(element.type),
          documentation:
            docComment ||
            `Field: ${element.label} : ${typeToString(element.type)}`,
          kind: CompletionItemKind.Field,
        });
      }
    } else if (isEnumType(fieldAccessType)) {
      for (const variant of fieldAccessType.variants) {
        members.push({
          name: variant.name,
          detail: variant.fields
            ? `(${variant.fields.map((e) => typeToString(e.type)).join(", ")})`
            : "()",
          documentation: `Variant: ${variant.name}`,
          kind: CompletionItemKind.EnumMember,
        });
      }
    } else if (isUnionType(fieldAccessType)) {
      for (const element of fieldAccessType.fields) {
        members.push({
          name: element.label,
          detail: typeToString(element.type),
          documentation: `Field: ${element.label} : ${typeToString(element.type)}`,
          kind: CompletionItemKind.Field,
        });
      }
    }

    // Collect methods from trait fields and generic impl registry
    if (targetExpr && exprIsAtom(targetExpr)) {
      const env = (targetExpr as AtomExpr).$?.env;
      if (env) {
        addAllMethods(members, env, fieldAccessType, originalReceiverType);
      }
    } else if (fieldAccessType.trait) {
      // No env available — collect what we can from direct trait fields
      addDirectTraitMethods(members, fieldAccessType);
    }

    // Convert to completion items, filtering out internal symbols
    const seenNames = new Set<string>();
    for (const member of members) {
      if (seenNames.has(member.name)) continue;
      // Skip internal compiler-generated methods
      if (member.name.startsWith("___") || member.name.startsWith("__yo_"))
        continue;
      seenNames.add(member.name);
      items.push({
        label: member.name,
        kind: member.kind,
        detail: member.detail,
        documentation: member.documentation,
        sortText: `0_${member.name}`,
      });
    }
  } catch (error) {
    // Return empty on error
  }

  return items;
}

function findVariableInScope(
  expr: Expr,
  name: string,
  currentLine: number
): AtomExpr | null {
  if (exprIsAtom(expr)) {
    if (
      expr.token.type === TokenType.Identifier &&
      expr.token.value === name &&
      expr.$?.type &&
      expr.token.position.row < currentLine
    ) {
      return expr;
    }
  } else if (exprIsFunctionCall(expr)) {
    const funcCallExpr = expr as FnCallExpr;
    const result = findVariableInScope(funcCallExpr.func, name, currentLine);
    if (result) return result;
    for (const arg of funcCallExpr.args) {
      const r = findVariableInScope(arg, name, currentLine);
      if (r) return r;
    }
  }
  return null;
}

/**
 * If the variable type is the `Type` meta-type and the value is a TypeValue,
 * unwrap to the inner type so `Point.` shows methods/fields of the actual type.
 */
function unwrapTypeValueIfNeeded(type: Type, value?: [Value]): Type {
  if (isTypeHierarchyType(type) && value && value[0] && isTypeValue(value[0])) {
    return value[0].value;
  }
  return type;
}

function extractTypeFromExpr(
  targetExpr: Expr | null,
  tokenBeforeDot: Token,
  currentLine: number,
  program: Expr[]
): Type | null {
  if (targetExpr) {
    if (exprIsAtom(targetExpr)) {
      const atomExpr = targetExpr as AtomExpr;
      if (atomExpr.$?.type) {
        // If the type is `Type` (meta-type) and the value is a TypeValue,
        // unwrap to the inner type so `Point.` shows methods/fields of Point
        if (
          isTypeHierarchyType(atomExpr.$.type) &&
          atomExpr.$.value &&
          isTypeValue(atomExpr.$.value)
        ) {
          return atomExpr.$.value.value;
        }
        return atomExpr.$.type;
      }
      if (atomExpr.$?.env) {
        try {
          const variables = getVariablesFromEnv(
            atomExpr.$.env,
            atomExpr.token.value
          );
          if (variables && variables.length > 0) {
            const variable = variables[variables.length - 1];
            if (variable) {
              return unwrapTypeValueIfNeeded(variable.type, variable.value);
            }
          }
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Fallback: environment-based lookup
  if (tokenBeforeDot.type !== TokenType.Identifier) return null;

  let bestEnv: Environment | null = null;
  let bestExprPosition = -1;

  const findBestEnv = (expr: Expr) => {
    if (exprIsAtom(expr)) {
      if (
        expr.$?.env &&
        expr.token.position.row < currentLine &&
        expr.token.position.row > bestExprPosition
      ) {
        bestEnv = expr.$.env;
        bestExprPosition = expr.token.position.row;
      }
    } else if (exprIsFunctionCall(expr)) {
      const funcCallExpr = expr as FnCallExpr;
      findBestEnv(funcCallExpr.func);
      for (const arg of funcCallExpr.args) {
        findBestEnv(arg);
      }
    }
  };
  for (const expr of program) {
    findBestEnv(expr);
  }

  if (!bestEnv) return null;

  try {
    const variables = getVariablesFromEnv(bestEnv, tokenBeforeDot.value);
    if (!variables || variables.length === 0) return null;

    const localVariables = variables.filter((v) => {
      if (v.initializedAtToken) {
        const varRow = v.initializedAtToken.position.row;
        return varRow > 2 && varRow < currentLine;
      }
      return false;
    });

    if (localVariables.length > 0) {
      const variable = localVariables[localVariables.length - 1];
      if (variable) {
        return unwrapTypeValueIfNeeded(variable.type, variable.value);
      }
    }
  } catch {
    /* ignore */
  }

  return null;
}

/**
 * Add all methods available on a type, from three sources:
 * 1. Direct trait fields (from anonymous impl blocks — flattened onto receiverType.trait)
 * 2. Named trait impl entries (stored with label="" and TraitValue assignedValue)
 * 3. Generic impl registry (for generic impl blocks like `impl(forall(T), ArrayList(T), ...)`)
 */
function addAllMethods(
  members: {
    name: string;
    detail: string;
    documentation: string;
    kind: CompletionItemKind;
  }[],
  env: Environment,
  fieldAccessType: Type,
  originalReceiverType: Type
): void {
  const seenNames = new Set(members.map((m) => m.name));

  function addMethod(name: string, type: Type, docComment?: string): void {
    if (seenNames.has(name)) return;
    seenNames.add(name);
    try {
      members.push({
        name,
        detail: typeToString(type),
        documentation: docComment || `Method ${name}`,
        kind: CompletionItemKind.Method,
      });
    } catch {
      members.push({
        name,
        detail: "",
        documentation: docComment || `Method ${name}`,
        kind: CompletionItemKind.Method,
      });
    }
  }

  // Source 1 & 2: Walk trait fields on the type
  if (fieldAccessType.trait) {
    for (const f of fieldAccessType.trait.fields) {
      // Direct function-typed fields (from anonymous impl blocks)
      if (f.label && isFunctionType(f.type)) {
        addMethod(f.label, f.type, f.docComment);
      }
      // Module-typed fields
      else if (f.label && isModuleType(f.type)) {
        addMethod(f.label, f.type, f.docComment);
      }
      // Named trait impl entries (stored with label="" and TraitValue assignedValue)
      else if (
        f.label === "" &&
        f.assignedValue &&
        isTraitValue(f.assignedValue)
      ) {
        const traitVal = f.assignedValue;
        const traitType = traitVal.type;
        for (let i = 0; i < traitType.fields.length; i++) {
          const sf = traitType.fields[i]!;
          if (sf.label && isFunctionType(sf.type)) {
            const value = traitVal.fields[i];
            const methodType =
              isFunctionValue(value) && value.specializedType
                ? value.specializedType
                : sf.type;
            addMethod(sf.label, methodType, sf.docComment);
          }
        }
      }
    }
  }

  // Source 3: Generic impl registry
  try {
    const genericMethods = enumerateMethodNamesFromGenericImpls({
      concreteType: originalReceiverType,
      env,
    });
    for (const m of genericMethods) {
      addMethod(m.name, m.type);
    }
  } catch {
    /* ignore — generic impl matching can fail on incomplete types */
  }
}

/**
 * Fallback: add methods from direct trait fields only (no env available).
 */
function addDirectTraitMethods(
  members: {
    name: string;
    detail: string;
    documentation: string;
    kind: CompletionItemKind;
  }[],
  fieldAccessType: Type
): void {
  if (!fieldAccessType.trait) return;
  const seenNames = new Set(members.map((m) => m.name));

  for (const f of fieldAccessType.trait.fields) {
    if (f.label && isFunctionType(f.type) && !seenNames.has(f.label)) {
      seenNames.add(f.label);
      const doc = f.docComment || `Method ${f.label}`;
      try {
        members.push({
          name: f.label,
          detail: typeToString(f.type),
          documentation: doc,
          kind: CompletionItemKind.Method,
        });
      } catch {
        members.push({
          name: f.label,
          detail: "",
          documentation: doc,
          kind: CompletionItemKind.Method,
        });
      }
    }
  }
}
