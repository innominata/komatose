/**
 * No model is built in. An empty engine means "not chosen here": the server
 * resolves it to the operator's default under Admin → Models, or reports that
 * nothing is chosen. It never falls back to a named model.
 */
export const DEFAULT_CHAT_MODEL_ID = "";
export const DEFAULT_REVIEW_MODEL_ID = "";
export const defaultChatSelection = () => ({
  engine: DEFAULT_CHAT_MODEL_ID,
  model: "",
});
