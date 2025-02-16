let test = ()-> {
  var x = 1;
  {
    let ref = &!x;
    // x = x + 1; // error: already borrowed as reference ^
  }
  {
    x = x + 1;
    let ref = &x;
    // x = x + 2; // error: already borrowed as reference ^
  }
  {
    x = x + 1;
    x = x + 2;
  }
}