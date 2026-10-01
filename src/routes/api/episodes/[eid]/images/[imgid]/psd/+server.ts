import { captureExport, finishedPsd } from '$lib/server/finishedExport';
import { attachmentFilename } from '$lib/server/export';
import { fail, messageOf, requireEpisodeAccess, requireUser, statusOf } from '$lib/server/http';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = async ({ locals,params,url }) => {
 try {
  const user=requireUser(locals.user);const {series,episode}=await requireEpisodeAccess(user,params.eid);
  const draft=url.searchParams.get('draft')==='1';const snapshot=await captureExport(series,episode,'psd',draft);
  const page=snapshot.pages.find(p=>p.image.id===params.imgid);if(!page)return fail(404,'Page not found');
  return new Response(new Uint8Array(await finishedPsd(page)),{headers:{'content-type':'image/vnd.adobe.photoshop','content-disposition':attachmentFilename(`${draft?'DRAFT-':''}${page.image.pageNumber??snapshot.pages.indexOf(page)+1}.psd`)}});
 }catch(e){return fail(statusOf(e),messageOf(e));}
};
