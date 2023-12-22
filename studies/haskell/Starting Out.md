> http://learnyouahaskell.com/starting-out

## Ready, set, go!

```typescript
import { assert } from "std/testing";

assert(2 + 15 == 17);
assert(49 * 100 == 4900);
assert(1892 - 1472 == 420);
assert(5 / 2 == 2.5);

assert(50 * 100 - 4999 == 1);
assert(50 * 100 - 4999 == 1);
assert(50 * (100 - 4999) == -244950);

assert(true && false == false);
assert(true && true == true);
assert(false || true == true);
assert(!false == true);
assert(!(true && true) == false);

assert(5 == 5);
assert(1 == 0);
assert(5 != 5);
assert(5 != 4);
assert("hello" == "hello");
```

## Baby's first functions

```typescript
function doubleMe(x: i32): i32 {
  x + x;
}

function doubleUs(x: i32, y: i32): i32 {
  doubleMe(x) + doubleMe(y);
}

function doubleSmallNumber(x: i32): i32 {
  if x > 100 {
    x;
  } else {
    x * 2;
  }
}

function doubleSmallNumber_(x: i32): i32 {
  (if x > 100 { x } else { x * 2 }) + 1;
}
```

## An intro to lists

```typescript
const lostNumbers = LinkedList.from([4, 8, 15, 16, 23, 42]);

assert(LinkedList.from([1, 2, 3, 4]) ++ LinkedList.from([9, 10, 11, 12]) == LinkedList.from([1, 2, 3, 4, 9, 10, 11, 12]));

assert(head(ListList.from([5, 4, 3, 2, 1])) == 5);
assert(tail(ListList.from([5, 4, 3, 2, 1])) == LinkedList.from([4, 3, 2, 1]));
assert(last(ListList.from([5, 4, 3, 2, 1])) == 1);
assert(init(ListList.from([5, 4, 3, 2, 1])) == LinkedList.from([5, 4, 3, 2]));
assert(length(ListList.from([5, 4, 3, 2, 1])) == 5);
assert(4 `elem` ListList.from([3, 4, 5, 6]) == true);
assert(10 `elem` ListList.from([3, 4, 5, 6]) == false);
```
