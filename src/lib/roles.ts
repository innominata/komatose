/**
 * Role vocabulary.
 *
 * This module deliberately imports nothing. `types.ts` re-exports these so the
 * rest of the app keeps using `$lib/types`, while the model registry can read
 * `ROLES` without pulling `types.ts` in — that edge used to close the cycle
 * `types.ts → providerCatalog.ts → modelRegistry.ts → types.ts`, which left
 * `PROVIDER_IDS` in its temporal dead zone and blanked the studio at runtime.
 */
export type Role = 'admin' | 'scanlator' | 'translator' | 'proofreader' | 'typesetter';

export const ROLES: Role[] = ['admin', 'scanlator', 'translator', 'proofreader', 'typesetter'];

/** Regular workflow accounts. Scanlators can create these, not admins or other scanlators. */
export const STAFF_ROLES: Role[] = ['translator', 'proofreader', 'typesetter'];
