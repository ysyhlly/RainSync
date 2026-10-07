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

import {PEER_AUTHORIZATION_MS,RoomP2PTransport} from '../apps/web/src/features/playback/room-p2p';
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

const receiverId='44444444-4444-4444-8444-444444444444';
const uploaderId='55555555-5555-4555-8555-555555555555';
const authorization=(peer_id:string,remote:string,lease_ms=PEER_AUTHORIZATION_MS)=>({version:1,peer_id,room_id:room,job_id:job,output_generation:room,session_id:null,lease_ms,peers:[{peer_id:remote,lease_ms}]});
async function transferPair() {
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('location', { origin: 'http://localhost' });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(value => value.toString(16).padStart(2, '0')).join('');
  const segment = { ...file, sha256, size_bytes: bytes.byteLength };
  const value = { ...directory, files: [directory.files[0], segment] };
  const api = vi.fn(async () => value);
  const receiver = new RoomP2PTransport(api as any, room, job);
  const uploader = new RoomP2PTransport(api as any, room, job);
  await Promise.all([receiver.prepare(), uploader.prepare()]);
  // This fixture substitutes only the established WebRTC channels; transfers
  // still execute production framing, hashing, upload and cancellation logic.
  const a = receiver as any, b = uploader as any;
  a.stopped = b.stopped = false;
  const errors: unknown[] = [];
  const makePeer = () => ({
    pc: { close: vi.fn() }, pending: new Map(), cancelled: new Set(), uploads: new Set(), ice: [],
    channel: { readyState: 'open', bufferedAmount: 0, close: vi.fn(), send: vi.fn() },
  });
  const receiving = makePeer(), uploading = makePeer();
  a.peerId=receiverId;b.peerId=uploaderId;
  a.peers.set(uploaderId, receiving);
  b.peers.set(receiverId, uploading);
  a.applyAuthorization(authorization(receiverId,uploaderId),performance.now());
  b.applyAuthorization(authorization(uploaderId,receiverId),performance.now());
  receiving.channel.send.mockImplementation((data: unknown) => {
    void Promise.resolve().then(() => b.receive(receiverId, uploading, data)).catch(error => errors.push(error));
  });
  uploading.channel.send.mockImplementation((data: unknown) => {
    void Promise.resolve().then(() => a.receive(uploaderId, receiving, data)).catch(error => errors.push(error));
  });
  b.remember(segment, bytes.buffer);
  return { receiver, uploader, a, b, receiving, uploading, segment, bytes, errors };
}

it('keeps a healthy peer connected after more than sixteen completed transfers', async () => {
  const f = await transferPair();
  try {
    for (let i = 0; i < 20; i++) {
      expect(new Uint8Array(await f.receiver.load(f.segment.url, 20, new AbortController().signal)))
        .toEqual(f.bytes);
    }
    const controls = f.receiving.channel.send.mock.calls.map(([data]) => JSON.parse(data));
    expect(controls.filter(value => value.type === 'cancel')).toHaveLength(0);
    expect(f.uploading.cancelled.size).toBe(0);
    expect(f.b.peers.size).toBe(1);
    expect(f.uploading.pc.close).not.toHaveBeenCalled();
    expect(f.errors).toEqual([]);
  } finally { await Promise.all([f.receiver.stop(), f.uploader.stop()]); }
});

it('ignores late cancellations for completed or rejected requests but retains active cancellation', async () => {
  const f = await transferPair();
  try {
    for (let id = 1; id <= 20; id++)
      await f.b.receive(receiverId, f.uploading, JSON.stringify({ type: 'cancel', id }));
    expect(f.uploading.cancelled.size).toBe(0);
    expect(f.b.peers.size).toBe(1);
    f.uploading.uploads.add(21);
    await f.b.receive(receiverId, f.uploading, JSON.stringify({ type: 'cancel', id: 21 }));
    expect(f.uploading.cancelled.has(21)).toBe(true);
    await f.b.upload(receiverId, f.uploading, 21, f.bytes.buffer);
    expect(f.uploading.channel.send).not.toHaveBeenCalled();
  } finally { await Promise.all([f.receiver.stop(), f.uploader.stop()]); }
});

