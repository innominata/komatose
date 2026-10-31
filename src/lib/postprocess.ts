/**
 * Post-processing: how an image editor's answer is matched to the page before it is written.
 * Ported with permission from Bear's finishing; the steps run in `ocr/postprocess.py`.
 */
export const POSTPROCESS_METHODS = [
  { id: "copy", label: "Copy page dots", hint: "Tone and lighting matched, then the page's own screentone dots copied in, aligned with the page." },
  { id: "redraw", label: "Redraw dots", hint: "Tone and lighting matched, then the page's dot pattern redrawn at the result's tone." },
  { id: "fill-dots", label: "Tone only, fill lost dots", hint: "Dots redrawn only where the result is grey or dotted; its drawing, flat black and white stay." },
  { id: "tone", label: "Tone only", hint: "Tone and lighting matched to the page; no screentone step." },
  { id: "none", label: "None", hint: "The editor's result as it came." },
] as const;

export type PostprocessMethod = (typeof POSTPROCESS_METHODS)[number]["id"];
export const DEFAULT_POSTPROCESS: PostprocessMethod = "copy";

export function isPostprocessMethod(value: unknown): value is PostprocessMethod {
  return POSTPROCESS_METHODS.some((m) => m.id === value);
}

export const postprocessLabel = (id?: string) => POSTPROCESS_METHODS.find((m) => m.id === id)?.label ?? "None";

/** What a page keeps of its last image-editor clean, so its post-processing can change later. */
export type CleanFinish = {
  /** The editor's answer as it came, before post-processing. */
  answer: string;
  /** The artwork it cleaned, and the mask it was written through. */
  base: string;
  mask: string;
  method: PostprocessMethod;
  /** The cleaned artwork this finishing produced; another clean since replaces it. */
  result: string;
};
