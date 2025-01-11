let main = ()=> {
  let context = {
    x: 1
  };
  let contextRef = &context;
  let xRef = contextRef.x;
  let xRef2 = &context.x;
  {
    let {x} = context;
    let y = x;
  }
  /*
  {
    let {x as xRef3} = contextRef;
  }
  */
}