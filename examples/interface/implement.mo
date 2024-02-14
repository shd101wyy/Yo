import { Id, id } from "./id.mo"

export type Coord = {
  x: i32;
  y: i32;
}

implements Id<Coord> {
  id: (x: Coord)-> Coord {
    x
  }
}

let test = ()-> {
  let coord: Coord = Coord { x: 1, y: 2 };
  let coord2 = id(coord);
  // let coord3 = Id<Coord>.id(coord);
}