type Coord = {x: i32, y: i32};

let main = ()-> i32 {
  // let coord1 = {x: 1, y: 2}; // error: Anonymous record is not supported now
  let mut coord = Coord {x: 3, y: 4};
  {
    let x = coord.x;
    let mut xRef = @coord.x;
    xRef = xRef + 1;
  }
  {
    let mut coordRef = @coord;
    let x = coordRef.x;
    let mut xRef = @coordRef.x;
    xRef = xRef + 1;
  }
  coord.x + coord.y
}