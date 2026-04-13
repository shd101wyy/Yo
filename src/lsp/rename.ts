import type {
  RenameParams,
  WorkspaceEdit,
  TextEdit,
} from "vscode-languageserver";
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
 * Walk AST and collect TextEdits for all references to a named symbol.
 */
function collectRenameEdits(
  exprs: Expr[],
  oldName: string,
  newName: string,
  modulePath: string
): TextEdit[] {
  const edits: TextEdit[] = [];
  const seenPositions = new Set<string>();

  function visit(expr: Expr): void {
    if (exprIsAtom(expr)) {
      const atom = expr as AtomExpr;
      if (
        atom.token.value === oldName &&
        atom.token.modulePath === modulePath
      ) {
        const key = `${atom.token.position.row}:${atom.token.position.column}`;
        if (!seenPositions.has(key)) {
          seenPositions.add(key);
          edits.push({
            range: {
              start: {
                line: atom.token.position.row,
                character: atom.token.position.column,
              },
              end: {
                line: atom.token.position.row,
                character: atom.token.position.column + oldName.length,
              },
            },
            newText: newName,
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
  return edits;
}

/**
 * Handle textDocument/rename requests.
 * Renames all references to a symbol within the same file.
 */
export function handleRename(
  params: RenameParams,
  docManager: LspDocumentManager
): WorkspaceEdit | null {
  try {
    const uri = params.textDocument.uri;
    const mod = docManager.getModule(uri);
    if (!mod) return null;

    const tokens = mod.evaluator.getTokens();
    const targetToken = findTokenAtPosition(
      tokens,
      params.position.line,
      params.position.character
    );
    if (!targetToken) return null;
    if (
      targetToken.type === TokenType.Whitespace ||
      targetToken.type === TokenType.SingleLineComment ||
      targetToken.type === TokenType.MultiLineComment
    ) {
      return null;
    }

    const oldName = targetToken.value;
    const newName = params.newName;
    const modulePath = uriToModulePath(uri);

    const exprs = mod.evaluator.getProgram();
    let edits = collectRenameEdits(exprs, oldName, newName, modulePath);

    // Fallback: token-level matching if AST walk found nothing
    if (edits.length === 0) {
      const seenPositions = new Set<string>();
      edits = [];
      for (const token of tokens) {
        if (
          token.value === oldName &&
          token.modulePath === modulePath &&
          token.type !== TokenType.Whitespace &&
          token.type !== TokenType.SingleLineComment &&
          token.type !== TokenType.MultiLineComment
        ) {
          const key = `${token.position.row}:${token.position.column}`;
          if (!seenPositions.has(key)) {
            seenPositions.add(key);
            edits.push({
              range: {
                start: {
                  line: token.position.row,
                  character: token.position.column,
                },
                end: {
                  line: token.position.row,
                  character: token.position.column + oldName.length,
                },
              },
              newText: newName,
            });
          }
        }
      }
    }

    if (edits.length === 0) return null;

    const targetUri = modulePathToUri(modulePath);
    return {
      changes: {
        [targetUri]: edits,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Handle textDocument/prepareRename requests.
 * Returns the range of the symbol at the cursor, or null if not renamable.
 */
export function handlePrepareRename(
  uri: string,
  line: number,
  character: number,
  docManager: LspDocumentManager
): {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  placeholder: string;
} | null {
  try {
    const mod = docManager.getModule(uri);
    if (!mod) return null;

    const tokens = mod.evaluator.getTokens();
    const targetToken = findTokenAtPosition(tokens, line, character);
    if (!targetToken) return null;
    if (targetToken.type !== TokenType.Identifier) {
      return null;
    }

    return {
      range: {
        start: {
          line: targetToken.position.row,
          character: targetToken.position.column,
        },
        end: {
          line: targetToken.position.row,
          character: targetToken.position.column + targetToken.value.length,
        },
      },
      placeholder: targetToken.value,
    };
  } catch {
    return null;
  }
}
