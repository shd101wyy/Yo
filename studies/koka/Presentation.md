> https://www.youtube.com/watch?v=6OFhD_mHtKA&ab_channel=ACMSIGPLAN
> Paper: https://www.microsoft.com/en-us/research/uploads/prod/2021/06/perceus-pldi21.pdf

<!-- @import "[TOC]" {cmd="toc" depthFrom=1 depthTo=6 orderedList=false} -->

<!-- code_chunk_output -->

- [Trailing lambdas](#trailing-lambdas)
- [With Syntax](#with-syntax)
  - [Finally](#finally)

<!-- /code_chunk_output -->

## Trailing lambdas

```typescript
for(i, 10, (i)=> {
  console.log(i)
})

// becomes

for(i, 10) (i)=> {
  console.log(i)
}
```

A function without arguments can be written directly betweeen braces

```typescript
repeat(10) {
  console.log(i)
}

// ==

repeat(10, ()=> {
  console.log(i)
})
```

`while` uses multiple trailing lambdas:

```typescript
function print11() {
  let i = 10;
  while { i >= 10 } {
    console.log(i)
    i = i - 1
  }
}
```

## With Syntax

- Often we need nested lambdas, leading to increased indentation

```typescript
function twice(f) {
  f();
  f();
}
function testTwice() {
  twice {
    twice {
      console.log("hello")
    }
  }
}
```

using `with`, it becomes:

```typescript
function twice(f) {
  f();
  f();
}
function testTwice() {
  with twice
  with twice
  console.log("hello")
}
```

### Finally

- Minimal-but-general: finally is a regular function

```typescript
function testFinally() {
  with finally { console.log("exiting..") }
  console.log("entering..")
  throw("oops") + 42
}

// ==

function testFinally() {
  finally(
    ()=> { console.log("exiting..") },
    ()=> {
      console.log("entering..")
      throw("oops") + 42
    }
  )
}
```

## Effect Types

- Every function has an input type, a return type, and an effect type.
- Effect typing fits naturally with HM type inference using polymorphic row-types.
- Algebraic effects and handlers fit naturally for user defined effects.
