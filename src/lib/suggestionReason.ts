/** Collapse stored source-review blurbs to the model names. */
export function compactSuggestionReason(reason: string): string {
  const chunks = reason
    .split(/\n+|(?=(?:AI Review|Review Transcription) · )|(?=Enquire · )/)
    .map((chunk) => compactOne(chunk.replace(/\s+/g, " ").trim()))
    .filter(Boolean);
  return [...new Set(chunks)].join("\n");
}

function compactOne(reason: string): string {
  if (!reason) return "";
  const translator =
    reason.match(/English translation by (.+?) from that transcription/i)?.[1]?.trim() ||
    reason.match(/English is from (.+?) from this transcription/i)?.[1]?.trim() ||
    "";

  const review = reason.match(/^((?:AI Review|Review Transcription) · [^:]+)/);
  if (review) {
    const head = review[1].trim();
    return translator && !head.includes(translator) ? `${head} · ${translator}` : head;
  }

  const enquire = reason.match(/^(Enquire · [^:]+)/);
  if (enquire) return enquire[1].trim();

  const ocr = reason.match(
    /^([^:]+): (?:Independent OCR|reading failed|No text returned)/,
  );
  if (ocr) {
    const label = ocr[1].trim();
    return translator && translator !== label ? `${label} · ${translator}` : label;
  }

  return reason;
}
