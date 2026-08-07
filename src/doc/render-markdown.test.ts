import { describe, it, expect } from "bun:test";
import {
  renderFunctionMd,
  renderTypeMd,
  renderTraitMd,
  renderConstantMd,
  renderModuleMd,
  renderIndexMd,
  renderDocMarkdown,
} from "./render-markdown";
import type {
  DocModel,
  DocModule,
  DocFunction,
  DocType,
  DocTrait,
  DocConstant,
} from "./model";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Helpers ──────────────────────────────────────────────────────────

function makeFunction(overrides: Partial<DocFunction> = {}): DocFunction {
  return {
    name: "add",
    signature: "add :: (fn(a : i32, b : i32) -> i32)",
    doc: "Add two numbers.",
    parameters: [
      { name: "a", type: "i32", isComptime: false },
      { name: "b", type: "i32", isComptime: false },
    ],
    returnType: "i32",
    isMethod: false,
    ...overrides,
  };
}

function makeType(overrides: Partial<DocType> = {}): DocType {
  return {
    name: "Point",
    kind: "struct",
    signature: "Point :: struct(x : i32, y : i32)",
    doc: "A 2D point.",
    fields: [
      { name: "x", type: "i32" },
      { name: "y", type: "i32" },
    ],
    typeParams: [],
    traitImpls: [],
    methods: [],
    ...overrides,
  };
}

function makeTrait(overrides: Partial<DocTrait> = {}): DocTrait {
  return {
    name: "Display",
    kind: "trait",
    signature: "Display :: trait(display : (fn(self: Self) -> str))",
    doc: "Format a value for display.",
    typeParams: [],
    methods: [
      makeFunction({
        name: "display",
        signature: "display : (fn(self: Self) -> str)",
        doc: "Render self as a string.",
        parameters: [{ name: "self", type: "Self", isComptime: false }],
        returnType: "str",
        isMethod: true,
        selfType: "Self",
      }),
    ],
    implementors: ["Point", "Color"],
    ...overrides,
  };
}

function makeConstant(overrides: Partial<DocConstant> = {}): DocConstant {
  return {
    name: "MAX_SIZE",
    type: "usize",
    value: "1024",
    doc: "Maximum buffer size.",
    ...overrides,
  };
}

function makeModule(overrides: Partial<DocModule> = {}): DocModule {
  return {
    name: "math",
    path: "std/math",
    doc: "Math utilities.",
    functions: [makeFunction()],
    types: [makeType()],
    traits: [makeTrait()],
    constants: [makeConstant()],
    submodules: [],
    ...overrides,
  };
}

function makeModel(overrides: Partial<DocModel> = {}): DocModel {
  return {
    name: "my-project",
    modules: [makeModule()],
    ...overrides,
  };
}

// ── Function rendering ───────────────────────────────────────────────

describe("renderFunctionMd", () => {
  it("renders a basic function", () => {
    const md = renderFunctionMd(makeFunction());
    expect(md).toContain("### `add`");
    expect(md).toContain("```rust");
    expect(md).toContain("add :: (fn(a : i32, b : i32) -> i32)");
    expect(md).toContain("Add two numbers.");
    expect(md).toContain("**Parameters:**");
    expect(md).toContain("`a` : `i32`");
    expect(md).toContain("**Returns:** `i32`");
  });

  it("renders comptime parameters", () => {
    const fn = makeFunction({
      parameters: [
        {
          name: "T",
          type: "Type",
          isComptime: true,
        },
        {
          name: "io",
          type: "Io",
          isComptime: false,
        },
      ],
    });
    const md = renderFunctionMd(fn);
    expect(md).toContain("*(comptime)*");
  });

  it("renders a method with self type", () => {
    const fn = makeFunction({
      name: "len",
      isMethod: true,
      selfType: "Vec",
    });
    const md = renderFunctionMd(fn);
    expect(md).toContain("### `Vec.len`");
  });
});

// ── Type rendering ───────────────────────────────────────────────────

