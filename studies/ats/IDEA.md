# ATS: Why Linear Types are the future of Systems Programming

- https://www.reddit.com/r/ProgrammingLanguages/comments/no8ij2/ats_why_linear_types_are_the_future_of_systems/
- https://www.youtube.com/watch?v=zt0OQb1DBko&ab_channel=StrangeLoopConference
- https://ats-lang.github.io/DOCUMENT/INT2PROGINATS/HTML/HTMLTOC/book1.html
- https://github.com/mb64/learnxinyminutes-docs/blob/ats/ATS.html.markdown
- https://bluishcoder.co.nz/tags/ats/index.html

## Refinement Types and Dependent Types

Runtime checks discharge proofs at **compile time**.

```typescript
function id(x: i32 | f32): if x is i32 then f32 else i32 {
  if (x is i32) {
    x as f32
  } else {
    x as i32
  }
}

function makeArray(size: i32): Array<i32>
where size < 10 && size > 0 {
  return new Array<i32>(size)
}

function main() {
  const size = readInt()
  if size < 10 && size > 0 {
    const arr = makeArray(size) // The function is guaranteed to return an array of size between 1 and 9
  } else {
    makeArray(size) // Compiler Error: size is not between 1 and 9
  }
}

```
