import {describe,it,expect} from 'vitest';
import {validateSharedDirectory,peerWaitMs,verifySharedBytes} from '../apps/web/src/features/playback/room-p2p';
const room='11111111-1111-4111-8111-111111111111',job='22222222-2222-4222-8222-222222222222';
const file={name:'segment00000.ts',url:`/api/v1/rooms/${room}/compute/${job}/files/segment00000.ts`,sha256:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',size_bytes:1};
const directory={job_id:job,output_generation:room,files:[{...file,name:'index.m3u8',url:`/api/v1/rooms/${room}/compute/${job}/files/index.m3u8`},file]};
describe('opt-in room P2P boundaries',()=>{
 it('binds trusted names URLs generations and lengths',()=>{expect(validateSharedDirectory(directory,room,job)).toBe(directory);for(const changed of [{...directory,job_id:room},{...directory,files:[...directory.files,file]},{...directory,files:[directory.files[0],{...file,url:'https://evil.invalid/segment.ts'}]},{...directory,files:[directory.files[0],{...file,size_bytes:8388609}]}])expect(()=>validateSharedDirectory(changed,room,job)).toThrow();});
 it('starts with HTTP and reserves playback deadline fallback',()=>{expect(peerWaitMs(100000,3)).toBe(0);expect(peerWaitMs(100000,11.9)).toBe(0);expect(peerWaitMs(100000,20)).toBe(2000);expect(peerWaitMs(8000000,12)).toBe(0);expect(peerWaitMs(100000,NaN)).toBe(0)});
 it('never accepts peer self asserted hash or short bytes',async()=>{expect(await verifySharedBytes(file,new ArrayBuffer(0))).toBe(false);expect(await verifySharedBytes(file,new Uint8Array([1]).buffer)).toBe(false)});
});

import {RoomP2PTransport} from '../apps/web/src/features/playback/room-p2p';
import {afterEach,vi} from 'vitest';
const sid='33333333-3333-4333-8333-333333333333';
const primaryDirectory={...directory,session_id:sid,files:directory.files.map(f=>({...f,url:`/api/v1/playback-sessions/${sid}/distributed/files/${f.name}`}))};
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()});
it('trusted primary directory is exact-session and exact-output, while preview scope cannot borrow it',()=>{
 expect(validateSharedDirectory(primaryDirectory,room,job,sid,room)).toBe(primaryDirectory);
 expect(()=>validateSharedDirectory(primaryDirectory,room,job,job,room)).toThrow();
 expect(()=>validateSharedDirectory(primaryDirectory,room,job,sid,job)).toThrow();
 expect(()=>validateSharedDirectory(primaryDirectory,room,job)).toThrow();
});
it('primary HTTP initialization does not consent, and a late join after stop cannot restart sharing',async()=>{
 vi.useFakeTimers();vi.stubGlobal('document',Object.assign(new EventTarget(),{visibilityState:'visible'}));vi.stubGlobal('navigator',{});
 let joined!:(v:any)=>void;
 const api=vi.fn(async(path:string,method='GET')=>{
  if(path.endsWith('/directory'))return primaryDirectory;
  if(path.endsWith('/distributed/p2p'))return new Promise(r=>{joined=r});
  return {};
 });
 const transport=new RoomP2PTransport(api as any,room,job,()=>{},{session:sid,outputGeneration:room});
 await transport.prepare();expect(transport.active).toBe(false);expect(api.mock.calls.some(([p])=>p.endsWith('/p2p'))).toBe(false);
 const starting=transport.start({acknowledge_peer_addresses:true,confirm_current_network:true,upload_allowed:true});
 for(let n=0;n<10;n++)await Promise.resolve();await transport.stop();joined({peer_id:sid,peers:[],output_generation:room});
 await expect(starting).rejects.toThrow();expect(transport.active).toBe(false);expect(api.mock.calls.some(([p,m])=>p===`/room-p2p/${sid}`&&m==='DELETE')).toBe(true);
});
