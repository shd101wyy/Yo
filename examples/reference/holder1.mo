type Holder = {
  x: i32;
}

let useI32Reference = (ref: &i32)-> {
  // Do nothing
}

let useHolderReference = (ref: @Holder)-> {
  let x = ref.x;
  useI32Reference(&x);
  useI32Reference(&ref.x);

  ref.x = 12;
  // *@ref.x = 13;
}

let test = ()-> {
  var holder = Holder {
    x: 1
  };
  useHolderReference(@holder);
}