# Learn Mo in 10 Minutes

```typescript
// Philosophy
// A combination of Lisp and C.

// Comment is using `//` or `/* */`
// Mo is case-sensitive

// In Mo, everything is a function:
x :: 12; // immutable x: i32
y := 14; // mutable   y: i32

// can be written as:

(::)(x, 12);
(:=)(y, 14);


// or without type inference

x : i32 : 12; // immutable x: i32
y : i32 = 14; // mutable   y: i32

// can be written as:

(:)((:)(x, i32), 12);
(=)((:)(y, i32), 14);

// define a function
add :: (x: i32, y: i32): i32 ->
  x + y;
// or define its type first
add : (x: i32, y: i32)-> i32;
add : (x: i32, y: i32): i32 -> x + y;
// the same as
add : (x: i32, y: i32)-> i32
    : (x: i32, y: i32): i32 -> x + y;

// call a function
add(3, 4);
// or without parens
add 3, 4;
// or use named arguments
add 3, y: 5;
add y: 5, x: 4;
// or use `add` as an infix operator
3 `add` 4;

// uniform function call syntax
// '.' will move the receiver to the first argument
3.add(4); // is equivalent to add(3, 4)

// block using {...} with ";" as separator
result :: {
  x := 3; // block requires to have ";" inside; otherwise we treat it as a record.
  y := 4;
  add x, y // the last expression without ";" becomes the return value
}; // result is 7
// is equavalent to call `begin`
result :: begin(
  x := 3,
  y := 4,
  add x, y
);

// record is defined using {...} as well, but use "," as separator instead of ";"
// Like the one in JavaScript
person :: {
  name: "John",
  age: 30
};
// is equavalent to call `record`
person :: record(
  name : "John",
  age : 30
);

// tuple is defined using [...]
unit :: []; // empty tuple
pair :: [1, 2]; // tuple with two elements
// is equavalent to call `tuple`
unit :: tuple();
pair :: tuple(1, 2);
first :: pair.0; // 1
second :: pair.1; // 2

// array is defined using [...] as well, but use ";" instead of ","
arr :: [1; 2; 3]; // i32[3]
// is equavalent to call `array`
arr :: array(1, 2, 3);
first :: arr[0]; // 1
rest_slice :: &arr[1..3]; // &i32[], where '..' is the range operator.

x :: [1]; // x: [i32]
// to make it array, add `;`
x :: [1;]; // x: i32[1]

// In Mo, type is the first-class citizen,
// meaning that you can assign a type to a variable, or pass it as an argument to a function.
MyI32 :: i32; // type alias
x : MyI32 = 12; // valid

// struct, accept one parameter that is a type
// struct : (T: Type) -> Struct
Point :: struct [i32, i32];
p :: Point [3, 4];

Rectangle :: struct {
  width: i32,
  height: i32
}
r :: Rectangle {
  width: 10,
  height: 20
};

// union, accept a record of types
// union : (T: Record) -> Union
Result :: union {
  int: i64,
  float: f65,
  bool: boolean
}
result :: Result { int: 12 };
result.float = 3.14;

// enum & tagged enum
// enum : (T: Record) -> Enum
Color :: enum {
  Red, // = 0
  Green,
  Blue
};
c :: Color.Red;

Shape :: enum {
  Circle: [i32],
  Rectangle: {width: i32, height: i32}
};
s :: Shape.Circle [5];
s :: Shape.Rectangle {width: 10, height: 20};

// type as function parameter
Option :: (T: Type): Type ->
  enum {
    Some: T,
    None
  }
x :: Option(i32).Some(12);

// interface
Id :: (T: Type)->
  interface {
    id: (x: T)-> T,
  }

// impl interface
impl Id(i32), {
  id: (x: i32): i32 -> x
}

// impl interface with generic type
forall ((T : Type) <: Show(T)), impl Show([T]), {
  show: (x: [T]): String ->
    "[" + x.0.show() + "]"
}
show [3]; // "[3]"

// Call a function defined in interface
(13).id(); // 13
Id(i32).id(13); // 13
// or
Id(_).id(13); // 13. Use `_` as a placeholder for type

// impl a type
Cm :: struct i32;
impl Cm, {
  M: (x: Cm): i32 -> x / 100,
}
x :: Cm = Cm 200;
x.M(); // 2
// or
Cm.M(x); // 2

// `forall` can be used to define generics
// e.g. without `forall` it also works:
id :: (T: Type, x: T): T -> x;
// but when you call it, you need to specify the type:
id(i32, 12); // 12
// e.g. with `forall`:
id :: forall (T: Type), (x: T): T -> x;
// then you can call it without specifying the type:
id(12); // 12

