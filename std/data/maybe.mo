import {*} from "./builtins"

export enum Maybe<T: Type> {
  Nothing,
  Just(value: T),
}