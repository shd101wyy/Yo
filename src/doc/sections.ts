// Section parser for Yo doc comments.
//
// Splits doc comment markdown by ## headings to extract structured sections
// (Returns, Errors, Panics, Examples, Safety, Deprecated).

export interface ParsedDocComment {
  /** First paragraph — used as summary in search results and completions */
  summary: string;
  /** Full description (everything before the first ## heading) */
  description: string;
  /** Named sections keyed by lowercase heading (e.g., "returns", "examples") */
  sections: Map<string, string>;
}

/** Well-known section headings (lowercase). */
const KNOWN_SECTIONS = new Set([
  "returns",
  "errors",
  "panics",
  "examples",
  "safety",
  "deprecated",
]);

/**
 * Parse a doc comment into structured sections.
 *
 * - Everything before the first `## ` heading is the description.
 * - The first paragraph of the description (up to the first blank line) is the summary.
 * - `## Returns`, `## Errors`, etc. are parsed as named sections.
 * - Unknown headings are kept as-is (key = lowercase heading text).
 * - Section content continues until the next `## ` heading or end of text.
 */
export function parseDocComment(text: string): ParsedDocComment {
  if (text.trim() === "") {
    return { summary: "", description: "", sections: new Map() };
  }

  const lines = text.split("\n");
  const sections = new Map<string, string>();

  // Accumulate lines into description (before first ##) and sections
  const descriptionLines: string[] = [];
  let currentSection: string | null = null;
  let currentSectionLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)$/);

    if (headingMatch) {
      // Flush previous section
      if (currentSection !== null) {
        sections.set(currentSection, trimSectionContent(currentSectionLines));
      }

      currentSection = headingMatch[1]!.trim().toLowerCase();
      currentSectionLines = [];
    } else if (currentSection !== null) {
      currentSectionLines.push(line);
    } else {
      descriptionLines.push(line);
    }
  }

  // Flush last section
  if (currentSection !== null) {
    sections.set(currentSection, trimSectionContent(currentSectionLines));
  }

  const description = trimSectionContent(descriptionLines);
  const summary = extractSummary(description);

  return { summary, description, sections };
}

/**
 * Extract the first paragraph from a description as the summary.
 * The first paragraph is everything up to the first blank line.
 */
function extractSummary(description: string): string {
  if (description === "") return "";

  const lines = description.split("\n");
  const summaryLines: string[] = [];

  for (const line of lines) {
    if (line.trim() === "") break;
    summaryLines.push(line);
  }

  return summaryLines.join("\n");
}

/** Trim leading/trailing blank lines from section content lines. */
function trimSectionContent(lines: string[]): string {
  // Remove leading blank lines
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === "") {
    start++;
  }
  // Remove trailing blank lines
  let end = lines.length;
  while (end > start && lines[end - 1]!.trim() === "") {
    end--;
  }
  return lines.slice(start, end).join("\n");
}

/**
 * Check if a section name is a well-known section heading.
 */
export function isKnownSection(name: string): boolean {
  return KNOWN_SECTIONS.has(name.toLowerCase());
}
