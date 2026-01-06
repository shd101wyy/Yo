> http://learnyouahaskell.com/a-fistful-of-monads > https://stackoverflow.com/questions/28910076/is-it-true-that-order-of-execution-inside-a-do-block-doesnt-depend-on-the-state

`>>=` is `bind`.

## The Monad type class

```typescript
interface Monad<m> {
  (>>=): static <a, b>(m<a>, a => m<b>) => m<b>;
  return: static <a>(a) => m<a>;
}

implement Monad<Maybe> for Maybe {
  static function (>>=)(m, func) {
    switch (m) {
      case Nothing:
        return Nothing;
      case Just(a):
        return func(a);
    }
  }

  static function return(a) {
    return Just(a);
  }
}
```

## do notation

```typescript
Just(3) >>= (x) => {
  return Just(x + 100);
};

function marySue(): Maybe<String> do {
  let x = lift Just(3);
  let y = lift Just("!");
  return Just(x + y);
}

function marySue2(): Maybe<String> do {
  let x = lift Nothing
  let y = lift Just("!")
  putStrLn("Woo hoo") // This will not be executed
  return Just(x + y)
}
```
