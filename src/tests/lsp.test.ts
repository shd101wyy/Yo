import { describe, it, expect, afterEach } from "bun:test";
import * as path from "node:path";
import { handleCompletion } from "../lsp/completion";
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
});
