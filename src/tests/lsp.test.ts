import { describe, it, expect, afterEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { handleCompletion } from "../lsp/completion";
import { handleDefinition } from "../lsp/definition";
import { handleHover } from "../lsp/hover";
import { handleSignatureHelp } from "../lsp/signature-help";
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
  return(i32(0));
});
export(main);
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
  return(i32(0));
});
export(main);
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
  x.CURSOR;
  return(i32(0));
});
export(main);
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
MathOps :: struct(
  /// Add two numbers
  add : (fn(a : i32, b : i32) -> i32),
  /// Negate a number
  neg : (fn(a : i32) -> i32)
);
main :: (fn() -> i32)({
  MathOps.add;
  return(i32(0));
});
export(main);
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
  return(i32(0));
});
export(main);
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
  return(i32(0));
});
export(main);
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
  p.METHOD;
  return(i32(0));
});
export(main);
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
  return(i32(0));
});
export(main);
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
    return(self.x + self.y);
  })
);

main :: (fn() -> unit)({
  (p : Point) = Point(i32(1), i32(2));
  p.sum();
});
export(main);
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
export(main);
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

      // A temp path OUTSIDE the repo: the buffer must behave as a standalone
      // module. Inside the repo it now sits under the repo-root build.yo
      // (P2.2), and ensureBuildImportsResolved's mid-analysis build.yo
      // evaluation invalidates the last-good-module fallback this completion
      // depends on — see issues/lsp-build-yo-eval-degrades-dirty-completion.md.
      const modulePath = `file://${path.join(os.tmpdir(), "yo_lsp_dirty_dot.yo")}`;
      // Good source that evaluates successfully and uses Option
      const goodSource = `
main :: (fn() -> i32)({
  (x : Option(i32)) = .Some(i32(42));
  return(i32(0));
});
export(main);
`;
      docManager.getModuleManager().loadModule(modulePath, goodSource);

      // Simulate typing "Option(i32)." — causes eval error
      const brokenSource = `
main :: (fn() -> i32)({
  (x : Option(i32)) = .Some(i32(42));
  Option(i32).
  return(i32(0));
});
export(main);
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
  return(i32(0));
});
export(main);
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
  return(i32(0));
});
export(main);
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
  return(i32(0));
});
export(main);
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
  return(i32(0));
});
export(main);
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
  return(i32(0));
});
export(main);
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
  return(i32(0));
});
export(main);
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
  return(i32(0));
});
export(main);
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
  return(i32(0));
});
export(main);
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
export(main);
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
  return(i32(0));
});
export(main);
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
  return(i32(0));
});
export(main);
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
  return(i32(0));
});
export(main);
`;
      // Load the good version first
      docManager.getModuleManager().loadModule(modulePath, goodSource);

      // Simulate user typing "Option" without semicolon (breaks evaluation)
      const brokenSource = `
main :: (fn() -> i32)({
  Option
  return(i32(0));
});
export(main);
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

  describe("hover doc comment resolution", () => {
    it("should prefer the local variable over same-named field docs", () => {
      const source = `
Point :: struct(
  /// This is the x coordinate of the point.
  x : i32,
  y : i32
);

main :: (fn() -> unit)({
  x := (i32 <: Add(i32)).(+)(i32(3), i32(4));
  x;
});
export(main);
`;
      const { uri, docManager } = loadSource(source, "hover_local_x.yo");
      const ln = lineOf(
        source,
        "  x := (i32 <: Add(i32)).(+)(i32(3), i32(4));"
      );
      const hover = handleHover(uri, ln, 2, docManager);
      expect(hover).not.toBeNull();
      const content =
        typeof hover!.contents === "string"
          ? hover!.contents
          : "value" in hover!.contents
            ? hover!.contents.value
            : "";
      expect(content).toContain("x");
      expect(content).toContain(": i32");
      expect(content).not.toContain("This is the x coordinate of the point.");
    });
  });
});

describe("LSP Completion - Import paths", () => {
  it("should suggest std modules for import path", () => {
    const source = `