describe("renderTypeMd", () => {
  it("renders a struct type", () => {
    const md = renderTypeMd(makeType());
    expect(md).toContain("### `Point`");
    expect(md).toContain("*struct*");
    expect(md).toContain("A 2D point.");
    expect(md).toContain("**Fields:**");
    expect(md).toContain("`x` : `i32`");
  });

  it("renders atomic object type kind", () => {
    const md = renderTypeMd(
      makeType({
        name: "Cond",
        kind: "atomic object",
        signature: "Cond :: atomic object(_raw : usize)",
        fields: [{ name: "_raw", type: "usize" }],
      })
    );

    expect(md).toContain("*atomic object*");
    expect(md).toContain("Cond :: atomic object(_raw : usize)");
  });

  it("renders an enum with variants", () => {
    const md = renderTypeMd(
      makeType({
        name: "Color",
        kind: "enum",
        signature: "Color :: enum(Red, Green, Blue)",
        doc: "A color.",
        fields: undefined,
        variants: [
          { name: "Red" },
          { name: "Green" },
          { name: "Blue", doc: "The color blue" },
        ],
      })
    );
    expect(md).toContain("*enum*");
    expect(md).toContain("**Variants:**");
    expect(md).toContain("`Red`");
    expect(md).toContain("`Blue` — The color blue");
  });

  it("renders trait impls", () => {
    const md = renderTypeMd(makeType({ traitImpls: ["Display", "Clone"] }));
    expect(md).toContain("**Implements:** `Display`, `Clone`");
  });

  it("renders impl blocks with methods", () => {
    const md = renderTypeMd(
      makeType({
        impls: [
          {
            signature: "impl(generic(T : Type), where(T <: Send), List(T))",
            methodNames: ["size", "is_empty"],
          },
        ],
        methods: [
          makeFunction({ name: "size", isMethod: true, selfType: "List" }),
          makeFunction({ name: "is_empty", isMethod: true, selfType: "List" }),
        ],
      })
    );

    expect(md).toContain(
      "`impl(generic(T : Type), where(T <: Send), List(T))`"
    );
    expect(md).toContain("List.size");
    expect(md).toContain("List.is_empty");
  });

  it("renders type parameters", () => {
    const md = renderTypeMd(
      makeType({
        name: "Vec",
        typeParams: [{ name: "T", type: "Type", isComptime: true }],
      })
    );
    expect(md).toContain("### `Vec(T)`");
  });
});

// ── Trait rendering ──────────────────────────────────────────────────

describe("renderTraitMd", () => {
  it("renders a trait with methods", () => {
    const md = renderTraitMd(makeTrait());
    expect(md).toContain("### `Display`");
    expect(md).toContain("*trait*");
    expect(md).toContain("Format a value for display.");
    expect(md).toContain("**Required Methods:**");
    expect(md).toContain("`Self.display`");
  });

  it("renders implementors", () => {
    const md = renderTraitMd(makeTrait());
    expect(md).toContain("**Implementors:** `Point`, `Color`");
  });
});

// ── Constant rendering ───────────────────────────────────────────────

describe("renderConstantMd", () => {
  it("renders a constant with value", () => {
    const md = renderConstantMd(makeConstant());
    expect(md).toContain("### `MAX_SIZE`");
    expect(md).toContain("`usize = 1024`");
    expect(md).toContain("Maximum buffer size.");
  });

  it("renders a constant without value", () => {
    const md = renderConstantMd(makeConstant({ value: undefined }));
    expect(md).toContain("`usize`");
    expect(md).not.toContain("=");
  });
});

// ── Module rendering ─────────────────────────────────────────────────

describe("renderModuleMd", () => {
  it("renders a module with all sections", () => {
    const md = renderModuleMd(makeModule());
    expect(md).toContain("# math");
    expect(md).toContain("> Module path: `std/math`");
    expect(md).toContain("Math utilities.");
    expect(md).toContain("## Contents");
    expect(md).toContain("## Types");
    expect(md).toContain("## Traits");
    expect(md).toContain("## Functions");
    expect(md).toContain("## Constants");
  });

  it("renders empty module without sections", () => {
    const md = renderModuleMd(
      makeModule({
        functions: [],
        types: [],
        traits: [],
        constants: [],
      })
    );
    expect(md).toContain("# math");
    expect(md).not.toContain("## Types");
    expect(md).not.toContain("## Functions");
  });
});

