> http://learnyouahaskell.com/types-and-typeclasses

## Believe the type

```typescript
assert(typeof "a" == "char");
assert(typeof "Hello!" == "char[]");
assert(typeof 1 == "i32");
assert(typeof (1) == "i32");
assert(typeof (1,) == "(i32)");
assert(typeof (1, 2) == "(i32, i32)");
```

## Type variables

```typescript
assert(typeof head == "<a>(LinkedList<a>) => a");
assert(typeof fst == "<a, b>((a, b)) => a");
```

## Typeclasses 101

```typescript
// Eq here is a typeclass
assert(typeof (==) == "<a: Eq>(a, a) => boolean");

// Ord here is a typeclass
assert(typeof (>) == "<a: Ord>(a, a) => boolean");

assert("Abrakadabra" < "Zebra");
assert("Abrakadabra" `compare` "Zebra" == LT);

// show
assert(show(3) == "3");
assert(show(5.334) == "5.334");
assert(show(true) == "true");

// read
assert(read("true") == true);
assert(read("false") == false);

assert(read("5") as i32 == 5);
assert(read("5") as f32 == 5.0);
```
