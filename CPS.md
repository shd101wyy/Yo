# CPS Transformation

## Transform the following code into CPS

```typescript
effect GiveInt {
  giveInt(x: i32): i32;
}

function main() {
  const giveIntHandler = handler GiveInt {
    giveInt(x) {
      resume(x + 1);
    }
  };
  giveIntHandler(()=> {
    // const { giveInt, return } = GiveInt;
    const x = do giveInt(3);
    const y = do giveInt(4);
    1 + x + y + 2;
  })
}

// Translate to the CPS form:
function main() {
  const giveIntHandler = handler GiveInt {
    giveInt() {
      resume(42);
    }
  };
  giveIntHandler(()=> {
    // const { giveInt, return } = giveIntHandler;
    giveInt(3, (x)=> {
      giveInt(4, (y) => {
        return(1 + x + y + 2);
      })
    })
  })
}
```

Another example

```typescript
effect GiveInt {
  giveInt(x: i32): i32;
}

function main() {
  const giveIntHandler = handler GiveInt {
    giveInt(x) {
      resume(x + 1);
    }
  };
  giveIntHandler(()=> {
    // const { giveInt, return } = GiveInt;
    const x = do giveInt(3);
    const y = x + 1;
    const z = do giveInt(4);
    1 + y + z + 2;
  })
}

// Translate to the CPS form:
function main() {
  const giveIntHandler = handler GiveInt {
    giveInt() {
      resume(42);
    }
  };
  giveIntHandler(()=> {
    // const { giveInt, return } = giveIntHandler;
    giveInt(3, (x)=> {
      const y = x + 1;
      giveInt(4, (z) => {
        return(1 + y + z + 2);
      })
    })
  })
}
```

## With linear types

```typescript
effect GiveInt {
  giveInt(x: i32): i32;
}

function main() {
  const giveIntHandler = handler GiveInt {
    giveInt(x) {
      resume(x + 1);
    }
  };
  giveIntHandler(()=> {
    // const { giveInt, return } = GiveInt;
    const file: File = openFile("foo.txt");
    const x = do giveInt(3);
    const fileContent: string = readFile(file);
    const y = do giveInt(4);
    1 + x + y + 2;
  })
}

// Translate to the CPS form:
function main() {
  const giveIntHandler = handler GiveInt {
    giveInt() {
      resume(42);
    }
  };
  giveIntHandler(()=> {
    // const { giveInt, return } = giveIntHandler;
    const file: File = openFile("foo.txt");
    giveInt(3, (x)=> {
      const fileContent: string = readFile(file);
      giveInt(4, (y) => {
        return(1 + x + y + 2);
      })
      // drop(fileContent);
    })
    // drop(file);
  })
}
```

```

## Reference

- [By example: Continuation-passing style in JavaScript](https://matt.might.net/articles/by-example-continuation-passing-style/)
- [How to compile with continuations](https://matt.might.net/articles/cps-conversion/)

```

```

```
