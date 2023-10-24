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

const codeGenerator = new CodeGenerator(code);
const ir = codeGenerator.getLlvmIr();
console.log(ir);

// write ir to "test.ll" file
writeFileSync("test.ll", ir);