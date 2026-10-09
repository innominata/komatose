import { QWEN3_VL_ID, QWEN3_VL_LABEL } from './qwenModels';

/** These models are installed separately and are available for region AI Review. */
export const LOCAL_REVIEW_MODELS = [
  { id: 'hayai-ocr-v2', label: 'Hayai OCR v2', transcriptionOnly: true },
  { id: 'hayai-ocr-v2.5-nova', label: 'Hayai OCR v2.5 Nova', transcriptionOnly: true },
  { id: 'pp-ocrv5-korean', label: 'PP-OCRv5 Korean', transcriptionOnly: true },
  { id: 'manga-ocr', label: 'Manga OCR', transcriptionOnly: true },
  { id: 'paddleocr-vl-1.6', label: 'PaddleOCR-VL-1.6', transcriptionOnly: true },
  { id: QWEN3_VL_ID, label: QWEN3_VL_LABEL, transcriptionOnly: false },
] as const;

export type LocalReviewModelId = typeof LOCAL_REVIEW_MODELS[number]['id'];
export function localReviewModel(id: string) {
  return LOCAL_REVIEW_MODELS.find(model => model.id === id);
}
export const MAX_SOURCE_REVIEWERS = 5;
