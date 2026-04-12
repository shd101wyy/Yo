import { describe, it, expect, afterEach } from "bun:test";
import * as path from "node:path";
import { handleCompletion } from "../lsp/completion";
import { handleDefinition } from "../lsp/definition";
import { handleHover } from "../lsp/hover";
import { LspDocumentManager } from "../lsp/document-manager";

/** Track created doc managers for cleanup */
let activeDocManagers: LspDocumentManager[] = [];

afterEach(() => {
  for (const dm of activeDocManagers) {
    dm.getModuleManager().resetAllState();
  }
  activeDocManagers = [];
});

/**
 * Helper: create a document manager and load a source string as a virtual file.
 * Returns the URI and docManager needed by LSP handlers.
 */
function loadSource(source: string, filename = "test.yo") {
  const stdPath = path.resolve(__dirname, "../../std");
  const docManager = new LspDocumentManager(stdPath);
  activeDocManagers.push(docManager);
  const modulePath = `file://${path.resolve(__dirname, filename)}`;
  // Use the internal module manager to load the source directly
  const mm = docManager.getModuleManager();
  mm.loadModule(modulePath, source);
  return { uri: modulePath, docManager };
}

/**
 * Helper: get the 0-based line number for a marker string within source.
 * Finds the line containing `marker` and returns its index.
 */
function lineOf(source: string, marker: string): number {
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(marker)) return i;
  }
  throw new Error(`Marker "${marker}" not found in source`);
}

/**
 * Helper: get completion labels at a specific position in source.
 */
function getCompletionLabels(
  source: string,
  line: number,
  character: number,
  filename?: string
): string[] {
  const lineText = source.split("\n")[line] ?? "";
  const { uri, docManager } = loadSource(source, filename);
  const items = handleCompletion(uri, line, character, lineText, docManager);
  return items.map((item) => item.label);
}

/**
 * Helper: get full completion items at a specific position.
 */
function getCompletionItems(
  source: string,
  line: number,
  character: number,
  filename?: string
) {
  const lineText = source.split("\n")[line] ?? "";
  const { uri, docManager } = loadSource(source, filename);
  return handleCompletion(uri, line, character, lineText, docManager);
}

// ─── Struct dot-completion ───────────────────────────────────────────────