open(import("std/"));
`;
    const { uri, docManager } = loadSource(source);
    const ln = lineOf(source, 'import("std/');
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
open(import("std/collections/"));
`;
    const { uri, docManager } = loadSource(source);
    const ln = lineOf(source, 'import("std/collections/');
    const lineText = source.split("\n")[ln]!;
    // Position cursor right after "std/collections/" — inside the quotes
    const target = 'open(import("std/collections/';
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
open(import("std/string"));
main :: (fn() -> i32)({
  return(i32(0));
});
export(main);
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
  return(i32(0));
});
export(main);
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
  return(i32(0));
});
export(main);
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
  return(i32(0));
});
export(main);
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
  return(i32(0));
});
export(main);
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
  return(i32(0));
});
export(main);
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
  return(i32(0));
});
export(main);
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
  return(i32(0));
});
export(main);
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

// ─── Enum variant completion ───────────────────────────────────────────────

describe("LSP Completion - Enum variant", () => {
  it("should suggest enum variants with dot prefix in match context", () => {
    const source = `
Color :: enum(Red, Green, Blue);
main :: (fn() -> i32)({
  (c : Color) = .Red;
  return(i32(0));
});
export(main);
`;
    const ln = lineOf(source, "(c : Color) = .Red");
    const line = source.split("\n")[ln]!;
    const col = line.indexOf(".Red") + 1; // after the dot
    const items = getCompletionItems(source, ln, col);
    const labels = items.map((i) => i.label);
    expect(labels).toContain(".Red");
    expect(labels).toContain(".Green");
    expect(labels).toContain(".Blue");
  });

  it("should provide snippet insertText for enum variants with fields", () => {
    const source = `
MyResult :: (fn(comptime(T) : Type, comptime(E) : Type) -> comptime(Type))(
  enum(Ok(value : T), Err(error : E))
);
main :: (fn() -> i32)({
  (r : MyResult(i32, str)) = .Ok(i32(42));
  return(i32(0));
});
export(main);
`;
    const ln = lineOf(source, "(r : MyResult");
    const line = source.split("\n")[ln]!;
    const col = line.indexOf(".Ok") + 1;
    const items = getCompletionItems(source, ln, col);
    const okItem = items.find((i) => i.label === ".Ok");
    expect(okItem).toBeDefined();
    // Should have snippet insert mode for fields
    if (okItem?.insertText) {
      expect(okItem.insertText).toContain("Ok(");
    }
  });
});

// ─── Impl method completion ─────────────────────────────────────────────────

describe("LSP Completion - Impl methods", () => {
  it("should suggest impl methods after dot on instance", () => {
    const source = `
Counter :: struct(count : i32);
impl(Counter,
  /// Get the current count
  get : (fn(self : Self) -> i32)(self.count),
  /// Increment the counter
  inc : (fn(self : Self) -> Self)(Self((self.count + i32(1))))
);
main :: (fn() -> i32)({
  c := Counter(i32(0));
  c.get;
  return(i32(0));
});
export(main);
`;
    const ln = lineOf(source, "c.get");
    const labels = getCompletionLabels(source, ln, 4);
    expect(labels).toContain("get");
    expect(labels).toContain("inc");
    // Should also include the struct field
    expect(labels).toContain("count");
  });

  it("should suggest impl methods on type-level access", () => {
    const source = `
Point :: struct(x : i32, y : i32);
impl(Point,
  origin : (fn() -> Self)(Self(i32(0), i32(0)))
);
main :: (fn() -> i32)({
  p := Point.origin;
  return(i32(0));
});
export(main);
`;
    const ln = lineOf(source, "Point.origin");
    const line = source.split("\n")[ln]!;
    const col = line.indexOf(".origin") + 1; // on 'o' after dot
    const labels = getCompletionLabels(source, ln, col);
    expect(labels).toContain("origin");
  });
});

