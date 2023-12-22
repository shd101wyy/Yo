> http://learnyouahaskell.com/modules

## Loading modules

```typescript
import "data/list";
import { nub, sort } from "data/list";
import "data/list" hiding {nub, sort}
import * as List from "data/list";
```

## Making our own modules

- **geometry.mo**

```typescript
function sphereVolume(r: f64): f64 {
  return (4.0 / 3.0) * Math.PI * Math.pow(r, 3);
}

function sphereArea(r: f64): f64 {
  return 4 * Math.PI * Math.pow(r, 2);
}

function cubeVolume(a: f64): f64 {
  return Math.pow(a, 3);
}

function cubeArea(a: f64): f64 {
  return 6 * Math.pow(a, 2);
}

function cuboidArea(a: f64, b: f64, c: f64): f64 {
  return 2 * (a * b + b * c + c * a);
}

function cuboidVolume(a: f64, b: f64, c: f64): f64 {
  return a * b * c;
}

function rectangleArea(a: f64, b: f64): f64 {
  return a * b;
}

export {
  sphereVolume,
  sphereArea,
  cubeVolume,
  cubeArea,
  cuboidArea,
  cuboidVolume,
};
```

- **main.mo**

```typescript
import * as Geometry from "./geometry";
import { sphereVolume } from "./geometry";
import { sphereVolume as sv } from "./geometry";
import "./geometry";
import "./geometry" hiding { sphereVolume };
```

---

Split into multiple files:

- **geometry/sphere.mo**

```typescript
function volume(r: f64): f64 {
  return (4.0 / 3.0) * Math.PI * Math.pow(r, 3);
}

function area(r: f64): f64 {
  return 4 * Math.PI * Math.pow(r, 2);
}
```

- **geometry/cuboid.mo**

```typescript
function rectangleArea(a: f64, b: f64): f64 {
  return a * b;
}

function volume(a: f64, b: f64, c: f64): f64 {
  return rectangleArea(a, b) * c;
}

function area(a: f64, b: f64, c: f64): f64 {
  return 2 * (rectangleArea(a, b) + rectangleArea(b, c) + rectangleArea(c, a));
}
```

- **geometry/cube.mo**

```typescript
import * as Cuboid from "./cuboid";

function volume(a: f64): f64 {
  return Cuboid.volume(a, a, a);
}

function area(a: f64): f64 {
  return Cuboid.area(a, a, a);
}
```
