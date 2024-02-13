import {*} from "../builtins.mo";

export interface Alias<InputType: Type, OutputType: Type> {
  (@): (out value: InputType)-> OutputType;
}

export interface Reference<InputType: Type, OutputType: Type> {
  (&): (out value: InputType)-> OutputType;
}

export interface Dereference<InputType: Type, OutputType: Type> {
  (*): (out value: InputType)-> OutputType;
}