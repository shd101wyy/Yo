Effectful function that calls the effectful operation will be translated to a state machine.

Inside such function, the `const` and `let` assignment will be disallowed.

```typescript
function safeDivide(x: i32, y: i32): {Exception} i32 {
  if (y == 0) {
    _ <- raise("divide by zero");
    y = 1; // This is allowed
    x / y
  } else {
    x / y
  }
}
```

```typescript
effect FileSystem {
  open(String, String): File;
  close(File): ();
  read(&<File>): String;
  write(&<File>, String): ();
}

function writeNewContentToFile(filePath: String, content: String,
  file?: File, fileContent?: String // ?: means the parameter is not initialized, and can be initialized once.
): {Exception, FileSystem} () {
  defer drop(content);

  file <- open(filePath, "w");
  defer {
    _ <- close(file);
  }

  fileContent <- read(file);
  defer drop(fileContent);

  _ <- write(file, content + fileContent);
}
```

```typescript
function crawlWebsite(url: String, html?: String): {Exception, Async} String {
  defer drop(url);
  html <- fetch(url);
  html
}
```

```typescript
effect State<T: Type> {
  get(): T;
  set(x: T): ();
}

function sumdown(sum: i32 = 0, i?: i32): {State<i32>, Divergent} i32 {
  i <- get();
  if i <= 0 {
    sum
  } else {
    _ <- set(i - 1);
    sumdown(sum + i);
  }
}

function state<T: Type>(init: T, action: ()=> {State<T>, Divergent} T): {Divergent} T
given Drop<T> if T is Linear
{
  let st = init;
  with handler State<T> {
    get(k) {
      k.resume(st);
    }
    set(x, k) {
      const o = (st = x);
      if T is Linear {
        drop(o);
        k.resume(());
      } else {
        k.resume(());
      }
    }
  }
  action()  
}

```
