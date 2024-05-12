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
export let show = <T>(x: Array<T>, using {show as showT}: Show<T>)=> string {
  // ...
}

let main = ()=> {
  let x = Array.from([1, 2, 3]);
  show(x);
}
```

What if we want to pass multiple functions

```typescript
export let test = <T>(x: T, y: T, using (+): (x: T, y: T)=> T, using (*): (x: T, y: T)=> T)=> T {
  x + y * x
}

// or
type Arith<T> = {
  (+): (x: T, y: T)=> T,
  (*): (x: T, y: T)=> T
}
export let test = <T>(x: T, y: T, using {+, *}: Arith<T>)=> T {
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
