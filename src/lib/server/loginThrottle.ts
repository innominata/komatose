import { createHash, randomBytes, scryptSync } from "node:crypto";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

type Bucket = {
  failures: number;
  firstAt: number;
  lockedUntil: number;
};

const g = globalThis as typeof globalThis & { __scanLoginThrottle?: Map<string, Bucket> };
if (!g.__scanLoginThrottle) g.__scanLoginThrottle = new Map();
const buckets = g.__scanLoginThrottle;

/** Dummy hash so unknown-user checks spend the same work as a real verify. */
const DUMMY_HASH = (() => {
  const salt = randomBytes(16);
  const key = scryptSync("komatose-unknown-user", salt, 64);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
})();

export const LOGIN_THROTTLE_LIMIT = MAX_FAILURES;

export function dummyPasswordHash(): string {
  return DUMMY_HASH;
}

export function loginThrottleKey(username: string, source: string): string {
  const user = username.trim().toLowerCase() || "-";
  const ip = source.trim() || "unknown";
  return createHash("sha256").update(`${user}\n${ip}`).digest("hex");
}

function bucket(key: string): Bucket {
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || (current.lockedUntil && current.lockedUntil < now && current.failures >= MAX_FAILURES && now - current.firstAt > WINDOW_MS)) {
    const fresh = { failures: 0, firstAt: now, lockedUntil: 0 };
    buckets.set(key, fresh);
    return fresh;
  }
  if (!current.lockedUntil && now - current.firstAt > WINDOW_MS) {
    current.failures = 0;
    current.firstAt = now;
  }
  return current;
}

export function loginThrottleStatus(key: string): { blocked: boolean; retryAfterMs: number } {
  const now = Date.now();
  const current = bucket(key);
  if (current.lockedUntil > now) {
    return { blocked: true, retryAfterMs: current.lockedUntil - now };
  }
  if (current.lockedUntil && current.lockedUntil <= now) {
    current.failures = 0;
    current.firstAt = now;
    current.lockedUntil = 0;
  }
  return { blocked: false, retryAfterMs: 0 };
}

export function recordLoginFailure(key: string): { blocked: boolean; retryAfterMs: number } {
  const current = bucket(key);
  current.failures += 1;
  if (current.failures >= MAX_FAILURES) {
    current.lockedUntil = Date.now() + LOCK_MS;
  }
  return loginThrottleStatus(key);
}

export function clearLoginFailures(key: string): void {
  buckets.delete(key);
}

/** Test helper. */
export function resetLoginThrottle(): void {
  buckets.clear();
}
