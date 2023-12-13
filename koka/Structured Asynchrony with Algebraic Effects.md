```typescript
effect Exception<T> {
  throw(s: String): <T>
}

// Effect* means zero or more effects
// Effect+ means one or more effects

function toMaybe<T: Type, E: Effect*>(action: ()=> [Exception, ...E] T): [...E] Maybe<T> {
  (handler Exception {
    return(x) {
      Just(x)
    },
    throw(s) {
      Nothing
    }
  })(action)
}

const toMaybeHandler: <T: Type, E: Effect*>(action: ()=> [Exception, ...E] T) => [...E] Maybe<T>
= handler Exception {
  return(x) {
    Just(x)
  },
  throw(s) {
    Nothing
  }
}
```

## 2.2 Resuming Operations

Every operation in a handler brings an identifier `resume` in scope which takes an argument the result of the operation and resumes the program at the invocation of the operation.

```typescript
effect Input {
  read(): String
}

function hello() {
  const name = do read();
  println("Hello " + name);
}

const alwaysThere = handler Input {
  read() {
    resume("there")
  }
}

alwaysThere(hello) // Hello there
```

## 2.3 State

```typescript
effect State<T> {
  get(): T,
  put(x: T): ()
}

function counter<E: Effect*>(): [State<i32>, Console, Divergence, ...E] () {
  const i = do get();
  if (i <= 0) {
    ()
  } else {
    println("Hi")
    do put(i - 1);
    counter()
  }
}
```
