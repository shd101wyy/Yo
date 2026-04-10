import { describe, it, expect } from "bun:test";
import { parseDocComment, isKnownSection } from "./sections";

describe("parseDocComment", () => {
  it("extracts summary from first paragraph", () => {
    const result = parseDocComment(
      "Creates a connection pool.\n\nMore details here."
    );
    expect(result.summary).toBe("Creates a connection pool.");
    expect(result.description).toBe(
      "Creates a connection pool.\n\nMore details here."
    );
  });

  it("handles single-line description as summary", () => {
    const result = parseDocComment("A simple function.");
    expect(result.summary).toBe("A simple function.");
    expect(result.description).toBe("A simple function.");
    expect(result.sections.size).toBe(0);
  });

  it("handles empty input", () => {
    const result = parseDocComment("");
    expect(result.summary).toBe("");
    expect(result.description).toBe("");
    expect(result.sections.size).toBe(0);
  });

  it("handles whitespace-only input", () => {
    const result = parseDocComment("   \n  \n  ");
    expect(result.summary).toBe("");
    expect(result.description).toBe("");
  });

  it("parses ## Returns section", () => {
    const result = parseDocComment(
      "Creates a pool.\n\n## Returns\n\nA pool instance."
    );
    expect(result.summary).toBe("Creates a pool.");
    expect(result.sections.get("returns")).toBe("A pool instance.");
  });

  it("parses ## Errors section", () => {
    const result = parseDocComment(
      "Opens a file.\n\n## Errors\n\nReturns `Err` if the file does not exist."
    );
    expect(result.sections.get("errors")).toBe(
      "Returns `Err` if the file does not exist."
    );
  });

  it("parses ## Panics section", () => {
    const result = parseDocComment(
      "Divides two numbers.\n\n## Panics\n\nPanics if divisor is zero."
    );
    expect(result.sections.get("panics")).toBe("Panics if divisor is zero.");
  });

  it("parses ## Examples section", () => {
    const result = parseDocComment(
      'Adds two numbers.\n\n## Examples\n\n```rust\nresult := add(1, 2);\nassert((result == 3), "ok");\n```'
    );
    expect(result.sections.get("examples")).toBe(
      '```rust\nresult := add(1, 2);\nassert((result == 3), "ok");\n```'
    );
  });

  it("parses ## Safety section", () => {
    const result = parseDocComment(
      "Dereferences a raw pointer.\n\n## Safety\n\nPointer must be valid and aligned."
    );
    expect(result.sections.get("safety")).toBe(
      "Pointer must be valid and aligned."
    );
  });

  it("parses ## Deprecated section", () => {
    const result = parseDocComment(
      "Old function.\n\n## Deprecated\n\nUse `new_function` instead."
    );
    expect(result.sections.get("deprecated")).toBe(
      "Use `new_function` instead."
    );
  });

  it("parses multiple sections", () => {
    const text = [
      "Creates a connection pool.",
      "",
      "Detailed description about pooling.",
      "",
      "## Returns",
      "",
      "A `Pool` instance.",
      "",
      "## Errors",
      "",
      "Returns `Err` if config is invalid.",
      "",
      "## Examples",
      "",
      "```rust",
      "pool := createPool(10, 5000);",
      "```",
    ].join("\n");

    const result = parseDocComment(text);

    expect(result.summary).toBe("Creates a connection pool.");
    expect(result.description).toBe(
      "Creates a connection pool.\n\nDetailed description about pooling."
    );
    expect(result.sections.size).toBe(3);
    expect(result.sections.get("returns")).toBe("A `Pool` instance.");
    expect(result.sections.get("errors")).toBe(
      "Returns `Err` if config is invalid."
    );
    expect(result.sections.get("examples")).toBe(
      "```rust\npool := createPool(10, 5000);\n```"
    );
  });

  it("lowercases section names", () => {
    const result = parseDocComment("Fn.\n\n## RETURNS\n\nA value.");
    expect(result.sections.has("returns")).toBe(true);
    expect(result.sections.get("returns")).toBe("A value.");
  });

  it("preserves unknown section headings", () => {
    const result = parseDocComment(
      "Fn.\n\n## Notes\n\nSome implementation notes.\n\n## See Also\n\n`other_fn`"
    );
    expect(result.sections.get("notes")).toBe("Some implementation notes.");
    expect(result.sections.get("see also")).toBe("`other_fn`");
  });

  it("trims blank lines around section content", () => {
    const result = parseDocComment("Summary.\n\n## Returns\n\n\nA value.\n\n");
    expect(result.sections.get("returns")).toBe("A value.");
  });

  it("handles section with multi-line content", () => {
    const result = parseDocComment(
      "Summary.\n\n## Errors\n\n- `NotFound` if missing.\n- `PermissionDenied` if access denied."
    );
    expect(result.sections.get("errors")).toBe(
      "- `NotFound` if missing.\n- `PermissionDenied` if access denied."
    );
  });

  it("handles description with no sections", () => {
    const text = "This is a simple function.\n\nIt does one thing well.";
    const result = parseDocComment(text);

    expect(result.summary).toBe("This is a simple function.");
    expect(result.description).toBe(text);
    expect(result.sections.size).toBe(0);
  });

  it("handles no description, only sections", () => {
    const result = parseDocComment("## Returns\n\nA value.");
    expect(result.summary).toBe("");
    expect(result.description).toBe("");
    expect(result.sections.get("returns")).toBe("A value.");
  });

  it("does not confuse # heading with ## section", () => {
    const result = parseDocComment(
      "# Main heading\n\nSome text.\n\n## Returns\n\nA value."
    );
    // # heading is part of the description, not parsed as a section
    expect(result.description).toBe("# Main heading\n\nSome text.");
    expect(result.sections.get("returns")).toBe("A value.");
  });

  it("handles summary with multi-line first paragraph", () => {
    const result = parseDocComment(
      "First line of summary.\nStill part of summary.\n\nSecond paragraph."
    );
    expect(result.summary).toBe(
      "First line of summary.\nStill part of summary."
    );
  });

  it("handles real-world doc comment", () => {
    const text = [
      "Creates a new connection pool with the given configuration.",
      "",
      "The pool lazily initializes connections up to `max_size`. Idle connections",
      "are reaped after `timeout` milliseconds of inactivity.",
      "",
      "## Returns",
      "",
      "A `Result(Pool, PoolError)` — `Ok` with the pool on success,",
      "or `Err` with a `PoolError` if the configuration is invalid.",
      "",
      "## Panics",
      "",
      "Panics if the global allocator is exhausted.",
      "",
      "## Examples",
      "",
      "```rust",
      "(pool : Result(Pool, PoolError)) = createPool(u32(10), u32(5000));",
      "```",
    ].join("\n");

    const result = parseDocComment(text);

    expect(result.summary).toBe(
      "Creates a new connection pool with the given configuration."
    );
    expect(result.sections.size).toBe(3);
    expect(result.sections.get("returns")).toContain("Result(Pool, PoolError)");
    expect(result.sections.get("panics")).toContain("global allocator");
    expect(result.sections.get("examples")).toContain("createPool");
  });
});

describe("isKnownSection", () => {
  it("recognizes known sections", () => {
    expect(isKnownSection("returns")).toBe(true);
    expect(isKnownSection("errors")).toBe(true);
    expect(isKnownSection("panics")).toBe(true);
    expect(isKnownSection("examples")).toBe(true);
    expect(isKnownSection("safety")).toBe(true);
    expect(isKnownSection("deprecated")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isKnownSection("Returns")).toBe(true);
    expect(isKnownSection("ERRORS")).toBe(true);
    expect(isKnownSection("Panics")).toBe(true);
  });

  it("rejects unknown sections", () => {
    expect(isKnownSection("notes")).toBe(false);
    expect(isKnownSection("see also")).toBe(false);
    expect(isKnownSection("todo")).toBe(false);
  });
});
