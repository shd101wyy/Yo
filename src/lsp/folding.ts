import { FoldingRange, FoldingRangeKind } from "vscode-languageserver";
import { TokenType, type Token } from "../token";
import type { LspDocumentManager } from "./document-manager";

/**
 * Handle textDocument/foldingRange requests.
 * Provides folding ranges based on matching braces and multi-line comments.
 */
export function handleFoldingRange(
  uri: string,
  docManager: LspDocumentManager
): FoldingRange[] {
  try {
    const mod = docManager.getModule(uri);
    if (!mod) return [];

    const tokens = mod.evaluator.getTokens();
    const ranges: FoldingRange[] = [];

    // Track brace pairs for region folding
    const braceStack: Token[] = [];

    for (const token of tokens) {
      switch (token.type) {
        case TokenType.LCurlyBracket:
          braceStack.push(token);
          break;
        case TokenType.RCurlyBracket: {
          const open = braceStack.pop();
          if (open && open.position.row < token.position.row) {
            ranges.push({
              startLine: open.position.row,
              startCharacter: open.position.column,
              endLine: token.position.row,
              endCharacter: token.position.column + 1,
              kind: FoldingRangeKind.Region,
            });
          }
          break;
        }
        case TokenType.LParen:
          braceStack.push(token);
          break;
        case TokenType.RParen: {
          const open = braceStack.pop();
          if (open && open.position.row < token.position.row) {
            ranges.push({
              startLine: open.position.row,
              startCharacter: open.position.column,
              endLine: token.position.row,
              endCharacter: token.position.column + 1,
              kind: FoldingRangeKind.Region,
            });
          }
          break;
        }
        case TokenType.MultiLineComment:
        case TokenType.DocBlockComment:
        case TokenType.InnerDocBlockComment: {
          // Multi-line comment — count the lines
          const lines = token.value.split("\n");
          if (lines.length > 1) {
            ranges.push({
              startLine: token.position.row,
              endLine: token.position.row + lines.length - 1,
              kind: FoldingRangeKind.Comment,
            });
          }
          break;
        }
      }
    }

    // Collapse consecutive single-line comments into folding regions
    addConsecutiveCommentRanges(tokens, ranges);

    return ranges;
  } catch {
    return [];
  }
}

/**
 * Group consecutive single-line comment lines into foldable regions.
 */
function addConsecutiveCommentRanges(
  tokens: Token[],
  ranges: FoldingRange[]
): void {
  let commentStart: number | null = null;
  let lastCommentLine = -2;

  for (const token of tokens) {
    if (
      token.type === TokenType.SingleLineComment ||
      token.type === TokenType.DocLineComment ||
      token.type === TokenType.InnerDocLineComment
    ) {
      if (token.position.row === lastCommentLine + 1) {
        // Continuation of a comment block
        lastCommentLine = token.position.row;
      } else {
        // End previous block if it spans multiple lines
        if (commentStart !== null && lastCommentLine > commentStart) {
          ranges.push({
            startLine: commentStart,
            endLine: lastCommentLine,
            kind: FoldingRangeKind.Comment,
          });
        }
        commentStart = token.position.row;
        lastCommentLine = token.position.row;
      }
    }
  }

  // Final block
  if (commentStart !== null && lastCommentLine > commentStart) {
    ranges.push({
      startLine: commentStart,
      endLine: lastCommentLine,
      kind: FoldingRangeKind.Comment,
    });
  }
}
