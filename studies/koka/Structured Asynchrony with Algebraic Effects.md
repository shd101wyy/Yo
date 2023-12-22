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
  Err(e: E)
}

effect Async<T, E> {
  async(initiate: (callback: (Result<T, E>) => [IO] ()) => [IO] ()): Result<T, E>
}

function await1<T>(initiate: (callback: (value: T)=> [IO] ())=> [IO] ()): [Async, Exception] T {
  do await((cb)=> {
    initiate((value)=> {
      cb(Ok(value))
    })
  })
}

function await0<T>(initiate: (callback: (value: ())=> [IO] ())=> [IO] ()):
[Async, Exception] () {
  await1((cb)=> {
    initiate(()=> {
      cb(())
    })
  })
}

function wait(seconds: i32): [Async, Exception] () {
  await0((cb)=> {
    setTimeout(cb, seconds * 1000);
    ()
  })
}

function helloWorld(): [Async, Exception, Console] () {
  println("Hello");
  wait(2);
  println("World");
}

function main() {
  with handler Async {
    async(initiate) {
      initiate(resume)
    }
  }
}
```

## My Problem

```typescript
effect GiveInt {
  giveInt(): i32
}

function useGiveInt {
  const giveIntHandler = handler<GiveInt>({
    giveInt(resume) {
      setTimeout(()=> {
        resume(1) // resume the execution of the program
      }, 1000);
    }
    0 // abort the execution of the program
  })

  const program = giveIntHandler(()=> {
    const x = do giveInt();
    const y = do giveInt();
    println(x + y)
  });
  defer program.drop();

  while (true) {
    let completed = false;
    switch program.run() {
      case Abort(x): {
        println("Aborted with " + x)
      }
      case Complete(x): {
        println("Completed with " + x)
        completed = true;
      }
    }
    if (completed) {
      break;
    }
  }
}
```
