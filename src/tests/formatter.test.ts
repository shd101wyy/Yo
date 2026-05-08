import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findYoFormatFiles, formatYoFiles, formatYoSource } from "../formatter";

describe("formatYoSource", () => {
  test("formats strict Yo syntax with fixed 2-space indentation", () => {
    const source = `{ println }::import("std/fmt");
main::(fn( ) -> unit)({println("Hello");if(true,{return();});});
export( main );`;

    expect(formatYoSource(source)).toBe(`{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  println("Hello");
  if(true, {
    return();
  });
});
export(main);
`);
  });

  test("preserves line and block comments", () => {
    const source = `/// entry point
main::(fn()->unit)({
// say hello
println("hello"); /* trailing */
});
`;

    expect(formatYoSource(source)).toBe(`/// entry point
main :: (fn() -> unit)({
  // say hello
  println("hello"); /* trailing */
});
`);
  });

  test("preserves raw template strings", () => {
    const source = "message::`hello ${name}\\n`; export(message);";

    expect(formatYoSource(source)).toBe(
      "message :: `hello ${name}\\n`;\nexport(message);\n"
    );
  });

  test("removes redundant grouping parentheses around expressions", () => {
    const source = `main::(fn()->i32)({
return((1 + 2));
});`;

    expect(formatYoSource(source)).toBe(`main :: (fn() -> i32)({
  return(1 + 2);
});
`);
  });

  test("preserves delimiter syntax that is not redundant grouping", () => {
    const source = `main::(fn()->unit)({
pair:=((1, 2));
single:=(value,);
point:={x: ((1 + 2)), y: 3};
arr_type::[i32; 10];
arr_type2::Array(i32, 10);
slice_type::[i32];
slice_type2::Slice(i32);
tuple_type::(i32, bool);
tuple_type2::Tuple(i32, bool);
ptr := &((value));
value:=add((1 + 2), i32(3));
make_fn:=(fn()->unit)({return();});
});`;

    expect(formatYoSource(source)).toBe(`main :: (fn() -> unit)({
  pair := (1, 2);
  single := (value,);
  point := { x : (1 + 2), y : 3 };
  arr_type :: [i32 ; 10];
  arr_type2 :: Array(i32, 10);
  slice_type :: [i32];
  slice_type2 :: Slice(i32);
  tuple_type :: (i32, bool);
  tuple_type2 :: Tuple(i32, bool);
  ptr := &(value);
  value := add(1 + 2, i32(3));
  make_fn := (fn() -> unit)({
    return();
  });
});
`);
  });

  test("keeps grouped infix expressions on operator right-hand sides", () => {
    const source = `main::(fn()->unit)({
value := ((x + y));
value2 = ((x + y));
branch := cond(
true => ((x / y)),
false => i32(0)
);
});`;

    expect(formatYoSource(source)).toBe(`main :: (fn() -> unit)({
  value := (x + y);
  value2 = (x + y);
  branch := cond(
    true => (x / y),
    false => i32(0)
  );
});
`);
  });

  test("keeps standalone comments and multiline call layout", () => {
    const source = `test("format effect", {
Raise :: (fn(msg : String, msg2 : String) -> i32);

// Use an effect in a function (effect becomes an implicit parameter)
safe_divide :: (fn(x : i32, y : i32, using(raise : Raise)) -> i32)(
cond(
(y == 0) => raise(\`div-by-zero\`, \`I don't like it\`),
true => (x / y)
)
);
});`;

    expect(formatYoSource(source)).toBe(`test("format effect", {
  Raise :: (fn(msg : String, msg2 : String) -> i32);
  // Use an effect in a function (effect becomes an implicit parameter)
  safe_divide :: (fn(x : i32, y : i32, using(raise : Raise)) -> i32)(
    cond(
      (y == 0) => raise(\`div-by-zero\`, \`I don't like it\`),
      true => (x / y)
    )
  );
});
`);
  });

  test("is idempotent for formatted source", () => {
    const source = `test("format effect", {
Raise :: (fn(msg : String, msg2 : String) -> i32);
safe_divide :: (fn(x : i32, y : i32, using(raise : Raise)) -> i32)(
cond(
(y == 0) => raise(\`div-by-zero\`, \`I don't like it\`),
true => (x / y)
)
);
});`;

    const once = formatYoSource(source);
    const twice = formatYoSource(once);

    expect(twice).toBe(once);
  });

  test("preserves operator rhs newline needed for right-associative parsing", () => {
    const source = `main::(fn()->unit)({
Raise :: struct(raise : (fn(msg : String) -> i32));
value := Raise(
raise :
(msg) -> {
escape(());
}
);
});`;

    const once = formatYoSource(source);

    expect(once).toBe(`main :: (fn() -> unit)({
  Raise :: struct(raise : (fn(msg : String) -> i32));
  value := Raise(
    raise :
      (msg) -> {
        escape(());
      }
  );
});
`);
    expect(formatYoSource(once)).toBe(once);
  });

  test("indents operator newline right-hand side as a continuation", () => {
    const source = `main::(fn()->unit)({
(given(yield) : Yield) =
(v) -> {
return((v * i32(3)));
};
});`;

    const once = formatYoSource(source);

    expect(once).toBe(`main :: (fn() -> unit)({
  (given(yield) : Yield) =
    (v) -> {
      return(v * i32(3));
    };
});
`);
    expect(formatYoSource(once)).toBe(once);
  });

  test("keeps grouped infix expressions before dot access", () => {
    const source = `main::(fn()->unit)({
(ptr &+ 1).* = 84;
assert((ptr &+ 1).* == 84);
});`;

    const once = formatYoSource(source);

    expect(once).toBe(`main :: (fn() -> unit)({
  (ptr &+ 1).* = 84;
  assert((ptr &+ 1).* == 84);
});
`);
    expect(formatYoSource(once)).toBe(once);
  });

  test("canonicalizes parenthesized dot dereference sugar", () => {
    const source = `main::(fn()->unit)({
assert(a.(*) == 99);
assert(c.(*).count == 10);
assert(d.* == 7);
});`;

    const once = formatYoSource(source);

    expect(once).toBe(`main :: (fn() -> unit)({
  assert(a.* == 99);
  assert(c.*.count == 10);
  assert(d.* == 7);
});
`);
    expect(formatYoSource(once)).toBe(once);
  });

  test("keeps compact array and tuple literals inside multiline calls", () => {
    const source = `main::(fn()->unit)({
cond(
ready => {
arr = [1, 2, 3];
tuple = (1, 2, 3);
},
true => {}
);
});`;

    const once = formatYoSource(source);

    expect(once).toBe(`main :: (fn() -> unit)({
  cond(
    ready => {
      arr = [1, 2, 3];
      tuple = (1, 2, 3);
    },
    true => {}
  );
});
`);
    expect(formatYoSource(once)).toBe(once);
  });

  test("formats multiline array literal with each element on its own line", () => {
    const source = `main::(fn()->unit)({
arr :: [1,
2, 3, 4, 5];
});`;

    const once = formatYoSource(source);

    expect(once).toBe(`main :: (fn() -> unit)({
  arr :: [
    1,
    2,
    3,
    4,
    5
  ];
});
`);
    expect(formatYoSource(once)).toBe(once);
  });

  test("keeps array type sugar compact even if written across lines", () => {
    const source = `main::(fn()->unit)({
t :: [i32; 10];
});`;

    const once = formatYoSource(source);

    expect(once).toBe(`main :: (fn() -> unit)({
  t :: [i32 ; 10];
});
`);
    expect(formatYoSource(once)).toBe(once);
  });

  test("preserves line-leading infix operators for ambiguous chains", () => {
    const source = `main::(fn()->unit)({
value := (
4
| 5
| 6
);
});`;

    const once = formatYoSource(source);

    expect(once).toBe(`main :: (fn() -> unit)({
  value := (
    4
    | 5
    | 6
  );
});
`);
    expect(formatYoSource(once)).toBe(once);
  });

  test("keeps macro splice calls tight", () => {
    const source = `main::(fn()->unit)({
expr := quote(self.(#(field.name.to_expr())).my_eq(other.#(field.name.to_expr())));
});`;

    const once = formatYoSource(source);

    expect(once).toBe(`main :: (fn() -> unit)({
  expr := quote(self.(#(field.name.to_expr())).my_eq(other.#(field.name.to_expr())));
});
`);
    expect(formatYoSource(once)).toBe(once);
  });

  test("keeps optional pointer type syntax tight", () => {
    const source = `main::(fn()->unit)({
argv_uninit := MaybeUninit(Array(?*(u8), usize(5))).new();
argv := *(?*(u8))(argv_uninit.as_ptr());
});`;

    const once = formatYoSource(source);

    expect(once).toBe(`main :: (fn() -> unit)({
  argv_uninit := MaybeUninit(Array(?*(u8), usize(5))).new();
  argv := *(?*(u8))(argv_uninit.as_ptr());
});
`);
    expect(formatYoSource(once)).toBe(once);
  });

  test("keeps negated trait constraint syntax stable", () => {
    const source = `main::(fn()->unit)({
fn2 :: (fn(comptime(T) : Type, where(T <:!(Runtime))) -> unit)({});
});`;

    const once = formatYoSource(source);

    expect(once).toBe(`main :: (fn() -> unit)({
  fn2 :: (fn(comptime(T) : Type, where(T <:!(Runtime))) -> unit)({});
});
`);
    expect(formatYoSource(once)).toBe(once);
  });

  test("formats field lambda calls idempotently", () => {
    const source = `main::(fn()->unit)({
given(exn) := Exception(throw : ((err) -> { escape(()); }));
});`;

    const once = formatYoSource(source);

    expect(once).toBe(`main :: (fn() -> unit)({
  given(exn) := Exception(
    throw : (
      (err) -> {
        escape(());
      }
    )
  );
});
`);
    expect(formatYoSource(once)).toBe(once);
  });
});

