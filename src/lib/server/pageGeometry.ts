import {transformPageAssets, compositePageAssets} from './cleanAssets';
import { mapTextPaths } from "../textPath";
import sharp, { type OverlayOptions } from "sharp";
import type { ImageRow, LineRow } from "../types";
import type { PageData, RegionData } from "../workflow";
import { sqlite } from "./db";
import { storePageThumbnail } from "./pageThumbnail";
import { getDoc, putDoc, readAsset, storeAsset } from "./workflowStore";
import { listLines } from "./queries";
import { layoutKey } from "./typesetting";
import { broadcast } from "./realtime";
import {randomUUID} from 'node:crypto';
import {cleaningFinishes} from '../postprocess';
import {WorkflowError} from './workflowStore';

export type PixelTransform = {
  sx: number; sy: number; dx: number; dy: number; width: number; height: number;
  /** Optional source bounds after scaling, before translation and padding. */
  crop?: { x: number; y: number; w: number; h: number };
};
type RasterColor = string | { r: number; g: number; b: number; alpha?: number };
export type EdgeColors = { left: RasterColor; right: RasterColor; top: RasterColor; bottom: RasterColor };
export type RasterBackground = RasterColor | EdgeColors;
export type GeometrySnapshot = {
  page: PageData;
  lines: { id: string; x: number | null | undefined; y: number | null | undefined; w: number | null | undefined; h: number | null | undefined; placed: boolean; region: RegionData }[];
  history?:Record<string,{undo:any[];redo:any[]}>;
  reviews?:{id:string;geometry?:unknown}[];
};

export async function captureGeometry(episodeId: string, imageId: string): Promise<GeometrySnapshot> {
  const snapshot:GeometrySnapshot={
    page: getDoc<PageData>(`page:${imageId}`, {}).data,
    lines: (await listLines(episodeId)).filter(l => l.imageId === imageId).map(l => ({
      id: l.id, x: l.x, y: l.y, w: l.w, h: l.h, placed: l.placed,
      region: getDoc<RegionData>(`region:${l.id}`, {}).data,
    })),
  };
  snapshot.history={};
  snapshot.reviews=(sqlite.prepare("SELECT id,payload,progress FROM workflow_jobs WHERE episode_id=? AND kind='page-proofread'").all(episodeId) as any[])
    .filter(r=>JSON.parse(r.payload).imageId===imageId||(JSON.parse(r.progress).pageGeometry?.imageIds??[]).includes(imageId))
    .map(r=>({id:r.id,geometry:JSON.parse(r.progress).pageGeometry}));
  for(const id of [`page:${imageId}`,...snapshot.lines.map(l=>`region:${l.id}`)]) {
    const row=sqlite.prepare('SELECT undo,redo FROM workflow_docs WHERE id=?').get(id) as any;
    snapshot.history[id]={undo:JSON.parse(row?.undo??'[]'),redo:JSON.parse(row?.redo??'[]')};
  }
  const image=sqlite.prepare('SELECT width,height FROM images WHERE id=? AND episode_id=?').get(imageId,episodeId) as any;
  if(image) {
    const hashes=new Set<string>();
    for(const p of [snapshot.page,...snapshot.history[`page:${imageId}`].undo,...snapshot.history[`page:${imageId}`].redo] as PageData[]) for(const k of ['prepared','original','cleaned','cleanBase','previousArtwork','mask'] as const) if(p[k]) hashes.add(p[k]!);
    for(const asset of hashes) {
      const meta=await sharp(await readAsset(asset)).metadata();
      if(meta.width!==image.width||meta.height!==image.height) throw new WorkflowError('An older artwork history uses an unknown page coordinate system. Stopped before editing the page so its work and history remain intact.');
    }
  }
  return snapshot;
}

