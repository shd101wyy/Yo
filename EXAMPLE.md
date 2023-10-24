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
