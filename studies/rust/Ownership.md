> https://www.baseflow.com/blogs/rust-ownership-model-and-the-borrow-checker#:~:text=One%20of%20the%20key%20features,free%20bugs%2C%20and%20data%20races.

## The stack

```typescript
function main() {
  let var_a: i8 = 6;
  let var_b: f32 = 7.0;
  let var_c: boolean = true;

  // all on heap
}
```

## The heap

```typescript
function main() {
  let var_a: i8 = 6; // stack
  let var_b: String = String.from("Hello, owrld"); // heap
}
```

```typescript
function main() {
  let var_b: String = String.from("Hello");
  someOtherFunction(var_b);
  print(var_b);
}

function someOtherFunction(var_b: String) {
  // var_b is a reference to the same String
  print(var_b);
}
```

```typescript
type Person = {
  age: u8;
  name: String;
};

function main() {
  let x: Person = {
    age: 6,
    name: String.from("John"),
  };
  let y: String = x.name;
  someOtherFunction(x);
}

function someOtherFunction(x: Person) {
  x.age = 30;
  x.name = String.from("Jane");
}
```

Everything is `&mut` by default like in Rust.
