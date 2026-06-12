import { describe, it, expect } from "bun:test";
import { tokenize } from "../lexer";
import { TokenType } from "../token";
import {
  extractDocComments,
  extractInlineDocs,
  findMatchingParens,
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
export(Comptime);

/// Runtime trait - indicates a type that can be used at runtime.
/// Examples: i32, bool, *(i32), void
Runtime :: trait(
  id := "Runtime"
);
export(Runtime);
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

// ── findMatchingParens ──────────────────────────────────────────────

describe("findMatchingParens", () => {
  it("finds matching parens for struct", () => {
    const tokens = tokenize("Point :: struct(x : f64, y : f64);", "test.yo");
    const result = findMatchingParens(tokens, 0);
    expect(result).not.toBeNull();
    expect(tokens[result!.open]!.type).toBe(TokenType.LParen);
    expect(tokens[result!.close]!.type).toBe(TokenType.RParen);
  });

  it("handles nested parens", () => {
    const tokens = tokenize(
      "Shape :: enum(Circle(radius: f64), Rect(w: f64, h: f64));",
      "test.yo"
    );
    // Find the outer enum(...)
    const result = findMatchingParens(tokens, 0);
    expect(result).not.toBeNull();
    // The close should be the last ) before ;
    expect(tokens[result!.close + 1]!.type).toBe(TokenType.Semicolon);
  });

  it("returns null when no parens found", () => {
    const tokens = tokenize("x :: 42;", "test.yo");
    const result = findMatchingParens(tokens, 0);
    expect(result).toBeNull();
  });

  it("starts searching from given index", () => {
    const tokens = tokenize("a(1); b(2);", "test.yo");
    // Find the second set of parens by starting after the first semicolon
    const semiIdx = tokens.findIndex((t) => t.type === TokenType.Semicolon);
    const result = findMatchingParens(tokens, semiIdx + 1);
    expect(result).not.toBeNull();
  });
});

// ── extractInlineDocs ───────────────────────────────────────────────

describe("extractInlineDocs", () => {
  // Helper: tokenize and extract inline docs from inside the first (...) of a keyword
  function inlineDocsFromSource(source: string): Map<string, string> {
    const tokens = tokenize(source, "test.yo");
    const parens = findMatchingParens(tokens, 0);
    if (!parens) return new Map();
    return extractInlineDocs(tokens, parens.open + 1, parens.close).docs;
  }

  // ── Struct fields ──

  it("extracts /// docs for struct fields", () => {
    const docs = inlineDocsFromSource(`Point :: struct(
      /// The x coordinate.
      x : f64,
      /// The y coordinate.
      y : f64
    );`);

    expect(docs.size).toBe(2);
    expect(docs.get("x")).toBe("The x coordinate.");
    expect(docs.get("y")).toBe("The y coordinate.");
  });

  it("handles struct with only some fields documented", () => {
    const docs = inlineDocsFromSource(`Config :: struct(
      /// The hostname.
      host : str,
      port : u16,
      /// Enable TLS.
      tls : bool
    );`);

    expect(docs.size).toBe(2);
    expect(docs.get("host")).toBe("The hostname.");
    expect(docs.get("tls")).toBe("Enable TLS.");
    expect(docs.has("port")).toBe(false);
  });

  it("handles struct with no documented fields", () => {
    const docs = inlineDocsFromSource(`Empty :: struct(x : i32, y : i32);`);
    expect(docs.size).toBe(0);
  });

  it("merges consecutive /// lines for a struct field", () => {
    const docs = inlineDocsFromSource(`Config :: struct(
      /// Maximum number of connections.
      /// Must be > 0.
      max_conns : u32
    );`);

    expect(docs.size).toBe(1);
    expect(docs.get("max_conns")).toBe(
      "Maximum number of connections.\nMust be > 0."
    );
  });

  it("extracts /** */ block doc for struct fields", () => {
    const docs = inlineDocsFromSource(`Config :: struct(
      /** The host address. */
      host : str,
      /** The port number. */
      port : u16
    );`);

    expect(docs.size).toBe(2);
    expect(docs.get("host")).toBe("The host address.");
    expect(docs.get("port")).toBe("The port number.");
  });

  // ── Function parameters ──

  it("extracts /// docs for fn parameters", () => {
    const source = `createPool :: (fn(
      /// Maximum connections.
      max_size: u32,
      /// Timeout in ms.
      timeout: u32
    ) -> i32)(0);`;
    const tokens = tokenize(source, "test.yo");

    // Find the fn(...) parens — skip past the outer ( to get fn
    const fnIdx = tokens.findIndex(
      (t) => t.type === TokenType.Identifier && t.value === "fn"
    );
    const parens = findMatchingParens(tokens, fnIdx);
    expect(parens).not.toBeNull();

    const docs = extractInlineDocs(
      tokens,
      parens!.open + 1,
      parens!.close
    ).docs;
    expect(docs.size).toBe(2);
    expect(docs.get("max_size")).toBe("Maximum connections.");
    expect(docs.get("timeout")).toBe("Timeout in ms.");
  });

  it("merges multi-line /// docs for fn parameters", () => {
    const source = `add :: (fn(
      /// The first operand.
      /// Must be non-negative.
      a: i32,
      /// The second operand.
      b: i32
    ) -> i32)(0);`;
    const tokens = tokenize(source, "test.yo");
    const fnIdx = tokens.findIndex(
      (t) => t.type === TokenType.Identifier && t.value === "fn"
    );
    const parens = findMatchingParens(tokens, fnIdx);
    const docs = extractInlineDocs(
      tokens,
      parens!.open + 1,
      parens!.close
    ).docs;

    expect(docs.get("a")).toBe("The first operand.\nMust be non-negative.");
    expect(docs.get("b")).toBe("The second operand.");
  });

  // ── Enum variants ──

  it("extracts /// docs for enum variants", () => {
    const docs = inlineDocsFromSource(`Color :: enum(
      /// Red color.
      Red,
      /// Green color.
      Green,
      /// Blue color.
      Blue
    );`);

    expect(docs.size).toBe(3);
    expect(docs.get("Red")).toBe("Red color.");
    expect(docs.get("Green")).toBe("Green color.");
    expect(docs.get("Blue")).toBe("Blue color.");
  });

  it("extracts docs for enum variants with fields", () => {
    const docs = inlineDocsFromSource(`Shape :: enum(
      /// A circle with given radius.
      Circle(radius : f64),
      /// A rectangle.
      Rectangle(width : f64, height : f64)
    );`);

    expect(docs.size).toBe(2);
    expect(docs.get("Circle")).toBe("A circle with given radius.");
    expect(docs.get("Rectangle")).toBe("A rectangle.");
  });

  it("extracts docs for enum variant fields", () => {
    // To document fields inside a variant like Circle(...), we'd pass the
    // inner parens range. This test documents the nested extraction approach.
    const source = `Shape :: enum(
      Circle(
        /// The radius of the circle.
        radius : f64
      ),
      Rectangle(
        /// The width.
        width : f64,
        /// The height.
        height : f64
      )
    );`;
    const tokens = tokenize(source, "test.yo");

    // Find Circle's inner parens
    const circleIdx = tokens.findIndex(
      (t) => t.type === TokenType.Identifier && t.value === "Circle"
    );
    const circleParens = findMatchingParens(tokens, circleIdx);
    expect(circleParens).not.toBeNull();
    const circleDocs = extractInlineDocs(
      tokens,
      circleParens!.open + 1,
      circleParens!.close
    ).docs;
    expect(circleDocs.get("radius")).toBe("The radius of the circle.");

    // Find Rectangle's inner parens
    const rectIdx = tokens.findIndex(
      (t) => t.type === TokenType.Identifier && t.value === "Rectangle"
    );
    const rectParens = findMatchingParens(tokens, rectIdx);
    expect(rectParens).not.toBeNull();
    const rectDocs = extractInlineDocs(
      tokens,
      rectParens!.open + 1,
      rectParens!.close
    ).docs;
    expect(rectDocs.get("width")).toBe("The width.");
    expect(rectDocs.get("height")).toBe("The height.");
  });

  // ── Trait fields ──

  it("extracts docs for trait fields", () => {
    const docs = inlineDocsFromSource(`Iterator :: trait(
      /// The type of elements.
      Item : Type,
      /// Advances the iterator.
      next : fn(self: *(Self)) -> Option(Self.Item)
    );`);

    expect(docs.size).toBe(2);
    expect(docs.get("Item")).toBe("The type of elements.");
    expect(docs.get("next")).toBe("Advances the iterator.");
  });

  // ── Edge cases ──

  it("handles empty token range", () => {
    const tokens = tokenize("struct();", "test.yo");
    const result = extractInlineDocs(tokens, 2, 2);
    expect(result.docs.size).toBe(0);
  });

  it("handles doc comment at end of range with no following identifier", () => {
    const source = `S :: struct(
      /// Orphan doc.
    );`;
    const docs = inlineDocsFromSource(source);
    expect(docs.size).toBe(0);
  });

  it("does not pick up regular // comments", () => {
    const docs = inlineDocsFromSource(`S :: struct(
      // regular comment
      x : i32,
      /// Doc comment.
      y : i32
    );`);

    expect(docs.size).toBe(1);
    expect(docs.has("x")).toBe(false);
    expect(docs.get("y")).toBe("Doc comment.");
  });

  it("handles mixed block and line doc comments", () => {
    const docs = inlineDocsFromSource(`S :: struct(
      /** Block doc for x. */
      x : i32,
      /// Line doc for y.
      y : i32
    );`);

    expect(docs.size).toBe(2);
    expect(docs.get("x")).toBe("Block doc for x.");
    expect(docs.get("y")).toBe("Line doc for y.");
  });

  it("handles single-line struct definition", () => {
    const docs = inlineDocsFromSource(
      `P :: struct(/** X */ x : f64, /** Y */ y : f64);`
    );

    expect(docs.size).toBe(2);
    expect(docs.get("x")).toBe("X");
    expect(docs.get("y")).toBe("Y");
  });

  it("preserves markdown formatting in inline docs", () => {
    const docs = inlineDocsFromSource(`S :: struct(
      /// The **bold** value.
      ///
      /// Example: \`x = 42\`
      x : i32
    );`);

    expect(docs.size).toBe(1);
    expect(docs.get("x")).toBe("The **bold** value.\n\nExample: `x = 42`");
  });

  it("extracts docs for optional fields with ?= syntax", () => {
    const docs = inlineDocsFromSource(`Config :: struct(
      /// Step name.
      name : comptime_str,
      /// Compilation target triple.
      (target : comptime_str) ?= "host",
      /// Optimization level.
      (optimize : i32) ?= 0
    );`);

    expect(docs.size).toBe(3);
    expect(docs.get("name")).toBe("Step name.");
    expect(docs.get("target")).toBe("Compilation target triple.");
    expect(docs.get("optimize")).toBe("Optimization level.");
  });

  it("extracts top-level doc for ?= field via extractDocComments", () => {
    const source = `/// Target doc.\n(target : i32) ?= 0;\n`;
    const tokens = tokenize(source, "test.yo");
    const result = extractDocComments(tokens);

    expect(result.declarations.length).toBe(1);
    expect(result.declarations[0]!.declarationName).toBe("target");
    expect(result.declarations[0]!.comment.content).toBe("Target doc.");
  });
});
