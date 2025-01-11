let test = ()=> {
  var x = 1;
  {
    let x = 2;
  }
  x = x + 1;
}
