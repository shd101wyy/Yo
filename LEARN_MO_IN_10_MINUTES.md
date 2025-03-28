# Learn Mo in 10 Minutes

```rust
// Philosophy
// A combination of Lisp and C.

// Comment is using `//` or `/* */`
// Mo is case-sensitive

// In Mo, everything is a function (or macro):
x := 12; // immutable x: i32
mut(y) := 14; // mutable   y: i32

// can be written as:
(:=)(x, 12);
(:=)(mut(y), 14);

// (:=) function is used to initialize a variable with a value
// (=) function is used to update a mutable variable with a new value
// (:) function is used to denote a type

(x : i32) := 12; // immutable x: i32
(mut(y) : i32) := 14; // mutable   y: i32

// can be written as:

(:)((:)(x, i32), 12);
(=)((:)(mut(y), i32), 14);

// There is no arithmetic precedence in Mo
// Every infix operator takes two arguments on its left and right
// so the expression below is invalid
3 + 4 - 5;
// needs to be written as
3 + (4 - 5);
// or
(3 + 4) - 5;
// or you can use ; to separate the expressions
3 + 4; - 5; // but apparently this is not what we meant :)
// same for
3 + 4 + 5;
// needs to be written as
(3 + 4) + 5;
// or
(+) 3, 4, 5
// or
(+ 3, 4, 5) // Like in Lisp! But with commas separating the arguments

// Why no precedence?
// Because it makes the language easier to parse and understand
// and it's consistent with the rest of the language
// It's explicit!
// Let's consider the following example:
2 ** 3 ** 4
// Should it be evaluated as
(2 ** 3) ** 4
// or as
2 ** (3 ** 4)
// It's hard to tell! So let's make it explicit

// define a function
add := (fn(x: i32, y: i32) : i32) -> (x + y);
// or define its type first
add : (fn(x: i32, y: i32)-> i32); // function type is written as fn(args...)-> return_type
add := ((fn(x: i32, y: i32): i32) -> (x + y)); // function implementation is written as fn(args...): return_type -> body
// the same as
add :  (fn(x: i32, y: i32)-> i32)
    := ((fn(x: i32, y: i32) : i32) -> (x + y));
// Or
fn add(x: i32, y: i32):i32, x + y;

// Type inference for function return values
// The return type can be inferred when obvious
add_inferred := fn(x: i32, y: i32) ->  // Return type inferred as i32
  (x + y);

// Type inference works with complex expressions too
get_value := fn(condition: boolean) ->  // Return type inferred as Option(i32)
  if condition,
    then: Option(i32).Some(42),
    else: Option(i32).None;

// Named parameters in function declarations with default values
create_user := fn(name: String,
                  age: i32 = 18,
                  role: String = String.from("user")
                ): User ->
  User {
    name: name,
    age: age,
    role: role
  };

// call a function
add(3, 4);
// or without parens
add 3, 4;
// or use named arguments
add 3, y: 5;
add y: 5, x: 4;
// Call with named parameters in any order, omitting those with defaults
user1 := create_user(name: "Alice");  // age=18, role="user" (defaults)
user2 := create_user(role: "admin", name: "Bob", age: 30);  // explicit values
// or use `add` as an infix operator
3 `add` 4;

// uniform function call syntax
// '.' will move the receiver to the first argument
3.add(4); // is equivalent to add(3, 4)

// Define a custom operator
(+++) := fn(x: i32, y: i32): i32 -> x + y;
3 +++ 4; // 7

// All function parameters are immutable by default
modify := fn(x: i32): i32 -> {
  x += 1; // error: x is immutable
  x
}
// To make the function parameter mutable, use `mut`
modify := fn(mut(x):i32): i32 -> {
  x += 1; // OK
  x
}

// block using {...} with ";" as separator
result := {
  x := 3; // block requires to have ";" inside; otherwise we treat it as a record.
  y := 4;
  add x, y // the last expression without ";" becomes the return value
}; // result is 7
// is equavalent to call `begin`
result := begin(
  x := 3,
  y := 4,
  add x, y
);