// ── Index rendering ──────────────────────────────────────────────────

describe("renderIndexMd", () => {
  it("renders an index page", () => {
    const md = renderIndexMd(makeModel());
    expect(md).toContain("# my-project — API Documentation");
    expect(md).toContain("## Modules");
    expect(md).toContain("[`std/math`](module/math.md)");
    expect(md).toContain("(4 items)");
  });
});

// ── File output ──────────────────────────────────────────────────────

describe("renderDocMarkdown", () => {
  it("writes README.md and module files", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-doc-md-"));
    try {
      renderDocMarkdown({ model: makeModel(), outputDir: tmpDir });

      const readme = fs.readFileSync(path.join(tmpDir, "README.md"), "utf-8");
      expect(readme).toContain("my-project");
      expect(readme).toContain("math.md");

      const modulePath = path.join(tmpDir, "module", "math.md");
      expect(fs.existsSync(modulePath)).toBe(true);
      const modContent = fs.readFileSync(modulePath, "utf-8");
      expect(modContent).toContain("# math");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Section rendering tests ──────────────────────────────────────────

describe("renderFunctionMd sections", () => {
  it("renders deprecated banner", () => {
    const md = renderFunctionMd(
      makeFunction({ deprecated: "Use new_add instead." })
    );
    expect(md).toContain("⚠️ **Deprecated**");
    expect(md).toContain("Use new_add instead.");
  });

  it("renders Returns section", () => {
    const md = renderFunctionMd(
      makeFunction({ returns: "The sum of the two operands." })
    );
    expect(md).toContain("The sum of the two operands.");
  });

  it("renders Errors section", () => {
    const md = renderFunctionMd(
      makeFunction({ errors: "Returns an error on overflow." })
    );
    expect(md).toContain("**Errors:**");
    expect(md).toContain("Returns an error on overflow.");
  });

  it("renders Examples section", () => {
    const md = renderFunctionMd(
      makeFunction({ examples: "```rust\nresult :: add(i32(1), i32(2));\n```" })
    );
    expect(md).toContain("**Examples:**");
    expect(md).toContain("result :: add(i32(1), i32(2));");
  });

  it("renders param descriptions", () => {
    const md = renderFunctionMd(
      makeFunction({
        parameters: [
          {
            name: "a",
            type: "i32",
            isComptime: false,
            doc: "First operand.",
          },
          {
            name: "b",
            type: "i32",
            isComptime: false,
            doc: "Second operand.",
          },
        ],
      })
    );
    expect(md).toContain("First operand.");
    expect(md).toContain("Second operand.");
  });
});

describe("renderTypeMd sections", () => {
  it("renders deprecated banner", () => {
    const md = renderTypeMd(makeType({ deprecated: "Use Point3D." }));
    expect(md).toContain("⚠️ **Deprecated**");
    expect(md).toContain("Use Point3D.");
  });

  it("renders examples", () => {
    const md = renderTypeMd(
      makeType({ examples: "```rust\np :: Point(i32(1), i32(2));\n```" })
    );
    expect(md).toContain("**Examples:**");
    expect(md).toContain("Point(i32(1), i32(2))");
  });
});

describe("renderTraitMd sections", () => {
  it("renders deprecated banner", () => {
    const md = renderTraitMd(makeTrait({ deprecated: "Use NewTrait." }));
    expect(md).toContain("⚠️ **Deprecated**");
    expect(md).toContain("Use NewTrait.");
  });

  it("renders examples", () => {
    const md = renderTraitMd(
      makeTrait({ examples: "```rust\nimpl(MyType, Show : ...)\n```" })
    );
    expect(md).toContain("**Examples:**");
  });
});

describe("renderConstantMd sections", () => {
  it("renders deprecated banner", () => {
    const md = renderConstantMd(makeConstant({ deprecated: "Use NEW_VALUE." }));
    expect(md).toContain("⚠️ **Deprecated**");
    expect(md).toContain("Use NEW_VALUE.");
  });
});
