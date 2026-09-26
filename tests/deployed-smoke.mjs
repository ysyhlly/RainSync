import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chromium} from '@playwright/test';
import WS from 'ws';
const base=process.env.TEST_ORIGIN??'http://localhost:8088';
const config=Object.fromEntries((await readFile('.env','utf8')).split(/\r?\n/).filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1)]}));
let cookie='',csrf='';
async function api(path,method='GET',body){const r=await fetch(base+'/api/v1'+path,{method,headers:{Origin:base,Cookie:cookie,'Content-Type':'application/json','x-csrf-token':csrf},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const value=await r.json();assert.equal(r.status,200,`${path}: ${JSON.stringify(value)}`);return value}
await writeFile('media/rainsync-demo.srt','1\n00:00:05,000 --> 00:00:08,000\nRainSync subtitle check\n');
csrf=(await api('/auth/login','POST',{username:'admin',password:config.ADMIN_PASSWORD})).csrf;
let source=(await api('/sources')).find(s=>s.name==='本地演示片源');if(!source)source=await api('/sources','POST',{name:'本地演示片源',kind:'local',config:{root:'/media'}});await api(`/sources/${source.id}/test`,'POST');
const media=(await api('/media')).find(m=>m.title==='rainsync-demo' && m.kind==='local');assert.ok(media);assert.ok(media.duration_ms>19000,'ffprobe discovers duration');
let room=(await api('/rooms')).find(r=>r.name==='RainSync 验证放映室');if(!room)room=await api('/rooms','POST',{name:'RainSync 验证放映室'});
const ws=new WS(base.replace('http','ws')+'/api/v1/ws',{headers:{Origin:base,Cookie:cookie}});const inbox=[];ws.on('message',b=>inbox.push(JSON.parse(b)));await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});ws.send(JSON.stringify({type:'JOIN',room_id:room.id}));
async function wait(type){for(let i=0;i<100;i++){const n=inbox.findIndex(v=>v.type===type);if(n>=0)return inbox.splice(n,1)[0];await new Promise(r=>setTimeout(r,100))}throw Error('missing '+type)}
let state=(await wait('SNAPSHOT')).state;
ws.send(JSON.stringify({protocol_version:1,room_id:room.id,command_id:randomUUID(),expected_revision:state.revision,media_generation:state.media_generation,type:'CHANGE_MEDIA',payload:{media_id:media.id}}));state=(await wait('ACK')).state;
const unsupported=await fetch(base+'/api/v1/playback-sessions',{method:'POST',headers:{Origin:base,Cookie:cookie,'Content-Type':'application/json','x-csrf-token':csrf},body:JSON.stringify({room_id:room.id,media_generation:state.media_generation,mode:'transcode',capabilities:{progressive_h264_aac:true,native_hls:false,mse_h264_aac:false}})});
assert.equal(unsupported.status,422,'reject HLS output on a progressive-only device');
assert.equal((await unsupported.json()).error.code,'DEVICE_HAS_NO_COMPATIBLE_PLAYBACK_TRANSPORT');
for(const mode of ['direct','remux','transcode']){
 const plan=await api('/playback-sessions','POST',{room_id:room.id,media_generation:state.media_generation,mode,position_ms:mode==='direct'?0:4000});
 const response=await fetch(base+plan.playback_url);assert.equal(response.status,200,mode);
 assert.ok(plan.subtitle_tracks.length>0,'sidecar subtitle discovered');const subtitle=await(await fetch(base+plan.subtitle_tracks[0].url)).text();assert.ok(subtitle.startsWith('WEBVTT'));assert.ok(subtitle.includes('RainSync subtitle check'));if(mode!=='direct')assert.ok(subtitle.includes('00:01.000')||subtitle.includes('00:00:01.000'),'subtitle uses rebased timeline');
 if(mode==='direct'){assert.ok((await response.arrayBuffer()).byteLength>10000)}else{
  const text=await response.text();assert.ok(text.startsWith('#EXTM3U'));const segment=text.split('\n').find(l=>l.startsWith('/media-delivery')&&!l.startsWith('#'));assert.ok(segment);assert.ok((await(await fetch(base+segment)).arrayBuffer()).byteLength>1000);
  execFileSync('docker',['run','--rm','rainsync-server:dev','ffmpeg','-v','error','-i','http://host.docker.internal:8088'+plan.playback_url,'-t','1','-f','null','-'],{stdio:'pipe',timeout:60000});
 }
 await api(`/playback-sessions/${plan.session_id}`,'DELETE');console.log('PASS deployed playback:',mode);
}
ws.close();
const browser=await chromium.launch();try{
 const pages=[];for(let i=0;i<2;i++){
  const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();pages.push(page);await page.goto(base);await page.getByLabel('用户名',{exact:true}).fill('admin');await page.getByLabel('密码',{exact:true}).fill(config.ADMIN_PASSWORD);await page.getByRole('button',{name:'进入影院'}).click();await page.getByLabel('选择房间').selectOption(room.id);await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2);
 }
 await pages[0].getByRole('button',{name:'▷ 播放',exact:true}).click();
 for(const page of pages){const button=page.getByRole('button',{name:'点击加入播放'});try{await button.waitFor({timeout:2000});await button.click()}catch{}}
 await new Promise(r=>setTimeout(r,2500));const positions=await Promise.all(pages.map(p=>p.locator('video').evaluate(v=>v.currentTime)));assert.ok(positions.every(p=>p>1));assert.ok(Math.abs(positions[0]-positions[1])<1);
 await mkdir('.runtime',{recursive:true});await pages[0].screenshot({path:'.runtime/live-playback.png',fullPage:true});
 await pages[0].getByRole('button',{name:'Ⅱ 暂停',exact:true}).click();
 console.log('PASS two real browser players: both advancing, difference below 1 second');
}finally{await browser.close()}
