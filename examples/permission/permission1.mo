// The references in **Mo** are second-class citizens. 
// They cannot be stored in `Enum`, `Record`, `Slice`.  
// We also disable to return a reference to a local value from a function.

/*
type CustomType = {
  x: read i32; 
}

enum CustomEnum {
  Some(value: read i32)
}

type CustomSlice = (read i32)[];
*/

type Data: Linear;
extern "C" {
  malloc: ()=> Data;
}

type Holder {
  data: read Data;
}

let useHolder = (holder: Holder)=> {
  let x = holder.data; // This should give error
}

let main = ()=> {
  let data = malloc();
  let holder = Holder { data: data }; // `data` shouldn't get consumed here.
  useHolder(holder);  
  consume(data);
}
