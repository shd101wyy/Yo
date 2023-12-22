```typescript
// Read-only reference
enum Reference<T: Linear, R: Region>: Free {
  // Reference(value: T)
}

// Read-write reference
enum MutableReference<T: Linear, R: Region>: Free {
  // MutableReference(value: T)
}


enum ByteBuffer: Linear {
  ByteBuffer(
    size: i32,
    capacity: i32,
    buffer: Pointer<u8>
  )
}
function length<R: Region>(buf: Reference<ByteBuffer, R>): i32 {
  buf.size
}
function main() {
  const buf: ByteBuffer = allocateBuffer(10, 'a');
  const len: i32 = length(buf);
  deallocateBuffer(buf);
}
```

## Dereferencing

Dereferencing takes a reference and returns the value it points to. You can’t dereference a reference to a linear value, because, since references are free types, you could do this repeatedly, and make multiple copies of the linear value. But you can dereference free values.

## The General Case

```typescript
function main() {
  const buf: ByteBuffer = allocateBuffer(10, 'a');

  // A new region
  {:R1 // R1 is a Region
    const buf2: Reference<ByteBuffer, R1> = buf;
    const len: i32 = length(buf2);
  }
}
```

## Rust Borrow Checker Rules

You can have any number of immutable references to a value. **OR** You can have one mutable reference to a value.

My summary:

- When the value is borrowed, we cannot mutate it.

```typescript
function main() {
  let x = 1;
  {:R
    let y: Reference<i32, R> = x;
    x = 2; // Error: x is borrowed in R
  }
  x = 3; // OK
}
```

```typescript
function main() {
  let x = 1;
  {:R
    let y: MutableReference<i32, R> = x;
    x = 2; // Error: x is borrowed in R
    y = 3; // OK
  }
  x = 4; // OK
}
```

- Cannot borrow as mutable more than once.

```typescript
function main() {
  let x = 1;
  {:R
    let y: MutableReference<i32, R> = x;
    let z: MutableReference<i32, R> = x; // Error: x is already borrowed as mutable in R
  }
}
```

- Cannot borrow as immutable and mutable at the same time.

```typescript

function main() {
  let x = 1;
  {:R
    let y: Reference<i32, R> = x;
    let z: MutableReference<i32, R> = x; // Error: x is already borrowed as immutable in R
  }
}
```

```typescript
function main() {
  const myString = String.from("hello");
  const array = Array.from([myString, String.from("world")]);

  {
    console.log(myString, array); // Error: `myString` is consumed in `array`
  }

  {:R
    const s: Reference<String, R> = array[0];
    console.log(s, myString); // Error: `myString` is consumed in `array`
    console.log(s, array); // OK
  }
}
```

```typescript
function main() {
  const x = String.from("hello");
  const some = Some(x);
  console.log(x, some); // Error: `x` is consumed in `some`

  {:R
    const s: Reference<String, R> = some;
    console.log(s, x); // Error: `x` is consumed in `some`
    console.log(s, some); // OK
  }
}
```

## Record field access

```typescript
enum Person: Linear {
  Person(name: String, age: i32)
}

function main() {
  const p = Person(String.from("Alice"), 30);
  p.name; // Has type `Reference<String, R>` for some region `R` as it's a Linear value.
  p.age; // Has type `i32` as it's a Free value.
}
```
