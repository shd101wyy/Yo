# Some Ideas

- Disallow to pass reference into closure struct?
- Allow $ only for immutable data structure?

# CPS transformation for effect handlers

```typescript
const main = ()=> void {
  const wait_for_seconds = control (seconds: u32)=> i32 {
    set_timeout(()=> {
      println("Done");
      return resume(12); // resume here has type: (i32)=> void, where `void` matches the return type of the parent function `main`
    }, seconds * 1000);
  }

  println("Before timeout");
  const result = wait_for_seconds(1);
  println("After timeout");
  println(result); // 12
}
```

compiles to:

```typescript
const main = ()=> void {
  const wait_for_seconds = (seconds: u32, resume: [^](i32)=> void)=> i32 {
    set_timeout(()=> {
      println("Done");
      return resume(12);
    }, seconds * 1000);
  }
  println("Before timeout");
  return wait_for_seconds(1, [=](result: i32)=> {
    println("After timeout");
    println(result);
  });
}
```

Another example:

```typescript
const traverse = (xs: List<i32>, ?yield: control(i: i32)=> boolean)=> void {
  match(xs) {
    case Cons:
      if (yield(xs.head)) {
        return traverse(xs.tail, yield);
      } else {
        return;
      }
    case Nil:
      return;
  }
}

const print_elements = ()=> {
  const ?yield = control(i: i32)=> boolean {
    println("Yielded: " + i);
    return resume(i <= 2);
  }
  print("Before traverse");
  traverse(Cons(1, Cons(2, Cons(3, Nil))));
  print("After traverse");
}
```

compiles to:

```typescript
const traverse = (xs: List<i32>, ?yield: control(i: i32)=> boolean)=> void {
  match(xs) {
    case Cons:
      yield(xs.head, [=](flag: boolean)=> {
        if (flag) {
          return traverse(xs.tail, yield);
        } else {
          return;
        }
      })
    case Nil:
      return;
  }
}

const print_elements = ()=> {
  const ?yield = (i: i32, resume: [^](boolean)=> void)=> void {
    println("Yielded: " + i);
    return resume(i <= 2);
  }
  print("Before traverse");
  traverse(Cons(1, Cons(2, Cons(3, Nil))), yield);
  print("After traverse");
}
```

## Calling multiple effects simultaneously

QUESTION: Should we do that this way? It seems to break the control flow.

```typescript
const main = ()=> i32 {
  const call = control (seconds: u32, ret_val: i32)=> i32 {
    set_timeout(()=> {
      println("Done 1");
      return resume(ret_val);
    }, seconds * 1000);
  }

  const [result1, result2] = all([call(1, 12), call(2, 13)]);
  const sum = result1 + result2;
  println(sum);
  return sum;
}
```

compiles to

```typescript
const another_main = (resume_main: (i32) => i32) => {
  const call = (seconds: u32, ret_val: i32, resume: (i32) => void) => void {
    set_timeout(() => {
      println("Done 1");
      resume(ret_val);
    }, seconds * 1000);
  };

  // Track results and completion
  const results = [null, null];
  let completed = 0;

  // Continuation after both calls finish
  const proceed = () => {
    const sum = results[0] + results[1];
    println(sum);
    resume_main(sum); // Propagate the result via the top-level continuation
  };

  // First call (index 0)
  call(1, 12, (res) => {
    results[0] = res;
    completed++;
    if (completed === 2) proceed();
  });

  // Second call (index 1)
  call(2, 13, (res) => {
    results[1] = res;
    completed++;
    if (completed === 2) proceed();
  });
};

const main = ()=> {
  var result;
  another_main([{result: &result}](result_)=> {
    *result = result_;
  })
  return result;
}
```

## All are functions

```typescript
// If there is no ; in {...}, then it's a record.

{ expr1; expr2; } // compiles to
begin(expr1, expr2, ());

{ expr1; expr2 } // compiles to
begin(expr1, expr2);

// operator + atom is operator
// e.g. &mut *mut
// so (+1) is also an operator
// . is special operator that cannot form operator with atom or other operators, but itself
// : is special operator that cannot form operator with atom.  

mut(x) := 12;
mut (x : i32) := 13;
mut x : i32 := 14;
y := 15;

Option := (T: Type): Type ->
  | .Some (T)
  | .None

x : Option(i32) := .Some(i32);

// Define interface
Id := (T: Type): Interface ->
  interface {
    id: (T) -> T,
  }

// Define implementation
impl Id(i32), {
  id: (x: i32)-> x
}

forall (T : Type <: Id, U: Type <: Id),
  impl Id((U, T)), {
    id: (x: (U, T))-> (x.0.id(), x.1.id())
  }

use_id := (T : Type <: Id, x: T): T -> {
  x.id();
  Id(_).id(x);
}

x := use_id(i32, 12);
y := use_id((i32, i32), (12, 13));

biggest := (a: i32, b: i32, c: i32): i32 -> {
  if a > b && a > c, then:
    a,
  else: if b > c,
    b,
    c
}

FnOnce := (Context: Type, Arguments: Type): Interface ->
  interface ({
    Output: Type,
    call_once: (self: Context, arguments: Arguments)-> this.Output
  })

FnMut := (Context: Free, Arguments: Type <: FnOnce(Context, Arguments)): Interface ->
  interface {
    Output: Type = FnOnce(Context, Arguments).Output,
    call_mut: (self: &mut Context, arguments: Arguments)-> this.Output
  }

Iterator := (Self: Type): Interface ->
  interface ({
    Item: Type,
    next: (self: &mut Self)-> Option(this.Item)
  })

IntoIterator := (Self: Type): Interface -> {
  Item := Type;
  // |: means given
  IntoIterator := (Type <: (Iterator(<@) |: <@ .Item == Item ));
  into_iter := (self: Self)-> IntoIterator;

  interface {
    Item,
    IntoIterator,
    into_iter,
  }
}

use_closure := forall(F <: FnOnce(<@, (i32, i32)) |: <@.Output == i32), (closure: F): i32 ->
  closure.call_once((12, 13))

defmacro my_if, (condition, then, else),
  quasiquote if(unquote(condition), unquote(then), unquote(else))

// <@ means the arg on left
x := 12
y := (x + <@) // 24


// Value constraint
NotZero := i32 |: <@ != 0

// impl a type
MyType := (T: Type)-> { value: T };

forall (T: Type), impl MyType(T), {
  this := MyType(T);
  {
    new: (value: T): this -> { value: value }
  }
}

// GADT

Expr := (T: Type): Type ->
  | .IntExpr (i32,) : Expr(i32)
  | .BoolExpr (boolean,) : Expr(boolean)
  | .EqExpr (Expr(i32), Expr(i32)) : Expr(boolean)

// Higher kinded types
Maybe := (T: Type): Type ->
  | .Just (T,)
  | .Nothing

Either := (A: Type, B: Type): Type ->
  | .Left (A,)
  | .Right (B,)

Functor := (Wrapper: (T: Type)-> Type): Interface ->
  interface {
    map: forall(A: Type, B: Type), (fa: Wrapper(A), f: (a: A)-> B)-> Wrapper(B),
  }

impl Functor(Maybe), {
  map: forall(A: Type, B: Type), (fa: Maybe(A), f: (a: A)-> B): Maybe(B) ->
    match fa,
      .Just(a) -> .Just(f(a)),
      .Nothing -> .Nothing
}

// Comptime
FixedArray := (T: Type, comptime N: u32): Type ->
  | .FixedArray (T[N],)
;
arr := FixedArray(i32, 3).FixedArray([1, 2, 3]);
```
