let main = ()=> {
  var x = 1;
  ([write](y: i32)=> {
    x = x + y;
  }).call(3);
  x // x should be 4
}