// record is defined using {...} with "," as separator instead of ";"
// Like the one in JavaScript
person := {
  name: "John",
  age: 30
};
// is equavalent to call `record`
person := record(
  name : "John",
  age : 30
);

// Empty braces {} are considered a record, not a block
empty_record := {};  // This is a record
// To create an empty block, you need at least one semicolon
empty_block := {;}   // This is a block (with no statements)

// tuple is defined using (...) with "," as separator
unit := (); // empty tuple
one_element := (1,); // tuple with one element requires extra "," at the end. Otherwise, it's considered a parenthesized expression.
pair := (1, 2); // tuple with two elements

// there might be ambiguity for the function that accepts tuple as its first argument
some_func := fn(x: (i32, i32)): i32 -> x(0) + x(1);
// then
some_func(1, 2); // error: expected 1 argument, got 2
// and
some_func (1, 2); // Works! The whitespace is necessary here to avoid ambiguity
                  // 3
// or call it like without whitespace between the function and '('
some_func((1, 2)); // 3

// array is defined using [...] with "," as separator.
arr := [1, 2, 3]; // Array(i32, 3)
// Array: fn(Type, comptime usize)-> Type
// is equivalent to call `array`
arr := array(1, 2, 3);
mut(arr) := [1, 2, 3]; // mutable array

// In Mo, type is the first-class citizen,
// meaning that you can assign a type to a variable, or pass it as an argument to a function.
MyI32 := i32; // type alias
x : MyI32 := 12; // valid

MyPoint := (i32, i32); // tuple type
p : MyPoint := (3, 4); // valid

// Define type variant with `.` operator ahead
// `.` is a special operator that acceps only a symbol after it.
Point := .Point(i32, i32);
// is equavalent to:
Point := ((.)(Point))(i32, i32)
// You can use `.` to access the variant
p := Point.Point(3, 4);
// or omit `.Variant` if the type only has one variant and the variant name is the same as the type name
p := Point 3, 4;
// or declare its type first
p : Point := .Point 3, 4;

// Define multiple variants
Color :=
  (|) .Red, // = 0
      .Green,
      .Blue;
c := Color.Red;


// C like union can also be defined using '|'
Result := .Result (
  | { int: i64, }
  | { float: f64, }
  | { bool: boolean }
); // The parentheses are necessary to avoid ambiguity

result := Result { int: 12 };
result.float = 3.14;

// A more complicated example
Shape :=
  | .Circle i32
  | .Rectangle {width: i32, height: i32}
s := Shape.Circle 5;
s := Shape.Rectangle {width: 10, height: 20};

// type as function parameter
Option := fn(T: Type): Type ->
  | .Some T
  | .None

x := Option(i32).Some(12);

// generalized algebraic data types (GADT)
// By default, all variants return the same type.
Point := .Point(i32, i32);
// is equavalent to:
Point := (.Point : (fn(i32, i32) -> Point));
// You can also specify the return type for each variant
// to make it a GADT
MyExpr := fn(T: Type): Type ->
  | .IntExpr : fn(i32) -> MyExpr(i32)
  | .BoolExpr : fn(boolean) -> MyExpr(boolean)
  | .EqExpr : fn(MyExpr(i32), MyExpr(i32)) -> MyExpr(boolean)
my_eval := fn(T: Type, expr: MyExpr(T)): T ->
  match expr,
    .IntExpr(i) -> i,
    .BoolExpr(b) -> b,
    .EqExpr(a, b) -> my_eval(a) == my_eval(b);

// higher kinded types
// are types that take other types as parameter
T1 := fn(F: (Type) -> Type, A: Type) ->
  .T1 F(A)
// Assume we have the `Maybe` type,
// then we can define `Option` like below
Option := fn(T: Type) -> T1(Maybe, T)


// interface
Id := fn(T: Type)->
  interface {
    id: (x: T)-> T,
  }

// impl interface
impl Id(i32), {
  id: fn(x: i32): i32 -> x
}

// impl interface with generic type
forall $ ((T : Type) <: Show(T)) -> impl Show((T,)), {
  show: fn(x: (T,)): String ->
    "(" + x(0).show() + ")"
}
show((3,)); // "(3)"

