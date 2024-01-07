type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: (x: Data)-> ();
}

type Context<R:Region> = {
  xRef: &!<Data, R>,
  yRef: &!<i32, R>
}

// Simulation of mutable closure
let test = ()-> {
  let mut x = malloc();
  let mut y = 12;
  {
    let mut context: Context = {
      xRef: &!x,
      yRef: &!y
    };
    let contextRef = &!context;
    let mut context2 = *contextRef;
    let mut {xRef as a} = *contextRef;
  }
  consume(x);
}