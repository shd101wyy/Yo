type Data: Linear;
extern "C" {
  malloc: ()=> Data;
}

type Holder = {
  x: i32;
  data: Data;
};

let useHolderDataReference = (ref: &Data)=> {
  // Do nothing
}

let useHolderReference = (ref: @Holder)=> {
  let x = ref.x;
  let old = (ref.data = malloc());
  consume(old);
  useHolderDataReference(&ref.data);
}

let test = ()=> {
  var holder = Holder {
    x: 12,
    data: malloc()
  };
  useHolderReference(@holder);
  consume(holder);
}