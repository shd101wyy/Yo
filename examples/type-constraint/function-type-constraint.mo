@import { Id } from "../classes/id.mo";

extern {
  eGeneridId: <A using Id<A>>(x: A)-> A;
}

export let genericId1 = <X using Id<X>>(x: X)-> X {
  let x = id(x);
  // let y = Id<f64>.id(12.3); // Should give error
  // let z = Id.id(12.0); // Should give error
  x
}

/*
// FIXME: To be supported
export let genericId2 = <X using Id<X>>(x: X)-> X {
  let x = Id<X>.id(x);
  x
}

export let genericId3 = <X using Id<X>>(x: X)-> X {
  let x = Id.id(x);
  x
}
*/