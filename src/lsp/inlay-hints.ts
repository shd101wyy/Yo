import {
  type InlayHint,
  InlayHintKind,
  type Position,
} from "vscode-languageserver";
import {
  type AtomExpr,
  type Expr,
  type FnCallExpr,
  exprIsAtom,
  exprIsFunctionCall,
} from "../expr";
import { typeToString } from "../types/utils";
import { isFunctionType, isUnitType } from "../types/guards";
import type { LspDocumentManager } from "./document-manager";
import { uriToModulePath } from "./utils";

/**
 * Handle textDocument/inlayHint requests.
 * Shows inferred types for `:=` declarations and function parameters.
 *
 * NOTE: Currently disabled in server.ts — the inlay hints (e.g., `p1: Point`)
 * were confusing in Yo's syntax. This file is kept for potential future use
 * with different hint styles.
 */
export function handleInlayHint(
  uri: string,
  docManager: LspDocumentManager
): InlayHint[] {
  try {
    const mod = docManager.getModule(uri);
    if (!mod) return [];

    const exprs = mod.evaluator.getProgram();
    const modulePath = uriToModulePath(uri);
    const hints: InlayHint[] = [];

    for (const expr of exprs) {
      collectInlayHints(expr, modulePath, hints);
    }

    return hints;
  } catch {
    return [];
  }
}

/**
 * Walk the AST collecting inlay hints for type inference.
 */
function collectInlayHints(
  expr: Expr,
  modulePath: string,
  hints: InlayHint[]
): void {
  if (!exprIsFunctionCall(expr)) return;

  const fnCall = expr as FnCallExpr;
  const op = exprIsAtom(fnCall.func)
    ? (fnCall.func as AtomExpr).token.value
    : null;

  // Show inferred type for `:=` declarations (mutable bindings with inferred types)
  if (op === ":=" && fnCall.args.length >= 2) {
    const lhs = fnCall.args[0]!;
    const rhs = fnCall.args[1]!;

    // Only show hint if:
    // 1. LHS is a simple identifier (not a typed declaration like `(x : i32) = ...`)
    // 2. RHS has a resolved type
    // 3. The type is not unit
    if (
      exprIsAtom(lhs) &&
      lhs.token.modulePath === modulePath &&
      rhs?.$?.type &&
      !isUnitType(rhs.$.type)
    ) {
      const name = (lhs as AtomExpr).token.value;
      // Skip internal/compiler-generated names
      if (!name.startsWith("__yo_") && !name.startsWith("___")) {
        const typeStr = typeToString(rhs.$.type);
        // Don't show if the type string is too complex or uninformative
        if (typeStr.length < 60 && typeStr !== "unknown") {
          const pos: Position = {
            line: lhs.token.position.row,
            character: lhs.token.position.column + lhs.token.value.length,
          };
          hints.push({
            position: pos,
            label: `: ${typeStr}`,
            kind: InlayHintKind.Type,
            paddingLeft: false,
            paddingRight: true,
          });
        }
      }
    }
  }

  // Show inferred return type for `::` function declarations without explicit type
  if (op === "::" && fnCall.args.length >= 2) {
    const rhs = fnCall.args[1]!;
    if (rhs?.$?.type && isFunctionType(rhs.$.type)) {
      // Function declarations already have type annotations in Yo, skip
    }
  }

  // Recurse into subexpressions
  if (exprIsAtom(fnCall.func)) {
    // Don't recurse into the operator atom itself
  } else {
    collectInlayHints(fnCall.func, modulePath, hints);
  }

  for (const arg of fnCall.args) {
    collectInlayHints(arg, modulePath, hints);
  }
}