// Call a function defined in interface
(13).id(); // 13
Id(i32).id(13); // 13
// or
Id(_).id(13); // 13. Use `_` as a placeholder for type

// impl a type
Cm := .Cm(i32);
impl Cm, {
  M: fn(x: Cm): i32 -> x / 100,
}
x : Cm := 200.Cm();
x.M(); // 2
// or
Cm.M(x); // 2

// `forall` can be used to define generics
// e.g. without `forall` it also works:
id := fn(T: Type, x: T): T -> x;
// but when you call it, you need to specify the type:
id(i32, 12); // 12
// e.g. with `forall`:
id := forall $ (T: Type) -> fn(x: T): T -> x;
// then you can call it without specifying the type:
id(12); // 12

// Module
// Module is a block of expressions.
// The very last expression is the return value.

// arith.mo
add := fn(x: i32, y: i32): i32 -> x + y;
sub := fn(x: i32, y: i32): i32 -> x - y;
{ add, sub } // export add and sub
// is equivalent to
// { add: add, sub: sub }

// main.mo
{ add, sub } := import("./arith.mo");
add(3, 4); // 7

// Type in Mo can be either Linear or Free
// Linear means it must be used exactly once
// For example, String is a linear type
s : String := String.from("Hello");
s.drop(); // drop the string. s is consumed and can't be used anymore.
s2 := s;  // error: s is consumed

// QUESTION: Should we have the RAII?
// RAII (Resource Acquisition Is Initialization)
// Mo automatically insert `drop` function for Linear types that are not used anymore and implement `drop` function.

// Type universe
// - ...
// - Type 2
// - Type 1
// - Type (0)
// - Free | Linear
// - Union | symbol | boolean | i32 | f64 | ...

// Interface is not a type here!

// Reference and Pointer
// Mo uses *, *mut to for immutable pointer and mutable pointer
// Mo uses &, &mut for immutable reference and mutable reference
mut(x) := 1;
mut(y) := 2;
swap := (fn(a: &mut(i32), b: &mut(i32)) -> {
  tmp := *a;
  *a = *b;
  *b = tmp;
});
swap(&mut(x), &mut(y));

// Mutable value semantics
// References in Mo are second-class citizens.
// Rule 1.0, let's say fucntion parameter is not local variable, then:
// - 1) Reference to local variable can only happen in the call site.
//   - 1.1) It cannot be stored in a variable or data structure.
//   - 1.2) It cannot be returned from the block.
// - 2) Function parameter of mutable reference is required to live shorter than the function parameter of immutable reference.
// - 3) Path to a value never appears twice in the function arguments. Path uniqueness, to guarantee One Reference Only (ORO).
//    - If a function returns a reference, then we need to continue checking it
//      eg: f1(f2(ref1), ref2);
//          if f2 returns another reference (this reference will be sure to contain ref1), then we need to check the paths of ref1 and ref2.
//          if f2 doesn't return a reference, then we don't need to check the paths of ref1 and ref2.

x := 12;
x_ref := &mut x; // error: Violate the Rule 1.1

y := {
  x := 12;
  &x // error: Violate the Rule 1.2
}

fn(some_ref: &mut(i32)) -> {
  x := some_ref; // Allowed! As some_ref is not a local variable
  x // return a reference here is Allowed! As it's from the function parameter.
}

fn(container: &mut(Container), some_ref: &(i32)) -> {
  container.x = some_ref; // Allowed!
                          // According to Rule 2
                          // container lives shorter than some_ref
}


// You can use the `use` function to use the reference value in a new scope
use &mut(x), x_ref -> {
  // `x` is not allowed to be used here
  *x_ref = 13;
}

// Iterator
to_iter_mut := (forall $ ((T: Type) ->
  (fn(arr: &mut(Array(T))) -> {
    return Iter {
      data: arr, // allow to assign reference in this case because it's the last expression
      index: 0
    };
  })))
arr := ["Hello".to_string(), "world".to_string(), "!".to_string()];
use arr.to_iter_mut(), iter-> {
  // arr is not allowed to be used here
  // iter: Iter(&mut(String))
  use iter.next(), v -> {
    // iter is not allowed to be used here
    // v: Option(&mut(String))
    // ...
  }
}


