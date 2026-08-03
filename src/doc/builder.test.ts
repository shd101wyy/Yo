// Tests for the doc model builder.
//
// These tests verify that buildDocModule correctly combines evaluator
// output (StructValue) with extracted doc comments to produce a DocModule.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ModuleManager } from "../module-manager";
import { tokenize } from "../lexer";
import { extractDocComments } from "./extractor";
import { buildDocModule, buildCrossReferences } from "./builder";
import type { DocModule } from "./model";
import { getVariablesFromEnv } from "../env";
import { exprIsFunctionCall, type FnCallExpr } from "../expr";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// Use a single shared ModuleManager and temp directory for all tests.
// Built-in types (like comptime_str) are singletons whose methods
// persist across evaluator resets, so creating multiple ModuleManagers
// causes "duplicate method" errors on the second prelude load.
let sharedModuleManager: ModuleManager;
let sharedTmpDir: string;
let testCounter = 0;

beforeAll(() => {
  sharedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-doc-test-"));
  sharedModuleManager = new ModuleManager();
});

afterAll(() => {
  fs.rmSync(sharedTmpDir, { recursive: true, force: true });
});

// ── Helper: evaluate a Yo source string and build its DocModule ──────

function buildDocFromSource(source: string, moduleName?: string): DocModule {
  const name = moduleName ?? `test_${testCounter++}`;
  const filePath = path.join(sharedTmpDir, `${name}.yo`);
  fs.writeFileSync(filePath, source);

  const modulePath = `file://${filePath}`;
  const { moduleValue, moduleError } =
    sharedModuleManager.loadModule(modulePath);
  const evaluator = sharedModuleManager.modules.get(modulePath)?.evaluator;

  if (moduleError) {
    throw moduleError;
  }
  if (!moduleValue) {
    throw new Error("No module value returned");
  }

  // Extract doc comments from the source tokens
  const tokens = tokenize(source, modulePath);
  const extraction = extractDocComments(tokens);

  // Build the doc module
  return buildDocModule({
    name,
    path: name,
    moduleValue,
    extraction,
    tokens,
    env: evaluator?.getEnv(),
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe("buildDocModule", () => {
  test("extracts module-level doc comment", () => {
    const doc = buildDocFromSource(`
//! This is the module doc.
//! It has two lines.

/// A simple constant
x :: i32(42);
export(x);
`);

    expect(doc.doc).toBe("This is the module doc.\nIt has two lines.");
  });

  test("documents a simple function", () => {
    const doc = buildDocFromSource(`
/// Adds two numbers.
add :: (fn(a : i32, b : i32) -> i32)((a + b));
export(add);
`);

    expect(doc.functions).toHaveLength(1);
    const fn = doc.functions[0]!;
    expect(fn.name).toBe("add");
    expect(fn.doc).toBe("Adds two numbers.");
    expect(fn.parameters).toHaveLength(2);
    expect(fn.parameters[0]!.name).toBe("a");
    expect(fn.parameters[0]!.type).toBe("i32");
    expect(fn.parameters[1]!.name).toBe("b");
    expect(fn.returnType).toBe("i32");
    expect(fn.isMethod).toBe(false);
  });

  test("documents a struct with fields", () => {
    const doc = buildDocFromSource(`
/// A 2D point.
Point :: struct(x : i32, y : i32);
export(Point);
`);

    expect(doc.types).toHaveLength(1);
    const type = doc.types[0]!;
    expect(type.name).toBe("Point");
    expect(type.doc).toBe("A 2D point.");
    expect(type.kind).toBe("struct");
    expect(type.fields).toBeDefined();
    expect(type.fields!.length).toBe(2);
    expect(type.fields![0]!.name).toBe("x");
    expect(type.fields![0]!.type).toBe("i32");
    expect(type.fields![1]!.name).toBe("y");
  });

  test("documents an enum with variants", () => {
    const doc = buildDocFromSource(`
/// A color enum.
Color :: enum(Red, Green, Blue);
export(Color);
`);

    expect(doc.types).toHaveLength(1);
    const type = doc.types[0]!;
    expect(type.name).toBe("Color");
    expect(type.doc).toBe("A color enum.");
    expect(type.kind).toBe("enum");
    expect(type.variants).toBeDefined();
    expect(type.variants!.length).toBe(3);
    expect(type.variants![0]!.name).toBe("Red");
    expect(type.variants![1]!.name).toBe("Green");
    expect(type.variants![2]!.name).toBe("Blue");
  });

  test("documents an enum with data variants", () => {
    const doc = buildDocFromSource(`
/// A shape type.
Shape :: enum(
  Circle(radius : i32),
  Rectangle(width : i32, height : i32)
);
export(Shape);
`);

    expect(doc.types).toHaveLength(1);
    const type = doc.types[0]!;
    expect(type.name).toBe("Shape");
    expect(type.kind).toBe("enum");
    expect(type.variants!.length).toBe(2);
    expect(type.variants![0]!.name).toBe("Circle");
    expect(type.variants![0]!.fields).toHaveLength(1);
    expect(type.variants![0]!.fields![0]!.name).toBe("radius");
    expect(type.variants![1]!.name).toBe("Rectangle");
    expect(type.variants![1]!.fields).toHaveLength(2);
  });

  test("documents a newtype", () => {
    const doc = buildDocFromSource(`
/// A user ID wrapper.
UserId :: newtype(value : i32);
export(UserId);
`);

    expect(doc.types).toHaveLength(1);
    const type = doc.types[0]!;
    expect(type.name).toBe("UserId");
    expect(type.kind).toBe("newtype");
    expect(type.fields).toHaveLength(1);
    expect(type.fields![0]!.name).toBe("value");
  });

  test("documents an object (reference-counted struct)", () => {
    const doc = buildDocFromSource(`
/// A ref-counted container.
Container :: ref(struct(data : i32));
export(Container);
`);

    expect(doc.types).toHaveLength(1);
    const type = doc.types[0]!;
    expect(type.name).toBe("Container");
    expect(type.kind).toBe("object");
    expect(type.fields).toHaveLength(1);
  });

  test("documents an atomic object", () => {
    const doc = buildDocFromSource(`
/// A thread-safe ref-counted container.
Container :: atomic(ref(struct(data : i32)));
export(Container);
`);

    expect(doc.types).toHaveLength(1);
    const type = doc.types[0]!;
    expect(type.name).toBe("Container");
    expect(type.kind).toBe("atomic object");
    expect(type.fields).toHaveLength(1);
  });

  test("documents a trait", () => {
    const doc = buildDocFromSource(`
/// Adds a name method.
Named :: trait(
  name : (fn(self : Self) -> i32)
);
export(Named);
`);

    expect(doc.traits).toHaveLength(1);
    const trait = doc.traits[0]!;
    expect(trait.name).toBe("Named");
    expect(trait.doc).toBe("Adds a name method.");
    expect(trait.methods).toHaveLength(1);
    expect(trait.methods[0]!.name).toBe("name");
  });

  test("documents constants", () => {
    const doc = buildDocFromSource(`
/// The maximum value.
MAX :: i32(100);
export(MAX);
`);

    // Constants may appear as functions or constants depending on evaluator
    const allItems = [...doc.constants, ...doc.functions];
    const max = allItems.find((item) => item.name === "MAX");
    expect(max).toBeDefined();
    expect(max!.doc).toBe("The maximum value.");
  });

  test("handles declarations without doc comments", () => {
    const doc = buildDocFromSource(`
add :: (fn(a : i32, b : i32) -> i32)((a + b));
export(add);
`);

    expect(doc.functions).toHaveLength(1);
    expect(doc.functions[0]!.doc).toBeUndefined();
  });

  test("handles empty module", () => {
    const doc = buildDocFromSource(``);

    expect(doc.functions).toHaveLength(0);
    expect(doc.types).toHaveLength(0);
    expect(doc.traits).toHaveLength(0);
    expect(doc.constants).toHaveLength(0);
    expect(doc.doc).toBeUndefined();
  });

  test("skips compiler-internal names", () => {
    const doc = buildDocFromSource(`
/// Public function.
add :: (fn(a : i32, b : i32) -> i32)((a + b));
export(add);
`);

    // Should not contain any ___-prefixed items
    for (const fn of doc.functions) {
      expect(fn.name.startsWith("___")).toBe(false);
    }
    for (const type of doc.types) {
      expect(type.name.startsWith("___")).toBe(false);
    }
  });

  test("documents multiple functions and types", () => {
    const doc = buildDocFromSource(`
/// Adds two numbers.
add :: (fn(a : i32, b : i32) -> i32)((a + b));

/// Subtracts two numbers.
sub :: (fn(a : i32, b : i32) -> i32)((a - b));

/// A point.
Point :: struct(x : i32, y : i32);

export(add);
export(sub);
export(Point);
`);

    expect(doc.functions).toHaveLength(2);
    expect(doc.functions[0]!.name).toBe("add");
    expect(doc.functions[1]!.name).toBe("sub");
    expect(doc.types).toHaveLength(1);
    expect(doc.types[0]!.name).toBe("Point");
  });

  test("includes methods from generic impl blocks", () => {
    const doc = buildDocFromSource(`
ArrayList :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(len : usize)
);

impl(generic(T : Type), ArrayList(T),
  /// Return the number of elements.
  length : (fn(self : Self) -> usize)(self.len),
  /// Check whether the list is empty.
  is_empty : (fn(self : Self) -> bool)(((self.len == usize(0))))
);

export(ArrayList);
`);

    expect(doc.types).toHaveLength(1);
    const type = doc.types[0]!;
    expect(type.methods.map((method) => method.name)).toEqual([
      "length",
      "is_empty",
    ]);
    expect(type.impls?.[0]?.signature).toContain(
      "impl(generic(T : Type), ArrayList(T), ...)"
    );
  });

  test("captures where constraints in impl signatures", () => {
    const doc = buildDocFromSource(`
List :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(len : usize)
);

impl(generic(T : Type), where(T <: Send), List(T),
  size : (fn(self : Self) -> usize)(self.len)
);

export(List);
`);

    expect(doc.types).toHaveLength(1);
    const type = doc.types[0]!;
    expect(type.methods.map((method) => method.name)).toContain("size");
    expect(type.impls?.[0]?.signature).toContain("generic(T : Type)");
    expect(type.impls?.[0]?.signature).toContain("where(T <: Send)");
  });

  test("keeps trait impl signatures compact", () => {
    const doc = buildDocFromSource(`
Boxed :: ref(struct(value : i32));

impl(Boxed, Dispose(
  dispose : (fn(self : Self) -> unit)(())
));

export(Boxed);
`);

    expect(doc.types).toHaveLength(1);
    const type = doc.types[0]!;
    expect(
      type.impls?.some((impl) => impl.signature === "impl(Boxed, Dispose(...))")
    ).toBe(true);
    // Trait impl should extract method names from body
    const disposeImpl = type.impls?.find(
      (impl) => impl.traitName === "Dispose"
    );
    expect(disposeImpl?.methodNames).toContain("dispose");
  });

  test("separates associated types from methods in trait impl", () => {
    const doc = buildDocFromSource(`pragma(Pragma.AllowUnsafe);
MyVec :: struct(data : i32, len : i32);

impl(MyVec, Index(usize)(
  Output : i32,
  index : (fn(inout(self) : Self, idx : usize) -> *(Self.Output))(&(self.data))
));

export(MyVec);
`);

    expect(doc.types).toHaveLength(1);
    const type = doc.types[0]!;
    const indexImpl = type.impls?.find((impl) => impl.traitName === "Index");
    expect(indexImpl).toBeDefined();
    // Output should be an associated type, not a method
    expect(indexImpl?.methodNames).toContain("index");
    expect(indexImpl?.methodNames).not.toContain("Output");
    expect(indexImpl?.associatedTypes).toHaveLength(1);
    expect(indexImpl?.associatedTypes?.[0]?.name).toBe("Output");
    expect(indexImpl?.associatedTypes?.[0]?.type).toBe("i32");
  });

  test("documents block doc comments", () => {
    const doc = buildDocFromSource(`
/**
 * Multiplies two numbers.
 *
 * Returns the product of a and b.
 */
mul :: (fn(a : i32, b : i32) -> i32)((a * b));
export(mul);
`);

    expect(doc.functions).toHaveLength(1);
    expect(doc.functions[0]!.doc).toBe(
      "Multiplies two numbers.\n\nReturns the product of a and b."
    );
  });
});

describe("buildCrossReferences", () => {
  test("populates trait implementors from type traitImpls", () => {
    const modules: DocModule[] = [
      {
        name: "test",
        path: "test",
        functions: [],
        types: [
          {
            name: "Point",
            kind: "struct",
            signature: "struct(x: i32, y: i32)",
            methods: [],
            traitImpls: ["Display", "Clone"],
          },
          {
            name: "Color",
            kind: "enum",
            signature: "enum(Red, Green, Blue)",
            methods: [],
            traitImpls: ["Display"],
          },
        ],
        traits: [
          {
            name: "Display",
            kind: "trait",
            signature: "trait(display: fn(Self) -> str)",
            methods: [],
            implementors: [],
          },
          {
            name: "Clone",
            kind: "trait",
            signature: "trait(clone: fn(Self) -> Self)",
            methods: [],
            implementors: [],
          },
        ],
        constants: [],
        submodules: [],
      },
    ];

    buildCrossReferences(modules);

    expect(modules[0]!.traits[0]!.implementors).toEqual(["Color", "Point"]);
    expect(modules[0]!.traits[1]!.implementors).toEqual(["Point"]);
  });

  // ── Section parsing integration tests ──────────────────────────────

  test("extracts Returns section from function doc", () => {
    const doc = buildDocFromSource(`
/// Parse the input string.
///
/// ## Returns
///
/// The parsed integer value, or -1 on failure.
parse :: (fn(s: str) -> i32)(i32(0));
export(parse);
`);

    expect(doc.functions).toHaveLength(1);
    expect(doc.functions[0]!.doc).toContain("Parse the input string.");
    expect(doc.functions[0]!.returns).toBe(
      "The parsed integer value, or -1 on failure."
    );
  });

  test("extracts Errors section from function doc", () => {
    const doc = buildDocFromSource(`
/// Open a file.
///
/// ## Errors
///
/// Returns an error if the file does not exist.
open_file :: (fn(path: str) -> i32)(i32(0));
export(open_file);
`);

    expect(doc.functions[0]!.errors).toBe(
      "Returns an error if the file does not exist."
    );
  });

  test("extracts Deprecated section from function doc", () => {
    const doc = buildDocFromSource(`
/// Old API function.
///
/// ## Deprecated
///
/// Use new_api instead.
old_api :: (fn() -> i32)(i32(0));
export(old_api);
`);

    expect(doc.functions[0]!.deprecated).toBe("Use new_api instead.");
  });

  test("extracts Examples section from function doc", () => {
    const doc = buildDocFromSource(`
/// Add two numbers.
///
/// ## Examples
///
/// \`\`\`rust
/// result :: add(i32(1), i32(2));
/// \`\`\`
add :: (fn(a: i32, b: i32) -> i32)((a + b));
export(add);
`);

    expect(doc.functions[0]!.examples).toContain("```rust");
  });

  test("extracts deprecated from type doc", () => {
    const doc = buildDocFromSource(`
/// Old point type.
///
/// ## Deprecated
///
/// Use Point3D instead.
OldPoint :: struct(x: i32, y: i32);
export(OldPoint);
`);

    expect(doc.types[0]!.deprecated).toBe("Use Point3D instead.");
  });

  test("extracts param doc from inline comments", () => {
    const doc = buildDocFromSource(`
/// Add two numbers.
add :: (fn(
  /// The first operand.
  a: i32,
  /// The second operand.
  b: i32
) -> i32)((a + b));
export(add);
`);

    expect(doc.functions[0]!.parameters).toHaveLength(2);
    expect(doc.functions[0]!.parameters[0]!.doc).toBe("The first operand.");
    expect(doc.functions[0]!.parameters[1]!.doc).toBe("The second operand.");
  });
});

// ── Variable.docComment propagation tests ──────────────────────────

/**
 * Helper: evaluate a Yo source string and return the evaluator program
 * so we can inspect Variable.docComment on the resulting env.
 */
function getEvaluatorProgram(source: string, moduleName?: string) {
  const name = moduleName ?? `test_var_${testCounter++}`;
  const filePath = path.join(sharedTmpDir, `${name}.yo`);
  fs.writeFileSync(filePath, source);

  const modulePath = `file://${filePath}`;
  sharedModuleManager.loadModule(modulePath);

  const module = sharedModuleManager.modules.get(modulePath);
  if (!module?.evaluator) {
    throw new Error("No evaluator available");
  }
  return module.evaluator.getProgram();
}

/** Find the last env from the program that has the given variable. */
function findVariableDocComment(
  program: ReturnType<typeof getEvaluatorProgram>,
  varName: string
): string | undefined {
  // Walk expressions to find one with env containing the variable
  for (let i = program.length - 1; i >= 0; i--) {
    const expr = program[i]!;
    if (exprIsFunctionCall(expr)) {
      const fnExpr = expr as FnCallExpr;
      const env = fnExpr.$?.env;
      if (env) {
        const vars = getVariablesFromEnv(env, varName);
        if (vars.length > 0) {
          return vars[vars.length - 1]!.docComment;
        }
      }
    }
  }
  return undefined;
}

describe("Variable.docComment propagation", () => {
  test("propagates doc comment to variable for :: declaration", () => {
    const program = getEvaluatorProgram(`
/// A documented constant.
x :: i32(42);
export(x);
`);

    expect(findVariableDocComment(program, "x")).toBe("A documented constant.");
  });

  test("propagates multi-line doc comment to variable", () => {
    const program = getEvaluatorProgram(`
/// First line.
/// Second line.
y :: i32(10);
export(y);
`);

    expect(findVariableDocComment(program, "y")).toBe(
      "First line.\nSecond line."
    );
  });

  test("variable without doc comment has undefined docComment", () => {
    const program = getEvaluatorProgram(`
z :: i32(5);
export(z);
`);

    expect(findVariableDocComment(program, "z")).toBeUndefined();
  });

  test("propagates doc comment to function variable", () => {
    const program = getEvaluatorProgram(`
/// Adds two numbers.
add :: (fn(a : i32, b : i32) -> i32)((a + b));
export(add);
`);

    expect(findVariableDocComment(program, "add")).toBe("Adds two numbers.");
  });

  test("propagates doc comment to type variable", () => {
    const program = getEvaluatorProgram(`
/// A 2D point.
Point :: struct(x : f64, y : f64);
export(Point);
`);

    expect(findVariableDocComment(program, "Point")).toBe("A 2D point.");
  });

  test("propagates block doc comment to variable", () => {
    const program = getEvaluatorProgram(`
/** A block-documented value. */
val :: i32(99);
export(val);
`);

    expect(findVariableDocComment(program, "val")).toBe(
      "A block-documented value."
    );
  });

  test("multiple documented declarations get separate doc comments", () => {
    const program = getEvaluatorProgram(`
/// First.
a1 :: i32(1);
/// Second.
b1 :: i32(2);
export(a1);
export(b1);
`);

    expect(findVariableDocComment(program, "a1")).toBe("First.");
    expect(findVariableDocComment(program, "b1")).toBe("Second.");
  });
});
