// Tests for the HTML documentation renderer.
//
// Tests cover:
// - HTML escaping
// - Search index generation
// - First sentence extraction
// - Full site rendering with markdown_yo WASM
// - Page structure validation

import { describe, test, expect, afterAll } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import type { DocModel, DocModule } from "./model";
import {
  renderDocSite,
  destroyMarkdownRenderer,
  escapeHtml,
  buildSearchIndex,
  firstSentence,
} from "./render-html";

const TEST_OUTPUT_DIR = path.join(process.cwd(), "tmp", "test-doc-html");

function cleanup(): void {
  if (fs.existsSync(TEST_OUTPUT_DIR)) {
    fs.rmSync(TEST_OUTPUT_DIR, { recursive: true });
  }
}

afterAll(() => {
  cleanup();
  destroyMarkdownRenderer();
});

// ── Unit tests ───────────────────────────────────────────────────────

describe("escapeHtml", () => {
  test("escapes special characters", () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"
    );
  });

  test("escapes ampersand", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  test("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("firstSentence", () => {
  test("extracts first sentence ending with period", () => {
    expect(firstSentence("Hello world. More text here.")).toBe("Hello world.");
  });

  test("extracts first sentence ending with exclamation", () => {
    expect(firstSentence("Welcome! This is great.")).toBe("Welcome!");
  });

  test("handles text without sentence-ending punctuation", () => {
    expect(firstSentence("No punctuation")).toBe("No punctuation");
  });

  test("handles text with newline", () => {
    expect(firstSentence("First line\nSecond line.")).toBe("First line");
  });

  test("ignores periods inside inline code", () => {
    expect(
      firstSentence(
        "C11 `<assert.h>` — assertion debugging facility. More details here."
      )
    ).toBe("C11 `<assert.h>` — assertion debugging facility.");
  });

  test("ignores periods inside filenames", () => {
    expect(firstSentence("Use stdio.h for C I/O. More text here.")).toBe(
      "Use stdio.h for C I/O."
    );
  });

  test("truncates long text without punctuation", () => {
    const longText = "a".repeat(200);
    const result = firstSentence(longText);
    expect(result.length).toBeLessThanOrEqual(120);
  });
});

describe("buildSearchIndex", () => {
  test("builds index from model", () => {
    const model: DocModel = {
      name: "test",
      modules: [
        {
          name: "mymod",
          path: "mymod",
          doc: "Module doc.",
          functions: [
            {
              name: "my_func",
              signature: "fn(x: i32) -> i32",
              parameters: [],
              returnType: "i32",
              isMethod: false,
            },
          ],
          types: [
            {
              name: "Point",
              kind: "struct",
              signature: "struct(x: i32, y: i32)",
              methods: [
                {
                  name: "new",
                  signature: "fn() -> Point",
                  parameters: [],
                  returnType: "Point",
                  isMethod: true,
                  selfType: "Point",
                },
              ],
              traitImpls: [],
            },
          ],
          traits: [
            {
              name: "Display",
              kind: "trait",
              signature: "trait(show: fn(self: Self) -> String)",
              methods: [],
              implementors: ["Point"],
            },
          ],
          constants: [
            {
              name: "VERSION",
              type: "i32",
              value: "42",
            },
          ],
          submodules: [],
        },
      ],
    };

    const index = buildSearchIndex(model);

    // Should have: module, function, type, method, trait, constant = 6
    expect(index.length).toBe(6);

    const moduleEntry = index.find((e) => e.kind === "module");
    expect(moduleEntry?.name).toBe("mymod");
    expect(moduleEntry?.href).toBe("module/mymod.html");

    const fnEntry = index.find((e) => e.kind === "function");
    expect(fnEntry?.name).toBe("my_func");
    expect(fnEntry?.href).toBe("module/mymod.html#fn-my_func");

    const typeEntry = index.find((e) => e.kind === "struct");
    expect(typeEntry?.name).toBe("Point");

    const methodEntry = index.find((e) => e.kind === "method");
    expect(methodEntry?.name).toBe("Point.new");

    const traitEntry = index.find((e) => e.kind === "trait");
    expect(traitEntry?.name).toBe("Display");

    const constEntry = index.find((e) => e.kind === "constant");
    expect(constEntry?.name).toBe("VERSION");
  });

  test("handles empty model", () => {
    const model: DocModel = { name: "empty", modules: [] };
    const index = buildSearchIndex(model);
    expect(index.length).toBe(0);
  });

  test("preserves inline code with periods in search docs", () => {
    const model: DocModel = {
      name: "headers",
      modules: [
        {
          name: "assert",
          path: "std/libc/assert",
          doc: "C11 `<assert.h>` — assertion debugging facility. More details here.",
          functions: [],
          types: [],
          traits: [],
          constants: [],
          submodules: [],
        },
      ],
    };

    const index = buildSearchIndex(model);
    expect(index[0]?.doc).toBe(
      "C11 `<assert.h>` — assertion debugging facility."
    );
  });
});