// closure
// FnOnce, FnMut, Fn are interfaces
// like the ones in Rust
x := 12;
use &mut(x), x-> {
  // x: &mut(i32)
  use ((fn(y: i32):i32) =>  // => means closure that captures the outside environment.
    *x = *x + y;
  // =>
  ), closure -> { // in this case, closure is FnMut
    closure(1); // x: 13
    closure(2); // x: 15
  }
}
// x: 15

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

// malloc
// There is no null pointer in Mo.
// ^Type or ^mut(Type) is a pointer type which is Linear.
ptr : Option(^mut(i32)) : malloc(sizeof(i32)); // allocate memory for i32
match ptr,
  .Some(p) -> {
    *p = 42; // dereference the pointer
    std.println(*p); // print the value
  },
  .None -> std.println("Memory allocation failed");
free(ptr); // free the memory

// Control flow
/// cond
cond  (x == 1) -> std.println("x is 1"),
      (x == 2) -> std.println("x is 2"),
      true   -> std.println("x is not 1 or 2")

/// while
factorial := fn(x: i32): i32 -> {
  result := 1;
  while x > 1, do: {
    result *= x;
    x -= 1;
  };
  result
}
//// or
factorial := fn(x: i32): i32 -> {
  result := 1;
  while x > 1,  // condition
        x -= 1, // step
  do: { // body
    result *= x;
  };
  result
}

// Recursion using recur
// recur is used to call the current function recursively
factorial_rec := fn(x: i32): i32 ->
  if x <= 1,
    then: 1,
    else: x * recur(x - 1);  // recur calls factorial_rec recursively

// recur can also be used with named arguments
fibonacci := fn(n: i32): i32 ->
  if n <= 1,
    then: n,
    else: recur(n: n - 1) + recur(n: n - 2);

// Tail recursion for better performance
factorial_tail := fn(x: i32, acc: i32 = 1): i32 ->
  if x <= 1,
    then: acc,
    else: recur(x: x - 1, acc: x * acc);  // tail-recursive call

/// for
for 0..=10, (x)-> std.println(x); // NOTE: The last argument is **NOT** a function

// Pattern matching
match x,
  1 -> std.println("x is 1"),
  2 -> std.println("x is 2"),
  _ -> std.println("x is not 1 or 2")

x := Option(i32).Some(12);
match x,
  .Some(y) -> std.println("x is Some with value " + y),
  .None -> std.println("x is None")

// Error Handling
// Mo uses the Result type for operations that may fail
// Similar to Rust, Result is a union type with Ok and Err variants

// Define the Result type as a generic type
Result := fn(T: Type, E: Type): Type ->
  | .Ok T
  | .Err E;

// Define a standard error type
DivisionError :=
  | .DivideByZero
  | .Overflow;

// Example: Safe division function that returns a Result
safe_div := fn(a: i32, b: i32): Result(i32, DivisionError) ->
  if b == 0,
    then: Result(i32, DivisionError).Err(.DivideByZero),
    else: Result(i32, DivisionError).Ok(a / b);

// Pattern matching for error handling
division_result := safe_div(10, 2);
match division_result,
  .Ok(value) -> std.println("Result: " + value.to_string()),
  .Err(.DivideByZero) -> std.println("Error: Cannot divide by zero");

// Macro definition
if := macro (condition: Expr, then: Expr, else: Expr): Expr ->
  quasiquote(
    cond  unquote(condition) -> unquote(then),
          true -> unquote(else)
  );

if x == 1, then: std.println("x is 1"), else: std.println("x is not 1");
// will be expanded to
cond  x == 1 -> std.println("x is 1"),
      true   -> std.println("x is not 1")


// AST Representation
Expr :=
  | .Atom(
    | .Symbol symbol
    | .Boolean boolean
    | .I32 i32
    | .F64 f64
    | .String string
    | .Char char
  )
  | .FuncCall { func: Box(Expr), args: ExprList }

