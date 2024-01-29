let main = (x: data, y: data)-> {
  x.friend = read y;
  y.friend = !{ read x };
}