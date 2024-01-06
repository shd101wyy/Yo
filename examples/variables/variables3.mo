let test = (flag: boolean)->  i32 {
  let mut x = 1;
  if (flag) {
    let y = x;
    y
  } else {
    1
  }
}