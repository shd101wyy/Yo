extern "C" {
  consume: <T>(x: T)-> ();
}

let test = ()-> {
  var x = 1;
  var y = 2;
  var context = {
    xRef: &!x,
    yRef: &!y
  }
  {
    let xRef = &!context.xRef;
  }
  {
    let mutContextRef = &!context;
    {
      let xRef = &!mutContextRef.xRef;    
      let xValue = **xRef;
      **xRef = xValue + 2;
    }
    {
      let yRef = &!mutContextRef.yRef;
      let yValue = **yRef;
      **yRef = yValue + 2;
    }
  }
  consume(context);
}