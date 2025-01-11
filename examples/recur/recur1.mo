let factorial = (i: i32, acc: i32 = 1)=> i32 {
  if (i <= 1) {
    acc
  } else {
    recur(i - 1, i * acc)
  }
};

let main = ()=> i32 {
  ((i: i32, acc: i32 = 1)=> i32 {
    if (i <= 1) {
      acc
    } else {
      recur(i - 1, i * acc)
    }
  })(10)
}