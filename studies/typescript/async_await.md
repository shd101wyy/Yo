```typescript
effect Exception<
  ErrorType,
  ResumeType = ()>
{
  throw: (error: ErrorType)-> Promise<ResumeType>
}

let safeDivide = async (a: i32, b: i32)->
  <Exception<string>> Promise<i32> {
  if (b == 0) {
    await throw("Cannot divide by zero")
  } else {
    a / b
  }
}

let main = async ()-> {
  try {
    let result = await safeDivide(10, 0);
  } with Exception<string, i32, i32> {
    throw: (error: string)-> Promise<i32> {
      abort 16;
    }
  }
}
```

Versus

```typescript
effect Exception<ErrorType, ResumeType> {
  throw: control (error: ErrorType)-> ResumeType;
}

let safeDivide = (a: i32, b: i32)-> <Exception<string, i32>> i32 {
  if (b == 0) {
    throw("Cannot divide by zero");
  } else {
    a / b
  }
}

let main = ()-> {
  let x = try {
    let result = safeDivide(10, 0);
  } with Exception<string, i32> {
    throw: control (error: string)-> i32 {
      abort 16;
    }
  };
  println(x); // 16
}
```

Versus

```typescript
effect Exception<ErrorType, ResumeType=()>
{
  throw: (error: ErrorType)-> Promise<ResumeType>;
}

let safeDivide = async (a: i32, b: i32)-> <Exception<string, i32>> Promise<i32> {
  if (b == 0) {
    let k = throw("Cannot divide by zero");
    print("Triggered exception");
    resume (await k);
  } else {
    resume (a / b);
  }
}

let main = async ()-> {
  let x = try {
    let result = await safeDivide(10, 0);
  } with Exception<string, i32> {
    throw: async (error: string)-> Promise<i32> {
      abort 16;
    }
  };
  println(x); // 16
}
```
