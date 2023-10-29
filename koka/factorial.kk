fun factorial(n: int): <div> int {
  var i := 1;
  var m := n;
  while {m > 0} {
    i := i * m;
    m := m - 1;
  }
  i
}


fun anotherFactorial(n: int) {
  var i := 1
  for (1,n) fn(x){
    i := i * x
  }
  i
}