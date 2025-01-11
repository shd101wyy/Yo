import { Id } from "./id.mo"; 
// then import the type Coord.
import { Coord } from "./coord.mo";  

let main = ()=> {
  let c1 = Coord {
    x: 1,
    y: 2
  };
  let c2 = Id<Coord>.id(c1);
}