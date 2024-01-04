let factorial = (i: i32)-> i32 {
  if (i <= 1) {
    1
  } else {
    i * factorial(i - 1)
  }
}

let main = ()-> i32 {
  factorial(5)
}