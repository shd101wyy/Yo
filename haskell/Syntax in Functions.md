http://learnyouahaskell.com/syntax-in-functions

```typescript
function lucky(a: Integral): String {
  match(a) {
    case 7: String.from("Lucky number 7");
    case 13: String.from("Lucky number 13");
    default: String.from("Not a lucky number");
  }
}

function factorial(a: Integral): Integral {
  match(a) {
    case 0: 1;
    default: a * factorial(a - 1);
  }
}

function charName(a: Char): String {
  match(a) {
    case 'a': String.from("Albert");
    case 'b': String.from("Broseph");
    case 'c': String.from("Cecil");
    default: String.from("No name");
  }
}

function addVectors(a: (i32, i32), b: (i32, i32)): (i32, i32) {
  match((a, b)) {
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

function head<a>(arr: [a]): a {
  match(arr) {
    case [x, ...xs]: x;
    default: panic("Empty list");
  }
}
```
