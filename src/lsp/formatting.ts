import { TextEdit, Range, Position } from "vscode-languageserver/node";
import { formatYoSource } from "../formatter";

export function handleDocumentFormatting(
  uri: string,
  content: string
): TextEdit[] | null {
  let formatted: string;
  try {
    formatted = formatYoSource(content, uri);
  } catch {
    // Parse error — leave the document unchanged
    return null;
  }

  if (formatted === content) {
    return [];
  }

  const lines = content.split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  return [
    TextEdit.replace(
      Range.create(
        Position.create(0, 0),
        Position.create(lines.length - 1, lastLine.length)
      ),
      formatted
    ),
  ];
}
