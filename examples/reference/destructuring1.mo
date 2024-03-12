type Holder = {
  x: read i32;
}

let test = (holder: Holder)=> {
  let {x} = holder;
}

let main = ()=> {
  let x = 10;
  test(Holder {x: read x});
}