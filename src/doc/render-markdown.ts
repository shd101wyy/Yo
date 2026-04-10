// Markdown documentation renderer — generates .md files from a DocModel.
//
// Produces:
//   - README.md — Module index
//   - module/<name>.md — Per-module documentation

import type {
  DocModel,
  DocModule,
  DocFunction,
  DocType,
  DocTrait,
  DocConstant,
  DocParam,
  DocField,
  DocVariant,
  DocAssociatedType,
} from "./model";
import * as fs from "fs";
import * as path from "path";

// ── Formatting helpers ───────────────────────────────────────────────

function formatTypeParams(params: DocParam[] | undefined): string {
  if (!params || params.length === 0) return "";
  const names = params.map((p) => p.name);
  return `(${names.join(", ")})`;
}

function indent(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.trim() ? prefix + line : line))
    .join("\n");
}

// ── Function rendering ───────────────────────────────────────────────

function renderFunction(fn: DocFunction): string {
  const lines: string[] = [];
  const anchor = fn.isMethod ? `${fn.selfType}.${fn.name}` : fn.name;
  lines.push(`### \`${anchor}\``);
  lines.push("");

  if (fn.deprecated) {
    lines.push(`> ⚠️ **Deprecated**: ${fn.deprecated}`);
    lines.push("");
  }

  lines.push("```rust");
  lines.push(fn.signature);
  lines.push("```");
  lines.push("");

  if (fn.doc) {
    lines.push(fn.doc);
    lines.push("");
  }

  if (fn.parameters.length > 0) {
    lines.push("**Parameters:**");
    lines.push("");
    for (const p of fn.parameters) {
      const comptime = p.isComptime ? " *(comptime)*" : "";
      const implicit = p.isImplicit ? " *(implicit)*" : "";
      const dflt = p.defaultValue ? ` = \`${p.defaultValue}\`` : "";
      const doc = p.doc ? ` — ${p.doc}` : "";
      lines.push(
        `- \`${p.name}\` : \`${p.type}\`${comptime}${implicit}${dflt}${doc}`
      );
    }
    lines.push("");
  }

  lines.push(`**Returns:** \`${fn.returnType}\``);
  lines.push("");

  if (fn.returns) {
    lines.push(fn.returns);
    lines.push("");
  }

  if (fn.errors) {
    lines.push("**Errors:**");
    lines.push("");
    lines.push(fn.errors);
    lines.push("");
  }

  if (fn.examples) {
    lines.push("**Examples:**");
    lines.push("");
    lines.push(fn.examples);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Type rendering ───────────────────────────────────────────────────

function renderFields(fields: DocField[]): string {
  const lines: string[] = [];
  lines.push("**Fields:**");
  lines.push("");
  for (const f of fields) {
    const dflt = f.defaultValue ? ` = \`${f.defaultValue}\`` : "";
    const doc = f.doc ? ` — ${f.doc}` : "";
    lines.push(`- \`${f.name}\` : \`${f.type}\`${dflt}${doc}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderVariants(variants: DocVariant[]): string {
  const lines: string[] = [];
  lines.push("**Variants:**");
  lines.push("");
  for (const v of variants) {
    const disc = v.discriminant ? ` = ${v.discriminant}` : "";
    const doc = v.doc ? ` — ${v.doc}` : "";
    if (v.fields && v.fields.length > 0) {
      const fieldStr = v.fields.map((f) => `${f.name}: ${f.type}`).join(", ");
      lines.push(`- \`${v.name}(${fieldStr})\`${disc}${doc}`);
    } else {
      lines.push(`- \`${v.name}\`${disc}${doc}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function renderAssociatedTypes(types: DocAssociatedType[]): string {
  const lines: string[] = [];
  lines.push("**Associated Types:**");
  lines.push("");
  for (const t of types) {
    const constraint = t.constraint ? ` : ${t.constraint}` : "";
    const doc = t.doc ? ` — ${t.doc}` : "";
    lines.push(`- \`${t.name}\`${constraint}${doc}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderType(type: DocType): string {
  const lines: string[] = [];
  const tp = formatTypeParams(type.typeParams);
  lines.push(`### \`${type.name}${tp}\``);
  lines.push("");

  if (type.deprecated) {
    lines.push(`> ⚠️ **Deprecated**: ${type.deprecated}`);
    lines.push("");
  }

  lines.push(`*${type.kind}*`);
  lines.push("");
  lines.push("```rust");
  lines.push(type.signature);
  lines.push("```");
  lines.push("");

  if (type.doc) {
    lines.push(type.doc);
    lines.push("");
  }

  if (type.fields && type.fields.length > 0) {
    lines.push(renderFields(type.fields));
  }

  if (type.variants && type.variants.length > 0) {
    lines.push(renderVariants(type.variants));
  }

  if (type.traitImpls.length > 0) {
    lines.push(
      `**Implements:** ${type.traitImpls.map((t) => `\`${t}\``).join(", ")}`
    );
    lines.push("");
  }

  if (type.methods.length > 0) {
    lines.push("**Methods:**");
    lines.push("");
    for (const m of type.methods) {
      lines.push(indent(renderFunction(m), 0));
    }
  }

  if (type.examples) {
    lines.push("**Examples:**");
    lines.push("");
    lines.push(type.examples);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Trait rendering ──────────────────────────────────────────────────

function renderTrait(trait: DocTrait): string {
  const lines: string[] = [];
  const tp = formatTypeParams(trait.typeParams);
  lines.push(`### \`${trait.name}${tp}\``);
  lines.push("");

  if (trait.deprecated) {
    lines.push(`> ⚠️ **Deprecated**: ${trait.deprecated}`);
    lines.push("");
  }

  lines.push(`*trait*`);
  lines.push("");
  lines.push("```rust");
  lines.push(trait.signature);
  lines.push("```");
  lines.push("");

  if (trait.doc) {
    lines.push(trait.doc);
    lines.push("");
  }

  if (trait.associatedTypes && trait.associatedTypes.length > 0) {
    lines.push(renderAssociatedTypes(trait.associatedTypes));
  }

  if (trait.methods.length > 0) {
    lines.push("**Required Methods:**");
    lines.push("");
    for (const m of trait.methods) {
      lines.push(renderFunction(m));
    }
  }

  if (trait.implementors.length > 0) {
    lines.push(
      `**Implementors:** ${trait.implementors.map((i) => `\`${i}\``).join(", ")}`
    );
    lines.push("");
  }

  if (trait.examples) {
    lines.push("**Examples:**");
    lines.push("");
    lines.push(trait.examples);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Constant rendering ───────────────────────────────────────────────

function renderConstant(constant: DocConstant): string {
  const lines: string[] = [];
  const val = constant.value ? ` = ${constant.value}` : "";
  lines.push(`### \`${constant.name}\``);
  lines.push("");

  if (constant.deprecated) {
    lines.push(`> ⚠️ **Deprecated**: ${constant.deprecated}`);
    lines.push("");
  }

  lines.push(`\`${constant.type}${val}\``);
  lines.push("");

  if (constant.doc) {
    lines.push(constant.doc);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Module rendering ─────────────────────────────────────────────────

function renderModule(mod: DocModule): string {
  const lines: string[] = [];
  lines.push(`# ${mod.name}`);
  lines.push("");
  lines.push(`> Module path: \`${mod.path}\``);
  lines.push("");

  if (mod.doc) {
    lines.push(mod.doc);
    lines.push("");
  }

  // Table of contents
  const hasContent =
    mod.functions.length > 0 ||
    mod.types.length > 0 ||
    mod.traits.length > 0 ||
    mod.constants.length > 0;

  if (hasContent) {
    lines.push("## Contents");
    lines.push("");

    if (mod.types.length > 0) {
      lines.push("**Types:**");
      for (const t of mod.types) {
        lines.push(`- [\`${t.name}\`](#${t.name.toLowerCase()})`);
      }
      lines.push("");
    }

    if (mod.traits.length > 0) {
      lines.push("**Traits:**");
      for (const t of mod.traits) {
        lines.push(`- [\`${t.name}\`](#${t.name.toLowerCase()})`);
      }
      lines.push("");
    }

    if (mod.functions.length > 0) {
      lines.push("**Functions:**");
      for (const f of mod.functions) {
        lines.push(`- [\`${f.name}\`](#${f.name.toLowerCase()})`);
      }
      lines.push("");
    }

    if (mod.constants.length > 0) {
      lines.push("**Constants:**");
      for (const c of mod.constants) {
        lines.push(`- [\`${c.name}\`](#${c.name.toLowerCase()})`);
      }
      lines.push("");
    }
  }

  // Types section
  if (mod.types.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Types");
    lines.push("");
    for (const t of mod.types) {
      lines.push(renderType(t));
    }
  }

  // Traits section
  if (mod.traits.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Traits");
    lines.push("");
    for (const t of mod.traits) {
      lines.push(renderTrait(t));
    }
  }

  // Functions section
  if (mod.functions.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Functions");
    lines.push("");
    for (const f of mod.functions) {
      lines.push(renderFunction(f));
    }
  }

  // Constants section
  if (mod.constants.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Constants");
    lines.push("");
    for (const c of mod.constants) {
      lines.push(renderConstant(c));
    }
  }

  return lines.join("\n");
}

// ── Index page ───────────────────────────────────────────────────────

function renderIndex(model: DocModel): string {
  const lines: string[] = [];
  lines.push(`# ${model.name} — API Documentation`);
  lines.push("");
  lines.push("## Modules");
  lines.push("");

  for (const mod of model.modules) {
    const itemCount =
      mod.functions.length +
      mod.types.length +
      mod.traits.length +
      mod.constants.length;
    const summary = mod.doc ? ` — ${mod.doc.split("\n")[0]}` : "";
    lines.push(
      `- [\`${mod.path}\`](module/${mod.name}.md) (${itemCount} items)${summary}`
    );
  }
  lines.push("");

  return lines.join("\n");
}

// ── Public API ───────────────────────────────────────────────────────

export interface RenderMarkdownOptions {
  model: DocModel;
  outputDir: string;
}

export function renderDocMarkdown(options: RenderMarkdownOptions): void {
  const { model, outputDir } = options;

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(path.join(outputDir, "module"), { recursive: true });

  // Write index
  fs.writeFileSync(
    path.join(outputDir, "README.md"),
    renderIndex(model),
    "utf-8"
  );

  // Write module pages
  for (const mod of model.modules) {
    fs.writeFileSync(
      path.join(outputDir, "module", `${mod.name}.md`),
      renderModule(mod),
      "utf-8"
    );
  }
}

// ── Exported helpers for testing ─────────────────────────────────────

export {
  renderFunction as renderFunctionMd,
  renderType as renderTypeMd,
  renderTrait as renderTraitMd,
  renderConstant as renderConstantMd,
  renderModule as renderModuleMd,
  renderIndex as renderIndexMd,
};