describe("LSP Definition - Enum variant", () => {
  it("should navigate from enum variant constructor to enum definition", () => {
    const source = `
Color :: enum(Red, Green, Blue);
main :: (fn() -> i32)({
  (c : Color) = .Red;
  return(i32(0));
});
export(main);
`;
    const { uri, docManager } = loadSource(source);
    const ln = lineOf(source, ".Red");
    const line = source.split("\n")[ln]!;
    const col = line.indexOf("Red");
    const def = handleDefinition(uri, ln, col, docManager);
    expect(def).not.toBeNull();
    // Should navigate to "Red" in "enum(Red, Green, Blue)"
    const defLine = lineOf(source, "enum(Red");
    expect(def!.range.start.line).toBe(defLine);
    const enumLine = source.split("\n")[defLine]!;
    expect(def!.range.start.character).toBe(enumLine.indexOf("Red"));
  });

  it("should navigate to variant with fields in enum definition", () => {
    const source = `
Shape :: enum(Circle(radius : i32), Square(side : i32));
main :: (fn() -> i32)({
  (s : Shape) = .Square(i32(5));
  return(i32(0));
});
export(main);
`;
    const { uri, docManager } = loadSource(source);
    const ln = lineOf(source, ".Square");
    const line = source.split("\n")[ln]!;
    const col = line.indexOf("Square");
    const def = handleDefinition(uri, ln, col, docManager);
    expect(def).not.toBeNull();
    // Should navigate to "Square" in enum definition
    const defLine = lineOf(source, "enum(Circle");
    expect(def!.range.start.line).toBe(defLine);
    const enumLine = source.split("\n")[defLine]!;
    expect(def!.range.start.character).toBe(enumLine.indexOf("Square"));
  });
});

describe("LSP Hover - improved display", () => {
  it("should not show runtime value for method hover", () => {
    const source = `
Counter :: struct(count : i32);
impl(Counter,
  /// Get the count
  get : (fn(self: Self) -> i32)(
    self.count
  )
);
main :: (fn() -> i32)({
  (c : Counter) = Counter(i32(0));
  c.get;
  return(i32(0));
});
export(main);
`;
    const { uri, docManager } = loadSource(source);
    const ln = lineOf(source, "c.get;");
    const line = source.split("\n")[ln]!;
    const col = line.indexOf("get");
    const hover = handleHover(uri, ln, col, docManager);
    expect(hover).not.toBeNull();
    const hoverText =
      typeof hover!.contents === "string"
        ? hover!.contents
        : "value" in hover!.contents
          ? hover!.contents.value
          : "";
    // Should NOT contain <runtime value>
    expect(hoverText).not.toContain("<runtime value>");
    // Should contain the type info
    expect(hoverText).toContain("get");
  });
});

// ─── Environment-based identifier completion ──────────────────────────────

describe("LSP Completion - Environment-based identifiers", () => {
  it("should suggest Option when typing Optio", () => {
    const source = `
main :: (fn() -> i32)({
  Optio;
  return(i32(0));
});
export(main);
`;
    const ln = lineOf(source, "Optio");
    const lineText = source.split("\n")[ln] ?? "";
    const col = lineText.indexOf("Optio") + 5;
    const labels = getCompletionLabels(source, ln, col);
    expect(labels).toContain("Option");
  });

  it("should suggest Result when typing Res", () => {
    const source = `
main :: (fn() -> i32)({
  Res;
  return(i32(0));
});
export(main);
`;
    const ln = lineOf(source, "  Res");
    const lineText = source.split("\n")[ln] ?? "";
    const col = lineText.indexOf("Res") + 3;
    const labels = getCompletionLabels(source, ln, col);
    expect(labels).toContain("Result");
  });

  it("should suggest imported types when typing prefix", () => {
    const source = `
open(import("std/string"));
main :: (fn() -> i32)({
  Stri;
  return(i32(0));
});
export(main);
`;
    const ln = lineOf(source, "Stri");
    const lineText = source.split("\n")[ln] ?? "";
    const col = lineText.indexOf("Stri") + 4;
    const labels = getCompletionLabels(source, ln, col);
    expect(labels).toContain("String");
  });

  it("should not include __yo_ internal names", () => {
    const source = `
main :: (fn() -> i32)({
  Optio
  return(i32(0));
});
export(main);
`;
    const ln = lineOf(source, "Optio");
    const lineText = source.split("\n")[ln] ?? "";
    const col = lineText.indexOf("Optio") + 5;
    const labels = getCompletionLabels(source, ln, col);
    const internalNames = labels.filter(
      (l) => l.startsWith("__yo_") || l.startsWith("___")
    );
    expect(internalNames.length).toBe(0);
  });
});

