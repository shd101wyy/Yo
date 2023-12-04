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
extern printlnd(x:i32):i32;
function finally(final: ()=>(), body: ()=> ()) {
  body();
  final();
}
function main() {
  with finally {
    printlnd(2);
  }
  printlnd(1);
}
`

code = `
extern printlnd(x:i32):i32;
function twice(fn: ()=> ()) {
  fn()
  fn()
}
function main() {
  with twice;
  with twice; {
    printlnd(12);
  }
}
`

code = `
interface Eq<T> {
  eq(x: T, y: T): boolean;
}

function eq(x: i32, y: i32) {
  x == y
}

function test<T>(x: T, y: T) {
   with Eq<T>;
   eq(x, y)
}
`

code = `
interface Eq<X> {
  eq(x: X, y: X): boolean;
}

function eq(x: i32, y: i32) {
  x == y
}

function test<T>(x: T, y: T) {
   Eq<T>.eq<T>(x, y)
}
`


code = `
interface Eq<X> {
  eq(x: X, y: X): boolean;
}
function test<T>(x: T, y: T) {
  with Eq<T>;
  eq(x, y)
}
function main() {
  test<i32>(3, 4)
}
`
code = `
interface Eq<X> {
  eq(x: X, y: X): boolean;
}

function main() {
  with Eq<i32>;
  eq(3, 4)
}
`

code = `
interface Id<X> {
  id(x: X): X;
}

function id(x: i32) {
  x
}

function id(x: f32) {
  x
}

function test<T>(x: T) {
  with Id<T>;
  id(x)
}
function main() {
  test<i32>(15)
}
`

code = `
function id(x: i32) {
  x
}
function id(x: i32) {
  x + 1
}
function main() {
  id(3)
}
`

code = `
trait Id<X> {
  id(x: X): X;
  id2(x: X): X;
}
`

code = `
trait Test {
  test(): i32 {
    13
  }
}

function main() {
  Test.test()
}
`

code = `
trait Test {
  add(x: i32, y: i32): i32 {
    x + y
  }
}

function main() {
  Test.add(3, 4)
}
`

code = ` // TODO: Try this <-
trait Test {
  add(x: i32, y: i32): i32 {
    x + y
  }
}

function main() {
  with Test;
  add(3, 4)
}
`

code = `
trait Id<X> {
  id(x: X): X;
}

instance Id<i32> {
  id(x: i32): i32 {
    x
  }
}
`

code = `
function id<X>(x: X): X {
  x
}

function test1() {
  id<i32>(3)
}

function test2() {
  id<i32>(4)
}

function main() {
  test1();
  test2()
}
`

code = `
trait Id<X> {
  id(x: X): X {
    const y: X = x;
    y
  }
}

function test1() {
  Id<i32>.id(3)
}
function test2() {
  Id<i32>.id(4)
}

function main() {
  test1();
  test2()
}
`
code = `
trait Id<X> {
  id(x: X): X {
    const y: X = x;
    y
  }
}

function main() {
  Id<f32>.id(3.2);
  Id<i32>.id(3) + Id<i32>.id(4)
}
`


code = `
trait Id<X> {
  id(x: X): X { x };
}

function main() {
  Id<i32>.id(34)
}
`


code = `
trait Id {
  id(x: i32): i32 { x };
}

instance Id {
  id(x: i32): i32 { x + 1 };
}

function main() {
  Id.id(35)
}
`

code = `
enum Color {
  Red,
  Blue,
  Green
}

function colorToInt(c: Color): i32 {
  switch c {
    case Color.Red: 0;
    case Color.Blue: 1;
    case Color.Green: 2;
  }
}

function main() {
  colorToInt(Color.Red)
}
`

code = `
function main() {
  const x = 12;
  switch x {
    case 0:
    case 1: 1;
    case 2: 2;
    case 3: {
      3
    }
    default: 4;
  }
}
`

code = `
enum Color {
  Red,
  Blue,
  Green
}

function colorToInt(c: Color): i32 {
  if (c is Color.Red) 0
  else if (c is Color.Blue) 1
  else if (c is Color.Green) 2
  else 3
}

function main() {
  colorToInt(Color.Red)
}
`

code = `
enum Option<T> {
  Some(val: T),
  None
}

function main() {
  const x = Option<i32>.Some(3);
  if x is Option<i32>.Some(val) // && val >= 0
  {
    val
  } else {
    0
  }
}
`

code = `
enum Option<T> {
  Some(val: T),
  None
}
function main() {
  Option<i32>.Some(3) is Option<i32>.Some(val) && val >= 0
}
`

code = `
enum Option<T> {
  Some(val: T),
  None
}
function test<T>(x: T) {
  Option<T>.Some(x)
}
function main(): i32 {
  const x = Option<i32>.Some(3);
  const y = Option<i32>.None;
  const z = test<i32>(12);
  0
}
`

code = `
enum Option<T> {
  Some(val: T),
  None
}
function test<T>(x: T) {
  Option<T>.Some(x)
}
function main(): i32 {
  const x = test<i32>(12);
  0
}
`

code = `
trait Id<X> {
  id(x: X): X;
}

instance<T> Id<Option<T>> {
  id(x: Option<T>): Option<T> {
    x
  }
}

function main() {
  Id<Option<i32>>.id(Option<i32>.Some(3))
}
`

code = `
trait Show<X> {
  show(x: X): string;
}

instance<T> Show<Option<T>> 
with Show<T> {
  show(x: Option<T>): string {
    if (x is Option<T>.Some(val)) {
      "Some(" + show(val) + ")"
    } else {
      "None"
    }
  }
}
`

code = `
enum Option<V> {
  Some(val: V),
  None
}
function test<T>(x: T) {
  const a = Option<T>.Some(x);
  Option<T>.Some(x)
}
function main(): i32 {
  const x = test<i32>(12);
  0
}
`

code = `
enum Option<V> {
  Some(val: V),
  None
}
function id(x: Option<i32>): Option<i32> {
  x
}
function main() {
  const x = Option<i32>.Some(3);
  const y = Option<i32>.None;
  id(x);
  id(y);
  0
}
`

code = `
enum Option<V> {
  Some(val: V),
  None
}

function main() {
  const x: Option<i32> = Option.Some(3);
  1
}
`

code = `
function id<T, Y>(x: T): T {
  x
}

function main() {
  id(12)
}
`

const codeGenerator = new CodeGenerator(code);

//// const ir = codeGenerator.getLlvmIr();
//// console.log(ir);

// write ir to "test.ll" file
//// writeFileSync("test.ll", ir);

// Run "clang ./src/lib.c test.ll -o test"
// Run "./test"
// Run "echo $?" to see the return value
//// spawnSync("clang", ["./src/lib.c", "test.ll", "-o", "test"], {stdio: "inherit"});
//// spawnSync("./test", [], {stdio: "inherit"});
