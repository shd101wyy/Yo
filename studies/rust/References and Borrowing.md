```typescript
function main() {
  const s1 = String.from("hello");
  const len = calculateLength(&s1);
  println(len);
}

function calculateLength<R:Region>(s: Reference<String, R>): i32 {
  return s.len;
}
```

## Mutable References

```typescript
function main() {
  let s = String.from("hello");
  change(&mut s);
}

function change<R:Region>(someString: MutableReference<String, R>) {
  someString.pushStr(", world");
}
```

## Dangling References

```typescript
function main() {:R
  const referenceToNothing = dangle();
}

function dangle<R: Region>(): Reference<String, R> {:R1
  let s = String.from("hello");
  const ref: Reference<String, R1> = s;
  ref // Error (R1 is not a subregion of R)
}
```
