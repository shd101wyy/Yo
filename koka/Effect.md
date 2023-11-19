```typescript
effect Yield {
  yield(i: i32): boolean
}

function traverse(xs: List<i32>): [Yield] () {
  switch(xs) {
    case Nil: ()
    case Cons(x, xs): if yield(x) traverse(xs) else ()
  }
}

function printElems(): [Console] () {
  try {
    traverse([1, 2, 3, 4])
  } catch {
    case Yield: {
      yield(i) {
        console.log(i);
        return true;
      }
    }
  }
}

// or

function printElems(): [Console] () {
  with Yield {
    yield(i) {
      console.log(i);
      return true;
    }
  }
  traverse([1, 2, 3, 4])
}

```
