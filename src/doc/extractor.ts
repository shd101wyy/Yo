// Doc comment extractor for Yo source files.
//
// Operates on the token stream (before parsing) to extract doc comments
// and associate them with declarations. Supports:
//
// - triple-slash (///) outer doc line comments (attach to next declaration)
// - //! inner doc line comments (attach to enclosing module)
// - block doc comments (attach to next declaration)
// - inner block doc comments (attach to enclosing module)

import type { Token } from "../token";
import { TokenType } from "../token";

// ── Types ────────────────────────────────────────────────────────────

export interface DocComment {
  /** Cleaned Markdown content (comment syntax stripped) */
  content: string;
  /** Whether this is an inner doc comment (//! or inner block variant) */
  inner: boolean;
  /** Source position of the first token in the doc comment */
  position: Token["position"];
  /** Module path from the token */
  modulePath: string;
}

export interface DocAssociation {
  /** The extracted and cleaned doc comment */
  comment: DocComment;
  /** Name of the declaration this doc comment is attached to (empty for inner/module docs) */
  declarationName: string;
  /** Position of the declaration token */
  declarationPosition: Token["position"] | null;
}

export interface DocExtractionResult {
  /** Inner doc comments for the module itself */
  moduleDoc: DocComment | null;
  /** Doc comments associated with declarations */
  declarations: DocAssociation[];
}

// ── Helpers ──────────────────────────────────────────────────────────

function isDocCommentToken(token: Token): boolean {
  return (
    token.type === TokenType.DocLineComment ||
    token.type === TokenType.InnerDocLineComment ||
    token.type === TokenType.DocBlockComment ||
    token.type === TokenType.InnerDocBlockComment
  );
}

function isInnerDocToken(token: Token): boolean {
  return (
    token.type === TokenType.InnerDocLineComment ||
    token.type === TokenType.InnerDocBlockComment
  );
}

function isWhitespaceOrRegularComment(token: Token): boolean {
  return (
    token.type === TokenType.Whitespace ||
    token.type === TokenType.SingleLineComment ||
    token.type === TokenType.MultiLineComment
  );
}

/**
 * Strip the comment syntax from a single `///` line comment token.
 * Input: `"/// some text"` → Output: `" some text"` → trimmed: `"some text"`
 *
 * The leading `///` (or `//!`) is removed. One leading space after the
 * prefix is stripped if present, preserving further indentation.
 */
export function stripDocLineComment(value: string): string {
  // Remove the prefix: /// or //!
  let content: string;
  if (value.startsWith("///")) {
    content = value.slice(3);
  } else if (value.startsWith("//!")) {
    content = value.slice(3);
  } else {
    content = value;
  }
  // Strip exactly one leading space if present
  if (content.startsWith(" ")) {
    content = content.slice(1);
  }
  return content;
}

// Strip the comment syntax from a doc block comment or inner doc block comment.
// Removes the opening/closing delimiters and leading asterisks on each line.
export function stripDocBlockComment(value: string): string {
  // Handle empty doc comments: /**/ or /***/ etc.
  if (value === "/**/" || value === "/*!*/") {
    return "";
  }

  // Remove opening delimiter: /** or /*!
  let content: string;
  if (value.startsWith("/**")) {
    content = value.slice(3);
  } else if (value.startsWith("/*!")) {
    content = value.slice(3);
  } else {
    content = value;
  }

  // Remove closing delimiter: */
  if (content.endsWith("*/")) {
    content = content.slice(0, -2);
  }

  // Single-line case: no newlines, just trim whitespace
  if (!content.includes("\n")) {
    return content.trim();
  }

  // Multi-line: split into lines, strip leading whitespace + optional `*`, then rejoin
  const lines = content.split("\n");
  const strippedLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    // Strip leading whitespace
    const trimmedLine = line.trimStart();
    // Strip a single leading `* ` or `*` (JSDoc-style)
    if (trimmedLine.startsWith("* ")) {
      line = trimmedLine.slice(2);
    } else if (trimmedLine === "*" || trimmedLine === "*\r") {
      line = "";
    } else {
      line = trimmedLine;
    }
    strippedLines.push(line);
  }

  // Trim leading/trailing empty lines
  while (strippedLines.length > 0 && strippedLines[0]!.trim() === "") {
    strippedLines.shift();
  }
  while (
    strippedLines.length > 0 &&
    strippedLines[strippedLines.length - 1]!.trim() === ""
  ) {
    strippedLines.pop();
  }

  return strippedLines.join("\n");
}

