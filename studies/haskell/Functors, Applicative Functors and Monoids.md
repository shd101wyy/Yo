> http://learnyouahaskell.com/functors-applicative-functors-and-monoids > https://www.adit.io/posts/2013-04-17-functors,_applicatives,_and_monads_in_pictures.html

- Functor: apply a function to a wrapped value.
- Applicatives: apply a wrapped function to a wrapped value.
- Monad: apply a function that returns a wrapped value to a wrapped value.

![Screenshot from 2023-10-17 22-29-03](https://i.imgur.com/QrJae59.png)

## Functors redux

```typescript
interface Functor<f> {
  fmap: <a, b>(func: ((a)=> b)) => f<b>;
}

implement Functor<IO> for ()=>IO<()> {
  function fmap(func) {
    do {
      let a = await this();
      return func(a);
    }
  }
}

async function main(): IO<()> {
  let line = await (getLine.fmap(reverseWords))();
  putStrLn(line);
}
```

## Applicative functors

```typescript
interface <f: Functor> Applicative<f> {
  pure: static (x: This) => f<This>;
  (<*>): (f<(This)=> b>) => f<b>;
}

implement Applicative<Maybe> for Maybe {
  static function pure(x) {
    return Just(x);
  }

  function (<*>)(func) {
    switch (this) {
      case Nothing:
        return Nothing;
      case Just(a):
        return a.fmap(func);
    }
  }
}

```
