let main = ()-> i32 {
  var arr = [1, 2, 3, 4, 5];
  {
    var first = write arr[0];
    first = first + 10;
  }
  {
    var ref = write arr;
    var first = write ref[0];
    first = first + 10;
  }
  arr[0]
}