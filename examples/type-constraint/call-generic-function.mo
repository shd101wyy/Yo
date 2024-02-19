import { genericId1 } from "./function-type-constraint.mo";
import { Id } from "../interface/id.mo";

implements Id<i32> {
  id: (x: i32)-> i32 {
    x
  }
}

let main = ()-> {
  let x = 12;

  {
    let y = genericId1<i32>(x);
    // let z = genericId1(x);
  }


  /*
  {
    let y = genericId2<i32>(x);
    let z = genericId2(x);
  }


  {
    let y = genericId3<i32>(x);
    let z = genericId3(x);
  }
  */
}