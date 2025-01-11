type Coord = {x: i32, y: i32};

let main = ()=> i32 {
  // let coord1 = {x: 1, y: 2}; // error: Anonymous record is not supported now
  var coord = Coord {x: 3, y: 4};
  {
    let x = coord.x;
    var xRef = @coord.x;
    xRef = xRef + 1;
  }
  {
    var coordRef = @coord;
    let x = coordRef.x;
    var xRef = @coordRef.x;
    xRef = xRef + 1;
  }
  coord.x + coord.y
}