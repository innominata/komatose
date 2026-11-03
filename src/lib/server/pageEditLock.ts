const runtime = globalThis as typeof globalThis & {
  __pageReframeLocks?: Set<string>;
};
export const pageEditLocks = (runtime.__pageReframeLocks ??= new Set<string>());
