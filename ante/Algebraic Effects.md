```typescript
effect GiveInt {
  giveInt(x: String): i32;
}

function doMath(x: i32): i32 with GiveInt {
  const a = giveInt("zero");
  const b = giveInt("foo");
  x + a + b
}

function handleGiveInt() {
  with handler GiveInt {
    giveInt(x) {
      if x === "zero" {
        0
      } else {
        123
      }
    }
  }
  do doMath(3) // 126
}
```

## Matching on the Returned Value

```typescript
function handleGiveInt() {
  with handler GiveInt {
    giveInt(_) {
      1 + resume(0)
    }
    return(x) { 0 }
  }
  do doMath(5); // 2
}

// 1 + (a = 0; b = giveInt("foo"); return 5 + a + b)
// 1 + (1 + (a = 0; b = 0; return 5 + 0 + 0))
// 1 + (1 + (return 5))
// 1 + (1 + (0)) = 2
```

## Resume multiple times

```typescript
effect Choice {
  choice(): boolean;
}

function xor(): boolean with Choice {
  const p = choice();
  const q = choice();
  if p then !q else q
}

function choiceAll(action: ()=> boolean with Choice): List<boolean> {
  with handler Choice {
    return(x): {
      [x]
    },
    choice() {
      resume(false) ++ resume(true)
    }
  }
  do action()
}

choiceAll(xor) // [false, true, true, false]

// (a = choice(); b = choice(); if a then !b else b)
// (a = false; b = choice(); if false then !b else b)
// (a = false; b = false; if false then !b else b)
// (a = false; b = false; b)
// (a = false; false)
// (false)
// (a = false; b = choice(); if false then !b else b)
// (a = false; b = true; if false then !b else b)
// (a = false; b = true; b)
// (a = false; true)
// (true)
// (a = choice(); b = choice(); if a then !b else b)
// (a = true; b = choice(); if true then !b else b)
// (a = true; b = false; if true then !b else b)
// (a = true; b = false; !b)
// (a = true; true)
// (true)
// (a = choice(); b = choice(); if a then !b else b)
// (a = true; b = choice(); if true then !b else b)
// (a = true; b = true; if true then !b else b)
// (a = true; b = true; !b)
// (a = true; false)
// (false)
// [false, true, true, false]
```

## Resume Zero Times

```typescript
function handleGiveInt(defaultValue: i32) {
  with handler GiveInt {
    giveInt(_) {
      defaultValue
    }
  }
  do doMath(7) + do doMath(8);
}

handleGiveInt(42); // 42
```

## My Idea

The `do` keyword.

```typescript
function handleGiveInt(defaultValue: i32) {
  with handler GiveInt {
    giveInt(_) {
      defaultValue
    }
  }
  do doMath(7) + do doMath(8);
}

// Expanded to:

function handleGiveInt(defaultValue: i32) {
  with handler GiveInt {
    giveInt(_) {
      defaultValue
    }
  }
  const x = doMath(7);
  if x is Resume(v) {
    const y = doMath(8);
    if y is Resume(w) {
      v + w
    } else if y is Return(v) {
      v // Stop the execution
    }
  } else if x is Return(v) {
    v // Stop the execution
  }
}

```
