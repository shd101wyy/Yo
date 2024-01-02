export class Emitter {
  private header: string = "";
  private definition: string = "";
  private code: string = "";
  constructor() {}

  emit(code: string) {
    this.code += code;
    return this.code;
  }

  emitLine(code: string) {
    this.code += code + "\n";
    return this.code;
  }

  emitHeaderLine(code: string) {
    this.header += code + "\n";
    return this.header;
  }

  emitDefinitionLine(code: string) {
    this.definition += code + "\n";
    return this.definition;
  }

  print() {
    return this.header + this.definition + this.code;
  }
}
