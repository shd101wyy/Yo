effect give-int
  ctl give-int(i: int): int

fun show(x: maybe<int>)
  match x
    Just(v) -> println(v: int)
    Nothing -> println("Nothing")

fun handle-effect() // : <console> maybe<int>
  with handler
    return(x)
      x
    ctl give-int(i)
      resume(i)
      // Just(i)
  give-int(3) + give-int(4)