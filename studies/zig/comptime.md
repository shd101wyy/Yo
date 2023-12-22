Use comptime to implement generic data types.

```typescript
function MyGeneric<T: type>: type {
  if (T == i32) {
    type 1 | 2 | 3
  } else if (T <= type {x: i32, y: i32}) { // T is subtype of {x: i32, y: i32}
    type {x: i32, y: i32}
  } else {
    type error
  }
}

type MyGenericInt = MyGeneric<i32>

```

Or not a function. `#` prefix means `comptime` operation.
All `type parameter`s are `comptime` operations.

```typescript
type MyGeneric<T> =
  #if (T == i32) (1 | 2 | 3)
  #else #if (T <= type {x: 132, y: 132}) {x: i32, y: i32}
  #else #compileError("Invalid type parameter")
```

```typescript
function returnValueBasedOnType<T: type>() {
  #if (T == i32) {
    2
  } #else #if (T == f32) {
    3.2
  }
}

returnValueBasedOnType<i32>() // 2
returnValueBasedOnType<f32>() // 3.2

function testType<T: type>() {
  #if (T == i32) {
    1
  } #else {
    #compileError("Invalid type parameter")
  }
}

function dimension(x: i32, y: i32) {
  x * y
}

const arr: i32[#dimension(2, 3)] = [1, 2, 3, 4, 5, 6]
```
