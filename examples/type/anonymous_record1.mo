type Coord = {x: i32, y: i32};

let main = ()-> i32 {
  // let coord1 = {x: 1, y: 2}; // error: Anonymous record is not supported now
  var coord = Coord {x: 3, y: 4};
  {
    let x = coord.x;
    var xRef = write coord.x;
    xRef = xRef + 1;
  }
  {
    var coordRef = write coord;
    let x = coordRef.x;
    var xRef = write coordRef.x;
    xRef = xRef + 1;
  }
  0
}