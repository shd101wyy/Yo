effect yield
  ctl yield( i : int ) : bool

fun traverse( xs : list<int> ) : yield () 
  match xs 
    Cons(x,xx) -> if yield(x) then traverse(xx) else ()
    Nil        -> ()

fun print-elems() : console () 
  with ctl yield(i)
    println("yielded " ++ i.show)
    resume(i<=2)
  traverse([1,2,3,4])

effect ask<a>                   // or: effect<a> ctl ask() : a
  ctl ask() : a

fun add-twice() : ask<int> int 
  ask() + ask()

fun ask-once() : console int
  var count := 0
  with ctl ask()
    count := count + 1
    if count <= 1 then resume(42) else 0
  println("before")   
  add-twice()
  println("after") // not executed
  12               // not executed