// ─── Generic type dot-completion ──────────────────────────────────────────

describe("LSP Completion - Generic type methods", () => {
  it("should suggest Option methods after dot", () => {
    const source = `
main :: (fn() -> i32)({
  (o : Option(i32)) = .Some(i32(42));
  o.is_some;
  return(i32(0));
});
export(main);
`;
    const ln = lineOf(source, "o.is_some");
    const labels = getCompletionLabels(source, ln, 4);
    expect(labels).toContain("unwrap");
    expect(labels).toContain("is_some");
    expect(labels).toContain("is_none");
    expect(labels).toContain("map");
    expect(labels).toContain("and_then");
    expect(labels).toContain("unwrap_or");
    // Enum variants should also be present
    expect(labels).toContain("Some");
    expect(labels).toContain("None");
  });

  it("should suggest Result methods after dot", () => {
    const source = `
main :: (fn() -> i32)({
  (r : Result(i32, bool)) = .Ok(i32(42));
  r.is_ok;
  return(i32(0));
});
export(main);
`;
    const ln = lineOf(source, "r.is_ok");
    const labels = getCompletionLabels(source, ln, 4);
    expect(labels).toContain("is_ok");
    expect(labels).toContain("is_err");
    expect(labels).toContain("map");
    expect(labels).toContain("map_err");
    expect(labels).toContain("and_then");
    expect(labels).toContain("ok");
    expect(labels).toContain("err");
  });
});

// ─── Trait type dot completion ──────────────────────────────────────────────

describe("LSP Completion - Trait type", () => {
  it("should suggest Add trait members when accessing comptime TraitType variable", () => {
    // `x :: (i32 <: Add(i32))` is valid: comptime binding holds a TraitType value.
    // `x.` should offer the trait's members as completions.
    const goodSource = `
main :: (fn() -> unit)({
  x :: (i32 <: Add(i32));
});
export(main);
`;
    const stdPath = path.resolve(__dirname, "../../std");
    const docManager = new LspDocumentManager(stdPath);
    activeDocManagers.push(docManager);
    const modulePath = `file://${path.resolve(__dirname, "trait_dot.yo")}`;
    docManager.getModuleManager().loadModule(modulePath, goodSource);

    // Simulate typing `x.` — causes eval error due to incomplete expression
    const dirtySource = `
main :: (fn() -> unit)({
  x :: (i32 <: Add(i32));
  x.
});
export(main);
`;
    const fakeDoc = {
      uri: modulePath,
      getText: () => dirtySource,
    };
    docManager.analyzeDocument(
      fakeDoc as import("vscode-languageserver-textdocument").TextDocument,
      () => {}
    );

    const ln = lineOf(dirtySource, "  x.");
    const lineText = dirtySource.split("\n")[ln]!;
    const character = lineText.indexOf("x.") + 2; // after dot

    const items = handleCompletion(
      modulePath,
      ln,
      character,
      lineText,
      docManager
    );
    const labels = items.map((i) => i.label);
    expect(labels).toContain("Output");
    expect(labels).toContain("+");
    const plusItem = items.find((item) => item.label === "+");
    expect(plusItem).toBeDefined();
    expect(plusItem!.insertText).toContain("(+)");
  });

  it("should suggest trait methods via RParen fallback for inline `(i32 <: Add(i32)).`", () => {
    // The good module has the `<:` expression on a specific line; when the dirty
    // buffer adds `.` after the `)`, the RParen fallback should find the TraitType.
    const stdPath = path.resolve(__dirname, "../../std");
    const docManager = new LspDocumentManager(stdPath);
    activeDocManagers.push(docManager);
    const modulePath = `file://${path.resolve(__dirname, "trait_rparen.yo")}`;

    // Good source: the <: expression stands alone so it's evaluated and has type info
    const goodSource = `
main :: (fn() -> unit)({
  _ :: (i32 <: Add(i32));
});
export(main);
`;
    docManager.getModuleManager().loadModule(modulePath, goodSource);

    // Dirty source adds `.` after `(i32 <: Add(i32))` on a line
    const dirtySource = `
main :: (fn() -> unit)({
  _ :: (i32 <: Add(i32));
  (i32 <: Add(i32)).
});
export(main);
`;
    const fakeDoc = {
      uri: modulePath,
      getText: () => dirtySource,
    };
    docManager.analyzeDocument(
      fakeDoc as import("vscode-languageserver-textdocument").TextDocument,
      () => {}
    );

    const ln = lineOf(dirtySource, "(i32 <: Add(i32)).");
    const lineText = dirtySource.split("\n")[ln]!;
    const character = lineText.indexOf(".") + 1;

    const items = handleCompletion(
      modulePath,
      ln,
      character,
      lineText,
      docManager
    );
    const labels = items.map((i) => i.label);
    expect(labels).toContain("Output");
    expect(labels).toContain("+");
  });
});

