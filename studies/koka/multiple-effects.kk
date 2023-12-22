
effect give-int
  ctl give-int(i: int): int

effect give-bool
  ctl give-bool(b: bool): bool

fun show(x: maybe<int>)
  match x
    Just(v) -> println(v: int)
    Nothing -> println("Nothing")

fun handle-multi-effects(): <console> maybe<int>
  with handler // outer handler will `return` after
    return(i)
      // println("return give-int")
      // Just(i + 3)
      i
    ctl give-int(i) 
      println("resume give-int")
      resume(i)
  with handler // inner handler will `return` first
    return(b)
      println("return give-bool")
      println(b:int)
      Just(b + 4)
    ctl give-bool(b) 
      println("resume give-bool")
      resume(b)
  give-int(2)
