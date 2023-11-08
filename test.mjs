import { spawnSync } from "child_process";
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

function main() {
  max(3, 4)
}
`


code = `
function test() {
  12
}
function main() {
  test()
}
`

code = `
function main() {
  const test = ()=> {
    12
  };
  test()
}
`

code = `
function main() {
  const ptr = {v: 1}
  const test = (x: i32, env={ptr:ptr})=> {
    env.ptr.v + x
  };
  test(2)
}
`

const codeGenerator = new CodeGenerator(code);

const ir = codeGenerator.getLlvmIr();
console.log(ir);

// write ir to "test.ll" file
writeFileSync("test.ll", ir);

// Run "clang ./src/lib.c test.ll -o test"
// Run "./test"
// Run "echo $?" to see the return value
spawnSync("clang", ["./src/lib.c", "test.ll", "-o", "test"], {stdio: "inherit"});
//// spawnSync("./test", [], {stdio: "inherit"});
