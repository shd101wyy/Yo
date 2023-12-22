> https://koka-lang.github.io/koka/doc/book.html#getstarted

## 2.2 Effect Typing

```typescript
interface Functions {
  square: (i32): [Total] i32; // total: mathematically pure
  divide: (i32, i32): [Exception] i32; // exception: may throw
  turing: (tape): [Diverge] i32; // diverge: may not terminate
  print: (string): [Console] void; // io: may write to console
  random: (): [NDeterministic] i32; // random: non-deterministic
}

// An alias for pure effects: a pure function always returns the same result when called with the same arguments but may not terminate or raise an exception.
type Pure = [Exception, Diverge];

// Stateful functions can manipulate heap h using allocations, reads and writes.
type State<h> = [Read<h>, Write<h>, Alloc<h>];
```

## 2.3 Effect Handlers

```typescript
// Here is an example of an effect definition with one function to yield `i32` values.
effect Yield {
  yield(i: i32): [Yield] boolean;
}

// Once the effect is declared, we can use it for example to yield the elements of a list:

function traverse(xs: List<i32>): [Yield] Unit {
  switch xs {
    case Cons(x, xx):
      if yield(x) {
        traverse(xx)
      } else ()
    case Nil: ()
  }
}
```

The `traverse` function calls `yield` and therefore gets the `Yield` effect in its type, and if we want to use `traverse`, we need to handle the `Yield` effect. This is much like defining an exception handler, except we can receive values (here an `i32`), and we can _resume_ with a result (which determines if we keep traversing):

```typescript
function printElemens: [Console] Unit {
  with Yield {
    yield(i: i32): [Yield, Console] boolean {
      do console.log("Yielded " + i.toString());
      resume i <= 2;
    }
  }
  do traverse([1, 2, 3, 4])
}
```

## 3.2 Effect Types

```typescript
function square1(x: i32): [Total] i32 {
  x * x
}

function square2(x: i32): [Console] i32 {
  console.log("Computing square of " + x.toString());
  x * x
}

function square3(x: i32): [Divergent] i32 {
  x * square3(x)
}

function square4(x: i32): [Exception] i32 {
  throw("Not implemented");
  x * x
}
```

### 3.2.2 Combining effects

```typescript
function combineEffect() {
  const i = Math.random(); // non-deterministic
  throw "Oops"; // exception raising
  combineEffects(); // and non-terminating
}
```

`combineEffect` has the type `[NDeterministic, Exception, Diverge] Unit` => `[Pure, NDeterministic] Unit`.

where:

```typescript
type Pure = [Exception, Diverge];
```

### 3.2.4 Local Mutable Variables

## 3.3 Data Types

### 3.3.1 Structs

```typescript
enum Person { // :Linear because String is linear type.
  Person(
    age: i32;
    name: String;
    realname: String
  );
};

const brian: Person = Person.Person(
  age: 42,
  name: "Brian",
  realname: "Brian McKenna",
);
```

### 3.3.2 Copying

### 3.3.7 Value Types

```typescript
enum ARGB: Free {
  ARGB(
    alpha: u8;
    red: u8;
    green: u8;
    blue: u8;
  );
}
```

## 3.4 Effect Handlers

### 3.4.1 Handling

```typescript
effect Raise {
  raise<T>(msg: String): [Raise] T;
}

function safeDivide(x: i32, y: i32): [Raise] i32 {
  if y == 0 {
    raise("Division by zero")  // No need for 'do' here
  } else {
    x / y
  }
}

function raiseConst(): i32 {
  with Raise {
    raise(msg: String) {
      42;
    }
  }
  8 + do safeDivide(1, 0)  // 'do' used at the call site
}
```

The call `raiseConst()` evaluates to `42` (not `50`).

### 3.4.2 Resuming

The power of effect handlers is not just that we can `yield` to the innermost handler, but that we can also `resume` back to the call site with a result.

```typescript
effect Ask<T> {
  ask: ()=> [Ask<T>] T;
}

function addTwice(): [Ask<i32>] i32 {
  ask() + ask()
}

function askConst(): i32 {
  with Ask {
    ask() {
      resume(21);
    }
  }

  do addTwice() // return 42
}

function askOnce() :i32 {
  let count = 0;
  with Ask {
    ask() {
      count = count + 1;
      if count <= 1 {
        resume(21)
      } else {
        0 // This is like return(0)
      }
    }
  }
  do addTwice() // return 0 from the second ask
}
```

### 3.4.3. Tail-Resumptive Operations

### 3.4.4. Abstracting Handlers

### 3.4.5. Return Operations

**A State Effect**

```typescript
interface State<a> {
  get: () => [State<a>] a;
  set: (x: a) => [State<a>] Unit;
}

function sumDown(sum: i32 = 0): [State<i32>, Divergent] i32 {
  const i = do get();
  if (i <= 0) {
    sum;
  } else {
    do set(i - 1);
    sumDown(sum + i);
  }
}

function state<a>(init: a, action: ()=> [State<a>, Divergent | e] b): [Divergent | e] b {
  let st = init;
  try {
    do action();
  } catch {
    case get: ()=> st;
    case set: (x: a) => {
      st = x;
      unit;
    }
  }
}

state(10, sumdown); // returns 55
```

### 3.4.6. Combining Handlers

### 3.4.11. Initially and Finally
