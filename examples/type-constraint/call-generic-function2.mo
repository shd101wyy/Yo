import { genericId1 } from "./function-type-constraint.mo";
import { Id } from "../interface/id.mo";

implements Id<i32> {
  id: (x: i32)=> i32 {
    x
  }
}

let main = ()=> {
  let x = genericId1<i32>(12);
}