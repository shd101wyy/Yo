type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: (x: Data[])-> ();
}


let test = (linearArray: Data[], freeArray: i32[])-> {
  let x = freeArray[0]; // Access Free value is allowed.  
  {
    let y = &linearArray[0]; // Access Linear value is not allowed, but reference is allowed.  
  }
  consume(linearArray)
}