describe("LSP Completion", () => {
  describe("struct field completion", () => {
    const source = `
Point :: struct(x : i32, y : i32);
main :: (fn() -> i32)({
  (p : Point) = Point(i32(1), i32(2));
  p.x;
  return i32(0);
});
export main;
`;

    it("should suggest struct fields after dot", () => {
      const ln = lineOf(source, "p.x");
      const labels = getCompletionLabels(source, ln, 4);
      expect(labels).toContain("x");
      expect(labels).toContain("y");
    });
  });

  // ─── Enum variant completion ───────────────────────────────────────────

  describe("enum variant completion", () => {
    const source = `
Color :: enum(Red, Green, Blue);
main :: (fn() -> i32)({
  (c : Color) = Color.Red;
  c.Red;
  return i32(0);
});
export main;
`;

    it("should suggest enum variants after dot on value", () => {
      const ln = lineOf(source, "c.Red");
      const labels = getCompletionLabels(source, ln, 4);
      expect(labels).toContain("Red");
      expect(labels).toContain("Green");
      expect(labels).toContain("Blue");
    });

    it("should suggest enum variants after dot on type", () => {
      // Color. should show Red, Green, Blue
      const ln = lineOf(source, "Color.Red");
      const labels = getCompletionLabels(source, ln, 22);
      expect(labels).toContain("Red");
      expect(labels).toContain("Green");
      expect(labels).toContain("Blue");
    });

    it("should provide snippets for enum variants with fields", () => {
      const enumSource = `
main :: (fn() -> i32)({
  (x : Option(i32)) = .Some(i32(42));
  x.CURSOR
  return i32(0);
});
export main;
`;
      const ln = lineOf(enumSource, "x.CURSOR");
      const items = getCompletionItems(enumSource, ln, 4);
      const someItem = items.find((i) => i.label === "Some");
      expect(someItem).toBeDefined();
      // Should have snippet with field placeholder
      expect(someItem!.insertText).toContain("Some(");
      expect(someItem!.insertTextFormat).toBe(2); // InsertTextFormat.Snippet = 2
      // None should NOT have a snippet
      const noneItem = items.find((i) => i.label === "None");
      expect(noneItem).toBeDefined();
      expect(noneItem!.insertTextFormat).toBeUndefined();
    });
  });

  // ─── Module member completion ──────────────────────────────────────────

  describe("module member completion", () => {
    const source = `
MathOps :: module(
  /// Add two numbers
  add : (fn(a : i32, b : i32) -> i32),
  /// Negate a number
  neg : (fn(a : i32) -> i32)
);
main :: (fn() -> i32)({
  MathOps.add;
  return i32(0);
});
export main;
`;

    it("should suggest module members after dot", () => {
      const ln = lineOf(source, "MathOps.add");
      const labels = getCompletionLabels(source, ln, 10);
      expect(labels).toContain("add");
      expect(labels).toContain("neg");
    });

    it("should include doc comments for module members", () => {
      const ln = lineOf(source, "MathOps.add");
      const items = getCompletionItems(source, ln, 10);
      const addItem = items.find((i) => i.label === "add");
      expect(addItem).toBeDefined();
      expect(addItem!.documentation).toContain("Add two numbers");
    });
  });

  // ─── Array and slice completion ────────────────────────────────────────

  describe("array and slice completion", () => {
    const source = `
main :: (fn() -> i32)({
  arr := [i32(1), i32(2), i32(3)];
  arr.len;
  return i32(0);
});
export main;
`;

    it("should suggest len for arrays", () => {
      const ln = lineOf(source, "arr.len");
      const labels = getCompletionLabels(source, ln, 6);
      expect(labels).toContain("len");
    });
  });

  // ─── Impl method completion ────────────────────────────────────────────

  describe("impl method completion", () => {
    const source = `
Point :: struct(x : i32, y : i32);

impl(Point,
  /// Get the x coordinate
  get_x : (fn(self : Self) -> i32)(self.x)
);

main :: (fn() -> i32)({
  (p : Point) = Point(i32(1), i32(2));
  p.get_x;
  return i32(0);
});
export main;
`;

    it("should suggest impl methods after dot", () => {
      const ln = lineOf(source, "p.get_x");
      const labels = getCompletionLabels(source, ln, 4);
      expect(labels).toContain("get_x");
      // Also check struct fields are present
      expect(labels).toContain("x");
      expect(labels).toContain("y");
    });

    it("should provide method snippets with parameter placeholders", () => {
      const methodSource = `
Point :: struct(x : i32, y : i32);

impl(Point,
  get_x : (fn(self : Self) -> i32)(self.x),
  add : (fn(self : Self, other : Point) -> Point)(
    Point((self.x + other.x), (self.y + other.y))
  )
);

main :: (fn() -> i32)({
  (p : Point) = Point(i32(1), i32(2));
  p.METHOD
  return i32(0);
});
export main;
`;
      const ln = lineOf(methodSource, "p.METHOD");
      const items = getCompletionItems(methodSource, ln, 4);
      // get_x has only self param → snippet should be get_x()
      const getXItem = items.find((i) => i.label === "get_x");
      expect(getXItem).toBeDefined();
      expect(getXItem!.insertText).toBe("get_x()");
      expect(getXItem!.insertTextFormat).toBe(2); // Snippet

      // add has self + other params → snippet should be add(${1:other})
      const addItem = items.find((i) => i.label === "add");
      expect(addItem).toBeDefined();
      expect(addItem!.insertText).toContain("add(");
      expect(addItem!.insertText).toContain("other");
      expect(addItem!.insertTextFormat).toBe(2); // Snippet
    });
  });

  // ─── Type-level completion ─────────────────────────────────────────────

  describe("type-level completion", () => {
    const source = `
Point :: struct(x : i32, y : i32);

impl(Point,
  origin : (fn() -> Self)(Point(i32(0), i32(0)))
);

main :: (fn() -> i32)({
  (p : Point) = Point.origin;
  return i32(0);
});
export main;
`;

    it("should suggest static methods on type", () => {
      const ln = lineOf(source, "Point.origin");
      const lineText = source.split("\n")[ln] ?? "";
      // Find "Point.origin" in the line and position cursor after "Point."
      const dotIdx = lineText.indexOf("Point.origin") + "Point.".length;
      const labels = getCompletionLabels(source, ln, dotIdx);
      expect(labels).toContain("origin");
    });
  });

  // ─── Self completion inside methods ─────────────────────────────────────

  describe("self completion inside methods", () => {
    const source = `
Point :: struct(x : i32, y : i32);

impl(Point,
  sum : (fn(self : Self) -> i32)({
    return (self.x + self.y);
  })
);

main :: (fn() -> unit)({
  (p : Point) = Point(i32(1), i32(2));
  p.sum();
});
export main;
`;

    it("should suggest struct fields after self.", () => {
      const ln = lineOf(source, "self.x + self.y");
      const lineText = source.split("\n")[ln] ?? "";
      const dotIdx = lineText.indexOf("self.x") + "self.".length;
      const labels = getCompletionLabels(source, ln, dotIdx);
      expect(labels).toContain("x");
      expect(labels).toContain("y");
    });
  });

  // ─── Prelude type completion ──────────────────────────────────────────

  describe("prelude type completion", () => {
    const source = `
main :: (fn() -> unit)({
  (x : Option(i32)) = .Some(i32(42));
  x.unwrap;
});
export main;
`;

    it("should suggest Option methods after dot", () => {
      const ln = lineOf(source, "x.unwrap");
      const lineText = source.split("\n")[ln] ?? "";
      const dotIdx = lineText.indexOf("x.") + 2;
      const labels = getCompletionLabels(source, ln, dotIdx);
      expect(labels).toContain("unwrap");
    });
  });

  // ─── Dirty buffer dot-completion ──────────────────────────────────────

  describe("dirty buffer dot-completion", () => {
    it("should suggest methods for type constructor call on dirty buffer", () => {
      const stdPath = path.resolve(__dirname, "../../std");
      const docManager = new LspDocumentManager(stdPath);
      activeDocManagers.push(docManager);

      const modulePath = `file://${path.resolve(__dirname, "dirty_dot.yo")}`;
      // Good source that evaluates successfully and uses Option
      const goodSource = `
main :: (fn() -> i32)({
  (x : Option(i32)) = .Some(i32(42));
  return i32(0);
});
export main;
`;
      docManager.getModuleManager().loadModule(modulePath, goodSource);

      // Simulate typing "Option(i32)." — causes eval error
      const brokenSource = `
main :: (fn() -> i32)({
  (x : Option(i32)) = .Some(i32(42));
  Option(i32).
  return i32(0);
});
export main;
`;
      const fakeDocument = {
        uri: modulePath,
        getText: () => brokenSource,
      };
      docManager.analyzeDocument(
        fakeDocument as import("vscode-languageserver-textdocument").TextDocument,
        () => {}
      );

      const ln = lineOf(brokenSource, "Option(i32).");
      const lineText = brokenSource.split("\n")[ln]!;
      const character = lineText.indexOf(".") + 1; // right after the dot

      const items = handleCompletion(
        modulePath,
        ln,
        character,
        lineText,
        docManager
      );
      const labels = items.map((item) => item.label);
      // Option(i32) is an enum type — should show Some and None variants
      expect(labels.length).toBeGreaterThan(0);
      // Should also have methods from impl blocks (unwrap, map, etc.)
      expect(labels).toContain("unwrap");
    });

    it("should suggest methods for simple type name on dirty buffer", () => {
      const stdPath = path.resolve(__dirname, "../../std");
      const docManager = new LspDocumentManager(stdPath);
      activeDocManagers.push(docManager);

      const modulePath = `file://${path.resolve(__dirname, "dirty_dot2.yo")}`;
      const goodSource = `
Point :: struct(x : i32, y : i32);
impl(Point,
  sum : (fn(self : Self) -> i32)((self.x + self.y))
);
main :: (fn() -> i32)({
  (p : Point) = Point(i32(1), i32(2));
  return i32(0);
});
export main;
`;
      docManager.getModuleManager().loadModule(modulePath, goodSource);

      // Simulate typing "p." where p doesn't exist in scope (e.g., variable lookup)
      // But Point as a type should still resolve
      const brokenSource = `
Point :: struct(x : i32, y : i32);
impl(Point,
  sum : (fn(self : Self) -> i32)((self.x + self.y))
);
main :: (fn() -> i32)({
  (p : Point) = Point(i32(1), i32(2));
  p.
  return i32(0);
});
export main;
`;
      const fakeDocument = {
        uri: modulePath,
        getText: () => brokenSource,
      };
      docManager.analyzeDocument(
        fakeDocument as import("vscode-languageserver-textdocument").TextDocument,
        () => {}
      );

      const ln = lineOf(brokenSource, "p.");
      const lineText = brokenSource.split("\n")[ln]!;
      const character = lineText.indexOf("p.") + 2; // right after the dot

      const items = handleCompletion(
        modulePath,
        ln,
        character,
        lineText,
        docManager
      );
      const labels = items.map((item) => item.label);
      // p is a Point struct — should show struct fields
      expect(labels).toContain("x");
      expect(labels).toContain("y");
    });
  });

  // ─── Nested struct field completion ──────────────────────────────────

  describe("nested struct field completion", () => {
    const source = `
Inner :: struct(value : i32);
Outer :: struct(inner : Inner, name : i32);
main :: (fn() -> i32)({
  (o : Outer) = Outer(Inner(i32(42)), i32(1));
  o.inner;
  return i32(0);
});
export main;
`;

    it("should suggest fields for nested struct access", () => {
      const ln = lineOf(source, "o.inner");
      const labels = getCompletionLabels(source, ln, 4);
      expect(labels).toContain("inner");
      expect(labels).toContain("name");
    });
  });

  // ─── Result type completion ─────────────────────────────────────────

  describe("Result type completion", () => {
    const source = `
main :: (fn() -> i32)({
  (r : Result(i32, i32)) = .Ok(i32(42));
  r.unwrap;
  return i32(0);
});
export main;
`;

    it("should suggest Result methods after dot", () => {
      const ln = lineOf(source, "r.unwrap");
      const labels = getCompletionLabels(source, ln, 4);
      expect(labels).toContain("unwrap");
    });

    it("should suggest Result enum variants with snippets", () => {
      const items = getCompletionItems(source, lineOf(source, "r.unwrap"), 4);
      const okItem = items.find((i) => i.label === "Ok");
      const errItem = items.find((i) => i.label === "Err");
      expect(okItem).toBeDefined();
      expect(errItem).toBeDefined();
      // Ok and Err should have snippets since they have fields
      expect(okItem!.insertTextFormat).toBe(2); // InsertTextFormat.Snippet
      expect(errItem!.insertTextFormat).toBe(2);
    });
  });

  // ─── Keyword completion ────────────────────────────────────────────────

  describe("keyword completion", () => {
    const source = `
main :: (fn() -> i32)({
  ret
  return i32(0);
});
export main;
`;

    it("should suggest keywords matching prefix", () => {
      const ln = lineOf(source, "ret");
      const labels = getCompletionLabels(source, ln, 5);
      expect(labels).toContain("return");
    });
  });
});

