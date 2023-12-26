type Data: Linear;  

type MyData<T: Type> = {
  age: i32,
  name: Data,
  job: T,
}

type MyData2<T: Type> = {
  age: i32,
  job: T,
}

enum Option<T: Type> {
  Some(value: T),
  None,
}

type I32Option = Option<i32>;
type DataOption = Option<Data>;

type MyRecord<T: Type> = {
  value: T,
}

type I32MyRecord = MyRecord<i32>;

enum MyDataEnum: Linear {
  MyDataEnum(value: Data)
}