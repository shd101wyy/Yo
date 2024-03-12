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
  x: read Data;
};

let main = ()=> {
  let x = malloc();
  let holder = Holder {x: read x};
  drop(x);
  println(holder.x); // Access to freed memory
}
```