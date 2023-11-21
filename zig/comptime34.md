## 34.1 Introducing the Compile-Time Concept 

### Compile-Time Parameters §

```typescript
function max<T>(x: T, y: T): {
  if x > y {
    x
  } else {
    y
  }
}

function gimmeTheBiggerFloat(x: f32, y: f32) f32 {
  max<f32>(x, y)
}

function gimmeTheBiggerInteger(x: i32, y: i32) i32 {
  max<i32>(x, y)
}
```

```typescript
function max<T>(a: T, b: T): T {
  #if (T == boolean) {
    return a || b;
  } else if (a > b) {
    return a;
  } else {
    return b;
  }
}

// This means the function like
// max<boolean>(x: boolean, y: boolean): boolean
// is defined as below:
function max<boolean>(a: boolean, b: boolean): boolean {
  return a || b;
}
```

### 34.1.2 Compile-Time Variables  

```typescript
type CmdFn = {
  name: char[];
  func: (x: i32)=> i32
}

function one(value: i32): i32 { value + 1 }
function two(value: i32): i32 { value + 2 }
function three(value: i32): i32 { value + 3 }
const cmdFns: CndFn[] = [
  {name: "one", func: one},
  {name: "two", func: two},
  {name: "three", func: three},
]

function performFn(#prefixChar: u8, startValue: i32): i32 {
  let result: i32 = startValue;
  // let #i = 0; // Compile-time variable
  cmdFns.#forEach((cmdFn)=> {
    if (cmdFn.name[0] == prefixChar) {
      result = cmdFn.func(result);
    }
  }) 
}

```
## 34.2 Generic Data Structures

All type parameters are `comptime` operations.

## 34.3 Case Study: print in Zig

```

```