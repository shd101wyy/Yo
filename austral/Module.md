## Module

https://github.com/austral/austral/blob/master/lib/builtin/Memory.aum

```typescript
type Address<T: Type>: Free;
type Pointer<T: Type>: Free;
function malloc<T: Type>(): Address<T>;
function calloc<T: Type>(count: usize): Address<T>;
function nullCheck<T: Type>(address: Address<T>): Option<Pointer<T>>;
function store<T: Type>(pointer: Pointer<T>, value: T): Unit;
function load<T: Type>(pointer: Pointer<T>): T;
function loadWrite<T: Type, R: Region>(ref: &mut<Pointer<T>, R>): &mut<T, R>;
function loadRead<T: Type, R: Region>(ref: &<Pointer<T>, R>): &<T, R>;
function free<T: Type>(pointer: Pointer<T>): Unit;
function realloc<T: Type>(pointer: Pointer<T>, count: usize): Address<T>;
function memmove<T: Type>(destination: Pointer<T>, source: Pointer<T>, count: usize): Unit;
function memcpy<T: Type>(destination: Pointer<T>, source: Pointer<T>, count: usize): Unit;
```


```typescript
inline function malloc<T: Type>(): Address<T> {
  
}
```
