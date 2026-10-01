import { QWEN_38_27B_ID } from "./qwenModels";
/** Product presets; execution must use the selected registry row. */
export const DEFAULT_CHAT_MODEL_ID = QWEN_38_27B_ID;
/**
 * Review defaults to the local chat model. It is deliberately not a CLI slug:
 * which CLI models exist is discovered, never hardcoded.
 */
export const DEFAULT_REVIEW_MODEL_ID = QWEN_38_27B_ID;
export const defaultChatSelection = () => ({
  engine: DEFAULT_CHAT_MODEL_ID,
  model: "",
});
