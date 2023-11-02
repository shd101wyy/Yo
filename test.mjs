import {CodeGenerator} from "./out/esm/index.mjs";
import {writeFileSync} from "fs"

let code = `
function add(x: i32, y: i32): i32 {
  x + y
}
add(1, 2)
`;
code = `
function test(): i32 {
  12
}
function main(): i32 {
  test()
  4
}
`
code = `
function foo(x: i32, y: i32): i32 {
  x * x + 2 * x * y + y * y
}

function bar(x: i32): i32 {
  foo(x, 4) + 1
}

extern sin(x: f32): f32;

function main(): i32 {
  bar(2)
}
`

code = `
// This is comment
function max(x: i32, y: i32): i32 {
  if (x > y) {
    x
  } else {
    y
  }
}
`

code = `
function main() {
  12
}
`

const codeGenerator = new CodeGenerator(code);

//// const ir = codeGenerator.getLlvmIr();
//// console.log(ir);

// write ir to "test.ll" file
//// writeFileSync("test.ll", ir);