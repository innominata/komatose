import { error, fail } from '@sveltejs/kit';
import { canUpload } from '$lib/server/access';
import { importSeriesBackup, listSeriesBackups, restoreSeriesBackup } from '$lib/server/seriesBackups';
import { messageOf, statusOf } from '$lib/server/http';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
  if (!canUpload(locals.user!)) error(403, 'Forbidden');
  return { backups: await listSeriesBackups(locals.user!), filter: url.searchParams.get('series') || '' };
};

export const actions: Actions = {
  import: async ({ request, locals }) => {
    try {
      if (!canUpload(locals.user!)) return fail(403, { error: 'Forbidden' });
      const form = await request.formData(), file = form.get('backup');
      if (!(file instanceof File) || !file.size) return fail(400, { error: 'Choose a series backup ZIP.' });
      const backup = await importSeriesBackup(Buffer.from(await file.arrayBuffer()), locals.user!);
      return { message: `Imported “${backup.label}”. Select Restore when you are ready to use it.` };
    } catch (e) { return fail(statusOf(e), { error: messageOf(e) }); }
  },
  restore: async ({ request, locals }) => {
    try {
      if (!canUpload(locals.user!)) return fail(403, { error: 'Forbidden' });
      const form = await request.formData();
      if (form.get('confirmation') !== 'restore') return fail(400, { error: 'Confirm the series restore first.' });
      const result = await restoreSeriesBackup(String(form.get('backupId') || ''), locals.user!);
      return { message: `Series restored.${result.safetyBackupId ? ' Its previous state was saved as a safety backup.' : ''}`, restoredSeriesId: result.seriesId };
    } catch (e) { return fail(statusOf(e), { error: messageOf(e) }); }
  },
};
