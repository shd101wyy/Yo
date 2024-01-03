export class Emitter {
  private header: string = "";
  private declaration: string = "";
  private code: string = "";
  constructor() {}

  emit(code: string, indentation = "") {
    this.code += indentation + code;
    return this.code;
  }

  emitLine(code: string, indentation = "") {
    this.code += indentation + code + "\n";
    return this.code;
  }

  emitHeaderLine(code: string, indentation = "") {
    this.header += indentation + code + "\n";
    return this.header;
  }

  emitDeclarationLine(code: string, indentation = "") {
    this.declaration += indentation + code + "\n";
    return this.declaration;
  }

  print() {
    return this.header + this.declaration + this.code;
  }
}
