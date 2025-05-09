// Module instance is a singleton
// Which means that the module instance is created once and reused
// and we cannot create multiple instances of the same module

def ID:
  (@(T): Type)-> @(Type),
  type module
    (This: Type) = T,
    id:
      (x: This)-> This
;

def Point:
  (@(T): Type)-> @(Type),
  struct
    x: T,
    y: T
;

(forall(@(T): Type) . 
  ID(Point(T)))
  id:
    fn(p)-> Point(T)(p.x, p.y)
;

p :: Point(i32)(3, 4);
ID(Point(i32)).id(p);


/*
derive Point, fn(T)-> {
  This :: Point(T);
  Id(This)
    This: This,
    id:
      fn(p)-> This(p.x, p.y)
};
Point(i32);     // Automatically implements ID(i32) for Point(i32)
Point(boolean); // Automatically implements ID(boolean) for Point(boolean)
*/

/*
def MakePointId:
  (@(T): Type)-> ID(Point(T)), {
  This :: Point(T);
  ID(This)
    This: This,
    id:
      fn(p)-> This(p.x, p.y)
}
x :: Point(i32); 
*/