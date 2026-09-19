import { sha256 } from "./canonical.js";
import { ReviewLspError } from "./errors.js";
import type { CoordinateContext, CoordinateExpectation } from "./types.js";

/**
 * Coordinate context and the optional request guard.
 *
 * The first real dogfood produced a hover that was entirely valid — correct candidate,
 * correct provenance, correct bytes — and completely irrelevant, because the requested line
 * was off by one. No evidence field could have caught it: the provenance was genuinely sound.
 * What was wrong was the question, not the answer.
 *
 * So the fix is not a stronger check on the result. It is returning enough of the bound source
 * with the answer that the caller can see what it actually asked about, plus an optional
 * expectation the caller can state up front. Neither raises the strength of any evidence: a
 * semantically irrelevant but provenance-valid response stays exactly that.
 */

/** UTF-16 code-unit slice of a line, matching the position encoding the profile declares. */
function lineAt(text: string, line: number): string | null {
  const lines = text.split("\n");
  const value = lines[line];
  return value === undefined ? null : value.replace(/\r$/, "");
}

/**
 * The identifier-ish run of characters containing the requested column.
 *
 * Deliberately simple: this is a targeting aid for a human or agent reading the receipt, not
 * a lexer, and it must not be mistaken for the language server's own idea of the symbol.
 */
function tokenAt(line: string, character: number): string | null {
  if (character < 0 || character > line.length) return null;
  const isWord = (value: string): boolean => /[\p{L}\p{N}_$]/u.test(value);
  let start = character;
  let end = character;
  while (start > 0 && isWord(line.charAt(start - 1))) start -= 1;
  while (end < line.length && isWord(line.charAt(end))) end += 1;
  return end > start ? line.slice(start, end) : null;
}

export function buildCoordinateContext(input: {
  text: string;
  line: number;
  character: number;
}): CoordinateContext {
  const text = lineAt(input.text, input.line);
  if (text === null) {
    throw new ReviewLspError(
      "CANDIDATE_PATH_INVALID",
      `requested line ${input.line} is outside the candidate document, which has ${input.text.split("\n").length} lines`,
    );
  }
  return {
    line_text: text,
    line_sha256: sha256(text),
    token: tokenAt(text, input.character),
    line_length: text.length,
  };
}

/**
 * Refuses a request whose position does not match what the caller said it was aiming at.
 *
 * This is a guard on the question, not on the evidence. A mismatch means the caller would have
 * received an answer about something it did not intend, so the request fails rather than
 * returning a result that looks authoritative and is beside the point.
 */
export function assertCoordinateExpectation(
  context: CoordinateContext,
  expectation: CoordinateExpectation | undefined,
): void {
  if (!expectation) return;

  if (expectation.token !== undefined && context.token !== expectation.token) {
    throw new ReviewLspError(
      "COORDINATE_EXPECTATION_UNMET",
      `requested position holds ${context.token === null ? "no identifier" : JSON.stringify(context.token)}, not ${JSON.stringify(expectation.token)}`,
    );
  }

  if (expectation.line_sha256 !== undefined && context.line_sha256 !== expectation.line_sha256) {
    throw new ReviewLspError(
      "COORDINATE_EXPECTATION_UNMET",
      "requested line does not match the line digest the caller expected",
    );
  }

  if (expectation.line_contains !== undefined && !context.line_text.includes(expectation.line_contains)) {
    throw new ReviewLspError(
      "COORDINATE_EXPECTATION_UNMET",
      `requested line does not contain ${JSON.stringify(expectation.line_contains)}`,
    );
  }
}
