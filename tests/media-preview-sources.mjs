import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";

await isolatedMediaStack("preview-sources",async f=>{
  const admin=f.client();await admin.login();
  for(const [name,options] of [["first",{}],["black-first",{blackSeconds:2}],["dark",{color:"0x202020"}],["black",{color:"black"}],["portrait",{width:360,height:640}]]) await f.makeClip(name+".mp4",options);
  execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=black:s=360x640:d=1,drawbox=x=0:y=0:w=iw:h=30:color=white:t=fill","-c:v","libx264","-threads","1","-pix_fmt","yuv420p",resolve(f.root,"edge-light.mp4")],{timeout:10000,windowsHide:true});
  await writeFile(resolve(f.root,"broken.mp4"),"broken");
  const source=await admin.request("/sources","POST",{name:"synthetic",kind:"local",config:{root:f.root}});
  await admin.request(`/sources/${source.id}/test`,"POST");
  const items=await admin.request("/media");
  await f.startWorker();
  const pixel=async(cover)=>{
    const response=await admin.raw(cover.url.replace("/api/v1",""));assert.equal(response.status,200);
    const file=resolve(f.root,`result-${cover.revision}.webp`);await writeFile(file,Buffer.from(await response.arrayBuffer()));
    const raw=execFileSync("ffmpeg",["-v","error","-i",file,"-frames:v","1","-f","rawvideo","-pix_fmt","rgb24","pipe:1"],{timeout:10000,windowsHide:true,maxBuffer:2e6});
    assert.equal(raw.length,640*360*3);return [...raw.subarray((180*640+320)*3,(180*640+320)*3+3)];
  };
  for(const item of items){
    await admin.request("/media/previews","POST",{media_ids:[item.id]});
    const unavailable=["black","broken"].includes(item.original_title);
    const cover=await f.waitForPreview(item.id,unavailable?"unavailable":"ready");
    if(!unavailable){const rgb=await pixel(cover);if(item.original_title==="dark")assert.ok(rgb.every(v=>v>=24&&v<=45));else if(item.original_title==="edge-light")assert.ok(rgb.every(v=>v<24),"frame accepted from uncropped edge light");else assert.ok(rgb[0]>180&&rgb[1]<50&&rgb[2]<50,`${item.title}: ${rgb}`);}
  }
  const video=await readFile(resolve(f.root,"first.mp4"));
  const poster=execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=blue:s=640x360","-frames:v","1","-f","image2pipe","-c:v","png","pipe:1"],{timeout:10000,windowsHide:true,maxBuffer:2e6});
  execFileSync("ffmpeg",["-v","error","-i",resolve(f.root,"first.mp4"),"-c","copy","-hls_time","0.5","-hls_segment_filename",resolve(f.root,"segment%d.ts"),resolve(f.root,"index.m3u8")],{timeout:10000,windowsHide:true});
  let requests=0,rangeRequests=0;
  const upstream=createServer(async(req,res)=>{
    requests++;
    const path=new URL(req.url,"http://fixture").pathname;
    if(path.endsWith("/Items")){res.setHeader("Content-Type","application/json");res.end(JSON.stringify({TotalRecordCount:2,Items:[{Id:"poster",Name:"poster",ImageTags:{Primary:"v1"},BackdropImageTags:["v1"]},{Id:"fallback",Name:"fallback"}]}));return;}
    if(path.includes("/Images/")){res.setHeader("Content-Type","image/png");res.end(poster);return;}
    if(path==="/redirect.mp4"){res.writeHead(302,{Location:"http://127.0.0.1:1/private"});res.end();return;}
    if(path==="/cross.m3u8"){res.end("#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:1/private.ts\n#EXT-X-ENDLIST\n");return;}
    if(path==="/slow.mp4"){res.writeHead(200);res.flushHeaders();return;}
    const bytes=path==="/index.m3u8"||path.startsWith("/segment")?await readFile(resolve(f.root,path.slice(1))):video;
    res.setHeader("ETag",'"fixture-v1"');res.setHeader("Accept-Ranges","bytes");
    if(path.endsWith(".m3u8"))res.setHeader("Content-Type","application/vnd.apple.mpegurl");
    let start=0,end=bytes.length-1;
    if(req.headers.range){rangeRequests++;const match=/bytes=(\d+)-(\d*)/.exec(req.headers.range);start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),end):end;res.statusCode=206;res.setHeader("Content-Range",`bytes ${start}-${end}/${bytes.length}`);}
    res.setHeader("Content-Length",end-start+1);res.end(req.method==="HEAD"?undefined:bytes.subarray(start,end+1));
  });
  await new Promise(r=>upstream.listen(0,"127.0.0.1",r));
  const origin=`http://127.0.0.1:${upstream.address().port}`;
  try {
    for(const path of ["/video.mp4","/index.m3u8","/redirect.mp4","/cross.m3u8","/slow.mp4"]){
      console.log("Checking HTTP",path);
      const s=await admin.request("/sources","POST",{name:path,kind:"http",config:{url:origin+path,headers:{Authorization:"fixture-only"}}});await admin.request(`/sources/${s.id}/test`,"POST");
      const id=f.sql(`SELECT id FROM media_items WHERE source_id='${s.id}'`);await admin.request("/media/previews","POST",{media_ids:[id]});
      const cover=await f.waitForPreview(id,["/video.mp4","/index.m3u8"].includes(path)?"ready":"unavailable",60000);
      if(cover.status==="ready"){const rgb=await pixel(cover);assert.ok(rgb[0]>180&&rgb[2]<50);}
    }
    for(const kind of ["jellyfin","emby"]){
      const s=await admin.request("/sources","POST",{name:kind,kind,config:{url:origin,token:"fixture",user_id:"fixture"}});await admin.request(`/sources/${s.id}/test`,"POST");
      const ids=f.sql(`SELECT id FROM media_items WHERE source_id='${s.id}' ORDER BY resource`).split("\n");
      for(const id of ids){await admin.request("/media/previews","POST",{media_ids:[id]});const cover=await f.waitForPreview(id);const rgb=await pixel(cover);const item=await admin.request(`/media/${id}`);if(item.title==="poster")assert.ok(rgb[2]>180&&rgb[0]<50);else assert.ok(rgb[0]>180&&rgb[2]<50);}
    }
    assert.ok(requests>0&&rangeRequests>0);
    const {agentId}=await f.startAgent();
    await f.waitForSql(`SELECT count(*) FROM media_items WHERE source_id='${agentId}' AND resource='first.mp4'`,"1",15000);
    const id=f.sql(`SELECT id FROM media_items WHERE source_id='${agentId}' AND resource='first.mp4'`);
    await admin.request("/media/previews","POST",{media_ids:[id]});const cover=await f.waitForPreview(id);assert.ok((await pixel(cover))[0]>180);
    await f.stopAgent();
    f.sql(`UPDATE media_items SET preview_generation=preview_generation+1 WHERE id='${id}'`);
    await admin.request('/media/previews','POST',{media_ids:[id]});await f.waitForPreview(id,'unavailable',60000);
    // Replace the actual NAS file and restart the same owned agent/credentials.
    await f.makeClip('first.mp4',{color:'blue'});await f.startAgent();
    await f.waitForSql(`SELECT count(*) FROM agents WHERE id='${agentId}' AND last_seen>now()-interval '5 seconds'`,'1',15000);
    f.sql(`UPDATE media_previews SET next_attempt_at=now()-interval '1 second' WHERE media_id='${id}'`);
    await admin.request('/media/previews','POST',{media_ids:[id]});const recovered=await f.waitForPreview(id);assert.ok((await pixel(recovered))[2]>180,'NAS recovery uses changed file');
    await admin.request(`/agents/${agentId}`,"DELETE");
    assert.notEqual((await admin.raw(cover.url.replace("/api/v1",""))).status,200);
    assert.equal((await admin.request(`/media/previews?ids=${id}`)).items.length,0);
    await f.stopAgent();await delay(300);
    assert.equal(f.sql("SELECT count(*) FROM playback_sessions"),"0");
    console.log("PASS: real sequential local decode, dark/black/corrupt/portrait, HTTP Range/HLS and rejected redirect/cross-origin/stall, upstream poster priority/fallback, real NAS relay/revoke, no playback sessions. Upstream servers here are protocol fixtures, not Jellyfin/Emby products.");
  } finally {upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
},{env:{MEDIA_PREVIEW_TIMEOUT_SECONDS:"5"}});
