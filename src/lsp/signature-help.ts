import {
  type SignatureHelp,
  type SignatureInformation,
  type ParameterInformation,
} from "vscode-languageserver";
import {
  type AtomExpr,
  type Expr,
  type FnCallExpr,
  exprIsAtom,
  exprIsFunctionCall,
} from "../expr";
import { isFunctionType } from "../types/guards";
import type { FunctionType } from "../types/definitions";
import { typeToString } from "../types/utils";
import type { LspDocumentManager } from "./document-manager";
import { findTokenAtPosition, uriToModulePath } from "./utils";

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

    // Check if cursor is within this call (after the function name)
    if (funcToken.modulePath !== modulePath) return;

    // The cursor must be on or after the function call line
    if (funcToken.position.row > line) return;

    // Check if cursor is within the arguments area
    if (fnCall.args.length > 0) {
      // Cursor should be after function name and within arg range
      const afterFuncName =
        line > funcToken.position.row ||
        (line === funcToken.position.row &&
          character > funcToken.position.column + funcToken.value.length);

      if (afterFuncName) {
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

        bestMatch = { funcExpr: fnCall.func, activeParameter: paramIndex };
      }
    }

    // Recurse into arguments
    visit(fnCall.func);
    for (const arg of fnCall.args) {
      visit(arg);
    }
  }

  for (const expr of exprs) {
    visit(expr);
  }

  return bestMatch;
}
