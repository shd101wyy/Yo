```typescript
interface Eq<T> {
  (==): (x: *T, y: *T) => boolean;
  (/=): (x: *T, y: *T) => boolean;
}

interface Ord<T> extends Eq<T> {
  compare: (x: *T, y: *T) => Ordering;
  (<): (x: *T, y: *T) => boolean;
  (<=): (x: *T, y: *T) => boolean;
  (>): (x: *T, y: *T) => boolean;
  (>=): (x: *T, y: *T) => boolean;
  max: (x: *T, y: *T) => T;
  min: (x: *T, y: *T) => T;
}

interface Drop<T> {
  drop: (self: *T) => void;
}

interface Show<T> {
  show: (self: *T) => String;
}

interface Copy<T> {
  copy: (self: *T) => T;
}

interface Clone<T> {
  clone: (self: *T) => T;
}

enum Maybe<T> {
  Nothing,
  Just(T),
} deriving (Drop, Show, Copy, Clone);
```