// ── Integration tests ────────────────────────────────────────────────

describe("renderDocSite", () => {
  function makeModule(overrides: Partial<DocModule> = {}): DocModule {
    return {
      name: "test_module",
      path: "test/test_module",
      functions: [],
      types: [],
      traits: [],
      constants: [],
      submodules: [],
      ...overrides,
    };
  }

  test("renders index.html and module pages", async () => {
    cleanup();
    const model: DocModel = {
      name: "TestProject",
      modules: [
        makeModule({
          doc: "A test module with **bold** text.",
          functions: [
            {
              name: "add",
              doc: "Add two numbers.",
              signature: "fn(a: i32, b: i32) -> i32",
              parameters: [
                {
                  name: "a",
                  type: "i32",
                  isComptime: false,
                },
                {
                  name: "b",
                  type: "i32",
                  isComptime: false,
                },
              ],
              returnType: "i32",
              isMethod: false,
            },
          ],
        }),
      ],
    };

    await renderDocSite({ model, outputDir: TEST_OUTPUT_DIR });

    // Check index.html exists
    const indexPath = path.join(TEST_OUTPUT_DIR, "index.html");
    expect(fs.existsSync(indexPath)).toBe(true);

    const indexHtml = fs.readFileSync(indexPath, "utf-8");
    expect(indexHtml).toContain("TestProject");
    expect(indexHtml).toContain("test_module");
    expect(indexHtml).toContain("<style>");
    expect(indexHtml).toContain("__SEARCH_INDEX");

    // Check module page exists
    const modulePath = path.join(TEST_OUTPUT_DIR, "module", "test_module.html");
    expect(fs.existsSync(modulePath)).toBe(true);

    const moduleHtml = fs.readFileSync(modulePath, "utf-8");
    expect(moduleHtml).toContain("test_module");
    expect(moduleHtml).toContain("<strong>bold</strong>");
    expect(moduleHtml).toContain("add");
    expect(moduleHtml).toContain("fn(a: i32, b: i32) -&gt; i32");
  });

  test("renders struct with fields and methods", async () => {
    cleanup();
    const model: DocModel = {
      name: "StructTest",
      modules: [
        makeModule({
          types: [
            {
              name: "Point",
              doc: "A 2D point.",
              kind: "struct",
              signature: "struct(x: i32, y: i32)",
              fields: [
                { name: "x", type: "i32", doc: "X coordinate." },
                { name: "y", type: "i32", doc: "Y coordinate." },
              ],
              methods: [
                {
                  name: "distance",
                  doc: "Calculate distance from origin.",
                  signature: "fn(self: Self) -> f64",
                  parameters: [
                    {
                      name: "self",
                      type: "Self",
                      isComptime: false,
                    },
                  ],
                  returnType: "f64",
                  isMethod: true,
                  selfType: "Point",
                },
              ],
              traitImpls: ["Display", "Clone"],
            },
          ],
        }),
      ],
    };

    await renderDocSite({ model, outputDir: TEST_OUTPUT_DIR });

    const html = fs.readFileSync(
      path.join(TEST_OUTPUT_DIR, "module", "test_module.html"),
      "utf-8"
    );

    expect(html).toContain("Point");
    expect(html).toContain("struct");
    expect(html).toContain("X coordinate");
    expect(html).toContain("Y coordinate");
    expect(html).toContain("distance");
    expect(html).toContain("Display");
    expect(html).toContain("Clone");
    expect(html).toContain("trait-impl-badge");
  });

  test("renders atomic object kind", async () => {
    cleanup();
    const model: DocModel = {
      name: "AtomicTest",
      modules: [
        makeModule({
          types: [
            {
              name: "Cond",
              doc: "A condition variable.",
              kind: "atomic object",
              signature: "Cond :: atomic object(_raw : usize)",
              fields: [{ name: "_raw", type: "usize" }],
              methods: [],
              traitImpls: [],
            },
          ],
        }),
      ],
    };

    await renderDocSite({ model, outputDir: TEST_OUTPUT_DIR });

    const html = fs.readFileSync(
      path.join(TEST_OUTPUT_DIR, "module", "test_module.html"),
      "utf-8"
    );

    expect(html).toContain("atomic object");
    expect(html).toContain("Cond :: atomic object(_raw : usize)");
  });

  test("renders enum with variants", async () => {
    cleanup();
    const model: DocModel = {
      name: "EnumTest",
      modules: [
        makeModule({
          types: [
            {
              name: "Color",
              doc: "A color enum.",
              kind: "enum",
              signature: "enum(Red, Green, Blue)",
              variants: [
                { name: "Red", doc: "The color red." },
                { name: "Green" },
                {
                  name: "Blue",
                  fields: [{ name: "shade", type: "u8" }],
                },
              ],
              methods: [],
              traitImpls: [],
            },
          ],
        }),
      ],
    };

    await renderDocSite({ model, outputDir: TEST_OUTPUT_DIR });

    const html = fs.readFileSync(
      path.join(TEST_OUTPUT_DIR, "module", "test_module.html"),
      "utf-8"
    );

    expect(html).toContain("Color");
    expect(html).toContain("enum");
    expect(html).toContain("Red");
    expect(html).toContain("Green");
    expect(html).toContain("Blue");
    expect(html).toContain("shade");
  });

  test("renders trait with associated types and implementors", async () => {
    cleanup();
    const model: DocModel = {
      name: "TraitTest",
      modules: [
        makeModule({
          traits: [
            {
              name: "Iterator",
              kind: "trait",
              doc: "An iterator trait.",
              signature:
                "trait(Item: Type, next: fn(self: Self) -> Option(Item))",
              associatedTypes: [
                {
                  name: "Item",
                  doc: "The type of items yielded.",
                  constraint: "Type",
                },
              ],
              methods: [
                {
                  name: "next",
                  doc: "Advance and return the next item.",
                  signature: "fn(self: *(Self)) -> Option(Self.Item)",
                  parameters: [
                    {
                      name: "self",
                      type: "*(Self)",
                      isComptime: false,
                    },
                  ],
                  returnType: "Option(Self.Item)",
                  isMethod: true,
                  selfType: "Iterator",
                },
              ],
              implementors: ["ArrayList", "Range"],
            },
          ],
        }),
      ],
    };

    await renderDocSite({ model, outputDir: TEST_OUTPUT_DIR });

    const html = fs.readFileSync(
      path.join(TEST_OUTPUT_DIR, "module", "test_module.html"),
      "utf-8"
    );

    expect(html).toContain("Iterator");
    expect(html).toContain("trait");
    expect(html).toContain("Item");
    expect(html).toContain("next");
    expect(html).toContain("ArrayList");
    expect(html).toContain("Range");
    expect(html).toContain("Associated Types");
    expect(html).toContain("Implementors");
  });

  test("renders constants with values", async () => {
    cleanup();
    const model: DocModel = {
      name: "ConstTest",
      modules: [
        makeModule({
          constants: [
            {
              name: "PI",
              doc: "The ratio of a circle's circumference to its diameter.",
              type: "f64",
              value: "3.14159",
            },
            {
              name: "MAX_SIZE",
              type: "usize",
              value: "1024",
            },
          ],
        }),
      ],
    };

    await renderDocSite({ model, outputDir: TEST_OUTPUT_DIR });

    const html = fs.readFileSync(
      path.join(TEST_OUTPUT_DIR, "module", "test_module.html"),
      "utf-8"
    );

    expect(html).toContain("PI");
    expect(html).toContain("3.14159");
    expect(html).toContain("circumference");
    expect(html).toContain("MAX_SIZE");
    expect(html).toContain("1024");
  });

  test("renders markdown in doc comments", async () => {
    cleanup();
    const model: DocModel = {
      name: "MarkdownTest",
      modules: [
        makeModule({
          doc: "# Module Title\n\nThis has **bold**, *italic*, and `code`.\n\n- Item 1\n- Item 2\n\n```rust\nlet x = 42;\n```",
        }),
      ],
    };

    await renderDocSite({ model, outputDir: TEST_OUTPUT_DIR });

    const html = fs.readFileSync(
      path.join(TEST_OUTPUT_DIR, "module", "test_module.html"),
      "utf-8"
    );

    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<li>");
    expect(html).toContain("<pre>");
  });

  test("renders multiple modules with sidebar navigation", async () => {
    cleanup();
    const model: DocModel = {
      name: "MultiMod",
      modules: [
        makeModule({ name: "alpha", path: "alpha", doc: "Alpha module." }),
        makeModule({ name: "beta", path: "beta", doc: "Beta module." }),
        makeModule({ name: "gamma", path: "gamma", doc: "Gamma module." }),
      ],
    };

    await renderDocSite({ model, outputDir: TEST_OUTPUT_DIR });

    // Check index has all modules
    const indexHtml = fs.readFileSync(
      path.join(TEST_OUTPUT_DIR, "index.html"),
      "utf-8"
    );
    expect(indexHtml).toContain("alpha");
    expect(indexHtml).toContain("beta");
    expect(indexHtml).toContain("gamma");

    // Check each module page exists and has sidebar
    for (const name of ["alpha", "beta", "gamma"]) {
      const modPath = path.join(TEST_OUTPUT_DIR, "module", `${name}.html`);
      expect(fs.existsSync(modPath)).toBe(true);

      const modHtml = fs.readFileSync(modPath, "utf-8");
      expect(modHtml).toContain("sidebar");
      expect(modHtml).toContain(`class="active"`);
    }
  });

  test("generates valid HTML structure", async () => {
    cleanup();
    const model: DocModel = {
      name: "ValidHTML",
      modules: [makeModule()],
    };

    await renderDocSite({ model, outputDir: TEST_OUTPUT_DIR });

    const html = fs.readFileSync(
      path.join(TEST_OUTPUT_DIR, "index.html"),
      "utf-8"
    );

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<head>");
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("</head>");
    expect(html).toContain("<body>");
    expect(html).toContain("</body>");
    expect(html).toContain("</html>");
  });

  test("search index is embedded in pages", async () => {
    cleanup();
    const model: DocModel = {
      name: "SearchTest",
      modules: [
        makeModule({
          functions: [
            {
              name: "search_target",
              signature: "fn() -> unit",
              parameters: [],
              returnType: "unit",
              isMethod: false,
            },
          ],
        }),
      ],
    };

    await renderDocSite({ model, outputDir: TEST_OUTPUT_DIR });

    const indexHtml = fs.readFileSync(
      path.join(TEST_OUTPUT_DIR, "index.html"),
      "utf-8"
    );
    expect(indexHtml).toContain("__SEARCH_INDEX");
    expect(indexHtml).toContain("search_target");
    expect(indexHtml).toContain("doc-search");
  });

  test("renders empty module gracefully", async () => {
    cleanup();
    const model: DocModel = {
      name: "EmptyTest",
      modules: [makeModule()],
    };

    await renderDocSite({ model, outputDir: TEST_OUTPUT_DIR });

    const html = fs.readFileSync(
      path.join(TEST_OUTPUT_DIR, "module", "test_module.html"),
      "utf-8"
    );

    expect(html).toContain("test_module");
    // Should not have empty sections
    expect(html).not.toContain("<h2>Types</h2>");
    expect(html).not.toContain("<h2>Traits</h2>");
    expect(html).not.toContain("<h2>Functions</h2>");
    expect(html).not.toContain("<h2>Constants</h2>");
  });

  test("handles dark mode CSS", async () => {
    cleanup();
    const model: DocModel = {
      name: "DarkMode",
      modules: [makeModule()],
    };

    await renderDocSite({ model, outputDir: TEST_OUTPUT_DIR });

    const html = fs.readFileSync(
      path.join(TEST_OUTPUT_DIR, "index.html"),
      "utf-8"
    );

    expect(html).toContain("prefers-color-scheme: dark");
  });

  test("renders impl blocks with generic and where clauses", async () => {
    cleanup();
    const model: DocModel = {
      name: "ImplDocs",
      modules: [
        makeModule({
          types: [
            {
              name: "List",
              doc: "An immutable list.",
              kind: "struct",
              signature:
                "List :: (fn(comptime(T) : Type) -> comptime(Type))(struct(len : usize))",
              methods: [],
              traitImpls: [],
              impls: [
                {
                  signature:
                    "impl(generic(T : Type), where(T <: Send), List(T))",
                  methodNames: ["size", "is_empty"],
                },
              ],
            },
          ],
        }),
      ],
    };

    await renderDocSite({ model, outputDir: TEST_OUTPUT_DIR });

    const html = fs.readFileSync(
      path.join(TEST_OUTPUT_DIR, "module", "test_module.html"),
      "utf-8"
    );

    expect(html).toContain("impl-header");
    expect(html).toContain("impl-block");
    expect(html).toContain("generic(T : Type)");
    expect(html).toContain("where(T &lt;: Send)");
    expect(html).toContain("size");
    expect(html).toContain("is_empty");
  });

  test("renders module card summary with inline code periods", async () => {
    cleanup();
    const model: DocModel = {
      name: "HeaderDocs",
      modules: [
        makeModule({
          name: "assert",
          path: "std/libc/assert",
          doc: "C11 `<assert.h>` — assertion debugging facility. More details here.",
        }),
      ],
    };

    await renderDocSite({ model, outputDir: TEST_OUTPUT_DIR });

    const html = fs.readFileSync(
      path.join(TEST_OUTPUT_DIR, "index.html"),
      "utf-8"
    );

    expect(html).toContain("<code>&lt;assert.h&gt;</code>");
    expect(html).toContain("assertion debugging facility.");
  });

  test("function with type params and effects", async () => {
    cleanup();
    const model: DocModel = {
      name: "EffectsTest",
      modules: [
        makeModule({
          functions: [
            {
              name: "async_read",
              doc: "Read a file asynchronously.",
              signature:
                "fn(generic(T), path: str, using(io: Io)) -> Impl(Future(Result(T, Error), Io))",
              parameters: [
                {
                  name: "path",
                  type: "str",
                  isComptime: false,
                },
              ],
              returnType: "Impl(Future(Result(T, Error), Io))",
              typeParams: [
                {
                  name: "T",
                  type: "Type",
                  isComptime: true,
                },
              ],
              effects: [
                {
                  name: "io",
                  type: "Io",
                  isComptime: true,
                },
              ],
              isMethod: false,
            },
          ],
        }),
      ],
    };

    await renderDocSite({ model, outputDir: TEST_OUTPUT_DIR });

    const html = fs.readFileSync(
      path.join(TEST_OUTPUT_DIR, "module", "test_module.html"),
      "utf-8"
    );

    expect(html).toContain("async_read");
    expect(html).toContain("Type Parameters");
    expect(html).toContain("Effects");
    expect(html).toContain("Io");
  });

  test("renders deprecated banner on functions", async () => {
    cleanup();
    const model: DocModel = {
      name: "TestProject",
      modules: [
        makeModule({
          functions: [
            {
              name: "old_fn",
              doc: "Old function.",
              signature: "fn() -> i32",
              parameters: [],
              returnType: "i32",
              isMethod: false,
              deprecated: "Use new_fn instead.",
            },
          ],
        }),
      ],
    };

    await renderDocSite({ model, outputDir: TEST_OUTPUT_DIR });

    const html = fs.readFileSync(
      path.join(TEST_OUTPUT_DIR, "module", "test_module.html"),
      "utf-8"
    );

    expect(html).toContain("deprecated-banner");
    expect(html).toContain("Deprecated");
    expect(html).toContain("Use new_fn instead.");
    expect(html).toContain('class="item-card deprecated"');
  });

  test("renders Returns and Errors sections on functions", async () => {
    cleanup();
    const model: DocModel = {
      name: "TestProject",
      modules: [
        makeModule({
          functions: [
            {
              name: "read_file",
              doc: "Read a file.",
              signature: "fn(path: str) -> Result(String, Error)",
              parameters: [
                {
                  name: "path",
                  type: "str",
                  isComptime: false,
                },
              ],
              returnType: "Result(String, Error)",
              isMethod: false,
              returns: "The file contents as a string.",
              errors: "Returns an error if the file does not exist.",
            },
          ],
        }),
      ],
    };

    await renderDocSite({ model, outputDir: TEST_OUTPUT_DIR });

    const html = fs.readFileSync(
      path.join(TEST_OUTPUT_DIR, "module", "test_module.html"),
      "utf-8"
    );

    expect(html).toContain("doc-section");
    expect(html).toContain("Returns");
    expect(html).toContain("The file contents as a string.");
    expect(html).toContain("Errors");
    expect(html).toContain("Returns an error if the file does not exist.");
  });

  test("renders param descriptions in parameters table", async () => {
    cleanup();
    const model: DocModel = {
      name: "TestProject",
      modules: [
        makeModule({
          functions: [
            {
              name: "add",
              doc: "Add numbers.",
              signature: "fn(a: i32, b: i32) -> i32",
              parameters: [
                {
                  name: "a",
                  type: "i32",
                  isComptime: false,
                  doc: "The first operand.",
                },
                {
                  name: "b",
                  type: "i32",
                  isComptime: false,
                  doc: "The second operand.",
                },
              ],
              returnType: "i32",
              isMethod: false,
            },
          ],
        }),
      ],
    };

    await renderDocSite({ model, outputDir: TEST_OUTPUT_DIR });

    const html = fs.readFileSync(
      path.join(TEST_OUTPUT_DIR, "module", "test_module.html"),
      "utf-8"
    );

    expect(html).toContain("Description");
    expect(html).toContain("The first operand.");
    expect(html).toContain("The second operand.");
  });

  test("renders deprecated type with banner", async () => {
    cleanup();
    const model: DocModel = {
      name: "TestProject",
      modules: [
        makeModule({
          types: [
            {
              name: "OldType",
              doc: "An old type.",
              kind: "struct",
              signature: "struct(x: i32)",
              methods: [],
              traitImpls: [],
              deprecated: "Use NewType instead.",
            },
          ],
        }),
      ],
    };

    await renderDocSite({ model, outputDir: TEST_OUTPUT_DIR });

    const html = fs.readFileSync(
      path.join(TEST_OUTPUT_DIR, "module", "test_module.html"),
      "utf-8"
    );

    expect(html).toContain("deprecated-banner");
    expect(html).toContain("Use NewType instead.");
  });

  test("renders examples section on type", async () => {
    cleanup();
    const model: DocModel = {
      name: "TestProject",
      modules: [
        makeModule({
          types: [
            {
              name: "Point",
              doc: "A 2D point.",
              kind: "struct",
              signature: "struct(x: i32, y: i32)",
              methods: [],
              traitImpls: [],
              examples: "```rust\np :: Point(i32(1), i32(2));\n```",
            },
          ],
        }),
      ],
    };

    await renderDocSite({ model, outputDir: TEST_OUTPUT_DIR });

    const html = fs.readFileSync(
      path.join(TEST_OUTPUT_DIR, "module", "test_module.html"),
      "utf-8"
    );

    expect(html).toContain("Examples");
    expect(html).toContain("Point(i32(1), i32(2))");
  });
});
