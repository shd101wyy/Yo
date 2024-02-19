import { Id } from "../interface/id.mo";

extern {
  eGeneridId: <T given Id<T>>(x: T)-> T;
}

export let genericId1 = <X given Id<X>>(x: X)-> X {
  let x = id(x);
  x
}

export let genericId2 = <X given Id<X>>(x: X)-> X {
  let x = Id<X>.id(x);
  x
}

export let genericId3 = <X given Id<X>>(x: X)-> X {
  let x = Id.id(x);
  x
}