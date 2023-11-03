import { Type } from "./type-checker";

export type ValueType = {
  id: string;
  variableName: string;
  // accessors: string[];
  type: Type;
  /* referenceCount of the value inside current frame */
  // referenceCount: number;
};

class Frame {
  private valueTypes: ValueType[] = [];

  constructor() {
    this.valueTypes = [];
  }

  public addValueType(valueType: ValueType) {
    this.valueTypes.push(valueType);
  }

  public getValueTypesByVariableName(variableName: string): ValueType[] {
    return this.valueTypes.filter(
      (valueType) => valueType.variableName === variableName
    );
  }
}

export default class Environment {
  private frames: Frame[] = [];

  private variableNameCounter: { [key: string]: number } = {};

  constructor() {
    this.frames = [new Frame()];
  }

  public pushFrame() {
    this.frames.push(new Frame());
  }

  public popFrame() {
    return this.frames.pop();
  }

  public getId(variableName: string): string {
    if (variableName in this.variableNameCounter) {
      this.variableNameCounter[variableName] =
        this.variableNameCounter[variableName] + 1;
    } else {
      this.variableNameCounter[variableName] = 0;
    }
    const counter = this.variableNameCounter[variableName];
    if (counter === 0) {
      return variableName;
    } else {
      return variableName + "_" + counter;
    }
  }

  public addValueType(
    valueType: Omit<ValueType, "id"> & { id?: string },
    deltaFrame = 0
  ) {
    this.frames[this.frames.length - 1 + deltaFrame].addValueType({
      id: valueType.id ?? this.getId(valueType.variableName),
      ...valueType,
    });
  }

  public getValueTypesByVariableName(variableName: string): ValueType[] {
    const valueTypes: ValueType[] = [];
    for (let i = 0; i < this.frames.length; i++) {
      const frame = this.frames[i];
      const valueTypesInFrame = frame.getValueTypesByVariableName(variableName);
      valueTypes.push(...valueTypesInFrame);
    }
    return valueTypes;
  }
}
