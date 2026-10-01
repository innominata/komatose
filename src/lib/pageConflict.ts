export function pageWriteConflict<T extends { revision: number }>(
  error: unknown,
): T | null {
  if (!(error instanceof Error)) return null;
  const err = error as Error & { status?: number; current?: T };
  if (err.status !== 409 || !err.current || !Number.isInteger(err.current.revision))
    return null;
  return err.current;
}
