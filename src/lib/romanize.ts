import { romanizeKorean } from "./romanizeKorean";
import {
  displayRomanization,
  hasHangul,
  hasJapanese,
  needsRomanization,
} from "./romanizeText";

const cache = new Map<string, string>();
const waiters = new Map<string, Array<(value: string) => void>>();
const queue = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;

function finish(text: string, value: string) {
  cache.set(text, value);
  for (const resolve of waiters.get(text) ?? []) resolve(value);
  waiters.delete(text);
}

async function flush() {
  timer = undefined;
  const texts = [...queue];
  queue.clear();
  if (!texts.length) return;
  try {
    const response = await fetch("/api/romanize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts }),
    });
    const data = response.ok ? await response.json() : { romanizations: [] };
    const romanizations = Array.isArray(data.romanizations) ? data.romanizations : [];
    texts.forEach((text, i) => finish(text, String(romanizations[i] ?? "")));
  } catch {
    texts.forEach((text) => finish(text, ""));
  }
}

export function romanize(text: string): Promise<string> {
  const key = text.normalize("NFC");
  if (!needsRomanization(key)) return Promise.resolve("");
  const cached = cache.get(key);
  if (cached != null) return Promise.resolve(cached);
  if (hasHangul(key) && !hasJapanese(key)) {
    const value = displayRomanization(key, romanizeKorean(key));
    cache.set(key, value);
    return Promise.resolve(value);
  }
  return new Promise((resolve) => {
    const pending = waiters.get(key);
    if (pending) {
      pending.push(resolve);
      return;
    }
    waiters.set(key, [resolve]);
    queue.add(key);
    timer ??= setTimeout(flush, 40);
  });
}