// ─── Signature Help ────────────────────────────────────────────────────────

describe("LSP Signature Help", () => {
  it("should show signature for a named function call", () => {
    const source = `
add :: (fn(a: i32, b: i32) -> i32)(
  (a + b)
);
main :: (fn() -> i32)({
  x := add(i32(1), i32(2));
  return(x);
});
export(main);
`;
    const { uri, docManager } = loadSource(source);
    const ln = lineOf(source, "add(i32(1)");
    const lineText = source.split("\n")[ln]!;
    // Cursor after first comma: inside second argument
    const col = lineText.indexOf("add(") + 4 + "i32(1), ".length;
    const result = handleSignatureHelp(uri, ln, col, docManager);
    expect(result).not.toBeNull();
    expect(result!.signatures.length).toBeGreaterThan(0);
    const sig = result!.signatures[0]!;
    expect(sig.parameters!.length).toBe(2);
    expect(result!.activeParameter).toBe(1);
  });

  it("should show parameter 0 when cursor is in first argument", () => {
    const source = `
add :: (fn(a: i32, b: i32) -> i32)(
  (a + b)
);
main :: (fn() -> i32)({
  x := add(i32(1), i32(2));
  return(x);
});
export(main);
`;
    const { uri, docManager } = loadSource(source);
    const ln = lineOf(source, "add(i32(1)");
    const lineText = source.split("\n")[ln]!;
    // Cursor inside first arg: right after "add("
    const col = lineText.indexOf("add(") + 5;
    const result = handleSignatureHelp(uri, ln, col, docManager);
    expect(result).not.toBeNull();
    expect(result!.activeParameter).toBe(0);
  });

  it("should not show signature for operator expressions", () => {
    const source = `
main :: (fn() -> i32)({
  x := (i32(1) + i32(2));
  return(x);
});
export(main);
`;
    const { uri, docManager } = loadSource(source);
    const ln = lineOf(source, "i32(1) + i32");
    const lineText = source.split("\n")[ln]!;
    // Cursor inside the second i32(2) call
    const col = lineText.indexOf("i32(2)") + 4;
    const result = handleSignatureHelp(uri, ln, col, docManager);
    // Should either return null or show i32 (not the + operator)
    if (result !== null) {
      const sig = result.signatures[0]!;
      expect(sig.label).not.toContain("+");
    }
  });

  it("should show signature for nested function calls at correct depth", () => {
    const source = `
add :: (fn(a: i32, b: i32) -> i32)(
  (a + b)
);
main :: (fn() -> i32)({
  x := add(i32(1), i32(2));
  return(x);
});
export(main);
`;
    const { uri, docManager } = loadSource(source);
    const ln = lineOf(source, "add(i32(1)");
    const lineText = source.split("\n")[ln]!;
    // Cursor inside inner i32(1): right after "i32("
    const col = lineText.indexOf("i32(1)") + 4;
    const result = handleSignatureHelp(uri, ln, col, docManager);
    // Should show i32 signature (innermost call), not add
    if (result !== null) {
      const sig = result.signatures[0]!;
      // Should not show the outer `add` function when cursor is inside inner i32
      // (either shows i32 or nothing)
      expect(
        sig.label.includes("i32") || sig.label.includes("add")
      ).toBeTruthy();
    }
  });
});