// Everything else is just function calls
// For example, a variable declaration like:
//   x := 12
// is just a function call to ":=" with arguments "x" and "12"
//
// Similarly:
// - match(x, arm1, arm2, ...)
// - impl(type, methods)
// - (:=)(x, 14)
// - if(cond, then_expr, else_expr)
// - for(range, body)
// - while(cond, body)
// - .(obj, method, args...)  // obj.method(args...)
//
// All are function calls, just with specialized notation in some cases

// Note: In Mo, like in Lisp, operators and identifiers are both symbols
// For example, '+', ':=', and 'add' are all symbols

// `quote` function to quote an expression
e := quote(add(1, 2));
// =>
e := Expr.FuncCall {
  func: Box(.Atom(.Symbol(quote(add)))),
  args: (
    Expr.Atom(.I32(1)),
    Expr.Atom(.I32(2))
  )
}
e.to_string(); // "add(1, 2)"

// More metaprogramming examples
// `quasiquote` allows creating code templates with holes
// `unquote` evaluates expressions inside quasiquoted expressions
x := 5;
y := 10;
template := quasiquote(add(unquote(x), unquote(y)));
// =>
template := Expr.FuncCall {
  func: Box(.Atom(.Symbol(quote(add)))),
  args: (
    Expr.Atom(.I32(5)),  // x was evaluated to 5
    Expr.Atom(.I32(10))  // y was evaluated to 10
  )
}

// `unquote_splicing` splices a list into the surrounding list
args : ExprList : (1, 2, 3); // NOTE: Tuple can be converted to ExprList
call := quasiquote(sum(unquote_splicing(args)));
// =>
call := Expr.FuncCall {
  func: Box(.Atom(.Symbol(quote(sum)))),
  args: (
    .Atom(.I32(1)),
    .Atom(.I32(2)),
    .Atom(.I32(3))
  )
}

// Combining these for more complex metaprogramming
create_adder := fn(n: i32): Expr ->
  quasiquote(
    (x: i32): i32 -> x + unquote(n)
  );

plus5 := eval(create_adder(5));
plus5(10);  // => 15

// Generate a sequence of operations
ops := [quote(add), quote(sub), quote(mul)];
generate_math := quasiquote(
  {
    unquote_splicing(
      ops.map((op) ->
        quasiquote(
          std.println(unquote(op) <> " result: " <>
            to_string(unquote(Expr.Atom(.Symbol(op)))(10, 5)))
        )
      )
    )
  }
);
// When evaluated, will print:
// add result: 15
// sub result: 5
// mul result: 50

// Architecture
// * Lexer - Tokenizer for analyzing the syntax
// * Parser - AST Generation, without caring about semantics
// * Interpreter - Type checking & Compile-time execution as much as possible
// * Compiler - Code Generation, to `C` only now

// C FFI
{*} := import("stdio.h");

extern "C", {
  printf: (fn(format: *char, ...) -> i32);
}

// Compile-time Execution
// Mo performs as much computation at compile time as possible
// The `comptime` function explicitly marks expressions for compile-time evaluation

// Compile-time constants
PI := comptime(3.14159265358979323846);

// Compile-time function execution
// Consider making the syntax more explicit:
factorial := fn(n: i32): i32 ->
  if n <= 1, then: 1, else: n * recur(n - 1);

// This will be computed during compilation
FACTORIAL_10 := comptime factorial(10);  // More consistent syntax without parentheses
                                         // Also consider a distinct naming convention for compile-time constants like ALL_CAPS

// Type-level computation using comptime
// Consider more intuitive syntax for type parameters:
Matrix := fn(T: Type, comptime(ROWS): usize, comptime(COLS): usize): Type ->
  Array(Array(T, COLS), ROWS);
// ^ Removing parentheses around ROWS makes it consistent with COLS

// Create a 3x3 matrix of integers
mat : Matrix(i32, 3, 3) := [
  [1, 2, 3],
  [4, 5, 6],
  [7, 8, 9]
];

// Compile-time if statements
// Consider a dedicated compile-time condition syntax:
DEBUG_MODE := comptime if debug_build(), true, false;
debug_print := fn(msg: String) ->
  comptime if DEBUG_MODE,  // More consistent with other uses of comptime
    then: std.println(msg),
    else: ();
```
