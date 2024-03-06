type ReadClosure = {
  x: read i32;
}

let call = (context: ReadClosure)=> {
  let {x} = context;
  x
}

let main = ()=> {
  let x = 1;
  call(ReadClosure { x: read x });
}