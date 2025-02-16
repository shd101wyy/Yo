
let longerOf = (a: @String, b: @String)-> @String {
  if (a.count() > b.count()) {
    a
  } else {
    b
  }
}

let emphasize = (z: @String, strength: i32 = 1)-> {
  z.append(repeatElement("!", count=strength));
}

let main = ()-> {
  let mut x = "Hi";
  let mut y = "World";
  emphasize(longerOf(x, y));
  println(x);
  println(y);
}

