import { memoryOverview, saveMemorySettings } from '$lib/server/directorMemory';
import { json } from '@sveltejs/kit';
import { directorOverviewAsync, directorPreflight, directorWarnings, dismissDirectorWarning, resetDirectorPage, resumeDirector, startDirector, stopDirector, undoDirector } from '$lib/server/directorService';
import { fail, messageOf, requireEdit, requireEpisodeAccess, requireFullAi, requireUser, statusOf } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({locals,params,url}) => {
  try {
    const user=requireUser(locals.user);
    const {series,episode}=await requireEpisodeAccess(user,params.eid);
    requireEdit(user);
    if(url.searchParams.has('memory')) return json(await memoryOverview(series.id,episode));
    const warningsFor=url.searchParams.get('warnings');
    if(warningsFor) return json({warnings:directorWarnings(episode.id,warningsFor)});
    return json(await directorOverviewAsync(params.eid,url.searchParams.get('runId')||undefined,
      Number(url.searchParams.get('after')||0)));
  } catch(error) { return fail(statusOf(error),messageOf(error)); }
};
export const POST: RequestHandler = async ({locals,params,request}) => {
  try {
    const user=requireUser(locals.user);
    const {series,episode}=await requireEpisodeAccess(user,params.eid);
    requireEdit(user);
    const body=await request.json();
    if(body.action==='preflight') return json(await directorPreflight(series,episode,user,body.model));
    if(body.action==='memory') { requireFullAi(user); return json(saveMemorySettings(series.id,body.revision,body.data,body.rebuild===true)); }
    if (body.action==='start' || body.action==='retry-blocked') {
      requireFullAi(user);
      if (body.scope!=='page' && body.scope!=='chapter') return fail(400,'Choose page or chapter scope');
      return json(await startDirector({series,episode,user,scope:body.scope,imageId:body.imageId,
        model:body.model,recheckAll:body.recheckAll===true,retryBlocked:body.action==='retry-blocked',policy:body.policy,
        tasks:Array.isArray(body.tasks)?body.tasks.filter((task:unknown)=>typeof task==='string'):undefined}),{status:202});
    }
    if (body.action==='pause' || body.action==='stop') return json(stopDirector(episode.id,String(body.runId||''),body.action==='stop'));
    if (body.action==='resume') {
      requireFullAi(user);
      return json(await resumeDirector({series,episode,user,runId:String(body.runId||'')}),{status:202});
    }
    if (body.action==='dismiss-warning') return json(dismissDirectorWarning(episode.id,String(body.imageId||''),String(body.key||'')));
    if (body.action==='reset-page') { requireFullAi(user); return json(resetDirectorPage(episode.id,String(body.imageId||''))); }
    if (body.action==='undo') return json(undoDirector({episodeId:episode.id,runId:String(body.runId||''),
      changeId:body.changeId===undefined?undefined:Number(body.changeId),imageId:body.imageId||undefined}));
    return fail(400,'Unknown Director action');
  } catch(error) { return fail(statusOf(error),messageOf(error)); }
};