// ─── Hover tests ─────────────────────────────────────────────────────────

describe("LSP Hover", () => {
  describe("variable hover", () => {
    const source = `
Point :: struct(x : i32, y : i32);
main :: (fn() -> i32)({
  (p : Point) = Point(i32(1), i32(2));
  p;
  return i32(0);
});
export main;
`;

    it("should show type on variable hover", () => {
      const { uri, docManager } = loadSource(source);
      const ln = lineOf(source, "  p;");
      const hover = handleHover(uri, ln, 2, docManager);
      expect(hover).not.toBeNull();
      expect(hover!.contents).toBeDefined();
      const content =
        typeof hover!.contents === "string"
          ? hover!.contents
          : "value" in hover!.contents
            ? hover!.contents.value
            : "";
      expect(content).toContain("Point");
    });
  });

  describe("struct type hover", () => {
    const source = `
/// A 2D point
Point :: struct(x : i32, y : i32);
main :: (fn() -> i32)({
  Point;
  return i32(0);
});
export main;
`;

    it("should show doc comment on type hover", () => {
      const { uri, docManager } = loadSource(source);
      const ln = lineOf(source, "  Point;");
      const hover = handleHover(uri, ln, 2, docManager);
      expect(hover).not.toBeNull();
      const content =
        typeof hover!.contents === "string"
          ? hover!.contents
          : "value" in hover!.contents
            ? hover!.contents.value
            : "";
      expect(content).toContain("Point");
    });
  });

  describe("function hover", () => {
    const source = `
/// Adds two integers
add :: (fn(a : i32, b : i32) -> i32)((a + b));
main :: (fn() -> i32)({
  add;
  return i32(0);
});
export main;
`;

    it("should show function signature and doc comment", () => {
      const { uri, docManager } = loadSource(source);
      const ln = lineOf(source, "  add;");
      const hover = handleHover(uri, ln, 2, docManager);
      expect(hover).not.toBeNull();
      const content =
        typeof hover!.contents === "string"
          ? hover!.contents
          : "value" in hover!.contents
            ? hover!.contents.value
            : "";
      expect(content).toContain("add");
    });
  });

  describe("impl field label hover", () => {
    const source = `
Point :: struct(x : i32, y : i32);

impl(Point,
  /// Get the x coordinate
  get_x : (fn(self : Self) -> i32)(self.x)
);

main :: (fn() -> i32)(i32(0));
export main;
`;

    it("should show type and doc comment for impl field label", () => {
      const { uri, docManager } = loadSource(source);
      // Find the `get_x` label in the impl block
      const ln = lineOf(source, "get_x :");
      const hover = handleHover(uri, ln, 2, docManager);
      expect(hover).not.toBeNull();
      const content =
        typeof hover!.contents === "string"
          ? hover!.contents
          : "value" in hover!.contents
            ? hover!.contents.value
            : "";
      expect(content).toContain("get_x");
    });
  });

  describe("hover fallback on dirty buffer", () => {
    it("should fall back to last good module when current has errors", () => {
      const stdPath = path.resolve(__dirname, "../../std");
      const docManager = new LspDocumentManager(stdPath);
      activeDocManagers.push(docManager);

      const modulePath = `file://${path.resolve(__dirname, "hover_fallback.yo")}`;
      const goodSource = `
Point :: struct(x : i32, y : i32);
main :: (fn() -> i32)({
  (p : Point) = Point(i32(1), i32(2));
  p;
  return i32(0);
});
export main;
`;
      // Load the good version first
      docManager.getModuleManager().loadModule(modulePath, goodSource);

      // Simulate the user typing something that breaks evaluation.
      // analyzeDocument caches the old module, then re-evaluates with broken code.
      const brokenSource = `
Point :: struct(x : i32, y : i32);
main :: (fn() -> i32)({
  (p : Point) = Point(i32(1), i32(2));
  Option
  return i32(0);
});
export main;
`;
      const fakeDocument = {
        uri: modulePath,
        getText: () => brokenSource,
      };
      docManager.analyzeDocument(
        fakeDocument as import("vscode-languageserver-textdocument").TextDocument,
        () => {}
      );

      // Hover on "Point" in the broken buffer — should still work via fallback
      const ln = 1; // "Point :: struct(...)" is line 1 (0-indexed, line 0 is blank)
      const hover = handleHover(modulePath, ln, 0, docManager);
      expect(hover).not.toBeNull();
      const content =
        typeof hover!.contents === "string"
          ? hover!.contents
          : "value" in hover!.contents
            ? hover!.contents.value
            : "";
      expect(content).toContain("Point");
    });

    it("should show hover for known identifiers in dirty buffer", () => {
      const stdPath = path.resolve(__dirname, "../../std");
      const docManager = new LspDocumentManager(stdPath);
      activeDocManagers.push(docManager);

      const modulePath = `file://${path.resolve(__dirname, "hover_option.yo")}`;
      const goodSource = `
main :: (fn() -> i32)({
  return i32(0);
});
export main;
`;
      // Load the good version first
      docManager.getModuleManager().loadModule(modulePath, goodSource);

      // Simulate user typing "Option" without semicolon (breaks evaluation)
      const brokenSource = `
main :: (fn() -> i32)({
  Option
  return i32(0);
});
export main;
`;
      const fakeDocument = {
        uri: modulePath,
        getText: () => brokenSource,
      };
      docManager.analyzeDocument(
        fakeDocument as import("vscode-languageserver-textdocument").TextDocument,
        () => {}
      );

      // Hover over "Option" — should find it via env lookup in fallback module
      const optionLn = lineOf(brokenSource, "Option");
      const hover = handleHover(modulePath, optionLn, 2, docManager);
      expect(hover).not.toBeNull();
      const content =
        typeof hover!.contents === "string"
          ? hover!.contents
          : "value" in hover!.contents
            ? hover!.contents.value
            : "";
      // Option is a known type constructor from prelude
      expect(content).toContain("Option");
    });
  });
});

