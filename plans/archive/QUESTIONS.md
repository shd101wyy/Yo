> **ARCHIVED 2026-09-04 — TS-era scratch note** (a `read`-reference destructuring
> Q&A from the TypeScript-compiler design period, March 2026). Kept for
> archaeology; not a plan.

1. Should we allow desturcuting of the variable that contains references?

```typescript
type Holder = {
  x: read Data
}

let test = (holder: Holder) {
  let {x} = holder; // QUESTION: What is the type of x?
                    // ANSWER: x has type "Data" but not "read Data"
                    //         therefore it will not work here as Data is linear
                    //         and we cannot move it out of the holder
}

let main = ()=> {
  let x = malloc();
  test(Holder {x: read x});
}
```

2. Why 2nd-class reference?

```typescript
type Holder = {
  read x: Data;
};

let main = ()=> {
  let x = malloc();
  let holder = Holder {x: x};
  drop(x);
  println(holder.x); // Access to freed memory
}
```

3. Disallow `read/write` for type that contains `read/write`?

```typescript
type Holder = {
  x: write Data;
}

let useHolder = (holder: read Holder) {
  holder.x = malloc(); // Confusion here if we allow `read Holder`.
}
```

solution, we use the explicit reference:

```typescript
type Holder = {
  x: &<Data>;
}

let useHolder = (holder: &mut<Holder>) {
  *holder.x = malloc();
}
```
