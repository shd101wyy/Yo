effect give-int
  ctl give-int(i: int): int

fun use-effects(): <give-int> int
  give-int(2) + give-int(4)

fun handle-effect-once(): <console> int
  with handler
    ctl give-int(i: int)
      println("handle give-int resume once")
      println(i: int)
      resume(i)
  use-effects()

/*
handle give-int resume once
2
handle give-int resume once
4
6
*/

fun handle-effect-separately(): <console> int
  with handler
    ctl give-int(i: int)
      println("handle give-int resume separately")
      println(i: int)
      resume(i)
      println("after resume")
      println(i: int)
      resume(i)
  use-effects()

/*
handle give-int resume separately
2
handle give-int resume separately
4
handle give-int resume separately
4
6
*/