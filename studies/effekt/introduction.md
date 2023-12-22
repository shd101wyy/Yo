> https://effekt-lang.org/#intro-handlers

## Effect Safety

> https://effekt-lang.org/docs/concepts/effect-safety

Define an effect

```typescript
interface Console {
  log: function(string)=> Unit;
}

function sayHello(): [Console] Unit {
  do log("Hello World");
}
```

```typescript

interface Raise {
  raise: function(string) => Unit;
}

function divide(m: i32, n: i32): i32 [Raise] {
  if (n == 0) {
    do raise("divide by zero");
  } else {
    m / n
  }
}

function typeError(): i32 {
  divide(1, 0) // Unhandled effect: Raise
}

function runDivide(): i32 {
  try {
    do divide(1, 0)
  } catch {
    case Raise: (msg: string) => {
      resume(0)
    }
  }
}
```

```typescript
interface FileSystem {}

function readFile(path: string, encoding: string): [FileSystem] string {
  // ...
}

function writeFile(path: string, content: string, encoding: string): [FileSystem] void {
  // ...
}

type IO = [Exception, IONoException];

function main(): [fs] void {
  fileContent < -fs.readFile("foo.txt", "utf-8");
  fs.writeFile("bar.txt", fileContent, "utf-8");
}
```

## Effect Handlers

> https://effekt-lang.org/docs/concepts/effect-handlers

```typescript
// We define the effect
interface MyException {
  FileNotFound: (path: string) => Unit;
}

// and we use it in some function
function trySomeFile(f: string): [MyException, Console] Unit {
  console.log("Trying to open file " + f);
  do FileNotFound(f);
  console.log("Unreachable");
}

// Handle the exception
function handled(): [Console] Unit {
  try {
    do trySomeFile("foo.txt");
  } catch {
    case FileNotFound: (path: string) => {
      console.log("File not found: " + path);
      resume(())
    }
  }
}

```
