import type { CompletionItem } from "vscode-languageserver";
import { CompletionItemKind, MarkupKind } from "vscode-languageserver";
import {
  getReceiverMethodsByNameFromEnv,
  getVariablesFromEnv,
  type Environment,
} from "../env";
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
import { areTypesCompatible } from "../types/compatibility";
import type { Type } from "../types/definitions";
import {
  isArrayType,
  isEnumType,
  isFunctionType,
  isPtrType,
  isSliceType,
  isStructType,
  isUnionType,
} from "../types/guards";
import { TypeTag } from "../types/tags";
import { typeToString } from "../types/utils";
import { valueToString } from "../value";
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
  if (!module || module.moduleError) {
    return getKeywordCompletions("");
  }

  // Check for dot-completion
  const textUpToCursor = lineText.substring(0, character);
  const isDotCompletion = textUpToCursor.endsWith(".");

  if (isDotCompletion) {
    return handleDotCompletion(module, line, character, lineText);
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
    const methods: { name: string; detail: string; documentation: string }[] =
      [];

    if (isArrayType(fieldAccessType)) {
      methods.push({
        name: "len",
        detail: "comptime(usize)",
        documentation: "Get the compile-time known length of the array",
      });
    } else if (isSliceType(fieldAccessType)) {
      methods.push({
        name: "len",
        detail: "usize",
        documentation: "Get the runtime length of the slice",
      });
    } else if (isStructType(fieldAccessType)) {
      for (const element of fieldAccessType.fields) {
        methods.push({
          name: element.label,
          detail: typeToString(element.type),
          documentation: `Field: ${element.label} : ${typeToString(element.type)}`,
        });
      }
    } else if (isEnumType(fieldAccessType)) {
      for (const variant of fieldAccessType.variants) {
        methods.push({
          name: variant.name,
          detail: variant.fields
            ? `(${variant.fields.map((e) => typeToString(e.type)).join(", ")})`
            : "()",
          documentation: `Variant: ${variant.name}`,
        });
      }
    } else if (isUnionType(fieldAccessType)) {
      for (const element of fieldAccessType.fields) {
        methods.push({
          name: element.label,
          detail: typeToString(element.type),
          documentation: `Field: ${element.label} : ${typeToString(element.type)}`,
        });
      }
    }

    // Try receiver method lookup from environment
    if (targetExpr && exprIsAtom(targetExpr)) {
      const env = (targetExpr as AtomExpr).$?.env;
      if (env) {
        addReceiverMethods(methods, env, originalReceiverType);
      }
    }

    // Check trait methods
    if (fieldAccessType.trait) {
      let env: Environment | null = null;
      if (targetExpr && exprIsAtom(targetExpr)) {
        env = (targetExpr as AtomExpr).$?.env ?? null;
      }
      addTraitMethods(
        methods,
        fieldAccessType as Type & { trait: NonNullable<Type["trait"]> },
        originalReceiverType,
        env
      );
    }

    // Convert to completion items
    const seenNames = new Set<string>();
    for (const method of methods) {
      if (seenNames.has(method.name)) continue;
      seenNames.add(method.name);
      items.push({
        label: method.name,
        kind: CompletionItemKind.Method,
        detail: method.detail,
        documentation: method.documentation,
        sortText: `0_${method.name}`,
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

function extractTypeFromExpr(
  targetExpr: Expr | null,
  tokenBeforeDot: Token,
  currentLine: number,
  program: Expr[]
): Type | null {
  if (targetExpr) {
    if (exprIsAtom(targetExpr)) {
      const atomExpr = targetExpr as AtomExpr;
      if (atomExpr.$?.type) return atomExpr.$.type;
      if (atomExpr.$?.env) {
        try {
          const variables = getVariablesFromEnv(
            atomExpr.$.env,
            atomExpr.token.value
          );
          if (variables && variables.length > 0) {
            return variables[variables.length - 1]?.type ?? null;
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
      return localVariables[localVariables.length - 1]?.type ?? null;
    }
  } catch {
    /* ignore */
  }

  return null;
}

const COMMON_METHOD_NAMES = [
  "is_atom",
  "is_fn_call",
  "get_callee",
  "get_args",
  "cons",
  "to_string",
  "clone",
  "equals",
  "map",
  "filter",
  "fold",
  "len",
  "head",
  "tail",
];

function addReceiverMethods(
  methods: { name: string; detail: string; documentation: string }[],
  env: Environment,
  receiverType: Type
): void {
  for (const methodName of COMMON_METHOD_NAMES) {
    try {
      const foundMethods = getReceiverMethodsByNameFromEnv({
        env,
        methodName,
        receiverType,
        context: { stdPath: env.modulePath },
      });
      if (!foundMethods || foundMethods.length === 0) continue;

      for (const method of foundMethods) {
        if (!method || !isFunctionType(method.type)) continue;

        if (method.type.parameters.length > 0) {
          const firstParamType = method.type.parameters[0]!.type;
          try {
            if (
              areTypesCompatible(
                { type: receiverType, env },
                { type: firstParamType, env }
              )
            ) {
              methods.push({
                name: methodName,
                detail: typeToString(method.type),
                documentation: `Method ${methodName}`,
              });
            }
          } catch {
            methods.push({
              name: methodName,
              detail: typeToString(method.type),
              documentation: `Method ${methodName}`,
            });
          }
        } else {
          methods.push({
            name: methodName,
            detail: typeToString(method.type),
            documentation: `Method ${methodName}`,
          });
        }
      }
    } catch {
      /* ignore */
    }
  }
}

function addTraitMethods(
  methods: { name: string; detail: string; documentation: string }[],
  fieldAccessType: Type & { trait: NonNullable<Type["trait"]> },
  originalReceiverType: Type,
  env: Environment | null
): void {
  for (const element of fieldAccessType.trait.fields) {
    if (!isFunctionType(element.type)) continue;

    if (element.type.parameters.length > 0 && env) {
      const firstParamType = element.type.parameters[0]!.type;
      try {
        if (
          areTypesCompatible(
            { type: originalReceiverType, env },
            { type: firstParamType, env }
          )
        ) {
          methods.push({
            name: element.label,
            detail: typeToString(element.type),
            documentation: `Method ${element.label}`,
          });
        }
      } catch {
        methods.push({
          name: element.label,
          detail: typeToString(element.type),
          documentation: `Method ${element.label}`,
        });
      }
    } else {
      methods.push({
        name: element.label,
        detail: typeToString(element.type),
        documentation: `Method ${element.label}`,
      });
    }
  }
}
