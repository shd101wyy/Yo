// let { add } = @import("./add.mo");
let {*} = @import("./add.mo");

let main = ()-> i32 {
  add(3, 4)
}