/**
 * Undo and redo for each text box on its own.
 *
 * Chrome keeps one undo history for the whole document: once a box has nothing left to undo,
 * Ctrl+Z moves focus to another box and undoes the typing there. Each text box keeps its own
 * history here instead, and Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y and the browser's Undo/Redo menu
 * items replay it. Restoring a value fires a normal `input` event, so the box saves the same
 * way typing does.
 */

type Snap = { value: string; start: number; end: number };
type History = {
  /** The box's identity; a box reused for another region starts a fresh history. */
  key: string;
  undo: Snap[];
  redo: Snap[];
  /** The value after the last edit this history saw. */
  current: string;
  kind: string;
  at: number;
  caret: number;
  /** The last character typed was a space or newline. */
  afterSpace: boolean;
};

type TextField = HTMLTextAreaElement | HTMLInputElement;

const LIMIT = 200;
/** A pause longer than this starts a new undo step. */
const PAUSE_MS = 1000;
const TEXT_INPUTS = new Set(["", "text", "search", "url", "tel", "email"]);
const histories = new WeakMap<TextField, History>();

function textField(target: EventTarget | null): TextField | null {
  if (target instanceof HTMLTextAreaElement) return target.readOnly || target.disabled ? null : target;
  if (target instanceof HTMLInputElement && TEXT_INPUTS.has(target.getAttribute("type")?.toLowerCase() ?? ""))
    return target.readOnly || target.disabled ? null : target;
  return null;
}

const keyOf = (el: TextField) => el.dataset.undoKey ?? el.id ?? "";
const snap = (el: TextField): Snap => ({ value: el.value, start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length });

function push(stack: Snap[], entry: Snap) {
  stack.push(entry);
  if (stack.length > LIMIT) stack.shift();
}

function historyFor(el: TextField): History {
  const key = keyOf(el);
  let h = histories.get(el);
  if (!h || h.key !== key) {
    h = { key, undo: [], redo: [], current: el.value, kind: "", at: 0, caret: -1, afterSpace: false };
    histories.set(el, h);
  }
  // Changed by something other than typing (a Format button, a drop, a save from elsewhere):
  // keep that change as its own step, so undo can return to what was there before it.
  if (el.value !== h.current) {
    push(h.undo, { value: h.current, start: h.current.length, end: h.current.length });
    h.redo = [];
    h.current = el.value;
    h.kind = "";
  }
  return h;
}

function kindOf(inputType: string) {
  if (inputType === "insertText") return "type";
  if (inputType === "deleteContentBackward" || inputType === "deleteContentForward") return "delete";
  return "other";
}

/** Records the value before an edit, starting a new undo step when this edit begins one. */
function beforeEdit(el: TextField, inputType: string, data: string | null) {
  const h = historyFor(el);
  const kind = kindOf(inputType);
  const now = Date.now();
  const collapsed = el.selectionStart === el.selectionEnd;
  const contiguous = collapsed && (kind === "delete" || el.selectionStart === h.caret);
  // A space typed after a word starts the next step, so undo removes " word" a word at a time.
  const space = kind === "type" && /\s/.test(data ?? "");
  const wordBreak = space && !h.afterSpace;
  const newStep = kind === "other" || kind !== h.kind || wordBreak || now - h.at > PAUSE_MS || !contiguous;
  if (newStep) {
    push(h.undo, snap(el));
    h.redo = [];
  }
  h.kind = kind;
  h.at = now;
  h.afterSpace = space;
}

function replay(el: TextField, direction: "undo" | "redo") {
  const h = historyFor(el);
  const from = direction === "undo" ? h.undo : h.redo;
  const to = direction === "undo" ? h.redo : h.undo;
  const entry = from.pop();
  if (!entry) return;
  push(to, snap(el));
  el.value = entry.value;
  el.setSelectionRange(entry.start, entry.end);
  h.current = el.value;
  h.kind = "";
  h.caret = -1;
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: direction === "undo" ? "historyUndo" : "historyRedo" }));
}

function shortcut(e: KeyboardEvent): "undo" | "redo" | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (key === "z") return e.shiftKey ? "redo" : "undo";
  if (key === "y" && !e.shiftKey) return "redo";
  return null;
}

/** Installs per-box undo for the whole page. Returns a function that removes it. */
export function installTextUndo(target: Window = window): () => void {
  const onKey = (e: KeyboardEvent) => {
    const direction = shortcut(e);
    const el = direction && !e.isComposing ? textField(e.target) : null;
    if (!el || !direction) return;
    // Handled here, so no app shortcut also sees it and the browser's shared history is unused.
    e.preventDefault();
    e.stopPropagation();
    replay(el, direction);
  };
  const onBeforeInput = (e: InputEvent) => {
    const el = textField(e.target);
    if (!el) return;
    if (e.inputType === "historyUndo" || e.inputType === "historyRedo") {
      e.preventDefault();
      replay(el, e.inputType === "historyUndo" ? "undo" : "redo");
      return;
    }
    if (e.isComposing) return;
    beforeEdit(el, e.inputType, e.data);
  };
  const onCompositionStart = (e: CompositionEvent) => {
    const el = textField(e.target);
    if (el) beforeEdit(el, "insertCompositionText", null);
  };
  const onInput = (e: Event) => {
    const el = textField(e.target);
    if (!el) return;
    const h = histories.get(el);
    if (!h || h.key !== keyOf(el)) return;
    h.current = el.value;
    h.caret = el.selectionEnd ?? -1;
  };
  target.addEventListener("keydown", onKey, true);
  target.addEventListener("beforeinput", onBeforeInput, true);
  target.addEventListener("compositionstart", onCompositionStart, true);
  target.addEventListener("input", onInput, true);
  return () => {
    target.removeEventListener("keydown", onKey, true);
    target.removeEventListener("beforeinput", onBeforeInput, true);
    target.removeEventListener("compositionstart", onCompositionStart, true);
    target.removeEventListener("input", onInput, true);
  };
}