describe("LSP Completion - Import paths", () => {
  it("should suggest std modules for import path", () => {
    const source = `
open import "std/";
`;
    const { uri, docManager } = loadSource(source);
    const ln = lineOf(source, 'import "std/');
    const lineText = source.split("\n")[ln]!;
    const col = lineText.indexOf('"std/') + 5; // After "std/
    const items = handleCompletion(uri, ln, col, lineText, docManager);
    const labels = items.map((i) => i.label);
    // Should include known std modules
    expect(labels).toContain("string");
    expect(labels).toContain("fmt");
    expect(labels).toContain("collections");
    expect(labels.length).toBeGreaterThan(5);
  });

  it("should suggest subdirectories in std/collections/", () => {
    const source = `
open import "std/collections/";
`;
    const { uri, docManager } = loadSource(source);
    const ln = lineOf(source, 'import "std/collections/');
    const lineText = source.split("\n")[ln]!;
    // Position cursor right after "std/collections/" — inside the quotes
    const target = 'open import "std/collections/';
    const col = target.length;
    const items = handleCompletion(uri, ln, col, lineText, docManager);
    const labels = items.map((i) => i.label);
    expect(labels).toContain("array_list");
    expect(labels).toContain("hash_map");
  });
});

describe("LSP Definition", () => {
  describe("import path go-to-definition", () => {
    const source = `
open import "std/string";
main :: (fn() -> i32)({
  return i32(0);
});
export main;
`;

    it("should navigate to imported module file", () => {
      const { uri, docManager } = loadSource(source);
      const ln = lineOf(source, '"std/string"');
      // Position the cursor inside the string literal
      const line = source.split("\n")[ln]!;
      const col = line.indexOf('"std/string"') + 1;
      const def = handleDefinition(uri, ln, col, docManager);
      expect(def).not.toBeNull();
      // Should point to a file path containing "string"
      expect(def!.uri).toContain("string");
      // Should be a .yo file
      expect(def!.uri).toMatch(/\.yo$/);
    });
  });

  describe("variable go-to-definition", () => {
    const source = `
Point :: struct(x : i32, y : i32);
main :: (fn() -> i32)({
  (p : Point) = Point(i32(1), i32(2));
  p;
  return i32(0);
});
export main;
`;

    it("should navigate to variable definition", () => {
      const { uri, docManager } = loadSource(source);
      const ln = lineOf(source, "  p;");
      const def = handleDefinition(uri, ln, 2, docManager);
      expect(def).not.toBeNull();
      // Should point to the same file
      expect(def!.uri).toBe(uri);
      // Should point to the declaration line (where `p` is defined)
      const declLine = lineOf(source, "(p : Point) = Point");
      expect(def!.range.start.line).toBe(declLine);
    });
  });

  describe("struct field go-to-definition", () => {
    const source = `
Point :: struct(
  /// X coordinate
  x : i32,
  /// Y coordinate
  y : i32
);
main :: (fn() -> i32)({
  (p : Point) = Point(i32(1), i32(2));
  p.x;
  return i32(0);
});
export main;
`;

    it("should navigate to struct field definition from property access", () => {
      const { uri, docManager } = loadSource(source);
      const ln = lineOf(source, "p.x;");
      // cursor on 'x' after the dot
      const line = source.split("\n")[ln]!;
      const col = line.indexOf(".x") + 1; // on 'x'
      const def = handleDefinition(uri, ln, col, docManager);
      expect(def).not.toBeNull();
      // Should point to the struct field definition
      const fieldLine = lineOf(source, "x : i32");
      expect(def!.range.start.line).toBe(fieldLine);
    });
  });

  describe("method go-to-definition", () => {
    const source = `
Point :: struct(x : i32, y : i32);
impl(Point,
  /// Create an origin point
  origin : (fn() -> Self)(Self(i32(0), i32(0)))
);
main :: (fn() -> i32)({
  p := Point.origin();
  return i32(0);
});
export main;
`;

    it("should navigate to impl method definition from call", () => {
      const { uri, docManager } = loadSource(source);
      const ln = lineOf(source, "Point.origin()");
      const line = source.split("\n")[ln]!;
      const col = line.indexOf("origin"); // on 'origin'
      const def = handleDefinition(uri, ln, col, docManager);
      expect(def).not.toBeNull();
      // Should point to the impl method definition
      const methodLine = lineOf(source, "origin : (fn() -> Self)");
      expect(def!.range.start.line).toBe(methodLine);
    });
  });
});

