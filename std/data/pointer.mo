import {*} from "../builtins.mo";

export class Alias<InputType: Type, OutputType: Type> {
  (@): (out value: InputType)-> OutputType;
}

export class Reference<InputType: Type, OutputType: Type> {
  (&): (out value: InputType)-> OutputType;
}

export class Dereference<InputType: Type, OutputType: Type> {
  (*): (out value: InputType)-> OutputType;
}