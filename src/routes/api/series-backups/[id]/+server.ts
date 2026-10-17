import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { getSeriesBackup, seriesBackupArchivePath } from '$lib/server/seriesBackups';
import { fail, messageOf, requireUser, statusOf } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
  try {
    const backup = await getSeriesBackup(params.id, requireUser(locals.user));
    const stream = createReadStream(seriesBackupArchivePath(backup.id));
    return new Response(Readable.toWeb(stream) as unknown as BodyInit, { headers: {
      'content-type': 'application/zip', 'content-length': String(backup.bytes),
      'content-disposition': `attachment; filename="series-backup-${backup.id}.zip"`,
      'cache-control': 'private, no-store',
    } });
  } catch (e) { return fail(statusOf(e), messageOf(e)); }
};
