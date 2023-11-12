```typescript
interface Show<T> {
  show: (x: T): string;
}

typeof i32 implements Show<i32> {
  show(x: i32): string {
    return x.toString()
  }
}

function show(x: i32) {
  return x.toString()
}

function testShow<T>(x: Show<T>) {
  x.show()
}

// type constructor
type List<T> =
  // data constructor
  | Cons (v: T, next: List<T>)
  | Nil
type List = Red | Black | Blue;
```
