# Learn Mo in 10 Minutes

```rust
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

// Type inference for function return values
// The return type can be inferred when obvious
add_inferred :: (x: i32, y: i32) ->  // Return type inferred as i32
  x + y;

// Type inference works with complex expressions too
get_value :: (condition: boolean) ->  // Return type inferred as Option(i32)
  if condition,
    then: Option(i32).Some(42),
    else: Option(i32).None;

// Named parameters in function declarations with default values
create_user :: (name: String, age: i32 = 18, role: String = "user"): User ->
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
user1 :: create_user(name: "Alice");  // age=18, role="user" (defaults)
user2 :: create_user(role: "admin", name: "Bob", age: 30);  // explicit values
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

// record is defined using {...} with "," as separator instead of ";"
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

// Empty braces {} are considered a record, not a block
empty_record :: {};  // This is a record
// To create an empty block, you need at least one semicolon
empty_block :: {;}   // This is a block (with no statements)

// tuple is defined using (...) with special semantics to distinguish from function calls
unit :: (); // empty tuple
one_element :: (1,); // tuple with one element
                     // NOTE: the comma is required to show it's a tuple
pair :: (1, 2); // tuple with two elements
// is equivalent to call `tuple`
unit :: tuple();
one_element :: tuple(1); // tuple with one element
pair :: tuple(1, 2);
first :: pair.0; // 1
second :: pair.1; // 2

// To disambiguate between function calls and tuples as arguments:

// Option 1: Use special notation for tuple literals in function arguments
take_tuple :: (t: (i32, i32)): i32 -> t.0 + t.1;
take_tuple tuple(1, 2);  // explicitly using tuple constructor
// or with a specialized syntax
take_tuple #(1, 2);  // using '#' prefix to denote a tuple literal

// Option 2: Use the type system to disambiguate
take_tuple :: (t: (i32, i32)): i32 -> t.0 + t.1;
take_tuple((1, 2): (i32, i32));  // explicitly type-annotating the tuple

// array is defined using [...] with "," as separator (now that tuples use parentheses)
arr :: [1, 2, 3]; // Array(i32, 3)
// Array: (Type, comptime usize)-> Type
// is equivalent to call `array`
arr :: array(1, 2, 3);
first :: arr[0]; // 1
rest_slice :: &arr[1..3]; // &Slice(i32), where '..' is the range operator.

// Single element array syntax is now simpler
x :: [1]; // x: Array(i32, 1)

// In Mo, type is the first-class citizen,
// meaning that you can assign a type to a variable, or pass it as an argument to a function.
MyI32 :: i32; // type alias
x : MyI32 = 12; // valid

MyPoint :: (i32, i32); // tuple type
p : MyPoint = (3, 4); // valid

// Define type variant with `.` operator ahead
Point :: .Point(i32, i32);
// is equavalent to:
Point :: ((.)(Point))(i32, i32)
// You can use `.` to access the variant
p :: Point.Point(3, 4);
// or omit `.Variant` if the type only has one variant and the variant name is the same as the type name
p :: Point 3, 4;
// or declare its type first
p : Point : .Point 3, 4;

// Define multiple variants
Color ::
  | .Red // = 0
  | .Green
  | .Blue;
c :: Color.Red;


// C like union can also be defined using '|'
Result :: .Result (
  | { int: i64, }
  | { float: f65, }
  | { bool: boolean }
); // The parentheses are necessary to avoid ambiguity

result :: Result { int: 12 };
result.float = 3.14;

// A more complicated example
Shape ::
  | .Circle i32
  | .Rectangle {width: i32, height: i32}
s :: Shape.Circle 5;
s :: Shape.Rectangle {width: 10, height: 20};

// type as function parameter
Option :: (T: Type): Type ->
  | .Some T
  | .None

x :: Option(i32).Some(12);

// generalized algebraic data types (GADT)
// By default, all variants return the same type.
Point :: .Point(i32, i32);
// is equavalent to:
Point :: .Point : (i32, i32) -> Point;
// You can also specify the return type for each variant
// to make it a GADT
MyExpr :: (T: Type): Type ->
  | .IntExpr : (i32) -> MyExpr(i32)
  | .BoolExpr : (boolean) -> MyExpr(boolean)
  | .EqExpr : (MyExpr(i32), MyExpr(i32)) -> MyExpr(boolean)
my_eval :: (T: Type, expr: MyExpr(T)): T ->
  match expr,
    .IntExpr(i) -> i,
    .BoolExpr(b) -> b,
    .EqExpr(a, b) -> my_eval(a) == my_eval(b);

// higher kinded types
// are types that take other types as parameter
T1 :: (F: (Type) -> Type, A: Type) ->
  .T1 F(A)
// Assume we have the `Maybe` type,
// then we can define `Option` like below
Option :: (T: Type) -> T1(Maybe, T)


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
forall ((T : Type) <: Show(T)), impl Show((T)), {
  show: (x: (T)): String ->
    "(" + x.0.show() + ")"
}
show (3); // "(3)"

// Call a function defined in interface
(13).id(); // 13
Id(i32).id(13); // 13
// or
Id(_).id(13); // 13. Use `_` as a placeholder for type

// impl a type
Cm :: .Cm(i32);
impl Cm, {
  M: (x: Cm): i32 -> x / 100,
}
x :: Cm = 200.Cm();
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
// - Union | symbol | boolean | i32 | f64 | ...

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

// malloc
// There is no null pointer in Mo.
// ^Type is a pointer type which is Linear.
ptr : Option(^i32) : malloc(sizeof(i32)); // allocate memory for i32
match ptr,
  .Some(p) -> {
    *p = 42; // dereference the pointer
    std.println(*p); // print the value
  },
  .None -> std.println("Memory allocation failed");
free(ptr); // free the memory

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

// Recursion using recur
// recur is used to call the current function recursively
factorial_rec :: (x: i32): i32 ->
  if x <= 1,
    then: 1,
    else: x * recur(x - 1);  // recur calls factorial_rec recursively

// recur can also be used with named arguments
fibonacci :: (n: i32): i32 ->
  if n <= 1,
    then: n,
    else: recur(n: n - 1) + recur(n: n - 2);

// Tail recursion for better performance
factorial_tail :: (x: i32, acc: i32 = 1): i32 ->
  if x <= 1,
    then: acc,
    else: recur(x: x - 1, acc: x * acc);  // tail-recursive call

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
// Since everything in Mo is a function, the grammar is much simpler

// Core Syntax
Program  ::= Expression*
Expression ::= Atom | FunctionCall

// Atoms (leaf nodes)
Atom ::= Symbol | Literal

// Literals
Literal ::= BooleanLiteral | NumberLiteral | StringLiteral | CharLiteral
Symbol  ::= Identifier | Operator

// Identifier and Operator definitions
Identifier ::= (Letter | '_') (Letter | Digit | '_')*
Letter     ::= 'a'..'z' | 'A'..'Z'
Digit      ::= '0'..'9'

// Operators can be standard or custom
Operator   ::= StandardOp | CustomOp
StandardOp ::= '+' | '-' | '*' | '/' | '%' | '=' | '==' | '!=' | '<' | '>' | '<=' | '>='
             | '::' | ':=' | ':' | '&' | '&mut' | '*' | '*mut' | '.' | '->' | '=>' | '=>>'
CustomOp   ::= OperatorChar+
OperatorChar ::= '!' | '#' | '$' | '%' | '&' | '*' | '+' | '-' | '.' | '/' | ':' | '<' | '=' | '>' | '?' | '@' | '\\' | '^' | '|' | '~'

// Function Call (the primary construct)
FunctionCall ::= Expression "(" [Expression ("," Expression)*] ")"  // func(arg1, arg2)
               | Expression Expression ("," Expression)*  // func arg1, arg2, ...
               | Expression InfixOperator Expression  // arg1 + arg2
               | PrefixOperator Expression  // !arg

// AST Representation
Expr ::
  | .Atom(
    | .Symbol symbol
    | .Boolean boolean
    | .I32 i32
    | .F64 f64
    | .String string
    | .Char char
  )
  | .FuncCall { func: Box(Expr), args: List(Expr) }

// Everything else is just function calls
// For example, a variable declaration like:
//   x :: 12
// is just a function call to "::" with arguments "x" and "12"
//
// Similarly:
// - match(x, arm1, arm2, ...)
// - impl(type, methods)
// - ::(x, 12)
// - :=(y, 14)
// - if(cond, then_expr, else_expr)
// - for(range, body)
// - while(cond, body)
// - .(obj, method, args...)  // obj.method(args...)
//
// All are function calls, just with specialized notation in some cases

// Note: In Mo, like in Lisp, operators and identifiers are both symbols
// For example, '+', '::', and 'add' are all symbols

// `quote` function
e :: quote(add(1, 2));
// =>
e :: Expr.FuncCall {
  func: Expr.Atom(.Symbol("add")),
  args: List([
    Expr.Atom(.I32(1)),
    Expr.Atom(.I32(2))
  ])
}

// More metaprogramming examples
// `quasiquote` allows creating code templates with holes
// `unquote` evaluates expressions inside quasiquoted expressions
x := 5;
y := 10;
template :: quasiquote(add(unquote(x), unquote(y)));
// =>
template :: Expr.FuncCall {
  func: Expr.Atom(.Symbol("add")),
  args: List([
    Expr.Atom(.I32(5)),  // x was evaluated to 5
    Expr.Atom(.I32(10))  // y was evaluated to 10
  ])
}

// `quote_splice` (unquote-splicing) splices a list into the surrounding list
args :: quote([1, 2, 3]);
call :: quasiquote(sum(quote_splice(args)));
// =>
call :: Expr.FuncCall {
  func: .Atom(.Symbol("sum")),
  args: List([
    .Atom(.I32(1)),
    .Atom(.I32(2)),
    .Atom(.I32(3))
  ])
}

// Combining these for more complex metaprogramming
create_adder :: (n: i32): Expr ->
  quasiquote(
    (x: i32): i32 -> x + unquote(n)
  );

plus5 :: eval(create_adder(5));
plus5(10);  // => 15

// Generate a sequence of operations
ops :: ["add", "sub", "mul"];
generate_math :: quasiquote(
  {
    quote_splice(
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
{*} = import("stdio.h");

extern "C", {
  printf: (format: *char, ...) -> i32;
}

// Compile-time Execution
// Mo performs as much computation at compile time as possible
// The `comptime` keyword explicitly marks expressions for compile-time evaluation

// Compile-time constants
PI :: comptime 3.14159265358979323846;

// Compile-time function execution
factorial :: (n: i32): i32 ->
  if n <= 1, then: 1, else: n * recur(n - 1);

// This will be computed during compilation
FACTORIAL_10 :: comptime factorial(10);  // = 3628800

// Type-level computation using comptime
Matrix :: (T: Type, comptime ROWS: usize, comptime COLS: usize): Type ->
  Array(Array(T, COLS), ROWS);

// Create a 3x3 matrix of integers
mat : Matrix(i32, 3, 3) = [
  [1, 2, 3],
  [4, 5, 6],
  [7, 8, 9]
];

// Compile-time if statements
DEBUG_MODE :: if is_comptime(), true, false;
debug_print :: (msg: String) ->
  if comptime DEBUG_MODE,  // Decided at compile time, dead code eliminated
    then: std.println(msg),
    else: ();
```
