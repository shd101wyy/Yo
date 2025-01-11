## Generics

Type function and function

```typescript

```

```typescript
const Color = type @"Red" | @"Green" | @"Blue";
const IntList = type @Nil {} | @Cons {head: i32, tail: IntList};


function List(t::type)::type {
  return type
    | Nil
    | Cons(head, tail)
}
```

## Dependent type

## Typeclass

```typescript
interface ShowSummary {
  function showSummary(self: this): string;
}

interface Show extends ShowSummary {
  function show(self: this): string;
}

function show(self: Show): string {
  return self.showSummary() + " " + self.show();
}

function showSummary(self: ShowSummary): string {
  return "Summary: " + self.showSummary();
}

type Color = @"Red" | @"Green" | @"Blue";

instance Show for Color {
  function show(self: Color): string {
    return self;
  }
}

instance ShowSummary for Color {
  function showSummary(self: Color): string {
    return "Color: " + self;
  }
}
```

```typescript
export interface Show<T> {
  show(x: T): string;
}

implement Show<i32> {
  show(x: i32): string {
    return x.toString();
  }
}

function test(x: T) {
  with Show<T>
  x.show();
}

// or

function test(x: T) {
  Show<T>.show(x);
}
```

## Function parameter of type that contains reference

It will be treated as "mutable".

## Use type for type synonym, enum (ADT), interface

IDEA: Let's still use `type` for type synonym, and `enum` for tagged union.

```typescript
// union
type number = i32 | f32;

// type name has to be lowercase
// enum (ADT)
type color = Red | Green | Blue;
type point = {x: i32, y: i32};
type shape =
  | Point point
  | Circle {center: point, radius: i32}
  | Rectangle {topLeft: point, bottomRight: point};

// type synonym
type myInt = i32;
type myColor =
  | color // type synonym for color
  | Yellow; // new variant

```

## Implicit parameters

Match by both name and type.

```typescript
let add = (x: i32, using y: i32)=> i32 {
  x + y
}

let main = ()=> {
  {
    add(3); // error: missing implicit parameter y
  }
  {
    let y = 4;
    add(3); // ok, 7
  }
  {
    let z = 4;
    add(3); // error: missing implicit parameter y
  }
  {
    add(3, 4); // ok, 7
  }
  {
    let y = 5;
    add(3); // ok, 8
  }
}
```

## Interface?

We can remove the `interface`.

```typescript
type Show<T> = {
  show: (x: T)=> string;
}

// problem: how to implement Show for Show<List<T>> where T also implements Show
export let show: (x: i32)=> string {
  // ...
}
export let show: (x: f32)=> string {
  // ...
}
export let { show }: Show<i64> = {
  show: (x: i64)=> x.toString()
}
export let show = <T>(x: Array<T>, using (show as showT):Show<T>)=> string {
  // ...
}

let showValue = <T>(x: T, using (show as showT):Show<T>)=> string {
  showT(x)
}

let main = ()=> {
  showValue(1);
  showValue(1.2);
  showValue(Array.from([1, 2, 3]));
}
```

^^^ Compiles above code to C

```c
char* show_i32(int x) {
  // ...
}
char* show_f32(float x) {
  // ...
}
char* show_i32_array(int* x, /*int len,*/ char* (*showT)(int)) {
  // ...
}
char* show_value_i32(int x, char* (*showT)(int)) {
  return showT(x);
}
char* show_value_f32(float x, char* (*showT)(float)) {
  return showT(x);
}
char* show_value_i32_array(int* x, /*int len,*/ char* (*show_i32_array)(int*, char* (*showT)(int))) {
  return show_i32_array(x, showT);
}

int main() {
  show_value_i32(1, show_i32);
  show_value_f32(1.2, show_f32);
  show_value_i32_array((int[]){1, 2, 3}, show_i32_array);
}
```

What if we want to pass multiple functions

```typescript
export let test = <T>(x: T, y: T,
  using (+): (x: T, y: T)=> T,
        (*): (x: T, y: T)=> T )=> T {
  x + y * x
}

// or
type Arith<T> = {
  (+): (x: T, y: T)=> T,
  (*): (x: T, y: T)=> T
}
export let test = <T>(x: T, y: T, using (+, *): Arith<T>)=> T {
  x + y * x
}

let (+) = (x: i32, y: i32)=> x + y;
let (*) = (x: i32, y: i32)=> x * y;

let main = ()=> {
  test(3, 4); // 15
}
```

```typescript
let test = (x: i32, using id: (x: i32)=> i32) {
  id(x)
}

let id = (x: i32)=> x;
let main = ()=> {
  test(3); // 3

  let id = (x: i32)=> x + 1;
  test(3); // 4
}
```

The code above compiles to C

```c
int test(int x, int (*id)(int)) {
  return id(x);
}

int id(int x) {
  return x;
}

int id_2(int x) {
  return x + 1;
}

int main() {
  test(3, id);
  test(3, id_2);
}
```

## Effect

```typescript
type Raise = <ResumeType, AbortType>(error: string, resume: (value: ResumeType)=> (), return Return<i32>);
let safeDivide = <AbortType>(x: i32, y: i32, using raise: Raise<i32, AbortType>, return Return<i32>) {
  if (y == 0) {
    raise("Divide by zero", (value: i32)=> {
      return(value);
    })
  } else {
    x / y
  }
}
let main = ()=> {
  let raise = (error: string, resume: (value: i32)=> ())=> {
    42 // abort
  };
  let raise = (error: string, resume: (value: i32)=> ())=> {
    resume(42) // resume
  };
  8 + safeDivide(1, 0)
}
```

```typescript
enum KState<ResumeType, AbortType> {
  Resume(value: ResumeType),
  Abort(value: AbortType)
}
type K<ResumeType, AbortType=anytype> = [=](state: KState)=> ();
let Raise<ResumeType> = (error: string, k: K<ResumeType>)-> ();

let safeDivide = (x: i32, y: i32, k: K<i32>, using raise: Raise<i32>)-> {
  if (y == 0) {
    raise("Divide by zero", (state)=> {
      k(state)
    })
  } else {
    k(Resume(x / y))
  }
}

let safeDivide = (x: i32, y: i32, k: K<i32>, using raise: Raise<i32>)-> {
  if (y == 0) {
    let state = do raise("Divide by zero");
    k(state)
  } else {
    k(Resume(x / y))
  }
}

let raise = (error: string, k: K<i32>)-> {
  k(42, Resume)
}
let raise = (error: string, k: K<i32, i32>)-> {
  k(15, Abort)
}

let main = (k: K<i32>)-> {
  safeDivide(1, 0, (state)=> {
    if (state is Resume) {
      print("Will not print if it's aborted");
      k(state)
    } else { // Abort
      k(state)
    }
  });
}

let main = (k: K<i32>)-> {
  let state = do safeDivide(1, 0);
  if (state is Abort) {
    k(state)
  } else {
    print("Will not print if it's aborted");
    k(state)
  }
}

let main = (k: K<i32>)-> {
  try {
    let value = do safeDivide(1, 0);
    print("Will not print if it's aborted");
    k(Resume(value))
  } onabort(value) {
    k(Abort(value))
  }
}
```
