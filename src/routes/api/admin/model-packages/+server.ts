import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fail, messageOf, requireManageUsers, requireUser, statusOf } from '$lib/server/http';
import { discoverModelPackages } from '$lib/server/modelPackages';
import { operatePackage, packageServiceStatus, startPackageOperation, cancelPackageOperation, packageOperation } from '$lib/server/modelSupervisor';
import { findRegistryRow, invalidateRegistryCache, upsertRegistryRow } from '$lib/server/modelRegistryStore';
import { migrateModelPackages } from '$lib/server/modelPackageMigration';

export const GET: RequestHandler = async ({ locals }) => {
  try {
    requireManageUsers(requireUser(locals.user));
    const discovered = discoverModelPackages();
    return json({ ...discovered, packages: discovered.packages.map(p => ({ id: p.manifest.id, name: p.manifest.name,
      revision: p.manifest.revision, adapter: p.manifest.adapter.id, lifecycle: Object.keys(p.manifest.lifecycle || {}),
      service: packageServiceStatus(p), operation: packageOperation(p.manifest.id) })) });
  } catch (e) { return fail(statusOf(e), messageOf(e)); }
};
export const POST: RequestHandler = async ({ locals, request }) => {
  try {
    requireManageUsers(requireUser(locals.user));
    const body = await request.json();
    if (body.action === 'refresh') {
      const result = discoverModelPackages(true);
      migrateModelPackages();
      invalidateRegistryCache();
      return json({ ok: true, count: result.packages.length, errors: result.errors });
    }
    if (body.action === 'model-updated') {
      const row = findRegistryRow(String(body.id));
      if (!row) return fail(404, 'Unknown model');
      upsertRegistryRow({ ...row, modelRevision: String(Date.now()) });
      return json({ ok: true });
    }
    if (body.action === 'cancel') { cancelPackageOperation(String(body.id)); return json({ ok: true }); }
    if (['install', 'start', 'stop'].includes(body.action)) return json({ ok: true, operation: startPackageOperation(String(body.id), body.action) });
    if (!['install', 'installation-status', 'start', 'health', 'stop'].includes(body.action)) return fail(400, 'Unknown package action');
    const output = await operatePackage(String(body.id), body.action, request.signal);
    return json({ ok: true, output });
  } catch (e) { return fail(statusOf(e), messageOf(e)); }
};
