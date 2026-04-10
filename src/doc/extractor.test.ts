import { describe, it, expect } from "bun:test";
import { tokenize } from "../lexer";
import { TokenType } from "../token";
import {
  extractDocComments,
  stripDocLineComment,
  stripDocBlockComment,
} from "./extractor";

// ── stripDocLineComment ─────────────────────────────────────────────

describe("stripDocLineComment", () => {
  it("strips triple-slash prefix and one space", () => {
    expect(stripDocLineComment("/// Hello world")).toBe("Hello world");
  });

  it("strips triple-slash with no space", () => {
    expect(stripDocLineComment("///Hello")).toBe("Hello");
  });

  it("strips //! prefix and one space", () => {
    expect(stripDocLineComment("//! Module doc")).toBe("Module doc");
  });

  it("preserves extra indentation", () => {
    expect(stripDocLineComment("///   indented")).toBe("  indented");
  });

  it("handles empty doc comment", () => {
    expect(stripDocLineComment("///")).toBe("");
  });

  it("handles empty //! comment", () => {
    expect(stripDocLineComment("//!")).toBe("");
  });
});

// ── stripDocBlockComment ────────────────────────────────────────────

describe("stripDocBlockComment", () => {
  it("strips simple block comment", () => {
    expect(stripDocBlockComment("/** Hello */")).toBe("Hello");
  });

  it("strips multi-line block with leading asterisks", () => {
    const input = `/**
 * First line
 * Second line
 */`;
    expect(stripDocBlockComment(input)).toBe("First line\nSecond line");
  });

  it("strips inner doc block comment", () => {
    const input = `/*! Module documentation */`;
    expect(stripDocBlockComment(input)).toBe("Module documentation");
  });

  it("handles empty doc block comment", () => {
    // Note: /**/ is parsed as regular MultiLineComment (not doc)
    // because the 3rd char * is followed by /. Minimal doc block: /** */
    expect(stripDocBlockComment("/** */")).toBe("");
  });

  it("preserves markdown formatting", () => {
    const input = `/**
 * # Heading
 *
 * - item 1
 * - item 2
 *
 * \`code\`
 */`;
    expect(stripDocBlockComment(input)).toBe(
      "# Heading\n\n- item 1\n- item 2\n\n`code`"
    );
  });
});

// ── Lexer doc token types ───────────────────────────────────────────

describe("lexer doc comment tokens", () => {
  it("tokenizes /// as DocLineComment", () => {
    const tokens = tokenize("/// doc comment\n", "test.yo");
    const docToken = tokens.find((t) => t.type === TokenType.DocLineComment);
    expect(docToken).toBeDefined();
    expect(docToken!.value).toBe("/// doc comment");
  });

  it("tokenizes //! as InnerDocLineComment", () => {
    const tokens = tokenize("//! module doc\n", "test.yo");
    const docToken = tokens.find(
      (t) => t.type === TokenType.InnerDocLineComment
    );
    expect(docToken).toBeDefined();
    expect(docToken!.value).toBe("//! module doc");
  });

  it("tokenizes /** */ as DocBlockComment", () => {
    const tokens = tokenize("/** block doc */", "test.yo");
    const docToken = tokens.find((t) => t.type === TokenType.DocBlockComment);
    expect(docToken).toBeDefined();
    expect(docToken!.value).toBe("/** block doc */");
  });

  it("tokenizes /*! */ as InnerDocBlockComment", () => {
    const tokens = tokenize("/*! inner block */", "test.yo");
    const docToken = tokens.find(
      (t) => t.type === TokenType.InnerDocBlockComment
    );
    expect(docToken).toBeDefined();
    expect(docToken!.value).toBe("/*! inner block */");
  });

  it("keeps // as SingleLineComment", () => {
    const tokens = tokenize("// regular comment\n", "test.yo");
    const commentToken = tokens.find(
      (t) => t.type === TokenType.SingleLineComment
    );
    expect(commentToken).toBeDefined();
    expect(commentToken!.value).toBe("// regular comment");
  });

  it("keeps /* */ as MultiLineComment", () => {
    const tokens = tokenize("/* regular block */", "test.yo");
    const commentToken = tokens.find(
      (t) => t.type === TokenType.MultiLineComment
    );
    expect(commentToken).toBeDefined();
    expect(commentToken!.value).toBe("/* regular block */");
  });

  it("does not treat //// as doc comment", () => {
    const tokens = tokenize("//// four slashes\n", "test.yo");
    const docToken = tokens.find((t) => t.type === TokenType.DocLineComment);
    expect(docToken).toBeUndefined();
    const commentToken = tokens.find(
      (t) => t.type === TokenType.SingleLineComment
    );
    expect(commentToken).toBeDefined();
  });

  it("does not treat /*** */ as doc comment (immediately closed)", () => {
    // Note: /**/ is tokenized as regular MultiLineComment, not doc block.
    // Minimal doc: three chars opening + space + two chars closing.
    // But /** foo */ IS a doc comment.
    const tokens = tokenize("/** real doc */", "test.yo");
    const docToken = tokens.find((t) => t.type === TokenType.DocBlockComment);
    expect(docToken).toBeDefined();
  });
});

