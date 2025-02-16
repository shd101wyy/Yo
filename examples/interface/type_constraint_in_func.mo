@import { Id } from "./id.mo";
@import { Coord } from "./implement.mo";

let test = <T: Type using Id<T>>(x: T)-> T {
  id(x)
}

/*
let main = ()-> {
  let coord = Coord {x: 1, y: 2};
  let coord2 = test(coord);
}
*/