/** Clip the source before compositing, including for negative nudges. */
export async function transformRaster(bytes: Buffer, t: PixelTransform, background: RasterBackground) {
  const meta = await sharp(bytes).metadata();
  const width = Math.max(1, Math.round(meta.width! * t.sx)), height = Math.max(1, Math.round(meta.height! * t.sy));
  const left = Math.max(0, -t.dx, t.crop?.x ?? 0), top = Math.max(0, -t.dy, t.crop?.y ?? 0);
  const w = Math.min(width, t.width - t.dx, t.crop ? t.crop.x + t.crop.w : width) - left;
  const h = Math.min(height, t.height - t.dy, t.crop ? t.crop.y + t.crop.h : height) - top;
  const edges = typeof background === "object" && "left" in background ? background : null;
  const canvas = sharp({ create: {
    width: t.width, height: t.height, channels: 4,
    background: edges ? "#ffffff" : background as RasterColor,
  } });
  if (w <= 0 || h <= 0) return canvas.png().toBuffer();
  const x = left + t.dx, y = top + t.dy;
  const layers: OverlayOptions[] = [];
  if (edges) {
    const strip = (left: number, top: number, width: number, height: number, color: RasterColor) => {
      if (width > 0 && height > 0) layers.push({
        input: { create: { width, height, channels: 4, background: color } }, left, top,
      });
    };
    strip(0, 0, t.width, y, edges.top);
    strip(0, y + h, t.width, t.height - y - h, edges.bottom);
    strip(0, 0, x, t.height, edges.left);
    strip(x + w, 0, t.width - x - w, t.height, edges.right);
  }
  const input = await sharp(bytes).resize(width, height, { fit: "fill" })
    .extract({ left, top, width: w, height: h }).png().toBuffer();
  return canvas.composite([...layers, { input, left: x, top: y }]).png().toBuffer();
}

