import { playbackTestContext } from "./helpers/playback-context";
import {afterEach,expect,it,vi} from 'vitest';
import {effectScope,reactive,ref} from 'vue';
import {createPlaybackRuntime} from '../apps/web/src/features/playback/playback-runtime';
import {matchesDistributedPlaybackPlan} from '../apps/web/src/features/playback/distributed-playback-intent';
import type {PlaybackPlan,PlaybackRequest} from '../packages/protocol';
const instances=vi.hoisted(()=>[] as any[]);
vi.mock('hls.js',()=>({default:class {
 static Events={ERROR:'error'};
 static isSupported=()=>true;
 static getMediaSource=()=>({isTypeSupported:()=>true});
 static DefaultConfig={loader:class {}};
 config:any;url='';destroy=vi.fn();stopLoad=vi.fn();startLoad=vi.fn();
 constructor(config:any){this.config=config;instances.push(this)}
 loadSource(url:string){this.url=url}attachMedia(){}on(){}
}}));
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const intent={schema_version:1,job_id:id(10),output_generation:id(11)};
const request:PlaybackRequest={room_id:id(2),media_generation:4,viewer_id:id(3),plan_generation:1,mode:'auto',position_ms:5000,audio_index:null,capabilities:{progressive_h264_aac:true,native_hls:false,mse_h264_aac:true},distributed_compute:intent};
function plan(body=request):PlaybackPlan{return {
 session_id:id(5),plan_generation:body.plan_generation,media_id:id(4),media_generation:body.media_generation,delivery_mode:'transcode',transport:'hls',playback_url:`/api/v1/playback-sessions/${id(5)}/distributed/files/index.m3u8`,timeline_origin_ms:0,duration_ms:16000,expires_in_seconds:600,rebuild_on_seek:false,audio_tracks:[],subtitle_tracks:[],subtitle_mode:'none',seekable_media_ranges_ms:[{start_ms:0,end_ms:16000}],decoder_fallback_modes:[],
 distributed_compute:{...intent,attempt:2,qualification_sha256:'a'.repeat(64),manifest_sha256:'b'.repeat(64),directory_url:`/api/v1/playback-sessions/${id(5)}/distributed/directory`,p2p_enabled:true,source_video_index:0,source_audio_index:null,video_codec:'h264',width:852,height:480,audio_codec:null,audio_channels:null,audio_sample_rate:null,source_duration_ms:16000,timestamp_shift_ms:1480}
}}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();instances.length=0});
it('checks exact qualified primary plan and rejects cross-session/output/audio/timeline responses',()=>{
 const p=plan();expect(matchesDistributedPlaybackPlan(request,p)).toBe(true);
 for(const changed of [
  {...p,distributed_compute:{...p.distributed_compute!,output_generation:id(22)}},
  {...p,playback_url:`/api/v1/playback-sessions/${id(22)}/distributed/files/index.m3u8`},
  {...p,timeline_origin_ms:1480},
  {...p,rebuild_on_seek:true},
  {...p,selected_audio_track:1},
  {...p,distributed_compute:{...p.distributed_compute!,video_codec:'hevc'}},
  {...p,distributed_compute:{...p.distributed_compute!,source_audio_index:1,audio_codec:'aac',audio_channels:2,audio_sample_rate:48000}},
 ])expect(matchesDistributedPlaybackPlan(request,changed)).toBe(false);
 expect(matchesDistributedPlaybackPlan({...request,distributed_compute:undefined},p)).toBe(false);
});
function setup(options:{defer?:boolean;wrong?:boolean}={}){
 vi.useFakeTimers();vi.stubGlobal('navigator',{});vi.stubGlobal('location',{origin:'http://localhost',href:`http://localhost/rooms/${id(2)}`});
 const storage=new Map();vi.stubGlobal('sessionStorage',{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v)});
 vi.stubGlobal('document',Object.assign(new EventTarget(),{visibilityState:'visible'}));
 let resolve!:(p:PlaybackPlan)=>void;let last:PlaybackPlan|undefined;
 const api=vi.fn(async(path:string,method='GET',body?:any)=>{
  if(path==='/playback-sessions/distributed-compute'&&method==='POST'){
   last=plan(body);if(options.wrong)last.distributed_compute!.output_generation=id(23);
   if(options.defer)return new Promise<PlaybackPlan>(r=>{resolve=r});return last;
  }
  if(path===`/playback-sessions/${id(5)}/distributed/directory`)return {session_id:id(5),job_id:intent.job_id,output_generation:intent.output_generation,files:[{name:'index.m3u8',url:last!.playback_url,sha256:'b'.repeat(64),size_bytes:100},{name:'segment00000.ts',url:`/api/v1/playback-sessions/${id(5)}/distributed/files/segment00000.ts`,sha256:'c'.repeat(64),size_bytes:1000}]};
  if(path.startsWith(`/playback-sessions/${id(5)}?`))return {session_id:id(5),plan_generation:last!.plan_generation,status:'ready',complete:true};
  return {};
 });
 const session=reactive({user:{id:id(1)} as {id:string}|undefined,epoch:1,api});
 const state=ref({room_id:id(2),media_id:id(4),media_generation:4,playback_status:'paused',anchor_position_ms:5000,anchor_server_time_ms:0,playback_rate:1});
 const active = ref(true),
   clock = { ready: true, revision: 1, now: () => 10000 };
 const scope=effectScope();const runtime = scope.run(() =>
   createPlaybackRuntime(
     playbackTestContext({
       session: session as any,
       state: state as any,
       connected: ref(true),
       active,
       clock: clock as any,
     }),
   ),
 )!;
  const error = runtime.playbackError;
 const element:any=Object.assign(new EventTarget(),{canPlayType:(v:string)=>v.includes('mpegurl')?'':'probably',pause:vi.fn(),play:vi.fn(async()=>{}),load:vi.fn(),removeAttribute:vi.fn(),getAttribute:()=>null,querySelectorAll:()=>[],error:null,buffered:{length:1,start:()=>0,end:()=>16},seekable:{length:1,start:()=>0,end:()=>16},currentTime:0,playbackRate:1,paused:true,seeking:false,readyState:4,duration:16});
 runtime.attach(element);return {runtime,state,active,session,element,api,error,clock,resolve:()=>resolve(last!),cleanup:()=>scope.stop()};
}
it('attaches qualified output to main Hls player and applies original room seek/rate with no preview or automatic peer join',async()=>{
 const f=setup();try{
  await f.runtime.useDistributedOutput(intent);
  const posts=f.api.mock.calls.filter(([p,m])=>p==='/playback-sessions/distributed-compute'&&m==='POST');expect(posts).toHaveLength(1);
  const body=posts[0][2] as any;expect(body.distributed_compute).toEqual(intent);expect(body.position_ms).toBe(5000);expect(body.http_file_fallback_version).toBeUndefined();expect(body.static_hls_fallback_version).toBeUndefined();
  expect(f.runtime.sessionId.value).toBe(id(5));expect(instances.at(-1).url).toBe(plan().playback_url);expect(instances.at(-1).config.fLoader).toBeTypeOf('function');
  expect(f.api.mock.calls.some(([p])=>p==='/playback-candidates'||p.endsWith('/p2p'))).toBe(false);expect(f.runtime.peerSharing.value).toBe(false);
  await f.element.onloadedmetadata();await f.runtime.applyState(true,true);expect(f.element.currentTime).toBeCloseTo(5);
  f.state.value.anchor_position_ms=9000;f.state.value.playback_rate=1.5;await f.runtime.applyState(true,true);expect(f.element.currentTime).toBeCloseTo(9);expect(f.element.playbackRate).toBeCloseTo(1.5);
  expect(f.api.mock.calls.filter(([p,m])=>p==='/playback-sessions/distributed-compute'&&m==='POST')).toHaveLength(1);
  await f.runtime.reset();expect(instances.at(-1).destroy).toHaveBeenCalled();expect(f.runtime.distributedFacts.value).toBeUndefined();
 }finally{f.cleanup()}
});
it('late qualified primary response cannot attach after the room changes',async()=>{
 const f=setup({defer:true});try{
  const loading=f.runtime.useDistributedOutput(intent);for(let i=0;i<40;i++)await Promise.resolve();f.state.value.media_generation=5;f.resolve();await loading;
  expect(instances).toHaveLength(0);expect(f.runtime.sessionId.value).toBeNull();expect(f.api.mock.calls.some(([p,m])=>p===`/playback-sessions/${id(5)}`&&m==='DELETE')).toBe(true);
 }finally{f.cleanup()}
});
it('rejects a qualified-plan generation mismatch before main media attachment',async()=>{
 const f=setup({wrong:true});try{await expect(f.runtime.useDistributedOutput(intent)).rejects.toThrow();expect(instances).toHaveLength(0);expect(f.runtime.sessionId.value).toBeNull()}finally{f.cleanup()}
});
