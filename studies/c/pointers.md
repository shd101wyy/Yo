```typescript
let increment = (x: *<i32>)-> { // This means `x` is not Linear
  *x = *x + 1;
}

let acceptOnlySpecificPointer = (x: *!<i32>)-> { // This means `x` is Linear and we require `true` to be passed in type.
  *x = *x + 1;
  consume(x);
}

extern "C" {
  free: <T: Linear>(x: T)-> ();
}

class Alias<T, O> {
  (@): (value: T)-> O;
}

class Reference<T, O> {
  (&): (value: T)-> O;
}

class Dereference<T, O> {
  (*): (value: T)-> O;
}

let main = ()-> {
  {
    let x: *!<Data> = malloc<Data>();
    let p: *!<Data> = x; // x is consumed
    free(p);
  }
  {
    let x: i32 = 12;
    let y: *<i32> = &x;
    increment(y);
  }
  {
    let x: *!<i32> = malloc();
    increment(@x); // Use `@` to create alias (Free) pointer to `x`.
    free(x);
  }
  {
    let context = {
      x: 1
    };
    let contextRef: *<{x: i32}> = &context;
    let x = (*contextRef.x);
  }
  {
    let x: *!<i32> = malloc<i32>();
    let x2: *<i32> = @x; // create alias (Free) pointer to `x`.
    free(x); // error: cannot free `x` while here is pointer or alias to `x`
  }
}
```

## Dangling pointer

```typescript
let test = ()-> {
  let buffer: u8[100];  // allocate 100 bytes on stack
  let ptr: *<u8[]> = &buffer;    // create a pointer to the buffer
  ptr // dangling pointer
      // Solution: We prevent returning Free pointer created from the current function body.
}

extern longest: <T, R: Region>(x: *<T, R>, y: *<T, R>)-> *<T, R>;

let test = ()-> {
  let x: *!<Data> = malloc();
  let y: *!<Data> = malloc();
  let p: *<Data> = longest(@x, @y);
  free(y); // error: cannot free `y` because `p` might be pointing to `y`.
}
```

## Prevent consuming when there is a pointer or alias to it.

Forcing to pass linear value if we want to modify it.

```typescript
let test = ()-> {
  let arr: *!<i32[1]> = malloc<i32[1]>();
  let ptr: *<i32> = &arr[0];

  realloc<i32[2]>(arr); // error: cannot realloc `arr` because `ptr` is pointing to `arr`.
}
```

## Closure

```typescript
let x = malloc<string>();
let y = 12;
{
  let context = {
    xRef: &x,
    yRef: &y
  }
}
```