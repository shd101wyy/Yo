# CPS transformation for effect handlers

```typescript
const main = ()=> void {
  const wait_for_seconds = control (seconds: u32)=> i32 {
    set_timeout(()=> {
      println("Done");
      return resume(12); // resume here has type: (i32)=> void, where `void` matches the return type of the parent function `main`
    }, seconds * 1000);
  }

  println("Before timeout");
  const result = wait_for_seconds(1);
  println("After timeout");
  println(result); // 12
}
```

compiles to:

```typescript
const main = ()=> void {
  const wait_for_seconds = (seconds: u32, resume: [^](i32)=> void)=> i32 {
    set_timeout(()=> {
      println("Done");
      return resume(12);
    }, seconds * 1000);
  }
  println("Before timeout");
  return wait_for_seconds(1, [=](result: i32)=> {
    println("After timeout");
    println(result);
  });
}
```

Another example:

```typescript
const traverse = (xs: List<i32>, ?yield: control(i: i32)=> boolean)=> void {
  match(xs) {
    case Cons:
      if (yield(xs.head)) {
        return traverse(xs.tail, yield);
      } else {
        return;
      }
    case Nil:
      return;
  }
}

const print_elements = ()=> {
  const ?yield = control(i: i32)=> boolean {
    println("Yielded: " + i);
    return resume(i <= 2);
  }
  print("Before traverse");
  traverse(Cons(1, Cons(2, Cons(3, Nil))));
  print("After traverse");
}
```

compiles to:

```typescript
const traverse = (xs: List<i32>, ?yield: control(i: i32)=> boolean)=> void {
  match(xs) {
    case Cons:
      yield(xs.head, [=](flag: boolean)=> {
        if (flag) {
          return traverse(xs.tail, yield);
        } else {
          return;
        }
      })
    case Nil:
      return;
  }
}

const print_elements = ()=> {
  const ?yield = (i: i32, resume: [^](boolean)=> void)=> void {
    println("Yielded: " + i);
    return resume(i <= 2);
  }
  print("Before traverse");
  traverse(Cons(1, Cons(2, Cons(3, Nil))), yield);
  print("After traverse");
}
```

## Calling multiple effects simultaneously

QUESTION: Should we do that this way? It seems to break the control flow.  

```typescript
const main = ()=> i32 {
  const call = control (seconds: u32, ret_val: i32)=> i32 {
    set_timeout(()=> {
      println("Done 1");
      return resume(ret_val);
    }, seconds * 1000);
  }

  const [result1, result2] = all([call(1, 12), call(2, 13)]);
  const sum = result1 + result2;
  println(sum);
  return sum;
}
```

compiles to

```typescript
const another_main = (resume_main: (i32) => i32) => {
  const call = (seconds: u32, ret_val: i32, resume: (i32) => void) => void {
    set_timeout(() => {
      println("Done 1");
      resume(ret_val);
    }, seconds * 1000);
  };

  // Track results and completion
  const results = [null, null];
  let completed = 0;

  // Continuation after both calls finish
  const proceed = () => {
    const sum = results[0] + results[1];
    println(sum);
    resume_main(sum); // Propagate the result via the top-level continuation
  };

  // First call (index 0)
  call(1, 12, (res) => {
    results[0] = res;
    completed++;
    if (completed === 2) proceed();
  });

  // Second call (index 1)
  call(2, 13, (res) => {
    results[1] = res;
    completed++;
    if (completed === 2) proceed();
  });
};

const main = ()=> {
  var result;
  another_main([{result: &result}](result_)=> {
    *result = result_;
  })
  return result;
}
```