// ─── Additional Completion Tests ──────────────────────────────────────────

describe("LSP Completion - Union types", () => {
  it("should suggest union fields after dot", () => {
    const source = `
FloatOrInt :: union(f : f32, i : i32);
main :: (fn() -> i32)({
  (v : FloatOrInt) = FloatOrInt(f32(1.0));
  v.f;
  return i32(0);
});
export main;
`;
    const ln = lineOf(source, "v.f");
    const labels = getCompletionLabels(source, ln, 4);
    expect(labels).toContain("f");
    expect(labels).toContain("i");
  });
});

describe("LSP Completion - Newtype", () => {
  it("should suggest newtype field after dot", () => {
    const source = `
MyInt :: newtype(value : i32);
main :: (fn() -> i32)({
  (mi : MyInt) = MyInt(i32(42));
  mi.value;
  return i32(0);
});
export main;
`;
    const ln = lineOf(source, "mi.value");
    const labels = getCompletionLabels(source, ln, 5);
    expect(labels).toContain("value");
  });
});

describe("LSP Hover - property access", () => {
  it("should show type info for struct field in property access", () => {
    const source = `
Point :: struct(
  /// X coordinate
  x : i32,
  /// Y coordinate
  y : i32
);
main :: (fn() -> i32)({
  (p : Point) = Point(i32(1), i32(2));
  p.x;
  return i32(0);
});
export main;
`;
    const { uri, docManager } = loadSource(source);
    const ln = lineOf(source, "p.x;");
    const line = source.split("\n")[ln]!;
    const col = line.indexOf(".x") + 1; // on 'x'
    const hover = handleHover(uri, ln, col, docManager);
    expect(hover).not.toBeNull();
    // Should contain type info (i32) and doc comment
    const contents = hover!.contents;
    const hoverText =
      typeof contents === "string"
        ? contents
        : "value" in contents
          ? contents.value
          : "";
    expect(hoverText).toContain("i32");
  });

  it("should show doc comment for struct field in property access", () => {
    const source = `
Point :: struct(
  /// X coordinate
  x : i32,
  /// Y coordinate
  y : i32
);
main :: (fn() -> i32)({
  (p : Point) = Point(i32(1), i32(2));
  p.y;
  return i32(0);
});
export main;
`;
    const { uri, docManager } = loadSource(source);
    const ln = lineOf(source, "p.y;");
    const line = source.split("\n")[ln]!;
    const col = line.indexOf(".y") + 1; // on 'y'
    const hover = handleHover(uri, ln, col, docManager);
    expect(hover).not.toBeNull();
    const contents = hover!.contents;
    const hoverText =
      typeof contents === "string"
        ? contents
        : "value" in contents
          ? contents.value
          : "";
    expect(hoverText).toContain("Y coordinate");
  });
});
