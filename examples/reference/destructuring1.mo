type Holder = {
  x: &i32;
}

let useI32Reference = (ref: &i32)=> {
  // Do nothing
}

let test = (holder: Holder)=> {
  // let {x} = holder; // Error
  useI32Reference(holder.x);
}

let main = ()=> {
  let x = 10;
  test(Holder {x: &x});
}
