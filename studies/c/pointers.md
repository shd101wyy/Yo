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

## Thinking

```typescript
type Array<T> = {
  length: i32,
  capacity: i32,
  data: *linear<T[]>
}

let new = <T>()-> *linear<Array<T>> {
  let x: *linear<Array<T>> = malloc<Array<T>>(@sizeOf<Array<T>>());
  *x.length = 0;
  *x.capacity = 1;
  *x.data = malloc<T[]>(@sizeOf<T>() * 1);
  x
}

extern "C" {
  realloc: <T>(x: *linear<T>, newCap: usize)-> *linear<T>;
}


let push = <T>(out x: *linear<Array<T>>, value: T)-> {
  let len = x.len;
  let cap = x.cap;
  if (len == cap) {
    let newCap = cap * 2;
    out (x.data as data) {
      *data = realloc<T[]>(data, newCap);
    }
    *x.data[len] = value;
    *x.len = len + 1;
  } else {
    *x.data[len] = value;
    *x.len = len + 1;
  }
}


let x: *linear<Array<i32>> = Array<i32>.from([]);
x.push(1);
x.push(2);

let p: *mut<Array<i32>> = &mut x;
```

## Mode

- read: immutable reference
- write: mutable reference
- owned: linear type
- consumed

```typescript
let swap = (x: write i32, y: write i32)-> {
  let tmp = x;
  x = y;
  y = tmp;
}

let main = ()-> {
  var x: i32 = 1;
  var y: i32 = 2;

  swap(write x, write y);
}
```

## Lifetime Index

What value needs to specify lifetime index in function parameters?

- `read` value
- `write` value

```typescript
let set = (
  holder: write {x: read string} @2, // &mut<{x: &<string>}, @2>
  value: read string @1
)-> {
  holder.x = value; // LHS lifetime index must be bigger than RHS lifetime index.
}

let test = ()-> {
  let x: string = "Hello"; // @1
  let holder: object = {}; // @2
  {
    let holderRef: write {x: read string} @holder = write holder; // @2 because `holder` is at @2
    let xRef: read string @x = read x;  // @1 because `x` is at @1
    set(holderRef, xRef);          // calling the function makes both `holderRef` and `xRef`
                                 // to be at @2, which is the maximum lifetime index.
  }
  // Sow now:
  // holderRef: write {x: read string} @2
  // xRef: read string @2

  x = realloc(x, 100); // error: cannot realloc `x` because `xRef` is at @2,
                       // and holder, which is the owner of @2, is not consumed.

  consume(x); // error: cannot consume `x` because `xRef` is at @2,
              // and holder, which is the owner of @2, is not consumed.

  consume(holder);
  consume(x);
}
```

The lifetime index order matters because it determines the order of consuming.

```typescript
let test = ()-> {
  let x: string = "Hello"; // @1
  let y: string = "World"; // @2

  consume(x); // error: cannot consume `x` because `y` is at @2, which is greater than @1.

  consume(y);
  consume(x);
}
```

strict?

```typescript
let add = (x: i32 @1, y: i32 @2)-> i32 {
  x + y
}

let main = ()-> {
  let x = 1; // @1
  let y = 2; // @2
  add(x /* @3 */, y /* @4 */); // allowed
  add(y /* @5 */, x /* @6 */); // allowed
  let z = 3; // @7
}
```

longest string

```typescript
let longest = (x: read string @1, y: read string @2)
-> read string @2 { // here we return the shortest lifetime index @1
  if (x.length > y.length) {
    x
  } else {
    y
  }
}

let main = ()-> {
  let x: string = "Hello"; // @1
  let y: string = "World"; // @2
  let z: read string @x = longest(read x /*@1*/, read y /*@2*/); // @2
  let z2: string = longest(read y /*@2*/ , read x /*@1*/); // error, because `y` is at @2, which is greater than @1.
}
```

### Destructuring

```typescript
let test = ()-> {
  let data: Data = malloc(); // @1
  let wrapper = {            // @2
    data: data
  };

  let x = wrapper.data; // error: cannot access Linear value `data`.

  let x: write Data @wrapper = write wrapper.data; // allowed
  let y: Data = (x = malloc()); // allowed, and `x` is update with new `malloc` value.
  drop(y);

  drop(wrapper);

}
```

### Array

```typescript
let test = ()-> {
  let arr = Array.from([1, 2, 3]);
  let first: read i32 @arr = read arr[0];
  let result = first + 1;
}
```


### JavaScript function

```typescript
let test = ()-> {
  let arr = Array.new();
  (write arr).push(1);
  (write arr).push(2);
  let length = (read arr).length();

  // Because we are using the uniform calling syntax, we can do this:
  arr.push(1); // We try `arr` first, then `read arr`, then `write arr`
  arr.push(2);
  let length = arr.length();
}
```

### Lifetime index in type

```typescript
type MyData = {
  x: read string @1,
  y: write string @2
}
```

### Multiple references

```typescript
type Foo = {
  x: read i32,
  y: read i32
}

let getXOrZeroRef = (x: read i32 @1, y: read i32 @2)-> read i32 /*@2 // It can only be the shortest lifetime in parameters
*/ {
  if (x > y) {
    x
  } else {
    y
  }
}

let main = ()-> {
  let x = 1; // @1
  {
    let y = 2; // @2

    let readX = read x; // @1
    let readY = read y; // @2

    let f: Foo = {x: readX, y: readY}; // @3
    let v = getXOrZeroRef(f.x, f.y); // @3
  }
}
```

### Test

```typescript
let set = (
  holder: write {x: read string} @2, // &mut<{x: &<string>}, @2>
  value: read string @1
)-> {
  holder.x = value; // LHS lifetime index must be bigger than RHS lifetime index.
}

let test = ()-> {
  let x: string = "Hello"; // @1
  let holder: object = {}; // @2
  {
    let holderRef: write {x: read string} @holder = write holder; // @2 because `holder` is at @2
    let xRef: read string @x = read x;  // @1 because `x` is at @1
    set(holderRef, xRef);          // calling the function makes both `holderRef` and `xRef`
                                 // to be at @2, which is the maximum lifetime index.
  }
}
```

