import type { Location } from "vscode-languageserver";
import {
  type AtomExpr,
  type Expr,
  type FnCallExpr,
  exprIsAtom,
  exprIsFunctionCall,
} from "../expr";
import { TokenType } from "../token";
import type { LspDocumentManager } from "./document-manager";
import { findTokenAtPosition, modulePathToUri, uriToModulePath } from "./utils";

/**
 * Handle textDocument/references requests.
 * Find all references to the symbol at the given position within the same file.
 */
export function handleReferences(
  uri: string,
  line: number,
  character: number,
  docManager: LspDocumentManager
): Location[] | null {
  try {
    const mod = docManager.getModule(uri);
    if (!mod) return null;

    const tokens = mod.evaluator.getTokens();
    const targetToken = findTokenAtPosition(tokens, line, character);
    if (!targetToken) return null;
    if (
      targetToken.type === TokenType.Whitespace ||
      targetToken.type === TokenType.SingleLineComment ||
      targetToken.type === TokenType.MultiLineComment
    ) {
      return null;
    }

    const symbolName = targetToken.value;
    const modulePath = uriToModulePath(uri);

    // Find all tokens with the same name in the same file
    const locations: Location[] = [];
    const exprs = mod.evaluator.getProgram();

    // Walk AST to find matching atom references
    collectReferences(exprs, symbolName, modulePath, locations);

    // Also check tokens directly for simple name matching
    // (catches references the AST walk might miss)
    if (locations.length === 0) {
      for (const token of tokens) {
        if (
          token.value === symbolName &&
          token.modulePath === modulePath &&
          token.type !== TokenType.Whitespace &&
          token.type !== TokenType.SingleLineComment &&
          token.type !== TokenType.MultiLineComment
        ) {
          locations.push({
            uri: modulePathToUri(token.modulePath),
            range: {
              start: {
                line: token.position.row,
                character: token.position.column,
              },
              end: {
                line: token.position.row,
                character: token.position.column + token.value.length,
              },
            },
          });
        }
      }
    }

    return locations.length > 0 ? locations : null;
  } catch {
    return null;
  }
}

/**
 * Walk AST and collect references to a named symbol.
 */
function collectReferences(
  exprs: Expr[],
  name: string,
  modulePath: string,
  locations: Location[]
): void {
  const seenPositions = new Set<string>();

  function visit(expr: Expr): void {
    if (exprIsAtom(expr)) {
      const atom = expr as AtomExpr;
      if (atom.token.value === name && atom.token.modulePath === modulePath) {
        const key = `${atom.token.position.row}:${atom.token.position.column}`;
        if (!seenPositions.has(key)) {
          seenPositions.add(key);
          locations.push({
            uri: modulePathToUri(atom.token.modulePath),
            range: {
              start: {
                line: atom.token.position.row,
                character: atom.token.position.column,
              },
              end: {
                line: atom.token.position.row,
                character: atom.token.position.column + atom.token.value.length,
              },
            },
          });
        }
      }
    }

    if (exprIsFunctionCall(expr)) {
      const fnCall = expr as FnCallExpr;
      visit(fnCall.func);
      for (const arg of fnCall.args) {
        visit(arg);
      }
    }
  }

  for (const expr of exprs) {
    visit(expr);
  }
}
