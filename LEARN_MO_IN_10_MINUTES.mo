// # Learn Mo in 10 Minutes
// Philosophy
// A combination of Lisp and C.

// Comment is using `//` or `/* */`
// Mo is case-sensitive

// In Mo, everything is a function:
x := true;
y :: 14;

// can be written as:
(:=)(x, true);
(::)(y, 14);

// (:) function is used to denote a type
// (=) function is used to update a mutable variable with a new value, or initialize a variable with a value
// (:=) function is used to denote a runtime variable with type inferred
// (::) function is used to denote a comptime variable with type inferred

x : i32;        // Define a runtime immutable variable
mut(x) : i32;   // Define a runtime mutable variable
compt(x) : i32; // Define a compile-time immutable variable
compt(mut(x)) : i32;  // Define a compile-time mutable variable

(compt(x) : compt_int) = 12;  // compt(x): i32, immutable.
(mut(y) : i32) = 14;          // mut(y): i32, mutable.
(z : i32) = 16;               // z: i32, immutable.

// can be written as:

(=)((:)(compt(x), compt_int), 12);
(=)((:)(mut(y), i32), 14);
(=)((:)(z, i32), 16);

// They are equavalent to the following:

x :: 12;
mut(y) := 14;
z := 16; // This will give error, as compt_int type cannot be assigned to runtime variable.  


// There is no arithmetic precedence in Mo
// Except for the "." is not taking as a operator, but it has the highest precedence.
// "." has its own parsing rules, for example a.b + c.d is parsed as (. a b) + (. c d)

// Every infix operator takes two arguments on its left and right
// so the expression below is invalid
//
//   3 + 4 - 5;
//
// needs to be written as
//
3 + (4 - 5);
//
// or
(3 + 4) - 5;
// or you can use ; to separate the expressions
3 + 4; - 5; // but apparently this is not what we meant :)
// same for
//
//   3 + 4 + 5;
//
// needs to be written as
(3 + 4) + 5;
// or
(+) 3, 4, 5;
// or
(+ 3, 4, 5); // Like in Lisp! But with commas separating the arguments

// But there is a trick
3 + // Newline after the operator is the magic here!
  4 + 5
;
// This is equavalent to
3 + (4 + 5);

// Why no precedence?
// Because it makes the language easier to parse and understand
// and it's consistent with the rest of the language
// It's explicit!
// Let's consider the following example:
//
//   2 ** 3 ** 4;
//
// Should it be evaluated as
(2 ** 3) ** 4;
// or as
2 ** (3 ** 4);
// It's hard to tell! So let's make it explicit

// NOTE: All operators are method in Mo
3 + 4;
// is equavalent to
3.(+) 4;

// define a function
def add(x: i32, y: i32):i32,
  x + y;
// or with anonymous function defined with `fn` and `->`
add ::
  (fn(x: i32, y: i32) : i32) ->
    x + y;

// or with the function type first, then the function implementation:
compt(add) : ((x: i32, y: i32)-> i32);          // function type is written as (args...)-> return_type
add = ((fn(x: i32, y: i32) : i32) -> (x + y));  // function implementation is written as fn(args...): return_type -> body

// If no function type is given, the the function implementation needs to define explicit function type
get_value :: ((fn(condition: boolean) : Option(i32)) ->
  if condition,
    then: Option(i32).Some(42),
    else: Option(i32).None);

// Named parameters in function declarations with default values
def create_user( 
    name: String,
    (age: i32) = 18,
    (role: String) = String.from("user")
  ): User,
  User
    name: name,
    age: age,
    role: role
  ;

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

// Mo also supports the infix function application
// 3 `add` 4; // is equivalent to add(3, 4)


// Define a custom operator
// NOTE: Operator is only allowed to be defined as method in interface implementation.
// So the code below is invalid.
def (+++)(x: i32, y: i32):i32,
  x + y;
3 +++ 4; // 7

