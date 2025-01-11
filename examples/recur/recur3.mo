let factorial = (i: i32)=> i32 {
  if (i <= 1) {
    1
  } else {
    i * recur(i - 1)
  }
};
