[IN DESIGN]

**Yo language** uses the memory management technique similar to the ARC (Automatic Reference Counting) in the Swift language:

> https://docs.swift.org/swift-book/documentation/the-swift-programming-language/automaticreferencecounting/

and RAII Smart pointers in the C++ language:

> https://en.cppreference.com/w/cpp/language/raii

## Stack vs Heap

All primitive types are stored in the stack, while all reference types are stored in the heap, like `strong reference` in Swift, and `shared_ptr` in C++.

- Value type: Stack
- Reference type: Heap

### Stack

```typescript
let x = 12; // i32, stack
let x = 12.5; // f32 stack
let x = "Hello, world"; // char[] (aka string), stack
let x = [1, 2, 3]; // i32[], stack
```

### Heap

```typescript
type Person = {
  name: string;
};
let x: Person = { name: "John" }; // Person (struct), heap

// Builtin collections
let x: String = String.from("Hello, world"); // String, heap
let x: Array<i32> = Array.from([1, 2, 3]); // Array<i32>, heap
let x: Set<i32> = Set.from([1, 2, 3]); // Set<i32>, heap
let x: Map<string, i32> = Map.from([
  // Map<string, i32>, heap
  ["a", 1],
  ["b", 2],
]);
```

Every thing is by default `shared` pointer.

To use `unique` and `weak` pointers, use `unique` and `weak` keyword.

```typescript
let x: Person = { name: "John" }; // Person (struct), heap
let x: unique Person = { name: "John" }; // Person (struct), heap
let x: weak Person = { name: "John" }; // Person (struct), heap
```

### ARC in Action

```typescript
type Person = {
  name: string;
};

let x: Person = { name: "John" }; // Person (struct), heap
// reference count: 1

{
  let y = x; // Person (struct), heap
  // reference count: 2
  {
    let z = y; // Person (struct), heap
    // reference count: 3
  }

  // z is out of scope
  // reference count: 2
}

// y is out of scope
// reference count: 1
x = { name: "Jane" };

// { name: "John" } now has reference count: 0 and will be deallocated
```

## Circular References

```typescript
type Person = {
  name: string;
  friend: Maybe<Person>;
};

{
  let x: Person = { name: "John", friend: Nothing };
  let y: Person = { name: "Jane", friend: Just(x) };
  x.friend = Just(y);
}
// x and y are out of scope
// but "John" and "Jane" are still in memory
// because they have reference count: 1 to each other
```

Solution: Use `weak` (unowned) to break the circular reference.

```typescript
type Person = {
  name: string;
  friend: Maybe<WeakPtr<Person>>;
};

{
  let x: Person = { name: "John", friend: Nothing };
  {
    let y: Person = { name: "Jane", friend: Just(x) };
    x.friend = Just(WeakPtr(y));
  }
  // y is out of scope
  //
  //   x => "John" <=weak=> "Jane"
  //
}
// x is out of scope
// "John" <=weak=> "Jane"
```
