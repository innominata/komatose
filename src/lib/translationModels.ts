import definitions from './translationModels.json';
import type { OcrLang } from './types';

export type TranslationWeights = {
  revision: string;
  filename: string;
  bytes: number;
  sha256: string;
  extras?: { filename: string; bytes: number; sha256: string }[];
};

export type TranslationModel = {
  id: string;
  label: string;
  repository: string;
  aliases: string[];
  languages: readonly OcrLang[];
  profile: 'cat-translate' | 'hy-manga' | 'hy-mt' | 'ko-en-minrnn' | 'opus-mt-ja-en' | 'shisa' | 'sugoi-ja-en' | 'translategemma';
  runtime?: 'llamacpp' | 'pytorch';
  envPrefix: string;
  weights: TranslationWeights | null;
};

export function translationRuntimeOf(model: TranslationModel) {
  return model.runtime || (model.profile === 'ko-en-minrnn' ? 'pytorch' : 'llamacpp');
}

export const TRANSLATION_MODELS = definitions as TranslationModel[];

/** Saved IDs remain short; known publisher IDs also resolve without being rewritten. */
export function translationModel(value?: string | null): TranslationModel | undefined {
  const key = (value || '').trim().toLowerCase();
  return TRANSLATION_MODELS.find(model =>
    [model.id, model.repository, ...model.aliases].some(id => id.toLowerCase() === key));
}

export function assertTranslationLanguage(model: TranslationModel, lang: OcrLang) {
  if (!model.languages.includes(lang))
    throw Object.assign(new Error(`${model.label} does not support ${lang} source. Choose a compatible translation model.`), { status: 400 });
}

export function assertGeneralModel(model?: string) {
  const specialist = translationModel(model);
  if (specialist)
    throw Object.assign(new Error(`${specialist.label} is a text translation model. Select it for Translation only; choose another model for vision, review, proofreading or chat.`), { status: 400 });
}