// closure
// FnOnce, FnMut, Fn are interfaces
x := 12;
add_x :: (y: i32): i32 =>  // => means closure that captures the environment and doesn't take ownership
  x + y;
// => will generate either FnMut, or Fn instance.

s := String.from("Hello");
use_x :: (f: (x: String)-> unit) =>> f(s); // =>> means closure that takes ownership
use_x((s)-> std.println(s)); // "Hello"


// do notation macro
// allows us to use `<-`, `<=`, `<<=` inside a block
do {
  response <<= fetch("https://api.example.com");
  std.println(response);
  json <<= response.json();
  std.println(json);
}
// is equavalent to
{
  fetch("https://api.example.com", (response) =>> {
    std.println(response);
    response.json((json) =>> {
      std.println(json);
    });
  })
}

// Module
// Module is a block of expressions.
// The very last expression is the return value.

// arith.mo
add :: (x: i32, y: i32): i32 -> x + y;
sub :: (x: i32, y: i32): i32 -> x - y;
{ add, sub } // export add and sub
// is equivalent to
// { add: add, sub: sub }

// main.mo
{ add, sub } :: import("./arith.mo");
add(3, 4); // 7

// Type in Mo can be either Linear or Free
// Linear means it must be used exactly once
// For example, String is a linear type
s :: String = String.from("Hello");
s.drop(); // drop the string. s is consumed and can't be used anymore.
s2 :: s;  // error: s is consumed

// Type universe
// - ...
// - Type 2
// - Type 1
// - Type (0)
// - Free | Linear
// - Struct | Union | Enum | atom | i32 | f64 | ...

// Interface is not a type here!

// Reference and Pointer
// Mo use &, &mut to for immutable reference and mutable reference
// Mo use *, *mut to for immutable pointer and mutable pointer
x := 1;
y := 2;
swap :: (a: &mut i32, b: &mut i32) -> {
  tmp := *a;
  *a = *b;
  *b = tmp;
};
swap(&mut x, &mut y);

// To create * and *mut pointer, use `as` function to case reference to pointer:
x_ptr := &x `as` *i32;

// Mutable value semantics
// References in Mo are second-class citizens.
// - Can't be stored in variables.
// - Can't return the reference to local variables in function body, but can return the references that are the function arguments or from the function arguments.
// - Can only be created at function call sites, as a special parameter-passing mode.
// - Path to a value never appears twice in the function arguments. Path uniqueness.
x := 12;
x_ref :: &mut x; // error: can't store reference in variable

// Control flow
/// cond
cond  x == 1 -> std.println("x is 1"),
      x == 2 -> std.println("x is 2"),
      true   -> std.println("x is not 1 or 2")

/// while
factorial :: (x: i32): i32 -> {
  result := 1;
  while x > 1, do: {
    result *= x;
    x -= 1;
  };
  result
}
//// or
factorial :: (x: i32): i32 -> {
  result := 1;
  while x > 1,  // condition
        x -= 1, // step
  do: { // body
    result *= x;
  };
  result
}

/// for
for x, in: 0..=10, do: std.println(x);

// Pattern matching
match x,
  1 -> std.println("x is 1"),
  2 -> std.println("x is 2"),
  _ -> std.println("x is not 1 or 2")

x := Option(i32).Some(12);
match x,
  .Some(y) -> std.println("x is Some with value " + y),
  .None -> std.println("x is None")

// Macro definition
if :: macro (condition: Expr, then: Expr, else: Expr): Expr ->
  quasiquote(
    cond  unquote(condition) -> unquote(then),
          true -> unquote(else)
  );

if x == 1, then: std.println("x is 1"), else: std.println("x is not 1");
// will be expanded to
cond  x == 1 -> std.println("x is 1"),
      true   -> std.println("x is not 1")

// Grammar
Expr :: struct {
  func: atom, // | Expr
  args: List(Expr)
};
// `quote` function
e :: quote(add(1, 2));
// =>
e :: Expr {
  func: quote(add),
  args: List(Expr)(1, 2)
}

// Architecture
// * Lexer - Tokenizer for analyzing the syntax
// * Parser - AST Generation, without caring about semantics
// * Interpreter - Type checking & Compile-time execution as much as possible
// * Compiler - Code Generation, to `C` only now

// C FFI
{*} = import("stdio.h");

extern "C", {
  printf: (format: *char, ...) -> i32;
}

```
