// JSON documentation renderer — serializes a DocModel to JSON.
//
// Produces a single JSON file containing the full documentation model.
// Useful for custom tooling, IDE integration, or feeding into other renderers.

import type { DocModel } from "./model";
import * as fs from "fs";
import * as path from "path";

export interface RenderJsonOptions {
  model: DocModel;
  outputDir: string;
  /** Pretty-print with indentation (default: true) */
  pretty?: boolean;
}

export function renderDocJson(options: RenderJsonOptions): void {
  const { model, outputDir, pretty = true } = options;

  fs.mkdirSync(outputDir, { recursive: true });

  const json = pretty ? JSON.stringify(model, null, 2) : JSON.stringify(model);

  fs.writeFileSync(path.join(outputDir, "doc.json"), json, "utf-8");
}
