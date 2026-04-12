import {
  type SignatureHelp,
  type SignatureInformation,
  type ParameterInformation,
} from "vscode-languageserver";
import {
  BuiltinKeywords,
  type AtomExpr,
  type Expr,
  type FnCallExpr,
  exprIsAtom,
  exprIsFunctionCall,
} from "../expr";
import { TokenType } from "../token";
import { isFunctionType } from "../types/guards";
import type { FunctionType } from "../types/definitions";
import { typeToString } from "../types/utils";
import type { LspDocumentManager } from "./document-manager";
import { findTokenAtPosition, uriToModulePath } from "./utils";

/**
 * Set of all builtin keyword names that should NOT trigger signature help.
 * These are syntactic/structural constructs, not user-callable functions.
 */
const BUILTIN_KEYWORD_SET = new Set(Object.values(BuiltinKeywords).flat());

/**
 * Handle textDocument/signatureHelp requests.
 * Shows parameter information when the user is inside a function call.
 */
export function handleSignatureHelp(
  uri: string,
  line: number,
  character: number,
  docManager: LspDocumentManager
): SignatureHelp | null {
  try {
    let mod = docManager.getModule(uri);
    if (!mod) {
      mod = docManager.getLastGoodModule(uri);
    }
    if (!mod) return null;

    const exprs = mod.evaluator.getProgram();
    const tokens = mod.evaluator.getTokens();
    const modulePath = uriToModulePath(uri);

    // Find the enclosing function call at this position
    const callInfo = findEnclosingCall(exprs, line, character, modulePath);
    if (!callInfo) return null;

    const { funcExpr, activeParameter } = callInfo;

    // Get the function type from the expression metadata
    const funcMeta = funcExpr.$;
    if (!funcMeta?.type) return null;

    let funcType: FunctionType | null = null;
    if (isFunctionType(funcMeta.type)) {
      funcType = funcMeta.type as FunctionType;
    }

    // Also try to look up via token in environment
    if (!funcType && exprIsAtom(funcExpr)) {
      const funcName = (funcExpr as AtomExpr).token.value;
      const token = findTokenAtPosition(tokens, line, character);
      if (token) {
        // Walk environment to find the function
        for (const expr of exprs) {
          if (exprIsFunctionCall(expr)) {
            const fn = expr as FnCallExpr;
            if (exprIsAtom(fn.func)) {
              const op = (fn.func as AtomExpr).token.value;
              if ((op === "::" || op === ":=") && fn.args.length >= 2) {
                const lhs = fn.args[0];
                if (
                  exprIsAtom(lhs) &&
                  (lhs as AtomExpr).token.value === funcName
                ) {
                  const rhs = fn.args[1];
                  if (rhs?.$?.type && isFunctionType(rhs.$.type)) {
                    funcType = rhs.$.type as FunctionType;
                    break;
                  }
                }
              }
            }
          }
        }
      }
    }

    if (!funcType) return null;

    const params: ParameterInformation[] = funcType.parameters.map((p) => ({
      label: p.label
        ? `${p.label}: ${typeToString(p.type)}`
        : typeToString(p.type),
    }));

    const sig: SignatureInformation = {
      label: typeToString(funcType),
      parameters: params,
    };

    if (funcMeta.docComment) {
      sig.documentation = funcMeta.docComment;
    }

    return {
      signatures: [sig],
      activeSignature: 0,
      activeParameter: Math.min(activeParameter, params.length - 1),
    };
  } catch {
    return null;
  }
}

/**
 * Find the function call expression that contains the cursor position.
 * Returns the function expression and the active parameter index.
 *
 * Strategy: depth-first search collecting only non-operator identifier calls.
 * Among all valid calls (cursor is after func name), return the innermost one
 * where the cursor is still within the call's argument range.
 */
function findEnclosingCall(
  exprs: Expr[],
  line: number,
  character: number,
  modulePath: string
): { funcExpr: Expr; activeParameter: number } | null {
  let bestMatch: { funcExpr: Expr; activeParameter: number } | null = null;

  function visit(expr: Expr): void {
    if (!exprIsFunctionCall(expr)) return;

    const fnCall = expr as FnCallExpr;
    const funcToken = fnCall.func.token;

    // Skip operator and dot calls — only show help for named function/method calls.
    // We still recurse into their children to find nested identifier calls.
    if (
      funcToken.type === TokenType.Operator ||
      funcToken.type === TokenType.Dot ||
      BUILTIN_KEYWORD_SET.has(funcToken.value)
    ) {
      visit(fnCall.func);
      for (const arg of fnCall.args) visit(arg);
      return;
    }

    // Only produce signature help for calls in the current module
    if (funcToken.modulePath !== modulePath) return;

    // Cursor must be after the function name
    const afterFuncName =
      line > funcToken.position.row ||
      (line === funcToken.position.row &&
        character > funcToken.position.column + funcToken.value.length);

    if (!afterFuncName) {
      for (const arg of fnCall.args) visit(arg);
      return;
    }

    // Cursor must be within the call's argument range (before the end of last arg).
    // This prevents picking a sibling or outer call whose func name happens to be
    // before the cursor but whose args have already ended.
    if (fnCall.args.length > 0) {
      const lastArg = fnCall.args[fnCall.args.length - 1]!;
      const lastEnd = findLastTokenEnd(lastArg);
      if (
        line > lastEnd.row ||
        (line === lastEnd.row && character > lastEnd.col)
      ) {
        // Cursor is past the end of this call's args — still recurse into args
        // (a nested call within one of the args might still contain the cursor)
        for (const arg of fnCall.args) visit(arg);
        return;
      }
    }

    // Count which parameter the cursor is in
    let paramIndex = 0;
    for (let i = 0; i < fnCall.args.length; i++) {
      const argToken = fnCall.args[i]!.token;
      if (
        line > argToken.position.row ||
        (line === argToken.position.row &&
          character >= argToken.position.column)
      ) {
        paramIndex = i;
      }
    }

    // Keep the deepest (innermost) match — recurse first, then update
    visit(fnCall.func);
    for (const arg of fnCall.args) visit(arg);

    // Only update if no deeper match was found (innermost wins)
    if (!bestMatch) {
      bestMatch = { funcExpr: fnCall.func, activeParameter: paramIndex };
    }
  }

  for (const expr of exprs) {
    visit(expr);
  }

  return bestMatch;
}

/**
 * Find the row and column of the last token in an expression's subtree.
 * Used to determine whether the cursor is still inside a function call.
 */
function findLastTokenEnd(expr: Expr): { row: number; col: number } {
  if (exprIsAtom(expr)) {
    return {
      row: expr.token.position.row,
      col: expr.token.position.column + expr.token.value.length,
    };
  }
  const fnExpr = expr as FnCallExpr;
  let best = findLastTokenEnd(fnExpr.func);
  for (const arg of fnExpr.args) {
    const argEnd = findLastTokenEnd(arg);
    if (
      argEnd.row > best.row ||
      (argEnd.row === best.row && argEnd.col > best.col)
    ) {
      best = argEnd;
    }
  }
  return best;
}
