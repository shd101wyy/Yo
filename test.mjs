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

code = `
function main() {
  const x = 1;
  const f = (y: i32)=> {
    x + y
  };
  f(5)
}
`


code = `
extern printlnd(d:i32):i32
function test(x: i32) {
  ()=> {
    printlnd(x);
    x + 1
  }
}
function main() {
  const f = test(3);
  printlnd(f());
  0
}
`
code = `
function test(f: (x: i32)=>i32) {
  f(3)
}

function main() {
  const a = 12;
  test((x: i32)=> {x + a})
}
`

code = `
extern printlnd(d:i32):i32
function factorial(x:i32, acc:i32=1): i32 {
  if (x == 0) {
    acc
  } else {
    factorial(x-1, acc*x)
  }
}

function main() {
  printlnd(factorial(10))
}
`

code = `
function main() {
  const x = {
    add: (a: i32, b: i32) => {
      a + b
    }
  };
  x.add(3, 4)
}
`

code = `
function main() {
  ((x: i32)=> { x })(16)
}
`

code = `
extern printlnd(x:i32):i32;
type Data<T> = {v: T};
function main() {
  const x: Data<i32> = {v: 1}
  printlnd(x.v)
}
`

code = `
function id<T>(x: T) {
  x
}
function test() {
  id<i32>(3) + 4
}
`

code = `
type Id<T> = {v: T}
type IntId = Id<i32>
`

code = `
type List<T> = {  tag: @"Cons", 
                  v: T, 
                  next: List<T> } | { tag: @"Nil"};
const end: List<i32> = { tag: @"Nil" }
`

code = `
type MyInt<T> = {v: T};
type MyIntInt = MyInt<i32>;
`

code = `
function add(x: i32, y: i32) { x + y }
function add(x: i32, y: i32, z: i32) { x + y + z }
function main() {
  add(3, 4)
}
`

code = `
interface Id<T> {
  id(xa: T): T;  
}
interface Id2<T> extends Id<T> {
  id2(xb: T): T;
}
function test<T>(x: Id2<T>) {
  x.id2()
}
`

code = `
function add(x: i32) {
  x
}
function add(x: i32, y: i32) {
  x + y
}
function main() {
  add(3)
}
`

code = `
function id<T>(x: T) {
  x
}
function main() {
  id<f32>(12.3);
  id<i32>(12)
}
`

code = `
function copy<T>(x: T) {
  const y: T = x;
  y
}
function main() {
  const x = copy<f32>(3.4);
  copy<i32>(3);
  copy<i32>(66)
}
`

code = `
function main() {
  const z = {x: 1, y: 2};
  with z;
  x + y
}
`

code = `
function test(fn: ()=> i32 ) {
  fn()
}
function main() {
  test(()=> { 16 })
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
