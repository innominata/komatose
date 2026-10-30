import { captureExport, finishedPsd } from '$lib/server/finishedExport';
import { attachmentFilename } from '$lib/server/export';
import { json } from '@sveltejs/kit';
import { assertEpisodeIdle, fail, messageOf, requireClean, requireEdit, requireEpisodeAccess, requireUser, statusOf } from '$lib/server/http';
import { applyPsdImport, planPsdImport } from '$lib/server/psdImport';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = async ({ locals,params,url }) => {
 try {
  const user=requireUser(locals.user);const {series,episode}=await requireEpisodeAccess(user,params.eid);
  const draft=url.searchParams.get('draft')==='1';const snapshot=await captureExport(series,episode,'psd',draft);
  const page=snapshot.pages.find(p=>p.image.id===params.imgid);if(!page)return fail(404,'Page not found');
  return new Response(new Uint8Array(await finishedPsd(page)),{headers:{'content-type':'image/vnd.adobe.photoshop','content-disposition':attachmentFilename(`${draft?'DRAFT-':''}${page.image.pageNumber??snapshot.pages.indexOf(page)+1}.psd`)}});
 }catch(e){return fail(statusOf(e),messageOf(e));}
};
/** Import edits from a PSD this page exported: `apply=1` saves them, otherwise the planned changes are listed. */
export const POST: RequestHandler = async ({ locals,params,request }) => {
 try {
  const user=requireUser(locals.user);requireEdit(user);requireClean(user);
  const {series,episode}=await requireEpisodeAccess(user,params.eid);assertEpisodeIdle(episode.id);
  const form=await request.formData();const file=form.get('file');
  if(!(file instanceof File)||!file.size)return fail(400,'No file');
  const plan=await planPsdImport(series,episode,params.imgid,Buffer.from(await file.arrayBuffer()));
  const summary={regions:plan.regions.map(r=>({lineId:r.lineId,layer:r.layer,changes:r.describe})),created:plan.created.map(r=>({layer:r.layer,text:r.body.slice(0,80)})),artwork:!!plan.artwork,warnings:plan.warnings,fromExport:plan.fromExport};
  if(form.get('apply')!=='1')return json(summary);
  const {failed}=await applyPsdImport(series,episode,user.id,plan);
  return json({...summary,applied:true,failed});
 }catch(e){return fail(statusOf(e),messageOf(e));}
};
