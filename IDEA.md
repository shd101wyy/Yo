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
