in `Mo` language, everything is `&mut` by default.

```typescript
function change(someString: String) {
  someString.push(", world");
}

{
  let s = String.from("hello");
  change(s);
  console.log(s); // "hello, world"
}
```

```typescript
function main() {
  let x = String.from("Hello"); // x => "Hello"
  let y = x;                    // x => "Hello" 
                                // y -> "Hello"

  x = String.from("World");     // x => "World"
                                // y -> "Hello"
}
```
