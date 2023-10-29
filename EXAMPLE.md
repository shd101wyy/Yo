```typescript
interface Eq<T> {
  (==): (x: &T, y: &T) => boolean;
  (/=): (x: &T, y: &T) => boolean;
}

interface Ord<T> extends Eq<T> {
  compare: (x: &T, y: &T) => Ordering;
  (<): (x: &T, y: &T) => boolean;
  (<=): (x: &T, y: &T) => boolean;
  (>): (x: &T, y: &T) => boolean;
  (>=): (x: &T, y: &T) => boolean;
  max: (x: &T, y: &T) => T;
  min: (x: &T, y: &T) => T;
}

interface Drop<T> {
  drop: (&self) => void;
}

interface Show<T> {
  show: (&self) => String;
}

interface Copy<T> {
  copy: (&self) => T;
}

interface Clone<T> {
  clone: (&self) => T;
}

enum Maybe<T> {
  Nothing,
  Just(T),
} deriving (Drop, Show, Copy, Clone);

type string = char[];
```

```typescript
type Person = {
  name: string;
};

function printPerson(x: unique<Person>) {
  print(x.name);
}

let x: unique<Person> = { name: "John" };
let y = x;
print(x.name); // Error! x loses ownership

let x: unique<Person> = { name: "John" };
printPerson(x);
print(x.name); // Error! x loses ownership
```