it('sends a cancellation for an aborted unfinished peer transfer', async () => {
  const f = await transferPair();
  try {
    f.receiving.channel.send.mockImplementation(() => {});
    const controller = new AbortController();
    const loading = f.receiver.load(f.segment.url, 20, controller.signal);
    const rejected = expect(loading).rejects.toThrow('Aborted');
    controller.abort();
    await rejected;
    const controls = f.receiving.channel.send.mock.calls.map(([data]) => JSON.parse(data));
    expect(controls.map(value => value.type)).toEqual(['request', 'cancel']);
    expect(f.receiving.pending.size).toBe(0);
  } finally { await Promise.all([f.receiver.stop(), f.uploader.stop()]); }
});

const request=(id=1)=>JSON.stringify({type:'request',id,name:file.name,job,generation:room});
const fakeLeaseClock=()=>vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date','performance']});
it('closes a removed remote peer before serving its cached segment, without relying on the receiver',async()=>{
  const f=await transferPair();
  try{
    const api=vi.fn(async(_path:string)=>({cursor:1,signals:[],authorization:{...authorization(uploaderId,receiverId),peers:[]}}));
    f.b.api=api;f.b.nextAuthorization=Infinity;
    await f.b.poll();
    expect(api.mock.calls[0][0]).toContain(`peers=${receiverId}`);
    expect(f.uploading.channel.close).toHaveBeenCalledOnce();
    expect(f.uploading.pc.close).toHaveBeenCalledOnce();
    expect(f.uploader.active).toBe(true);
    await f.b.receive(receiverId,f.uploading,request());
    expect(f.uploading.channel.send).not.toHaveBeenCalled();
    expect(f.uploader.stats.uploadedBytes).toBe(0);
  }finally{await Promise.all([f.receiver.stop(),f.uploader.stop()]);}
});
it('closes and denies an expired remote ticket even when the expiry callback has not run',async()=>{
  fakeLeaseClock();const f=await transferPair();
  try{
    f.b.applyAuthorization({...authorization(uploaderId,receiverId),peers:[{peer_id:receiverId,lease_ms:20}]},performance.now());
    // Simulate a suspended/delayed timer: the synchronous send gate still fences it.
    clearTimeout(f.b.authorizationTimer);
    await vi.advanceTimersByTimeAsync(21);
    await f.b.receive(receiverId,f.uploading,request());
    expect(f.uploading.channel.send).not.toHaveBeenCalled();
    expect(f.uploading.pc.close).toHaveBeenCalledOnce();
  }finally{await Promise.all([f.receiver.stop(),f.uploader.stop()]);}
});
it('halts uploads that were waiting for rate pacing when a peer is removed',async()=>{
  fakeLeaseClock();const f=await transferPair();
  try{
    f.b.uploadAt=performance.now()+100;
    await f.b.receive(receiverId,f.uploading,request());
    expect(f.uploading.uploads.has(1)).toBe(true);
    f.b.applyAuthorization({...authorization(uploaderId,receiverId),peers:[]},performance.now());
    await vi.advanceTimersByTimeAsync(101);
    expect(f.uploading.channel.send).not.toHaveBeenCalled();
    expect(f.uploading.uploads.size).toBe(0);
  }finally{await Promise.all([f.receiver.stop(),f.uploader.stop()]);}
});
it('rechecks remote authorization after buffered-channel backpressure clears',async()=>{
  fakeLeaseClock();const f=await transferPair();
  try{
    let unblock!:()=>void;
    Object.assign(f.uploading.channel,{bufferedAmount:256*1024,addEventListener:vi.fn((_event,callback)=>{unblock=callback}),removeEventListener:vi.fn()});
    await f.b.receive(receiverId,f.uploading,request());
    f.b.applyAuthorization({...authorization(uploaderId,receiverId),peers:[]},performance.now());
    f.uploading.channel.bufferedAmount=0;unblock();
    await Promise.resolve();await Promise.resolve();
    expect(f.uploading.channel.send).not.toHaveBeenCalled();
  }finally{await Promise.all([f.receiver.stop(),f.uploader.stop()]);}
});
it('expires sharing independently of a stalled poll, and a late reply cannot revive it',async()=>{
  fakeLeaseClock();const f=await transferPair();
  try{
    let reply!:(value:unknown)=>void;
    f.b.api=vi.fn((path:string)=>path.includes('?')?new Promise(resolve=>{reply=resolve}):Promise.resolve({}));
    const polling=f.b.poll();
    await vi.advanceTimersByTimeAsync(PEER_AUTHORIZATION_MS+1);
    expect(f.uploader.active).toBe(false);
    expect(f.uploading.pc.close).toHaveBeenCalledOnce();
    reply({cursor:5,signals:[],authorization:authorization(uploaderId,receiverId)});
    await polling;
    expect(f.uploader.active).toBe(false);expect(f.b.peers.size).toBe(0);
    expect(f.b.authorizedPeers.size).toBe(0);
  }finally{await Promise.all([f.receiver.stop(),f.uploader.stop()]);}
});
it('deducts round-trip time rather than extending a lease at receipt',async()=>{
  fakeLeaseClock();const f=await transferPair();
  try{
    const requestedAt=performance.now();
    await vi.advanceTimersByTimeAsync(1000);
    f.b.applyAuthorization(authorization(uploaderId,receiverId),requestedAt);
    expect(f.b.authorizedUntil-performance.now()).toBe(2000);
    await vi.advanceTimersByTimeAsync(2001);
    expect(f.uploader.active).toBe(false);
  }finally{await Promise.all([f.receiver.stop(),f.uploader.stop()]);}
});
it.each([
  {peer_id:receiverId},{room_id:job},{job_id:room},{output_generation:job},{session_id:sid},
  {version:2},{lease_ms:0},{lease_ms:PEER_AUTHORIZATION_MS+1},
  {peers:[{peer_id:receiverId,lease_ms:PEER_AUTHORIZATION_MS+1}]},
  {peers:[{peer_id:receiverId,lease_ms:1},{peer_id:receiverId,lease_ms:1}]},
  {peers:[{peer_id:uploaderId,lease_ms:1}]},
])('fails closed for a poll with mismatched or malformed authorization %j',async changed=>{
  const f=await transferPair();
  try{
    f.b.api=vi.fn(async()=>({cursor:1,signals:[],authorization:{...authorization(uploaderId,receiverId),...changed}}));
    await f.b.poll();
    expect(f.uploader.active).toBe(false);expect(f.uploading.pc.close).toHaveBeenCalledOnce();
  }finally{await Promise.all([f.receiver.stop(),f.uploader.stop()]);}
});
it('fails closed when an older server omits the peer authorization contract',async()=>{
  const f=await transferPair();
  try{
    f.b.api=vi.fn(async()=>({cursor:1,signals:[]}));
    await f.b.poll();expect(f.uploader.active).toBe(false);
  }finally{await Promise.all([f.receiver.stop(),f.uploader.stop()]);}
});
it('ignores unauthorized queued signaling senders after applying the latest snapshot',async()=>{
  const f=await transferPair();
  try{
    f.b.api=vi.fn(async()=>({cursor:1,signals:[{sender:receiverId,kind:'offer',payload:{}}],authorization:{...authorization(uploaderId,receiverId),peers:[]}}));
    f.b.nextAuthorization=Infinity;
    await f.b.poll();expect(f.uploader.active).toBe(true);expect(f.b.peers.size).toBe(0);
  }finally{await Promise.all([f.receiver.stop(),f.uploader.stop()]);}
});
