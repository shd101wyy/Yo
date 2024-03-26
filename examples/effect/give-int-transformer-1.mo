type GiveIntHandler = {
  giveInt: (x: i32)=> i32;
}

let useGiveInt = (x: i32, giveIntHandler: GiveIntHandler)=> i32 {
  giveIntHandler.giveInt(x)
}

let main = ()=> {
  ((giveIntHandler: GiveIntHandler)=> {
    let x = useGiveInt(giveIntHandler);
    x
  })(GiveIntHandler {
    giveInt: (coro, x: i32)=> {

    }
  })
}