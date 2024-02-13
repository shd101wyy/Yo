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

```typescript

```

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
