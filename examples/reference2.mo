let test = ()-> {
  let mut x = 1;
  let ref1 = &!x;
  let ref2 = ref1;
  // let ref3 = ref1; // error: ref1 is already consumed ^
}