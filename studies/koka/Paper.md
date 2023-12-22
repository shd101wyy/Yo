> Paper: https://www.microsoft.com/en-us/research/uploads/prod/2021/06/perceus-pldi21.pdf

## 2.1 Types and Effects

```typescript
enum List<a> {
  Cons(head: a, tail: List<a>),
  Nil
}

function map(xs: List<a>, func: (a) => [e] b): [e] List<b> {
  switch(xs) {
    case Cons(x, xx):
      Cons(func(x), map(xx, func))
    default: Nil
  }
}
```

Idea:

```typescript
function main() {
  const x = List.new(1, 100000);
  console.log(x); // x is not used after this point
  // so console.log takes ownership of x
  // and is responsible for freeing it
}
```

## 2.2 Precise Reference Counting

```typescript
function foo() {
  const xs = List.new(1, 100000); // create large list
  const ys = map(xs, inc); // increment elements
  // `map` function takes ownership of `xs`
  console.log(ys);
}
```