export function transformRegion(line: LineRow, region: RegionData, page: ImageRow, t: PixelTransform) {
  const point = (p: { x: number; y: number }) => ({
    x: (p.x * page.width * t.sx + t.dx) / t.width,
    y: (p.y * page.height * t.sy + t.dy) / t.height,
  });
  const position = point({ x: line.x ?? 0, y: line.y ?? 0 });
  const bounds = { ...position, w: (line.w ?? 0) * page.width * t.sx / t.width, h: (line.h ?? 0) * page.height * t.sy / t.height };
  const next: RegionData = {
    ...region,
    ...(region.polygon ? { polygon: region.polygon.map(point) } : {}),
    ...mapTextPaths(region, point),
  };
  if(region.bubbleBounds) {
    const b=region.bubbleBounds;
    next.bubbleBounds={...point(b),w:b.w*page.width*t.sx/t.width,h:b.h*page.height*t.sy/t.height};
  }
  if (region.layout) {
    const old = region.layout;
    const svg = old.svg.replace(/(<svg\b[^>]*>)/, `$1<g transform="translate(${t.dx} ${t.dy}) scale(${t.sx} ${t.sy})">`).replace(/<\/svg>\s*$/, "</g></svg>")
      .replace(/(<svg\b[^>]*\bwidth=")[^"]*"/, `$1${t.width}"`)
      .replace(/(<svg\b[^>]*\bheight=")[^"]*"/, `$1${t.height}"`)
      .replace(/viewBox="[^"]*"/, `viewBox="0 0 ${t.width} ${t.height}"`);
    next.layout = { ...old, svg, width: t.width, height: t.height,
      rows: old.rows.map(r => ({ ...r, x: r.x * t.sx + t.dx, baseline: r.baseline * t.sy + t.dy, width: r.width * t.sx })) };
    next.layout.key = layoutKey(
      { ...line, ...bounds },
      next,
      { ...page, width: t.width, height: t.height },
      old.style,
      old.dpi,
    );
  }
  return { bounds, region: next };
}

export async function applyPageGeometry(episodeId: string, oldPage: ImageRow, newPage: ImageRow, snapshot: GeometrySnapshot, t: PixelTransform, background: RasterBackground) {
  const frameId=randomUUID(),cache=new Map<string,Promise<string>>();
  const raster=(asset:string,mask=false)=>{
    const key=asset+(mask?':mask':':art');
    if(!cache.has(key)) cache.set(key,(async()=>storeAsset(await transformRaster(await readAsset(asset),t,mask?'#000000':background)))());
    return cache.get(key)!;
  };
  const pageState=async(saved:PageData):Promise<PageData>=>{
    const page:PageData={...saved,placedAssets:await transformPageAssets(saved.placedAssets,t),geometryFrameId:frameId,completed:undefined,maskDiagnostics:undefined};
    for(const key of ['prepared','original','cleaned','cleanBase','previousArtwork','mask'] as const) if(saved[key]) page[key]=await raster(saved[key]!,key==='mask');
    if(page.prepared) {page.preparedAt=newPage.updatedAt;page.thumbnail=await storePageThumbnail(await compositePageAssets(await readAsset(page.cleaned??page.cleanBase??page.prepared),page));page.thumbnailAt=newPage.updatedAt;}
    if(saved.strokes) page.strokes=saved.strokes.map(s=>({...s,radius:s.radius*Math.sqrt(t.sx*t.sy),points:s.points.map(p=>({x:(p.x*oldPage.width*t.sx+t.dx)/t.width,y:(p.y*oldPage.height*t.sy+t.dy)/t.height}))}));
    if(saved.contentApprovals) page.contentApprovals=saved.contentApprovals.flatMap(a=>{
      const x=Math.max(0,a.x*t.sx+t.dx),y=Math.max(0,a.y*t.sy+t.dy),right=Math.min(t.width,(a.x+a.width)*t.sx+t.dx),bottom=Math.min(t.height,(a.y+a.height)*t.sy+t.dy);
      return right>x&&bottom>y?[{...a,x,y,width:right-x,height:bottom-y}]:[];
    });
    const finishes=[];
    for(const f of cleaningFinishes(saved)) {
      const answer=await storeAsset(await sharp(await readAsset(f.answer)).resize(oldPage.width,oldPage.height,{fit:'fill'}).png().toBuffer());
      finishes.push({...f,base:await raster(f.base),answer:await raster(answer),mask:await raster(f.mask,true),result:await raster(f.result)});
    }
    if(finishes.length) {page.cleanFinishes=finishes;page.cleanFinish=finishes.length===1?{...finishes[0],result:page.cleaned??finishes[0].result}:undefined;}
    return page;
  };
  const regionState=async(line:LineRow,saved:RegionData,history=false)=>{
    const original={...line,...(history?saved.historyBounds:{})};
    const transformed=transformRegion(original,saved,oldPage,t);
    transformed.region.geometryFrameId=frameId;
    if(original.x!=null&&original.y!=null) transformed.region.historyBounds=transformed.bounds;
    if(saved.textMask) transformed.region.textMask=await storeAsset(await transformRaster(await readAsset(saved.textMask),t,'#ffffff'));
    if(saved.layout&&saved.layout.key!==layoutKey(original,saved,oldPage,saved.layout.style,saved.layout.dpi)&&transformed.region.layout) transformed.region.layout.key=saved.layout.key;
    return transformed;
  };
  const page=await pageState(snapshot.page),currentLines=await listLines(episodeId);
  const histories:Record<string,{undo:any[];redo:any[]}>={};
  const pageHistory=snapshot.history?.[`page:${oldPage.id}`]??{undo:[],redo:[]};
  histories[`page:${oldPage.id}`]={undo:await Promise.all(pageHistory.undo.map(pageState)),redo:await Promise.all(pageHistory.redo.map(pageState))};
  const regions:({line:LineRow}&ReturnType<typeof transformRegion>)[]=[];
  for(const saved of snapshot.lines) {
    const line=currentLines.find(l=>l.id===saved.id);
    if(!line) continue;
    const oldHistory=snapshot.history?.[`region:${line.id}`]??{undo:[],redo:[]};
    histories[`region:${line.id}`]={undo:await Promise.all(oldHistory.undo.map(async r=>(await regionState(line,r,true)).region)),redo:await Promise.all(oldHistory.redo.map(async r=>(await regionState(line,r,true)).region))};
    regions.push({line,...await regionState(line,saved.region)});
  }
  sqlite.transaction(()=>{
    for(const {line,bounds:b,region} of regions) {
      if(line.placed&&line.x!=null&&line.y!=null) {
        const visible=b.x+b.w>0&&b.y+b.h>0&&b.x<1&&b.y<1;
        sqlite.prepare('UPDATE lines SET x=?,y=?,w=?,h=?,placed=?,updated_at=? WHERE id=? AND episode_id=?').run(b.x,b.y,b.w,b.h,visible?1:0,Date.now(),line.id,episodeId);
      }
      const doc=getDoc<RegionData>(`region:${line.id}`,{});putDoc(episodeId,doc.id,region,doc.revision);
    }
    const doc=getDoc<PageData>(`page:${oldPage.id}`,{});putDoc(episodeId,doc.id,page,doc.revision);
    // Geometry has its own page undo entry. Keep cleaning/style undo in the new frame.
    for(const [id,h] of Object.entries(histories)) sqlite.prepare('UPDATE workflow_docs SET undo=?,redo=? WHERE id=?').run(JSON.stringify(h.undo),JSON.stringify(h.redo),id);
    const frame=getDoc(`frame:${frameId}`,{});putDoc(episodeId,frame.id,{id:frameId,width:t.width,height:t.height,sources:[{frameId:snapshot.page.geometryFrameId??`legacy:${oldPage.id}:${oldPage.updatedAt}`,imageId:oldPage.id,transform:t}]},frame.revision);
    markGeometryReviews(episodeId,oldPage.id);
  })();
  for(const line of (await listLines(episodeId)).filter(l=>l.imageId===oldPage.id)) broadcast(episodeId,{type:'line:upsert',line});
}

export async function restoreGeometry(episodeId: string, image: ImageRow, snapshot: GeometrySnapshot) {
  sqlite.transaction(() => {
    for (const line of snapshot.lines) {
      const changed = sqlite.prepare("UPDATE lines SET x=?,y=?,w=?,h=?,placed=?,updated_at=? WHERE id=? AND episode_id=? AND image_id=?")
        .run(line.x ?? null, line.y ?? null, line.w ?? null, line.h ?? null, line.placed ? 1 : 0, Date.now(), line.id, episodeId, image.id);
      if (!changed.changes) continue;
      const doc = getDoc<RegionData>(`region:${line.id}`, {});
      putDoc(episodeId, doc.id, line.region, doc.revision);
      const history=snapshot.history?.[doc.id];
      if(history) sqlite.prepare("UPDATE workflow_docs SET undo=?,redo=? WHERE id=?").run(JSON.stringify(history.undo),JSON.stringify(history.redo),doc.id);
    }
    const doc = getDoc<PageData>(`page:${image.id}`, {});
    putDoc(episodeId, doc.id, { ...snapshot.page, ...(snapshot.page.prepared ? { preparedAt: image.updatedAt } : {}) }, doc.revision);
    const history=snapshot.history?.[doc.id];
    if(history) {
      const normalise=(states:PageData[])=>states.map(p=>({...p,...(p.prepared?{preparedAt:image.updatedAt}:{} )}));
      sqlite.prepare('UPDATE workflow_docs SET undo=?,redo=? WHERE id=?').run(JSON.stringify(normalise(history.undo)),JSON.stringify(normalise(history.redo)),doc.id);
    }
    markGeometryReviews(episodeId,image.id);
    for(const saved of snapshot.reviews??[]) {
      const row=sqlite.prepare('SELECT progress FROM workflow_jobs WHERE id=? AND episode_id=?').get(saved.id,episodeId) as any;
      if(row) {const progress=JSON.parse(row.progress);if(saved.geometry===undefined) delete progress.pageGeometry;else progress.pageGeometry=saved.geometry;sqlite.prepare('UPDATE workflow_jobs SET progress=? WHERE id=?').run(JSON.stringify(progress),saved.id);}
    }
  })();
  for (const line of (await listLines(episodeId)).filter(l => l.imageId === image.id))
    broadcast(episodeId, { type: "line:upsert", line });
}

function markGeometryReviews(episodeId:string,imageId:string) {
  for(const row of sqlite.prepare("SELECT id,payload,progress FROM workflow_jobs WHERE episode_id=? AND kind='page-proofread'").all(episodeId) as any[]) {
    const progress=JSON.parse(row.progress);
    if(JSON.parse(row.payload).imageId!==imageId&&!(progress.pageGeometry?.imageIds??[]).includes(imageId)) continue;
    progress.pageGeometry={imageIds:[...new Set([imageId,...progress.pageGeometry?.imageIds??[]])],stale:true,reason:'Page geometry changed'};
    sqlite.prepare('UPDATE workflow_jobs SET progress=? WHERE id=?').run(JSON.stringify(progress),row.id);
  }
}
