- [Must move types](https://smallcultfollowing.com/babysteps/blog/2023/03/16/must-move-types/)
- [What Vale Taughe Me About Linear Types, Borrowing, and Memory Safety](https://verdagon.dev/blog/linear-types-borrowing)
- [The Pain Of Real Linear Types In Rust](https://faultlore.com/blah/linear-rust/)

```typescript
enum Pointer<T: Type>: Linear {
  PointTo(T),
  Null
}

function allocate<T>(value: T): Pointer<T>;
function deallocate<T>(ptr: Pointer<T>): ();

function load<T: Free>(ptr: Pointer<T>): [Pointer<T>, T];
function store<T: Free>(ptr: Pointer<T>, value: T): Pointer<T>;
```

```typescript
enum File: Linear {
  File(handle: i32);
}

function openFile(path: string): File {
  let ptr: i32 = fopen(as_c_string(path), "r");
  File.File(handle=ptr)
}

function writeFile(file: File, data: string): () {
  let { handle } = file;
  fputs(as_c_string(data), handle);
  File.File(handle=handle)
}
function closeFile(file: File): () {
  let { handle } = file;
  fclose(handle);
}
```
