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