// ── Main extractor ───────────────────────────────────────────────────

/**
 * Extract doc comments from a token stream and associate them with declarations.
 *
 * Strategy:
 * - Inner doc comments (//! and block variant) are collected as module-level docs.
 * - Outer doc comments (triple-slash and block variant) are associated with
 *   the next non-whitespace, non-comment token (the declaration name).
 * - Consecutive triple-slash lines are merged into a single doc comment block.
 */
export function extractDocComments(tokens: Token[]): DocExtractionResult {
  const result: DocExtractionResult = {
    moduleDoc: null,
    declarations: [],
  };

  const innerDocParts: string[] = [];
  let innerDocPosition: Token["position"] | null = null;
  let innerDocModulePath = "";

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;

    // ── Inner doc comments: collect for module doc ──
    if (isInnerDocToken(token)) {
      if (innerDocPosition === null) {
        innerDocPosition = token.position;
        innerDocModulePath = token.modulePath;
      }

      if (token.type === TokenType.InnerDocLineComment) {
        innerDocParts.push(stripDocLineComment(token.value));
        i++;
        // Skip whitespace between consecutive //! lines
        while (i < tokens.length && tokens[i]!.type === TokenType.Whitespace) {
          // Only skip whitespace within the same line or next line
          if (tokens[i]!.value.includes("\n")) {
            // Check if the next non-whitespace token is also //!
            let next = i + 1;
            while (
              next < tokens.length &&
              tokens[next]!.type === TokenType.Whitespace
            ) {
              next++;
            }
            if (
              next < tokens.length &&
              tokens[next]!.type === TokenType.InnerDocLineComment
            ) {
              i = next;
              break;
            } else {
              break;
            }
          }
          i++;
        }
        continue;
      } else {
        // InnerDocBlockComment
        innerDocParts.push(stripDocBlockComment(token.value));
        i++;
        continue;
      }
    }

    // ── Outer doc line comments: merge consecutive, then associate ──
    if (token.type === TokenType.DocLineComment) {
      const docParts: string[] = [];
      const startPosition = token.position;
      const modulePath = token.modulePath;

      // Collect this and consecutive /// lines
      docParts.push(stripDocLineComment(token.value));
      i++;

      while (i < tokens.length) {
        // Skip whitespace tokens that are just newlines between /// lines
        let j = i;
        while (j < tokens.length && tokens[j]!.type === TokenType.Whitespace) {
          j++;
        }
        if (j < tokens.length && tokens[j]!.type === TokenType.DocLineComment) {
          docParts.push(stripDocLineComment(tokens[j]!.value));
          i = j + 1;
        } else {
          break;
        }
      }

      const docComment: DocComment = {
        content: docParts.join("\n"),
        inner: false,
        position: startPosition,
        modulePath,
      };

      // Find the next declaration identifier
      const { name, position: declPos } = findNextDeclarationName(tokens, i);

      result.declarations.push({
        comment: docComment,
        declarationName: name,
        declarationPosition: declPos,
      });
      continue;
    }

    // ── Outer doc block comments: associate with next declaration ──
    if (token.type === TokenType.DocBlockComment) {
      const docComment: DocComment = {
        content: stripDocBlockComment(token.value),
        inner: false,
        position: token.position,
        modulePath: token.modulePath,
      };

      i++;

      // Find the next declaration identifier
      const { name, position: declPos } = findNextDeclarationName(tokens, i);

      result.declarations.push({
        comment: docComment,
        declarationName: name,
        declarationPosition: declPos,
      });
      continue;
    }

    i++;
  }

  // Assemble module doc from inner doc parts
  if (innerDocParts.length > 0 && innerDocPosition !== null) {
    result.moduleDoc = {
      content: innerDocParts.join("\n"),
      inner: true,
      position: innerDocPosition,
      modulePath: innerDocModulePath,
    };
  }

  return result;
}

/**
 * Find the next identifier token that likely represents a declaration name.
 * Skips whitespace and comments to reach it.
 */
function findNextDeclarationName(
  tokens: Token[],
  startIndex: number
): { name: string; position: Token["position"] | null } {
  let i = startIndex;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (isWhitespaceOrRegularComment(token) || isDocCommentToken(token)) {
      i++;
      continue;
    }
    if (token.type === TokenType.Identifier) {
      return { name: token.value, position: token.position };
    }
    // If we hit something that's not an identifier (e.g., a keyword, operator),
    // the doc comment doesn't have a clear declaration target
    return { name: "", position: null };
  }
  return { name: "", position: null };
}
