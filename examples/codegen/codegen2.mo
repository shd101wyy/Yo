let main = ()-> i32 {
  let x = 1;
  let y = (if (x > 0) {
    1
  } else {
    2
  });

  if (true) {
    x
  } else {
    y
  }
}