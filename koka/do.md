`return` is called in the innermost scope.

## One resume

```typescript
effect GiveInt {
  giveInt(i: i32): i32
}

function handle(): i32 {
  with handler GiveInt {
    return(x) {
      x + 10
    },
    giveInt(i, resume) {
      resume(i)
    }
  }
  const x = do giveInt(1);
  const y = do giveInt(2);
  x + y
}

// is equivalent to
function handle(): i32 {
  (({giveInt, return}: GiveInt)=> {
    giveInt(1, (x) => {
      giveInt(2, (y) => {
        return(x + y)
      })
    })
  })(handler GiveInt {
    return(x) {
      x + 10
    },
    giveInt(i, resume) {
      resume(i)
    }
  })
}
```

## Multiple resumes

```typescript
effect GiveInt {
  giveInt(i: i32): i32
}

function handle(): i32 {
  with handler GiveInt {
    return(x) {
      x + 10
    },
    giveInt(i, resume) {
      resume(i) + resume(i)
    }
  }
  do giveInt(1)
}
// return 22

// is equavalent to
function handle(): i32 {
  (({giveInt, return}: GiveInt)=> {
    giveInt(1, (x) => {
      return(x)
    })
  })(handler GiveInt {
    return(x) {
      x + 10
    },
    giveInt(i, resume) {
      resume(i) + resume(i)
    }
  })
}
```

## Call separately

```typescript
effect GiveInt {
  giveInt(i: i32): i32
}

function handle(): i32 {
  with handler GiveInt {
    return(x) {
      x + 10
    },
    giveInt(i, resume) {
      resume(i)
    }
  }
  const x = do giveInt(1);
  println(x);
  const y = do giveInt(2);
  println(y);
  y
}

/*

1
2
12

*/

// is equivalent to

function handle(): i32 {
  (({giveInt, return}: GiveInt)=> {
    giveInt(1, (x) => {
      println(x);
      giveInt(2, (y) => {
        println(y);
        return(y)
      })
    })
  })(handler GiveInt {
    return(x) {
      x + 10
    },
    giveInt(i, resume) {
      resume(i)
    }
  })
}
```

## Handler not called

```typescript
effect GiveInt {
  giveInt(i: i32): i32
}

function handle(): Option<i32> {
  with handler GiveInt {
    return(x) {
      Some(x + 1)
    },
    giveInt(i, resume) {
      resume(i); // resume: (i: i32) => Option<i32>
    }
  }
  12
}

// return Some(13)

// is equivalent to

function handle(): Option<i32> {
  useEffect(handler GiveInt {
    return(x) {
      Some(x + 1)
    },
    giveInt(i, resume) {
      resume(i); // resume: (i: i32) => Option<i32>
    }
  }, ({return, giveInt})=> {
    return(12)
  })
}
```

## Handler return

```typescript
effect GiveInt {
  giveInt(i: i32): i32
}

function handle(): Option<i32> {
  with handler GiveInt {
    return(x) {
      println("- return");
      Some(x + 1)
    },
    giveInt(i, resume) {
      // resume(i); // resume: (i: i32) => Option<i32>
      Some(i)
    }
  }
  do giveInt(12) + do giveInt(14)
}

// return Some(12)

// is equivalent to

function handle(): Option<i32> {
  (({return, giveInt}: GiveInt)=> {
    giveInt(12, (x) => {
      giveInt(14, (y) => {
        return(x + y)
      })
    })
  })(handler GiveInt {
    return(x) {
      Some(x + 1)
    },
    giveInt(i, resume) {
      resume(i); // resume: (i: i32) => Option<i32>
    }
  })
}
```

## Handler resume

```typescript
effect GiveInt {
  giveInt(i: i32): i32
}

function handle(): Option<i32> {
  with handler GiveInt {
    return(x) {
      println("- return");
      Some(x + 1)
    },
    giveInt(i, resume) {
      resume(i); // resume: (i: i32) => Option<i32>
    }
  }
  do giveInt(12) + do giveInt(14)
}

// return Some(27)

// is equivalent to

function handle(): Option<i32> {
  (({return, giveInt}: GiveInt)=> {
    giveInt(12, (x) => {
      giveInt(14, (y) => {
        return(x + y)
      })
    })
  })(handler GiveInt {
    return(x) {
      Some(x + 1)
    },
    giveInt(i, resume) {
      resume(i); // resume: (i: i32) => Option<i32>
    }
  })
}
```
