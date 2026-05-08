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
});
