# Removals

## `with` statement
- `with` statement such as

```typescript
function test() {
  with finally {
    // do something in the end
  }
  // some other code
}
```

Reason: It doesn't work well with linear types, especially the closure.  
Besides, I decided to switch the effect handler from using `with` to using `try`/`with`.  

## function signature **must** specify the return type

For easier type inference.
If not specified, the return type will be unit `()`.  

## `if` and `match` need to have braces

We used to support the following syntax:

```
if x > y {
  // ...
}
```

but this caused problem because the parser cannot distinguish between brace elision and a block. For example, it might consider `y {...}` as a function call `y(()=> { ... })`.   

So we decided to remove this feature. And we require the following syntax:

```
if (x > y) {
  // ...
}
```

## Lisp like syntax

It's so hard to read and write.  

## Immutable reference used to be Linear, but now Free
For supporting closure.  

## ~~Let's remove the Union and Intersection types~~  
Only the tagged union (sum type) is supported.  

## Let's require file extension for import and export
Because we might support importing `.c` file in the future.  

## Don't use setjmp/longjmp to implement effect handler
Because it does produce the overhead.  
Let take [protothread](https://dunkels.com/adam/pt/) or [async.h](https://github.com/naasking/async.h) as references.  

## Remove `read` and `write` permission?

It might not work in generics, like:

```typescript
interface Test<T> {
  modify: (value: write T)=> T;
}

implements Test<read i32> {
  // What should be the signature of `modify`???
}
```

Also, the implicit dereference is confusing sometimes.  

```typescript
let readInt = (x: i32)=> {

}

let readIntRef = (read x: i32)=> {
  readInt(x); // This causes confusion  
}
```

## Remove the RAII?

I don't remember why I stopped doing this 🤔