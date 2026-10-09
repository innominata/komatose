export const OCR_RECOGNIZERS = [
  { id: 'hayai-ocr-v2', label: 'Hayai OCR v2' },
  { id: 'paddleocr-vl-1.6', label: 'PaddleOCR-VL-1.6' },
] as const;

export type OcrReading = {
  model: string;
  source: string;
  error?: string;
  translation?: string;
};
export type OcrConsensus = { agreed: boolean; source: string; readings: OcrReading[]; decision?: import('./decider').TranscriptionDecision };

/** A decider resolution is distinct from the OCR plurality evidence. */
export function ocrResolutionAccepted(result: OcrConsensus): boolean {
  return result.decision ? result.decision.status === 'accepted' : result.agreed;
}

/** Crop/OCR failed; the region still exists so the disagreement can be reviewed. */
export function failedOcrConsensus(error: string, modelIds: string[] = OCR_RECOGNIZERS.map((m) => m.id)): OcrConsensus {
  return {
    agreed: false,
    source: '',
    readings: modelIds.map((model) => ({ model, source: '', error })),
  };
}

/**
 * Compare OCR lettering while ignoring wrap/spacing and interchangeable
 * dashes/tildes/separator dots. Prolonged-sound ー, letters, numbers, and
 * other punctuation (! vs ?) still count as real differences.
 */
export function ocrComparableKey(value: string): string {
  return value.normalize('NFKC').replace(/[\s\p{Cf}\p{Pd}~˜∼〜～＿_·•∙⋅・‧]/gu, '');
}

export function compareOcrReadings(
  readings: OcrReading[],
  preferIds: string[] = ['paddleocr-vl-1.6'],
): OcrConsensus {
  const clusters = new Map<string, OcrReading[]>();
  for (const reading of readings) {
    const key = ocrComparableKey(reading.source);
    if (reading.error || !/[\p{L}\p{N}]/u.test(key)) continue;
    const list = clusters.get(key) || [];
    list.push(reading);
    clusters.set(key, list);
  }
  const ranked = [...clusters.values()].sort((a, b) => b.length - a.length);
  const top = ranked[0];
  const second = ranked[1];
  const agreed = Boolean(top && (!second || top.length > second.length));
  let source = '';
  if (agreed && top) {
    const preferred = preferIds.map((id) => top.find((reading) => reading.model === id)).find(Boolean);
    const longest = [...top].sort((a, b) => b.source.length - a.source.length)[0];
    source = (preferred || longest).source.trim();
  }
  return { agreed, source, readings };
}
