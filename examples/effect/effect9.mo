interface GiveInt {
  giveInt: ()=> [GiveInt] i32;
}

let test = (func: ()=> [GiveInt] i32)=> [GiveInt]() // without <GiveInt> ahead () it will give error.  
{
  func();
}