export class Emitter {
  private headers: string = "";
  private declarations: string = "";
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
    this.headers += indentation + code + "\n";
    return this.headers;
  }

  emitDeclarationLine(code: string, indentation = "") {
    this.declarations += indentation + code + "\n";
    return this.declarations;
  }

  print() {
    return this.headers + "\n" + this.declarations + "\n" + this.code.trim();
  }
}
