effect GiveData<T> {
  giveData: (x: T)-> T;
}

let main = (x: i32) -> i32 {
  let result = try {
    let n = giveData(12);
    n + x
  } with GiveData<i32> {
    giveData: (x: i32)-> i32 {
      x + 1
    }
  };
  result
}