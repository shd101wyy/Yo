```typescript
effect GiveInt {
  giveInt(x: i32): i32;
}

function main() {
  const giveIntHandler = handler GiveInt {
    return(x) {
      x
    },
    giveInt(x, resume) {
      1 + resume(x)
    }
  };
  giveIntHandler(()=> {
    // const { giveInt, return } = GiveInt;
    const x = do giveInt(3);
    const y = do giveInt(4);
    1 + x + y + 2;
  })
}
```

## handler call translates to state machine example

1. Initialize the frame for the handler call

   The frame should be large enough to store all the local variables of the handler call.

1. Break down each effectful operation call into a state machine

   Each `do` operation should have a jump label.  

   Push effectful operation call to stack.  

```typescript
// effectful operation call stack: []
1:
    const x = do giveInt(3); // <=
2:
    const y = do giveInt(4);
3:
    1 + x + y + 2;
```

```typescript
// effectful operation call stack: [giveInt(3): 1 + (?)]
1:
    const x = 3;
2:
    const y = do giveInt(4); // <=
3:
    1 + x + y + 2;
```

```typescript
// effectful operation call stack: [giveInt(3): 1 + (?), giveInt(4): 1 + (?)]
1:
    const x = 3;
2:
    const y = 4;
3:
    1 + x + y + 2; // <= call `return` defined in handler
```

1. Call `return` function defined in handlers

1. Pop from effectful operation call stack

```typescript
// effectful operation call stack: [giveInt(3): 1 + (?)]
// giveInt(4) is popped
1 + (1 + x + y + 2);
```

```typescript
// effectful operation call stack: []
// giveInt(3) is popped
1 + (1 + (1 + x + y + 2));
```

1. Free the frame for the handler call in the end.  

## `resume`
The resume function checks:

1. One-shot delimited continuation so it can only be called once.  