type Data: Linear;
extern "C" {
  malloc: ()=> Data;
  consume: (x: Data)=> ();
}

type Context<R:Region> = {
  xRef: &!<Data, R>,
  yRef: &!<i32, R>
}

extern "C" {
  consumeContext: <R:Region>(context: Context<R>)=> ();
}


// Simulation of mutable closure
let test = ()=> {
  let mut x = malloc();
  let mut y = 12;
  {
    let mut context: Context = {
      xRef: &!x,
      yRef: &!y
    };
    {
      let mut contextRef = &!context;
      let {xRef, yRef} = &!contextRef;
    }
    consumeContext(context);
  }
  consume(x);
}