## Overview

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

### 2.2 Resuming Operations

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

### 2.3 State

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

## 3. Asynchrous Programming

### 3.1 An Asynchronous Effect

```typescript
enum Result<T, E> {
  Ok(x: T),
  Error(e: E)
}

type Exception<E, A> = effect (error: E) => A;

function untry<T, E>(value: Result<T, E>, ?throw: Exception<E>): T {
  match (value) {
    case Ok(x): x,
    case Error(e): do throw(e)
  }
}

type Async<T, E> = effect (initiate: (callback: (Result<T>)=> ()) => ()) => Result<T, E>

function await1<T, E>(initiate: (callback: (T)=> ())=> (),
                      ?await: Async<T>,
                      ?Exception<E>): T {
  untry(do await((cb)=> {
    initiate((value)=> {
      cb(Ok(value))
    })
  }))
}

function await0<E>(initiate: (callback: ()=> ())=> (),
                ?Async<(), E>,
                ?Exception<E>): () {
  await1((cb)=> {
    initiate(()=> {
      cb(())
    })
  })
}

function wait<E>(seconds: i32, ?Async<(), E>, ?Exception<E>) () {
  await0((cb)=> {
    set_timeout(cb, seconds * 1000);
    ()
  })
}

function hello_world<E>(?Async<()>, ?Exception<E>): () {
  println("Hello");
  wait(2);
  println("World");
}
```

### 3.2. Implementing an asynchronous handler

```typescript
function main() {
  let ?async_handle = effect (initiate) {
    initiate((result)=> {
      resume(result)
    });
  }
  hello_world(?async_handle)
}
```

### 3.3 Interleaving
