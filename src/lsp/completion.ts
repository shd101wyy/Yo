import type { CompletionItem } from "vscode-languageserver";
import {
  CompletionItemKind,
  InsertTextFormat,
  MarkupKind,
} from "vscode-languageserver";
import * as fs from "node:fs";
import * as path from "node:path";
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
import { stringIsOperator, TokenType, type Token } from "../token";
import type { FunctionType, Type } from "../types/definitions";
import {
  isArrayType,
  isBoxedType,
  isEnumType,
  isFunctionType,
  isSourceNamespaceType,
  isPtrType,
  isStructType,
  isTraitType,
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
import { selectBestVariableAtPosition } from "./utils";

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
  // Check for import path completion first (works even without a valid module)
  const textUpToCursor = lineText.substring(0, character);
  const importPathItems = handleImportPathCompletion(
    textUpToCursor,
    uri,
    docManager
  );
  if (importPathItems.length > 0) return importPathItems;

  const module = docManager.getModule(uri);
  if (!module) {
    return getKeywordCompletions("");
  }

  // Check for dot-completion — allow even when module has errors,
  // since the error is often caused by the incomplete `expr.` being typed

  const isDotCompletion = textUpToCursor.endsWith(".");

  if (isDotCompletion) {
    // Check if this is enum variant dot-prefix completion (e.g., `.Some`, `.None`)
    // triggered by `.` after `=`, `=>`, `(`, `,`, `return`, or at start of expression
    const textBeforeDot = textUpToCursor.slice(0, -1).trimEnd();
    const isEnumDotPrefix =
      textBeforeDot.length === 0 ||
      textBeforeDot.endsWith("=") ||
      textBeforeDot.endsWith("(") ||
      textBeforeDot.endsWith(",") ||
      textBeforeDot.endsWith("return") ||
      textBeforeDot.endsWith("{") ||
      textBeforeDot.endsWith(";");

    if (isEnumDotPrefix) {
      const mod = docManager.getLastGoodModule(uri) ?? module;
      const enumItems = handleEnumVariantCompletion(mod, line, character);
      if (enumItems.length > 0) return enumItems;
    }

    // Try current module first
    const items = handleDotCompletion(module, line, character, lineText);
    if (items.length > 0) return items;

    // Fall back to last good module — the current evaluation may have lost
    // inner scope type info due to the incomplete `expr.` expression
    const lastGood = docManager.getLastGoodModule(uri);
    if (lastGood && lastGood !== module) {
      const lastGoodItems = handleDotCompletion(
        lastGood,
        line,
        character,
        lineText
      );
      if (lastGoodItems.length > 0) return lastGoodItems;
    }

    // Last resort: text-based type resolution for expressions like `Option(i32).`
    // Parse the text before the dot and try to resolve the type from available envs
    if (textBeforeDot) {
      const currentTextItems = handleTextBasedDotCompletion(
        module,
        textBeforeDot,
        line,
        character
      );
      if (currentTextItems.length > 0) return currentTextItems;
      if (lastGood && lastGood !== module) {
        const lastGoodTextItems = handleTextBasedDotCompletion(
          lastGood,
          textBeforeDot,
          line,
          character
        );
        if (lastGoodTextItems.length > 0) return lastGoodTextItems;
      }
    }
    return items;
  }

  // For non-dot completion, try to provide identifier completions
  // even when the module has errors by using the last good module
  if (module.moduleError) {
    const prefix = extractPrefix(lineText, character);
    // Try the current errored module first — it may have partial env info
    const currentItems = handleIdentifierCompletion(
      module,
      line,
      character,
      prefix
    );
    if (currentItems.length > 0) return currentItems;
    // Fall back to last good module
    const lastGood = docManager.getLastGoodModule(uri);
    if (lastGood) {
      const items = handleIdentifierCompletion(
        lastGood,
        line,
        character,
        prefix
      );
      if (items.length > 0) return items;
    }
    return getKeywordCompletions(prefix);
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
    if (keyword.startsWith("___") || keyword.startsWith("__yo_")) continue;
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
 * Handle import path completion (e.g., `import("std/` or `import("./`).
 * Provides file/directory completions for import paths.
 */
function handleImportPathCompletion(
  textUpToCursor: string,
  uri: string,
  docManager: LspDocumentManager
): CompletionItem[] {
  // Match strict syntax (`import("std/...`) and tolerate the legacy spacing
  // form so completion still works while editing older files.
  const importMatch = textUpToCursor.match(
    /import(?:\s+|\s*\(\s*)"([^"]*?)([^"/]*)$/
  );
  if (!importMatch) return [];

  const fullPath = importMatch[1]! + importMatch[2]!;
  const prefix = importMatch[2]!;

  let basePath: string;
  if (fullPath.startsWith("std/")) {
    // Resolve from std library
    const stdPath = docManager.getStdPath();
    if (!stdPath) return [];
    const subPath = fullPath.slice(4); // Remove "std/"
    const lastSlash = subPath.lastIndexOf("/");
    if (lastSlash >= 0) {
      basePath = path.join(stdPath, subPath.slice(0, lastSlash));
    } else {
      basePath = stdPath;
    }
  } else if (fullPath.startsWith("./") || fullPath.startsWith("../")) {
    // Resolve relative to current file
    const filePath = uri.startsWith("file://") ? uri.slice(7) : uri;
    const fileDir = path.dirname(filePath);
    const subPath = fullPath;
    const lastSlash = subPath.lastIndexOf("/");
    if (lastSlash >= 0) {
      basePath = path.resolve(fileDir, subPath.slice(0, lastSlash));
    } else {
      basePath = fileDir;
    }
  } else {
    return [];
  }

  try {
    if (!fs.existsSync(basePath)) return [];
    const entries = fs.readdirSync(basePath, { withFileTypes: true });
    const items: CompletionItem[] = [];
    const lowerPrefix = prefix.toLowerCase();

    for (const entry of entries) {
      const name = entry.name;
      // Skip hidden files and non-yo files
      if (name.startsWith(".")) continue;

      if (entry.isDirectory()) {
        if (!name.toLowerCase().startsWith(lowerPrefix)) continue;
        items.push({
          label: name,
          kind: CompletionItemKind.Folder,
          sortText: `0_${name}`,
        });
      } else if (name.endsWith(".yo")) {
        const nameWithoutExt = name.slice(0, -3);
        if (!nameWithoutExt.toLowerCase().startsWith(lowerPrefix)) continue;
        // Don't show index.yo directly — it's the directory's module
        if (name === "index.yo") continue;
        items.push({
          label: nameWithoutExt,
          kind: CompletionItemKind.File,
          sortText: `1_${nameWithoutExt}`,
        });
      }
    }
    return items;
  } catch {
    return [];
  }
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

    // Track the deepest env at or before the cursor for env-based completion
    let deepestEnvNearCursor: Environment | null = null;
    let deepestEnvDepth = -1;

    const extractVariables = (expr: Expr) => {
      if (exprIsAtom(expr)) {
        // Track deepest env at or before cursor position
        if (expr.$?.env && expr.$.env.frames.length > deepestEnvDepth) {
          const tokenLine = expr.token.position.row;
          const tokenColumn = expr.token.position.column;
          const isAtOrBeforeCursor =
            tokenLine < line ||
            (tokenLine === line && tokenColumn <= character);
          if (isAtOrBeforeCursor) {
            deepestEnvNearCursor = expr.$.env;
            deepestEnvDepth = expr.$.env.frames.length;
          }
        }

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

    // Add variables from environment that aren't already in AST candidates.
    // This brings in prelude types (Option, Result, String, etc.) and imports
    // that may not have been used yet in the source code.
    if (deepestEnvNearCursor) {
      addEnvVariablesToCandidates(
        deepestEnvNearCursor,
        lowerPrefix,
        candidateVariables
      );
    }

    for (const [varName, candidates] of candidateVariables) {
      // Skip internal compiler-generated names
      if (varName.startsWith("___") || varName.startsWith("__yo_")) continue;

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
            const selectedVariable = selectBestVariableAtPosition(variables, {
              position: { row: line, column: character, character },
              modulePath: best.token.modulePath,
            });
            docComment = selectedVariable?.docComment;
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
 * Add variables from the environment to the candidate map.
 * This supplements AST-based scanning by including variables that are
 * available in scope but not yet referenced in the source (e.g., prelude
 * types like Option, Result, String, imports, etc.).
 */
function addEnvVariablesToCandidates(
  env: Environment,
  lowerPrefix: string,
  candidateVariables: Map<string, AtomExpr[]>
): void {
  const seenNames = new Set(candidateVariables.keys());

  for (const frame of env.frames) {
    for (const variable of frame.variables) {
      const name = variable.name;
      // Skip already-found variables, internal names, and temp variables
      if (seenNames.has(name)) continue;
      if (name.startsWith("___") || name.startsWith("__yo_")) continue;
      if (name.startsWith("_") && name.length > 1 && name[1] !== "_") continue;

      if (!name.toLowerCase().includes(lowerPrefix)) continue;

      seenNames.add(name);

      // Create a synthetic AtomExpr-like entry so it integrates with
      // the existing candidate ranking and display logic.
      const syntheticExpr = {
        token: {
          type: TokenType.Identifier,
          value: name,
          position: { row: 0, column: 0, character: 0 },
        },
        $: {
          type: variable.type,
          value: variable.value?.[0],
          env,
          docComment: variable.docComment,
        },
      } as AtomExpr;

      candidateVariables.set(name, [syntheticExpr]);
    }
  }
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

    if (tokenBeforeDot) {
      const tokenTextInCurrentLine = lineText.substring(
        tokenBeforeDot.position.column,
        dotPosition
      );
      if (tokenTextInCurrentLine !== tokenBeforeDot.value) {
        tokenBeforeDot = undefined;
      }
    }

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

    // Fallback for closing-paren: `(T <: Trait).` patterns.
    // When the token before `.` is `)`, search for FnCallExprs on this line
    // whose func token is before the dot — pick the leftmost (outermost) one.
    // Only applies when the found expression has a TraitType (either directly
    // or as the inner type of a TypeValue). Otherwise let handleTextBasedDotCompletion
    // handle it (which supports addAllMethods for regular types).
    if (
      !targetExpr &&
      tokenBeforeDot.value === ")" &&
      tokenBeforeDot.type === TokenType.RParen
    ) {
      let outermostFnCall: FnCallExpr | null = null;
      let outermostCol = Infinity;
      const isFnCallWithTraitType = (fc: FnCallExpr): boolean => {
        if (!fc.$?.type) return false;
        if (isTraitType(fc.$.type)) return true;
        // `(T <: Trait)` has type = TypeHierarchyType, value = TypeValue(TraitType)
        if (
          isTypeHierarchyType(fc.$.type) &&
          fc.$.value &&
          isTypeValue(fc.$.value) &&
          isTraitType(fc.$.value.value)
        )
          return true;
        return false;
      };
      const searchFnCallsOnLine = (expr: Expr) => {
        if (exprIsFunctionCall(expr)) {
          const fc = expr as FnCallExpr;
          const row = fc.func.token?.position?.row;
          const col = fc.func.token?.position?.column ?? Infinity;
          if (
            row === line &&
            col < dotPosition &&
            isFnCallWithTraitType(fc) &&
            col < outermostCol
          ) {
            outermostFnCall = fc;
            outermostCol = col;
          }
          searchFnCallsOnLine(fc.func);
          for (const arg of fc.args) searchFnCallsOnLine(arg);
        }
      };
      for (const expr of program) searchFnCallsOnLine(expr);
      if (outermostFnCall) targetExpr = outermostFnCall;
    }

    // Extract the type
    const targetTokenForLookup = {
      position: {
        row: line,
        column: dotPosition,
        character: dotPosition,
      },
      modulePath: tokenBeforeDot.modulePath,
    } satisfies Pick<Token, "position" | "modulePath">;
    const variableType = extractTypeFromExpr(
      targetExpr,
      tokenBeforeDot,
      targetTokenForLookup,
      program
    );
    if (!variableType) return items;

    const originalReceiverType = variableType;

    // Auto-dereference pointer and Box(T) types for field access
    let fieldAccessType = variableType;
    while (isPtrType(fieldAccessType) || isBoxedType(fieldAccessType)) {
      if (isPtrType(fieldAccessType)) {
        fieldAccessType = fieldAccessType.childType;
      } else if (isBoxedType(fieldAccessType)) {
        // Box(T) has a single field "*" of type T
        fieldAccessType = fieldAccessType.fields[0]!.type;
      }
    }

    // Collect methods/fields
    const members: {
      name: string;
      detail: string;
      documentation: string;
      kind: CompletionItemKind;
      insertText?: string;
      insertTextFormat?: typeof InsertTextFormat.Snippet;
    }[] = [];

    collectTypeMembers(members, fieldAccessType);

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
      const item: CompletionItem = {
        label: member.name,
        kind: member.kind,
        detail: member.detail,
        documentation: member.documentation,
        sortText: `0_${member.name}`,
      };
      if (member.insertText) {
        item.insertText = member.insertText;
        item.insertTextFormat = member.insertTextFormat;
      }
      items.push(item);
    }
  } catch {
    // Return empty on error
  }

  return items;
}

/**
 * Text-based dot-completion fallback.
 * Parses the text before the dot (e.g., "Option(i32)") and resolves the
 * type by looking up the function/type name in available environments.
 * Handles patterns like:
 * - `TypeConstructor(args).` — looks up the constructor, applies it to get the result type
 * - `identifier.` — simple variable lookup (already handled elsewhere, this is a last resort)
 */
function handleTextBasedDotCompletion(
  module: { evaluator: { getProgram(): Expr[]; getTokens(): Token[] } },
  textBeforeDot: string,
  line: number,
  character: number
): CompletionItem[] {
  const items: CompletionItem[] = [];

  try {
    const program = module.evaluator.getProgram();

    // Find the deepest env available at or before the cursor position.
    let deepestEnv: Environment | null = null;
    let deepestDepth = -1;
    let deepestEnvRow = -1;
    let deepestEnvColumn = -1;

    const findDeepEnv = (expr: Expr) => {
      if (exprIsAtom(expr)) {
        if (expr.$?.env) {
          const tokenLine = expr.token.position.row;
          const tokenColumn = expr.token.position.column;
          const isAtOrBeforeCursor =
            tokenLine < line ||
            (tokenLine === line && tokenColumn <= character);
          if (!isAtOrBeforeCursor) return;

          const envDepth = expr.$.env.frames.length;
          const isBetterMatch =
            envDepth > deepestDepth ||
            (envDepth === deepestDepth &&
              (tokenLine > deepestEnvRow ||
                (tokenLine === deepestEnvRow &&
                  tokenColumn > deepestEnvColumn)));
          if (isBetterMatch) {
            deepestEnv = expr.$.env;
            deepestDepth = envDepth;
            deepestEnvRow = tokenLine;
            deepestEnvColumn = tokenColumn;
          }
        }
      } else if (exprIsFunctionCall(expr)) {
        const funcCallExpr = expr as FnCallExpr;
        findDeepEnv(funcCallExpr.func);
        for (const arg of funcCallExpr.args) {
          findDeepEnv(arg);
        }
      }
    };
    for (const expr of program) {
      findDeepEnv(expr);
    }
    if (!deepestEnv) return items;
    const resolvedEnv: Environment = deepestEnv;

    // Parse the text to extract function name and check if it's a call
    // The text might include assignment context like "x := Option(i32)"
    // so we extract the last expression: match `Name(...)` or just `Name` at the end
    const subtypeMatch = textBeforeDot.match(
      /\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*<:\s*([A-Za-z_][a-zA-Z0-9_]*)(?:\s*\(([^()]*(?:\([^()]*\))*[^()]*)\))?\s*\)\s*$/
    );
    const callMatch = textBeforeDot.match(
      /([A-Z][a-zA-Z0-9_]*)\s*\(([^()]*(?:\([^()]*\))*[^()]*)\)\s*$/
    );
    const simpleMatch = textBeforeDot.match(/([a-zA-Z_][a-zA-Z0-9_]*)$/);

    const typeName = subtypeMatch?.[2] ?? callMatch?.[1] ?? simpleMatch?.[1];
    if (!typeName) return items;

    const variables = getVariablesFromEnv(resolvedEnv, typeName);
    if (!variables || variables.length === 0) return items;

    const variable =
      selectBestVariableAtPosition(variables, {
        position: { row: line, column: character, character },
        modulePath: resolvedEnv.modulePath,
      }) ?? variables[variables.length - 1];
    if (!variable) return items;

    let resolvedType: Type | null = null;

    if (callMatch || subtypeMatch) {
      // For `Option(i32)`, search the AST for any expression where
      // this constructor was previously called, and use that result type.
      resolvedType = findTypeConstructorResult(program, typeName);
    }

    if (!resolvedType && variable.value?.[0]) {
      if (isTypeValue(variable.value[0])) {
        resolvedType = variable.value[0].value;
      }
    }

    if (!resolvedType) {
      resolvedType = unwrapTypeValueIfNeeded(
        variable.type,
        variable.value as [Value] | undefined
      );
    }

    if (!resolvedType) return items;

    // Auto-dereference pointer and Box(T) types
    let fieldAccessType = resolvedType;
    while (isPtrType(fieldAccessType) || isBoxedType(fieldAccessType)) {
      if (isPtrType(fieldAccessType)) {
        fieldAccessType = fieldAccessType.childType;
      } else if (isBoxedType(fieldAccessType)) {
        fieldAccessType = fieldAccessType.fields[0]!.type;
      }
    }

    // Collect members
    const members: {
      name: string;
      detail: string;
      documentation: string;
      kind: CompletionItemKind;
      insertText?: string;
      insertTextFormat?: typeof InsertTextFormat.Snippet;
    }[] = [];

    collectTypeMembers(members, fieldAccessType);
    addAllMethods(members, deepestEnv, fieldAccessType, resolvedType);

    // Convert to completion items
    const seenNames = new Set<string>();
    for (const member of members) {
      if (seenNames.has(member.name)) continue;
      if (member.name.startsWith("___") || member.name.startsWith("__yo_"))
        continue;
      seenNames.add(member.name);
      const item: CompletionItem = {
        label: member.name,
        kind: member.kind,
        detail: member.detail,
        documentation: member.documentation,
        sortText: `0_${member.name}`,
      };
      if (member.insertText) {
        item.insertText = member.insertText;
        item.insertTextFormat = member.insertTextFormat;
      }
      items.push(item);
    }
  } catch {
    // Return empty on error
  }

  return items;
}

/**
 * Find the result type of a type constructor call by searching the AST
 * for any expression where the constructor was previously used.
 */
function findTypeConstructorResult(
  program: Expr[],
  constructorName: string
): Type | null {
  let resultType: Type | null = null;

  const search = (expr: Expr) => {
    if (resultType) return;
    if (exprIsFunctionCall(expr)) {
      const funcCallExpr = expr as FnCallExpr;
      if (
        exprIsAtom(funcCallExpr.func) &&
        (funcCallExpr.func as AtomExpr).token.value === constructorName &&
        funcCallExpr.$?.type
      ) {
        if (isTypeHierarchyType(funcCallExpr.$.type) && funcCallExpr.$.value) {
          if (isTypeValue(funcCallExpr.$.value)) {
            resultType = funcCallExpr.$.value.value;
            return;
          }
        }
        resultType = funcCallExpr.$.type;
        return;
      }
      search(funcCallExpr.func);
      for (const arg of funcCallExpr.args) {
        search(arg);
      }
    }
  };

  for (const expr of program) {
    search(expr);
  }
  return resultType;
}

/**
 * Collect struct/enum/union/module/array fields for a type.
 * Extracted to avoid duplication between handleDotCompletion and text-based fallback.
 */
function collectTypeMembers(
  members: {
    name: string;
    detail: string;
    documentation: string;
    kind: CompletionItemKind;
    insertText?: string;
    insertTextFormat?: typeof InsertTextFormat.Snippet;
  }[],
  fieldAccessType: Type
): void {
  if (isArrayType(fieldAccessType)) {
    members.push({
      name: "len",
      detail: "comptime(usize)",
      documentation: "Get the compile-time known length of the array",
      kind: CompletionItemKind.Property,
    });
  } else if (isStructType(fieldAccessType)) {
    for (const element of fieldAccessType.fields) {
      members.push({
        name: element.label,
        detail: typeToString(element.type),
        documentation:
          element.docComment ||
          `Field: ${element.label} : ${typeToString(element.type)}`,
        kind: CompletionItemKind.Field,
      });
    }
  } else if (isEnumType(fieldAccessType)) {
    for (const variant of fieldAccessType.variants) {
      const member: (typeof members)[number] = {
        name: variant.name,
        detail: variant.fields
          ? `(${variant.fields.map((e) => typeToString(e.type)).join(", ")})`
          : "()",
        documentation: `Variant: ${variant.name}`,
        kind: CompletionItemKind.EnumMember,
      };
      if (variant.fields && variant.fields.length > 0) {
        const snippetParams = variant.fields
          .map((f, i) => `\${${i + 1}:${f.label || typeToString(f.type)}}`)
          .join(", ");
        member.insertText = `${variant.name}(${snippetParams})`;
        member.insertTextFormat = InsertTextFormat.Snippet;
      }
      members.push(member);
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
  } else if (isSourceNamespaceType(fieldAccessType)) {
    for (const field of fieldAccessType.fields) {
      if (!field.label) continue;
      if (field.label.startsWith("___") || field.label.startsWith("__yo_"))
        continue;
      const kind = isFunctionType(field.type)
        ? CompletionItemKind.Function
        : isSourceNamespaceType(field.type)
          ? CompletionItemKind.Module
          : isTypeHierarchyType(field.type)
            ? CompletionItemKind.Class
            : CompletionItemKind.Field;
      try {
        members.push({
          name: field.label,
          detail: typeToString(field.type),
          documentation: field.docComment || `${field.label}`,
          kind,
        });
      } catch {
        members.push({
          name: field.label,
          detail: "",
          documentation: field.docComment || `${field.label}`,
          kind,
        });
      }
    }
  } else if (isTraitType(fieldAccessType)) {
    // `(T <: Trait).` — show the trait's fields and methods
    for (const field of fieldAccessType.fields) {
      if (!field.label) continue;
      if (field.label.startsWith("___") || field.label.startsWith("__yo_"))
        continue;
      const kind = isFunctionType(field.type)
        ? CompletionItemKind.Method
        : isSourceNamespaceType(field.type)
          ? CompletionItemKind.Module
          : isTypeHierarchyType(field.type)
            ? CompletionItemKind.Class
            : CompletionItemKind.Property;
      const snippet = isFunctionType(field.type)
        ? generateMethodSnippet(field.label, field.type)
        : undefined;
      try {
        members.push({
          name: field.label,
          detail: typeToString(field.type),
          documentation:
            field.docComment ||
            (isFunctionType(field.type)
              ? `Trait method: ${field.label}`
              : `Trait member: ${field.label}`),
          kind,
          ...snippet,
        });
      } catch {
        members.push({
          name: field.label,
          detail: "",
          documentation:
            field.docComment ||
            (isFunctionType(field.type)
              ? `Trait method: ${field.label}`
              : `Trait member: ${field.label}`),
          kind,
          ...snippet,
        });
      }
    }
  }
}
function handleEnumVariantCompletion(
  module: { evaluator: { getProgram(): Expr[]; getTokens(): Token[] } },
  line: number,
  _character: number
): CompletionItem[] {
  const items: CompletionItem[] = [];

  try {
    const program = module.evaluator.getProgram();

    // Strategy 1: Find typed declarations on this line or the surrounding context.
    // Look for `(var : Type) = expr` where the cursor is at `expr`.
    // Also look for match/cond branches and function call arguments.
    const enumType = inferExpectedEnumType(program, line);
    if (enumType && isEnumType(enumType)) {
      for (const variant of enumType.variants) {
        const detail = variant.fields
          ? `(${variant.fields.map((f) => typeToString(f.type)).join(", ")})`
          : "";
        const item: CompletionItem = {
          label: `.${variant.name}`,
          kind: CompletionItemKind.EnumMember,
          detail,
          documentation: `Variant: ${variant.name}`,
          sortText: `0_${variant.name}`,
        };
        // Use snippet for variants with fields, plain text for unit variants
        if (variant.fields && variant.fields.length > 0) {
          const snippetParams = variant.fields
            .map((f, i) => `\${${i + 1}:${f.label || typeToString(f.type)}}`)
            .join(", ");
          item.insertText = `${variant.name}(${snippetParams})`;
          item.insertTextFormat = InsertTextFormat.Snippet;
        } else {
          item.insertText = variant.name;
        }
        items.push(item);
      }
    }
  } catch {
    // ignore
  }

  return items;
}

/**
 * Infer the expected enum type from context at the given line.
 * Walks the AST looking for typed declarations and match expressions.
 */
function inferExpectedEnumType(program: Expr[], line: number): Type | null {
  for (const expr of program) {
    const result = findExpectedTypeAtLine(expr, line);
    if (result) return result;
  }
  return null;
}

/**
 * Recursively search the AST for an expression that provides a type context at the given line.
 */
function findExpectedTypeAtLine(expr: Expr, line: number): Type | null {
  if (!exprIsFunctionCall(expr)) return null;
  const fnExpr = expr as FnCallExpr;

  // Pattern: `(var : Type) = expr` — the `=` call
  // In Yo AST, `(x : Type) = value` is parsed as `=(:(x, Type), value)`
  if (exprIsAtom(fnExpr.func) && fnExpr.func.token.value === "=") {
    if (fnExpr.args.length >= 2) {
      const lhs = fnExpr.args[0]!;
      // Check if the RHS is on the target line
      const rhs = fnExpr.args[1]!;
      const rhsLine = exprIsAtom(rhs)
        ? rhs.token.position.row
        : exprIsFunctionCall(rhs)
          ? ((rhs as FnCallExpr).token?.position?.row ?? -1)
          : -1;

      if (rhsLine === line || isExprNearLine(lhs, line)) {
        // The LHS should be a `:` call like `:(x, Type)`
        if (exprIsFunctionCall(lhs)) {
          const lhsFn = lhs as FnCallExpr;
          if (
            exprIsAtom(lhsFn.func) &&
            lhsFn.func.token.value === ":" &&
            lhsFn.args.length >= 2
          ) {
            const typeExpr = lhsFn.args[1]!;
            // The type expr should have been evaluated
            if (typeExpr.$?.value && isTypeValue(typeExpr.$.value)) {
              return typeExpr.$.value.value;
            }
            if (typeExpr.$?.type) {
              return typeExpr.$.type;
            }
          }
        }
      }
    }
  }

  // Pattern: `match(expr, .Variant => ...)` — provide variants of the matched expression's type
  if (exprIsAtom(fnExpr.func) && fnExpr.func.token.value === "match") {
    if (fnExpr.args.length >= 1) {
      // Check if any match branch is on the target line
      for (let i = 1; i < fnExpr.args.length; i++) {
        const arg = fnExpr.args[i]!;
        if (isExprNearLine(arg, line)) {
          // The first arg is the matched expression — get its type
          const matchedExpr = fnExpr.args[0]!;
          if (matchedExpr.$?.type) {
            return matchedExpr.$.type;
          }
        }
      }
    }
  }

  // Pattern: `cond(expr => result, .Variant => ...)` — similar to match
  if (exprIsAtom(fnExpr.func) && fnExpr.func.token.value === "cond") {
    // cond branches use `=>` — check if any branch has the cursor line
    for (const arg of fnExpr.args) {
      if (isExprNearLine(arg, line)) {
        // For cond, the branch condition might be an enum pattern
        if (arg.$?.type && isEnumType(arg.$.type)) {
          return arg.$.type;
        }
      }
    }
  }

  // Recurse into sub-expressions
  let result = findExpectedTypeAtLine(fnExpr.func, line);
  if (result) return result;
  for (const arg of fnExpr.args) {
    result = findExpectedTypeAtLine(arg, line);
    if (result) return result;
  }
  return null;
}

/**
 * Check if an expression is on or near the given line.
 */
function isExprNearLine(expr: Expr, line: number): boolean {
  if (exprIsAtom(expr)) {
    return expr.token.position.row === line;
  }
  if (exprIsFunctionCall(expr)) {
    const fn = expr as FnCallExpr;
    if (fn.token?.position?.row === line) return true;
    if (exprIsAtom(fn.func) && fn.func.token.position.row === line) return true;
    for (const arg of fn.args) {
      if (isExprNearLine(arg, line)) return true;
    }
  }
  return false;
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
  targetToken: Pick<Token, "position" | "modulePath">,
  program: Expr[]
): Type | null {
  if (targetExpr) {
    if (exprIsAtom(targetExpr)) {
      const atomExpr = targetExpr as AtomExpr;
      if (atomExpr.$?.type) {
        // If the type is `Type` (meta-type) and the value is a TypeValue,
        // unwrap to the inner type so `Point.` shows methods/fields of Point
        if (isTypeHierarchyType(atomExpr.$.type)) {
          if (atomExpr.$.value && isTypeValue(atomExpr.$.value)) {
            return atomExpr.$.value.value;
          }
          // Value may not be on the atom — check the env for the actual TypeValue
          // (e.g. `x :: (i32 <: Add(i32))` — the LHS atom has type but no value)
          if (atomExpr.$?.env) {
            try {
              const variables = getVariablesFromEnv(
                atomExpr.$.env,
                atomExpr.token.value
              );
              if (variables && variables.length > 0) {
                const variable =
                  selectBestVariableAtPosition(variables, targetToken) ??
                  variables[variables.length - 1];
                if (variable) {
                  return unwrapTypeValueIfNeeded(variable.type, variable.value);
                }
              }
            } catch {
              /* ignore */
            }
          }
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
            const variable =
              selectBestVariableAtPosition(variables, targetToken) ??
              variables[variables.length - 1];
            if (variable) {
              return unwrapTypeValueIfNeeded(variable.type, variable.value);
            }
          }
        } catch {
          /* ignore */
        }
      }
    } else if (exprIsFunctionCall(targetExpr)) {
      // Handle FnCallExpr as targetExpr (e.g. `(i32 <: Add(i32)).`)
      const fc = targetExpr as FnCallExpr;
      if (fc.$?.type) {
        if (
          isTypeHierarchyType(fc.$.type) &&
          fc.$.value &&
          isTypeValue(fc.$.value)
        ) {
          return fc.$.value.value;
        }
        return fc.$.type;
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
        expr.token.position.row < targetToken.position.row &&
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

    const variable =
      selectBestVariableAtPosition(variables, targetToken) ??
      variables[variables.length - 1];
    if (variable) {
      return unwrapTypeValueIfNeeded(variable.type, variable.value);
    }
  } catch {
    /* ignore */
  }

  return null;
}

/**
 * Generate a method snippet with parameter placeholders.
 * Skips the `self` parameter (first param if label is "self").
 * Returns { insertText, insertTextFormat } or undefined for non-function types.
 */
function generateMethodSnippet(
  name: string,
  type: Type
):
  | { insertText: string; insertTextFormat: typeof InsertTextFormat.Snippet }
  | undefined {
  if (!isFunctionType(type)) return undefined;
  const funcType = type as FunctionType;
  const completionName = stringIsOperator(name) ? `(${name})` : name;
  // Filter out the self parameter — it's bound by the receiver, not callsite args.
  const callParams = funcType.parameters.filter((p) => p.label !== "self");
  if (callParams.length === 0) {
    return {
      insertText: `${completionName}()`,
      insertTextFormat: InsertTextFormat.Snippet,
    };
  }
  const snippetParams = callParams
    .map((p, i) => `\${${i + 1}:${p.label || typeToString(p.type)}}`)
    .join(", ");
  return {
    insertText: `${completionName}(${snippetParams})`,
    insertTextFormat: InsertTextFormat.Snippet,
  };
}

/**
 * Add all methods available on a type, from three sources:
 * 1. Direct trait fields (from anonymous impl blocks — flattened onto receiverType.trait)
 * 2. Named trait impl entries (stored with label="" and TraitValue assignedValue)
 * 3. Generic impl registry (for generic impl blocks like `impl(generic(T), ArrayList(T), ...)`)
 */
function addAllMethods(
  members: {
    name: string;
    detail: string;
    documentation: string;
    kind: CompletionItemKind;
    insertText?: string;
    insertTextFormat?: typeof InsertTextFormat.Snippet;
  }[],
  env: Environment,
  fieldAccessType: Type,
  originalReceiverType: Type
): void {
  const seenNames = new Set(members.map((m) => m.name));

  function addMethod(name: string, type: Type, docComment?: string): void {
    if (seenNames.has(name)) return;
    seenNames.add(name);
    const snippet = generateMethodSnippet(name, type);
    try {
      members.push({
        name,
        detail: typeToString(type),
        documentation: docComment || `Method ${name}`,
        kind: CompletionItemKind.Method,
        ...snippet,
      });
    } catch {
      members.push({
        name,
        detail: "",
        documentation: docComment || `Method ${name}`,
        kind: CompletionItemKind.Method,
        ...snippet,
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
      else if (f.label && isSourceNamespaceType(f.type)) {
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
    insertText?: string;
    insertTextFormat?: typeof InsertTextFormat.Snippet;
  }[],
  fieldAccessType: Type
): void {
  if (!fieldAccessType.trait) return;
  const seenNames = new Set(members.map((m) => m.name));

  for (const f of fieldAccessType.trait.fields) {
    if (f.label && isFunctionType(f.type) && !seenNames.has(f.label)) {
      seenNames.add(f.label);
      const doc = f.docComment || `Method ${f.label}`;
      const snippet = generateMethodSnippet(f.label, f.type);
      try {
        members.push({
          name: f.label,
          detail: typeToString(f.type),
          documentation: doc,
          kind: CompletionItemKind.Method,
          ...snippet,
        });
      } catch {
        members.push({
          name: f.label,
          detail: "",
          documentation: doc,
          kind: CompletionItemKind.Method,
          ...snippet,
        });
      }
    }
  }
}
