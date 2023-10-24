http://learnyouahaskell.com/making-our-own-types-and-typeclasses

## Algebraic data types intro

```typescript
// Type constructor
enum MyBoolean {
  False, // Value constructor
  True // Value constructor
}

export { MyBoolean(..) };
```

```typescript
enum Shape {
  Circle(f32, f32, f32),
  Rectangle(f32, f32, f32, f32)
}
deriving (Show)

function surface(shape: Shape): f32 {
  switch (shape) {
    case Circle(_, _, r): 3.14 * r ^ 2;
    case Rectangle(x1, y1, x2, y2): (Math.abs(x2 - x1) * Math.abs(y2 - y1));
  }
}

assert(surface(Shape.Circle(10, 20, 10)) === 314.15927);
assert(surface(Shape.Rectangle(0, 0, 100, 100)) === 10000);
```

```typescript
enum Point {
  Point(f32, f32)
}
deriving (Show)

enum Shape {
  Circle(Point, f32),
  Rectangle(Point, Point)
}
deriving (Show)

function surface(shape: Shape): f32 {
  switch(shape) {
    case Circle(_, r): 3.14 * r ^ 2;
    case Rectangle(Point(x1, y1), Point(x2, y2)): (Math.abs(x2 - x1) * Math.abs(y2 - y1));
  }
}

export {
  Point(..),
  Shape(..)
}
```

## Record syntax

```typescript
// Without value constructors
type Person = {
  firstName: String;
  lastName: String;
  age: i32;
  height: f32;
  phoneNumber: String;
  flavor: String;
};
deriving(Show);

const guy: Person = {
  firstName: String.from("John"),
  lastName: String.from("Doe"),
  age: 30,
  height: 1.8,
  phoneNumber: String.from("1234567890"),
  flavor: String.from("Vanilla"),
};

assert(guy.firstName === String.from("John"));
```

## Type parameters

```typescript
enum Maybe<a> {
  Nothing,
  Just(a)
}
deriving (Show)

assert(typeof(Just(1)) === "Maybe<i32>");
assert(typeof(Just("Haha")) === "Maybe<String>");
```

## Type synonyms

```typescript
type string = char[];
type PhoneNumber = String;
type Name = String;
type PhoneBook = (Name, PhoneNumber)[];

function inPhoneBook(name: Name, phoneNumber: PhoneNumber, phoneBook: PhoneBook): boolean {
  for (let i = 0; i < phoneBook.length(); i++) {
    const (n, p) = phoneBook[i];
    if (n === name && p === phoneNumber) {
      return true;
    }
  }
  return false;
}

enum Either<a, b> {
  Left(a),
  Right(b)
}
deriving (Eq, Ord, Read, Show)

assert(typeof(Left(1)) === "Either<i32, ?>");
assert(typeof(Right(1)) === "Either<?, i32>");
assert(typeof(Left("Haha")) === "Either<string, ?>");
```

## Recursive data structures

```typescript
enum List<a> {
  Empty,
  Cons(a, List<a>)
}
deriving (Show, Read, Eq, Ord)
```

## Typeclass 102

```typescript
interface Eq<a> {
  (==): (&x: a, &y: a) => boolean;
  (!=): (&x: a, &y: a) => boolean;
}

enum TrafficLight {
  Red,
  Yellow,
  Green
}

implement Eq<TrafficLight> for TrafficLight {
  function (==)(x: &TrafficLight, y: &TrafficLight): boolean {
    switch((x, y)) {
      case (Red, Red): true;
      case (Green, Green): true;
      case (Yellow, Yellow): true;
      default: false;
    }
  }

  function (!=)(x: &TrafficLight, y: &TrafficLight): boolean {
    !(x == y);
  }
}

implement Show<TrafficLight> for TrafficLight {
  function show(&self): String {
    switch(self) {
      case Red: String.from("Red light");
      case Yellow: String.from("Yellow light");
      case Green: String.from("Green light");
    }
  }
}

assert(Red == Red);
assert(Red /= Green);
assert(show(Red) === String.from("Red light"));

implement Eq<m> for Maybe<m> {
  function (==)(x: Maybe<m>, y: Maybe<m>): boolean {
    switch((x, y)) {
      case (Nothing, Nothing): true;
      case (Just(x), Just(y)): x == y;
      default: false;
    }
  }
}

interface Num<a: Eq> {
  // ...
}

implement<m: Eq> Eq<Maybe<m>> {
  function (==)(x: Maybe<m>, y: Maybe<m>): boolean {
    switch((x, y)) {
      case (Nothing, Nothing): true;
      case (Just(x), Just(y)): x == y;
      default: false;
    }
  },

  function (!=)(x: Maybe<m>, y: Maybe<m>): boolean {
    !(x == y);
  }
}
```

## A yes-no typeclass

```typescript
interface YesNo {
  yesno: (&self) => boolean;
}

implement YesNo for Int {
  function yesno(&self): boolean {
    self != 0;
  }
}

implement YesNo for Maybe<T> {
  function yesno(&self): boolean {
    switch self {
      case Nothing: false;
      default: true;
    }
  }
}

assert((0).yesno() === false);
assert((1).yesno() === true);
assert(Nothing.yesno() === false);
assert(Just(1).yesno() === true);
```

## The Functor typeclass

```typescript
interface Functor<f> {
  fmap: <a, b>(&self, func: (a)=> b) => f<b>;
}

implement Function<Maybe<T>> for Maybe<T> {
  function fmap(&self, func: (T)=> T): Maybe<T> {
    switch(self) {
      case Nothing: Nothing;
      case Just(x): Just(func(x));
    }
  }
}

assert(Just(1).fmap((x) => x + 1) === Just(2));
```