describe("formatYoFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-fmt-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("discovers .yo files recursively and ignores non-Yo files", () => {
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "main.yo"), "main::1;", "utf-8");
    fs.writeFileSync(path.join(srcDir, "README.md"), "main::1;", "utf-8");

    const files = findYoFormatFiles(["src"], tmpDir);

    expect(files).toEqual([path.join(srcDir, "main.yo")]);
  });

  test("writes formatted files by default", () => {
    const file = path.join(tmpDir, "main.yo");
    fs.writeFileSync(file, "main::(fn()->unit)({return();});", "utf-8");

    const result = formatYoFiles([file]);

    expect(result.changed).toEqual([file]);
    expect(fs.readFileSync(file, "utf-8")).toBe(`main :: (fn() -> unit)({
  return();
});
`);
  });

  test("check mode reports changed files without writing", () => {
    const file = path.join(tmpDir, "main.yo");
    const original = "main::1;";
    fs.writeFileSync(file, original, "utf-8");

    const result = formatYoFiles([file], { check: true });

    expect(result.changed).toEqual([file]);
    expect(fs.readFileSync(file, "utf-8")).toBe(original);
  });

  test("is idempotent across the tests fixture tree", () => {
    const sourceTestsDir = path.resolve(__dirname, "../../tests");
    const copiedTestsDir = path.join(tmpDir, "tests");
    fs.cpSync(sourceTestsDir, copiedTestsDir, { recursive: true });

    formatYoFiles(["tests"], { cwd: tmpDir });
    const secondResult = formatYoFiles(["tests"], { cwd: tmpDir });

    expect(secondResult.changed).toEqual([]);
  });
});