// All function parameters are immutable by default
def modify(x: i32):i32, {
  x += 1; // error: x is immutable
  x
}
// To make the function parameter mutable, add `mut` qualifier
def modify(mut(x): i32):i32, {
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
empty_block := {}   // This is an empty block that returns unit.  

// All tuples in Mo are named tuples.
// You can define the tuple type using `type` keyword.  
// A tuple type can have named fields or unnamed fields.
// Like the one in JavaScript.
Person :: type (name: String, age: i32);
// NOTE: You cannot have labelled fields in the tuple value, it's only allowed in the tuple type.
(person : Person) = (
  "John",
  30
);
name := person.name; // "John"
age := person.age;   // 30


// tuple is defined using (...) with "," as separator
one_element := (1,); // tuple with one element requires extra "," at the end. Otherwise, it's considered a parenthesized expression.
                      // The "." ahead of the tuple is necessary to distinguish it from a type.
pair := (1, 2); // tuple with two elements
MyTuple :: type (i32, f32);
(my_tuple : MyTuple) = (1, 2.0); // tuple with two elements
my_tuple := (1, 2.0);

NamedTuple :: type (x: i32, y: i32);
(named_tuple : NamedTuple) = (x: 1, y: 2); // tuple with named elements
// or without name
(named_tuple : NamedTuple) = (1, 2); // tuple with unnamed elements

// tuple elements are ordered, so the below is not valid:
(named_tuple : NamedTuple) = (y: 2, x: 1); // error: type mismatch

// access fields using "."
// by field name
named_tuple.x; // 1
// or by index
named_tuple.0; // 1

x := 1;
y := 2;
named_tuple := (x: x, y: y);

// destructure
(a, b) := named_tuple; // a: 1, b: 2
// or destructure with name
(y: y, x: x) := named_tuple; // y: 2, x: 1
// or destructurep part of the tuple
(x: x) := named_tuple; // x: 1
// or rename the field
(x: a) := named_tuple; // a: 1

// there might be ambiguity for the function that accepts tuple as its first argument
def some_func(x: (i32, i32)):i32, {
  return x.0 + x.1;
};

// then
some_func(1, 2); // error: expected 1 argument, got 2
// and
some_func (1, 2); // Works! The whitespace is necessary here to avoid ambiguity
                  // 3
// or call it like without whitespace between the function and '('
some_func((1, 2)); // 3

// array is defined using [...] with "," as separator.
arr := [1, 2, 3]; // Array(i32, 3)
// Array: (Type, compt(_): usize)-> Type
// is equivalent to call `array`
arr := array(1, 2, 3);
arr := [1, 2, 3]; // mutable array

// In Mo, type is the first-class citizen,
// meaning that you can assign a type to a variable, or pass it as an argument to a function.
MyI32 :: i32; // type alias
(x : MyI32) = 12; // valid
(y: i32) = x; // valid


MyPoint :: type (i32, i32); // tuple type
(p : MyPoint) = (3, 4); // valid

// In Mo, you can define a struct like below:
Point :: struct(i32, i32);
p := Point 3, 4;

Point :: struct(x: i32, y: i32);
p := Point(x: 3, y: 4);
// destructure:
Point(a, b) := p; // a: 3, b: 4
/// Exact struct name
Point(y: y) := p
/// or use "_"
/// "_" here infered to Point
_(y: y) := p;       // y: 4
/// or use curly brackets "{}"
{ y, x: z } := p; // y: 4
/// { y } gets converted to _(y: y, x: z);

Cm := struct i32;
x := Cm 200;

// In Mo, struct/enum/union are nominal types.
// This means that two types with the same structure are not the same type.
// For example, the following two types are different:
Point1 :: struct(i32, i32);
Point2 :: struct(i32, i32);
Point1 == Point2; // false
p1 := Point1 3, 4;
(p2: Point2) := p1; // error: type mismatch

// Anonymous struct
// "_" here means to be a placeholder for the type that could be inferred later
(p: struct(i32, i32)) := _(3, 4);
(p : Point) := _(x: 3, y: 4);

// another example of using the anonymous tuple here:
(p : ( a: i32, b: boolean )) := ( a: 3, b: true );
(p : ( a: i32, b: boolean )) := ( b: true, a: 3 ); // Error: Type mismatch
// because (b: true, a: 3) on the RHS has type:
// (b: boolean, a: i32) which doesn't really match 
// (a: i32, b: boolean) on the LHS.
// The order of the fields matters!
// In this case, we need to use the struct:
(p: struct(a: i32, b: boolean)) := _(b: true, a: 3); // Valid!
// _(b: true, a: 3) will re-order the fields to match the struct type

// ADT (tagged union)
Color ::
  enum
    Red, // = 0
    Green,
    Blue;
color := Color.Red; // color is of type Color

// each variant can have one type as its argument
Animal ::
  enum
    Dog(String, f64),
    Cat(name: String, weight: f64);
a := Animal.Dog "Buddy", 12.5;
// or use the anonymous variant liternal:
(b : Animal) = .Cat name: "Whiskers", weight: 8.5;

// Or use the anonymous tagged union literal:
(color: (enum Red, Green, Blue)) = .Red;

// union
Result ::
  union 
    int: i64,
    float: f64,
    bool: boolean;

result := Result(int:12);
result.float = 3.14;
// or use the anonymous union liternal:
(result : Result) = _( int: 12 );
(result : (union a: i32, b: f64 )) = _( a: 3 );

// A more complicated example
Shape ::
  enum
    Circle(i32),
    Rectangle(width: i32, height: i32);
s := Shape.Circle 5;
s := Shape.Rectangle width: 10, height: 20;

// type as function parameter
def Option(compt(T): Type): compt Type,
  enum(
    Some(T),
    None
  );

x := Option(i32).Some(12);

// generalized algebraic data types (GADT)
// By default, all variants return the same type.
// You can also specify the return type for each variant
// to make it a GADT
def MyExpr(compt(T): Type): compt Type,
  enum
    IntExpr(i32): MyExpr(i32),
    BoolExpr(boolean): MyExpr(boolean),
    EqExpr(MyExpr(i32), MyExpr(i32)): MyExpr(boolean)
  ;
def my_eval(compt(T): Type, expr: MyExpr(T)): T,
  match expr,
    .IntExpr(i) -> i,
    .BoolExpr(b) -> b,
    .EqExpr(a, b) -> (my_eval(a) == my_eval(b))
;

// higher kinded types
// are types that take other types as parameter
def T1(F: ((compt Type) -> compt Type), A: compt Type): compt Type,
  F(A)
;
// Assume we have the `Maybe` type,
// then we can define `Option` like below
def Option(compt(T): Type): compt(Type), 
  T1(Maybe, T);

// interface
def Id(compt(Self): Type): compt(Type),
  interface
    (Self: Type) = Self,
    id: ((Self)-> Self)
;

def Stringer(compt(Self): Type): compt(Type),
  interface
    (Self: Type) = Self,
    to_string: ((Self)-> String)
;

/// Implement the interface by calling the interface
Id(i32)
  id:
    fn(self)-> self
;

Stringer((any(compt(T): Type), any(compt(U): Type)) <= // => or <= operator is used to define type constraints
  using(Stringer(T), Stringer(U)))
  to_string:
    fn((x, y))->
      "(" + 
      x.to_string() + 
      "," + 
      y.to_string() + 
      ")"
;

/// method call
12.id(); // 12
(3,4).to_string(); // "(3,4)"
// or call from the interface
Id.id(12); // 12
Stringer.to_string((3,4)); // "(3,4)"

// Implement method to a type
Cm :: struct(i32);
impl Cm,
  M : 
    (fn(_(cm): Cm):i32) ->
      cm / 100
;

(x : Cm) = Cm(200);
x.M(); // 2

// `any` can be used to define generics
// e.g. without `any` it also works:
def id(compt(T): Type, x: T):T, {
  return x;
};
// but when you call it, you need to specify the type:
id(i32, 12); // 12
id(boolean, 12); // true
// e.g. with `any`:
def id(x: any(compt(T): Type)): T, {
  return x;
}

// then you can call it without specifying the type:
id(12);   // 12
id(true); // true

// Module
// Module is a block of expressions.
// The very last expression is the return value.

// arith.mo
def add(x: i32, y: i32): i32,
  x + y;
def sub (x: i32, y: i32): i32,
  x - y;
( add: add, sub: sub ) // export add and sub
// is equivalent to
// ( add: add, sub: sub )

// main.mo
{ add, sub } := import("./arith.mo");
add(3, 4); // 7

// Type in Mo can be either Linear or Free
// Linear means it must be used exactly once
// For example, String is a linear type
(s : String) = String.from("Hello");
s.drop(); // drop the string. s is consumed and can't be used anymore.
s2 := s;  // error: s is consumed

// QUESTION: Should we have the RAII?
// RAII (Resource Acquisition Is Initialization)
// Mo automatically insert `drop` function for Linear types that are not used anymore and implement `drop` function.

// Type universe
// - ...
// - Type 2
// - Type 1
// - Free | Linear | Type (or Type(0))
// - symbol | boolean | i32 | f64 | 
//   Union | Intersection | Variant |
//   1 | 2 | 3 | 4 | ...
//    ^ Singleton Type

// Below is an example of define a singleton type
singleton_list : [1, 2, 3];
singleton_list = [1, 2, 3]; // The only legal value of this type

fail_list : [1, 2, 3];
fail_list = [2, 3, 4]; // Type error: expected [1, 2, 3], got [2, 3, 4]

Array7 := Array(7, 3);
(arr: Array7) = [7, 7, 7]; // Correct!

// Interface is not a type here!

// Reference and Pointer
// Mo uses *, *! to for immutable pointer and mutable pointer
// Mo uses &, &! for immutable reference and mutable reference
x := 1;
y := 2;
def swap(a: &!(i32), b: &!(i32)) -> {
  tmp := *(a);
  *(a) = *(b);
  *(b) = tmp;
};
swap(&!(x), &!(y));

// Mutable Value Semantics rules:
// Rule 1.0, let's say fucntion parameter is not local variable, then:
// - 1) Reference can only happen in the call site.
//   - 1.1) It cannot be stored in a variable or data structure.
//   - 1.2) Reference to local variable cannot be returned from the block.
// - 2) Path to a value never appears twice in the function arguments. Path uniqueness, to guarantee One Reference Only (ORO).
//    - If a function returns a reference, then we need to continue checking it
//      eg: f1(f2(ref1), ref2);
//          if f2 returns another reference (this reference will be sure to contain ref1), then we need to check the paths of ref1 and ref2.
//          if f2 doesn't return a reference, then we don't need to check the paths of ref1 and ref2.

x := 12;
x_ref := &!(x); // error: Violate the Rule 1.1

y := {
  x := 12;
  &(x) // error: Violate the Rule 1.2
}

fn(some_ref: &!(i32)) -> {
  x := some_ref;      // Not allowed! Violate the Rule 1.1
  return some_ref;    // Allowed
  // or
  return ( value: some_ref ); // Allowed
}

fn(container: &!(Container), some_ref: &(i32)) -> {
  container.x = some_ref; // Not allowed!
                          // Why? Because it is hard to compare the lifetime of container and some_ref.
                          // container might live longer than some_ref.
}


// You can use the `use` function to use the reference value in a new scope
use &!(x), x_ref -> {
  // `x` is not allowed to be used here
  *(x_ref) = 13;
}

// Iterator
def to_iter_mut(arr: &!(Array(any(compt(T): Type)))): Iter,
  return Iter
    data: arr, // allow to assign reference in this case because it's the last expression
    index: 0
;

arr := ["Hello".to_string(), "world".to_string(), "!".to_string()];
use arr.to_iter_mut(), iter-> {
  // arr is not allowed to be used here
  // iter: Iter(&!(String))
  use iter.next(), v -> {
    // iter is not allowed to be used here
    // v: Option(&!(String))
    // ...
  }
};


// closure
// FnOnce, FnMut, Fn are interfaces
// like the ones in Rust
x := 12;
use &!(x), x-> {
  // x: &!(i32)
  use ((fn(y: i32):i32) => { // => means closure that captures the outside environment.
    *(x) = (*(x) + y);
  // =>
  }), closure -> { // in this case, closure is FnMut
    closure(1); // x: 13
    closure(2); // x: 15
  }
}
// x: 15

// do notation
// allows us to use `<-`, `<=`, `<<=` inside a block
do {
  response <<= fetch("https://api.example.com");
  std.println(response);
  json <<= response.json();
  std.println(json);
}
// is equavalent to
{
  fetch("https://api.example.com", fn(response) =>> {
    std.println(response);
    response.json((json) =>> {
      std.println(json);
    });
  });
}

// malloc
// There is no null pointer in Mo.
// ^Type or ^!(Type) is a pointer type which is Linear.
(ptr : Option(^!(i32))) = malloc(sizeof(i32)); // allocate memory for i32
match ptr,
  .Some(p) -> {
    *(p) = 42; // dereference the pointer
    std.println(*(p)); // print the value
  },
  .None -> std.println("Memory allocation failed");
free(ptr); // free the memory

// cast reference to pointer using `as` function
x := 12;
// ptr := &!(x) `as` *!(i32);

// Control flow
/// cond
cond  (x == 1) -> std.println("x is 1"),
      (x == 2) -> std.println("x is 2"),
      true   -> std.println("x is not 1 or 2");

/// while
def factorial(x: i32): i32, {
  mut(x) := x; // Convert immutable variable to mutable
  mut(result) := 1;
  while x > 1, do: {
    result *= x;
    x -= 1;
  };
  result
};

//// or
def factorial(x: i32): i32, {
  mut(x) := x;
  mut(result) := 1;
  while x > 1,  // condition
        x -= 1, // step
  do: { // body
    result *= x;
  };
  result
}

// Recursion using recur
// recur is used to call the current function recursively
def factorial_rec(x: i32): i32,
  if x <= 1,
    then: 1,
    else: (x * recur(x - 1));  // recur calls factorial_rec recursively

// recur can also be used with named arguments
def fibonacci(n: i32): i32,
  if n <= 1,
    then: n,
    else: (recur(n - 1) + recur(n - 2));

// Tail recursion for better performance
def factorial_tail(x: i32, (acc: i32) = 1): i32,
  if x <= 1,
    then: acc,
    else: recur(x - 1, x * acc);  // tail-recursive call

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
def Result(compt(T): Type, compt(E): Type): compt Type,
  enum
    Ok(T),
    Err(E);

// Define a standard error type
DivisionError ::
  enum
    DivideByZero,
    Overflow;

// Example: Safe division function that returns a Result
def safe_div(a: i32, b: i32): Result(i32, DivisionError),
  if b == 0,
    then: Result(i32, DivisionError).Err(.DivideByZero),
    else: Result(i32, DivisionError).Ok(a / b);

// Pattern matching for error handling
division_result := safe_div(10, 2);
match division_result,
  .Ok(value) -> std.println("Result: " + value.to_string()),
  .Err(.DivideByZero) -> std.println("Error: Cannot divide by zero");

// Macro function definition
// all of its parameters and return type are Expr
// The `unquote` function is only allowed to be used inside the `quote` function.  
// And if the return value is declared with `unquote`, then it's a macro function.  
def if(quote(condition): Expr, 
      quote(then): Expr,
      quote(else): Expr)
    : (unqoute(_): Expr),
  quote(
    cond  unquote(condition) -> unquote(then),
          true -> unquote(else));

if x == 1, then: std.println("x is 1"), else: std.println("x is not 1");
// will be expanded to
cond  (x == 1) -> std.println("x is 1"),
      true   -> std.println("x is not 1");


// AST Representation
Expr ::
  enum(
    Atom(
      enum(
        Symbol(symbol),
        Boolean(boolean),
        I32(i32),
        F64(f64),
        String(String),
        Char(char)
      )),
    FuncCall(
      func: Box(Expr),
      args: List(Expr)
    ));

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

// `quote` function to quote an expression, return Expr
e := quote(add(1, 2));
// or use `:` operator for `quote, and `$` operator for `unquote`
e := :(add(1, 2));
// =>
e := Expr.FuncCall(
  func: Box(.Atom(.Symbol(symbol(add)))),
  args: list(
    Expr.Atom(.I32(1)),
    Expr.Atom(.I32(2))
  ));
e.to_string(); // "add(1, 2)"

// More metaprogramming examples
// `quote` allows creating code templates with holes
// `unquote` evaluates expressions inside quoted expressions
x := quote(5);
y := quote(10);
template := quote(add(unquote(x), unquote(y)));
// =>
template := Expr.FuncCall(
  func: Box(.Atom(.Symbol(symbol(add)))),
  args: list(
    Expr.Atom(.I32(5)),  // x was evaluated to 5
    Expr.Atom(.I32(10))  // y was evaluated to 10
  ));

// `unquote_splicing` splices a list into the surrounding list
x := 2;
(arg_tuple : Expr) = (quote (1, x, 3)); // quote returns a Expr type value representing the AST.
call := quote(sum(unquote_splicing(arg_tuple.args), 4, 5));
// or with ... operator
call := quote(sum(...(unquote(arg_tuple.args)), 4, 5));

// =>
(call : Expr) = .FuncCall
  func: Box(.Atom(.Symbol(symbol(sum)))),
  args: list(
    .Atom(.I32(1)),
    .Atom(.Symbol(symbol(x))),
    .Atom(.I32(3)),
    .Atom(.I32(4)),
    .Atom(.I32(5))
  )

// Generate a sequence of operations
ops := [quote(add), quote(sub), quote(mul)];
generate_math := quote(
  {
    unquote_splicing(
      ops.map(fn(op)->
        quote(
          std.println((unquote(op) <> " result: ") <>
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
(*) := import("stdio.h");

extern "C",
  printf: ((format: *(char), ...(args)) -> i32);

// Compile-time Execution
PI :: 3.14159265358979323846; // PI : const_float;

// A function returning Type or (compt Type) can only be executed at compile time
// Compile-time function execution
def factorial(compt(n): compt_int): compt compt_int,
  if n <= 1, then: 1, else: (n * recur(n - 1));

// This will be computed during compilation
x :: 10; // x : compt_int;
FACTORIAL_10 :: factorial(10);  // FACTORIAL_10 : compt_int

x :: 10; // x : compt_int
(y : i32) = x; // y : i32, this is a cast from compt_int to i32
// This is not allowed
(z : compt_int) = y; // error: cannot cast i32 to compt_int for variable

// Below is another example
def max(compt(T): Type, a: T, b: T): T,
  cond // implicit compile-time evaluate the condition if it's known at the compile-time, and skip the branch not taken.
    (T == boolean) -> a.or b,
    (a > b) -> a,
    true -> b;
max(boolean, false, true); // compiles to:
def max(a: boolean, b: boolean): boolean, {
  {
    return a.or b;
  }
};

arr :: [1, 2, 3]; // compt(arr): Array(i32, 3);
arr(0) = 10; // Not allowed, arr is immutable

(arr: Array(i32, 3)) = [1, 2, 3]; // arr: Array(i32, 3); runtime mutable
arr := [1, 2, 3]; // arr: Array(i32, 3); runtime mutable
arr := [read_input(), 2, 3]; // arr: Array(i32, 3); runtime mutable


// Type-level computation using `compt`
// A function that returns a type is called a type function.  
// The type function requires all its parameters to be `compt`.  
// The type function is pure, which means it will be cached once executed.
// All parameters of Type (Free or Linear) are `compt` by default so you don't need to specify it explicitly.
def Matrix(compt(T): Type, compt(ROWS): usize, compt(COLS): usize): compt Type,
  Array(Array(T, COLS), ROWS);

// Create a 3x3 matrix of integers
(mat : Matrix(i32, 3, 3)) = [
  [1, 2, 3],
  [4, 5, 6],
  [7, 8, 9]
];
