let main = ()=> i32 {
  var arr = [1, 2, 3, 4, 5];
  {
    var first = @arr[0];
    first = first + 10;
  }
  {
    var ref = @arr;
    var first = @ref[0];
    first = first + 10;
  }
  arr[0]
}