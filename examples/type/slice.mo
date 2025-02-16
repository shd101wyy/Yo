let main = ()-> i32 {
  let mut arr = [1, 2, 3, 4, 5];
  {
    let mut first = @arr[0];
    first = first + 10;
  }
  {
    let mut ref = @arr;
    let mut first = @ref[0];
    first = first + 10;
  }
  arr[0]
}