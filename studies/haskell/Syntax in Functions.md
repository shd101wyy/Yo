> http://learnyouahaskell.com/syntax-in-functions

## Pattern matching

```typescript
function lucky(x: i32): String {
  switch (x) {
    case 7: String.from("Lucky number 7");
    case 13: String.from("Lucky number 13");
    default: String.from("Not a lucky number");
  }
}

function factorial(a: i32): Integral {
  switch (a) {
    case 0: 1;
    default: a * factorial(a - 1);
  }
}

function charName(a: char): String {
  switch (a) {
    case 'a': String.from("Albert");
    case 'b': String.from("Broseph");
    case 'c': String.from("Cecil");
    default: String.from("No name");
  }
}

function addVectors(a: (i32, i32), b: (i32, i32)): (i32, i32) {
  switch ((a, b)) {
    case ((x1, y1), (x2, y2)): (x1 + x2, y1 + y2);
    default: (0, 0);
  }
}

function first<a, b, c>((x, y, z): (a, b, c)): a {
  return x;
}

function second<a, b, c>((x, y, z): (a, b, c)): b {
  return y;
}

function third<a, b, c>((x, y, z): (a, b, c)): c {
  return z;
}

function head<a>(arr: &a[]): a {
  switch(arr) {
    case [x, ...xs]: x;
    default: panic("Empty list");
  }
}

function length<a, b: i32>(arr: &a[]): b {
  switch (arr) {
    case []: 0;
    case [x, ...xs]: 1 + length(xs);
  }
}
```

## Guards, guards!

```typescript
function bmiTell(x: RealFloat): String {
  switch (x) {
    case x if x <= 18.5: String.from("You're underweight, you emo, you!");
    case x if x <= 25.0: String.from("You're supposedly normal. Pffft, I bet you're ugly!");
    case x if x <= 30.0: String.from("You're fat! Lose some weight, fatty!");
    default: String.from("You're a whale, congratulations!");
  }
}

function bmiTell<a:RealFloat>(weight: a, height: a): String {
  let bmi = weight / height ^ 2;
  switch (bmi) {
    case x if x <= 18.5: String.from("You're underweight, you emo, you!");
    case x if x <= 25.0: String.from("You're supposedly normal. Pffft, I bet you're ugly!");
    case x if x <= 30.0: String.from("You're fat! Lose some weight, fatty!");
    default: String.from("You're a whale, congratulations!");
  }
}

function max<a: Ord>(x: a, y: a): a {
  if (x > y) {
    x
  } else {
    y
  }
}

function myCompare<a: Ord>(x: a, y: a): Ordering {
  if (x == y) {
    EQ
  } else if (x > y) {
    GT
  } else {
    LT
  }
}
```
