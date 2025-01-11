import { genericId1 } from "./function-type-constraint.mo";

let main = ()=> {
  let x = genericId1<()>(());
}