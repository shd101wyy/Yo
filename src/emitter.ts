import { isCodegenTempName } from "./utils";

export class Emitter {
  private headers: string = "";
  private declarations: string = "";
  private code: string = "";
  /**
   * When set (by generateFunction, pointing at the current function's
   * context.declaredCVarNames), emitLine records every codegen TEMP that is
   * DECLARED in an emitted body line, in C-emission order. The drop-emission
   * gate consults the same set to decide whether a temp's C declaration has
   * been emitted yet; without this centralized capture, the many temp-decl
   * emission paths that build the declaration via getTypeString (not
   * getVariableTypeString) leave their temps untracked, so the gate wrongly
   * SKIPS their drops → the live RC value leaks. See
   * issues/fixed/yo-self-fixpoint-eval-phase-leak.md.
   */
  declaredCVarNamesRef?: Set<string>;
  constructor() {}

  // Matches a C declaration `<type…> <name> = …` or `<type…> <name>;` and
  // captures <name>: a type-ending char (word/`>`/`*`/`]`), whitespace, the
  // identifier, then `=` (not `==`) or `;`. Does NOT match an assignment
  // (`name = …`, name at line start with no type before it) nor a `___drop`
  // argument use (`…((cast)(name))`, name wrapped in parens), so genuine
  // never-declared phantoms are never recorded.
  private static readonly DECL_RE = /[\w>*\]]\s+([A-Za-z_]\w*)\s*(?:=(?!=)|;)/;

  private recordDeclaredTemp(code: string) {
    const set = this.declaredCVarNamesRef;
    if (!set || !code.includes("_temp_")) return;
    const m = Emitter.DECL_RE.exec(code);
    if (m && isCodegenTempName(m[1]!)) set.add(m[1]!);
  }

  emit(code: string, indentation = "") {
    this.code += indentation + code;
    return this.code;
  }

  emitLine(code: string, indentation = "") {
    this.code += indentation + code + "\n";
    this.recordDeclaredTemp(code);
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