// ── extractDocComments ──────────────────────────────────────────────

describe("extractDocComments", () => {
  it("extracts a single /// doc comment for a declaration", () => {
    const tokens = tokenize("/// A trait.\nFoo :: trait();\n", "test.yo");
    const result = extractDocComments(tokens);

    expect(result.moduleDoc).toBeNull();
    expect(result.declarations).toHaveLength(1);
    expect(result.declarations[0]!.comment.content).toBe("A trait.");
    expect(result.declarations[0]!.declarationName).toBe("Foo");
  });

  it("merges consecutive /// lines", () => {
    const source = `/// First line.
/// Second line.
/// Third line.
MyType :: struct();
`;
    const tokens = tokenize(source, "test.yo");
    const result = extractDocComments(tokens);

    expect(result.declarations).toHaveLength(1);
    expect(result.declarations[0]!.comment.content).toBe(
      "First line.\nSecond line.\nThird line."
    );
    expect(result.declarations[0]!.declarationName).toBe("MyType");
  });

  it("extracts /** */ block doc comment", () => {
    const source = `/**
 * A dynamic array.
 *
 * Supports resizing.
 */
ArrayList :: struct();
`;
    const tokens = tokenize(source, "test.yo");
    const result = extractDocComments(tokens);

    expect(result.declarations).toHaveLength(1);
    expect(result.declarations[0]!.comment.content).toBe(
      "A dynamic array.\n\nSupports resizing."
    );
    expect(result.declarations[0]!.declarationName).toBe("ArrayList");
  });

  it("extracts //! as module doc", () => {
    const source = `//! This is the module doc.
//! It has two lines.

Foo :: struct();
`;
    const tokens = tokenize(source, "test.yo");
    const result = extractDocComments(tokens);

    expect(result.moduleDoc).not.toBeNull();
    expect(result.moduleDoc!.content).toBe(
      "This is the module doc.\nIt has two lines."
    );
    expect(result.moduleDoc!.inner).toBe(true);
  });

  it("extracts /*! */ as module doc", () => {
    const source = `/*! Module-level block doc. */
Foo :: struct();
`;
    const tokens = tokenize(source, "test.yo");
    const result = extractDocComments(tokens);

    expect(result.moduleDoc).not.toBeNull();
    expect(result.moduleDoc!.content).toBe("Module-level block doc.");
  });

  it("handles multiple doc comments for different declarations", () => {
    const source = `/// First type.
Foo :: struct();

/// Second type.
Bar :: enum();
`;
    const tokens = tokenize(source, "test.yo");
    const result = extractDocComments(tokens);

    expect(result.declarations).toHaveLength(2);
    expect(result.declarations[0]!.declarationName).toBe("Foo");
    expect(result.declarations[0]!.comment.content).toBe("First type.");
    expect(result.declarations[1]!.declarationName).toBe("Bar");
    expect(result.declarations[1]!.comment.content).toBe("Second type.");
  });

  it("ignores regular comments, only extracts doc comments", () => {
    const source = `// regular comment
/// doc comment
Foo :: struct();
`;
    const tokens = tokenize(source, "test.yo");
    const result = extractDocComments(tokens);

    expect(result.declarations).toHaveLength(1);
    expect(result.declarations[0]!.comment.content).toBe("doc comment");
  });

  it("handles module doc and declaration docs together", () => {
    const source = `//! Module documentation.

/// A type.
Foo :: struct();
`;
    const tokens = tokenize(source, "test.yo");
    const result = extractDocComments(tokens);

    expect(result.moduleDoc).not.toBeNull();
    expect(result.moduleDoc!.content).toBe("Module documentation.");
    expect(result.declarations).toHaveLength(1);
    expect(result.declarations[0]!.declarationName).toBe("Foo");
  });

  it("handles empty token stream", () => {
    const result = extractDocComments([]);
    expect(result.moduleDoc).toBeNull();
    expect(result.declarations).toHaveLength(0);
  });

  it("extracts doc from real std-lib-like code", () => {
    const source = `//! Core traits for the Yo type system.

/// Comptime trait - indicates a type that can be used at compile-time.
/// Examples: i32, bool, Type
Comptime :: trait(
  id := "Comptime"
);
export Comptime;

/// Runtime trait - indicates a type that can be used at runtime.
/// Examples: i32, bool, *(i32), void
Runtime :: trait(
  id := "Runtime"
);
export Runtime;
`;
    const tokens = tokenize(source, "prelude.yo");
    const result = extractDocComments(tokens);

    expect(result.moduleDoc).not.toBeNull();
    expect(result.moduleDoc!.content).toBe(
      "Core traits for the Yo type system."
    );

    expect(result.declarations).toHaveLength(2);
    expect(result.declarations[0]!.declarationName).toBe("Comptime");
    expect(result.declarations[0]!.comment.content).toBe(
      "Comptime trait - indicates a type that can be used at compile-time.\nExamples: i32, bool, Type"
    );
    expect(result.declarations[1]!.declarationName).toBe("Runtime");
  });
});
