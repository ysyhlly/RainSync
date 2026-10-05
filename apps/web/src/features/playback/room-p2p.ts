import type { ApiClient } from '../../shared/api/client';
export interface SharedFile { name:string; url:string; sha256:string; size_bytes:number }
export interface SharedDirectory { session_id?:string; job_id:string; output_generation:string; files:SharedFile[] }
export interface PeerStats { peerBytes:number; httpBytes:number; uploadedBytes:number; duplicateBytes:number; badHashes:number; fallbacks:number }
interface Pending { file:SharedFile; data:Uint8Array; received:number; resolve:(data:ArrayBuffer)=>void; reject:(error:Error)=>void }
interface Peer { pc:RTCPeerConnection; channel?:RTCDataChannel; pending:Map<number,Pending>; cancelled:Set<number>; uploads:Set<number>; ice:RTCIceCandidateInit[] }
export const MAX_FILE_BYTES=8*1024*1024;
export const CACHE_BYTES=32*1024*1024;
const MAX_PEERS=3, CHUNK_BYTES=8192, HIGH_WATER=128*1024;
const shaPattern=/^[a-f0-9]{64}$/;
const uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function validateSharedDirectory(value:SharedDirectory,room:string,job:string,session?:string,outputGeneration?:string):SharedDirectory {
  if(!uuidPattern.test(room)||!uuidPattern.test(job)||value.job_id!==job||!uuidPattern.test(value.output_generation)||!Array.isArray(value.files)||value.files.length>2048)throw Error('P2P 目录绑定不匹配');
  if(session!==undefined&&(!uuidPattern.test(session)||value.session_id!==session))throw Error('P2P 主播放器绑定不匹配');
  if(outputGeneration!==undefined&&value.output_generation!==outputGeneration)throw Error('P2P 输出代次变化');
  if(session===undefined&&value.session_id!==undefined)throw Error('P2P 目录作用域不匹配');
  const names=new Set<string>();
  for(const file of value.files){
    const prefix=session?`/api/v1/playback-sessions/${session}/distributed/files/`:`/api/v1/rooms/${room}/compute/${job}/files/`;
    if(!/^(index\.m3u8|segment\d{5}\.ts)$/.test(file.name)||names.has(file.name)||!shaPattern.test(file.sha256)||!Number.isSafeInteger(file.size_bytes)||file.size_bytes<1||file.size_bytes>MAX_FILE_BYTES||file.url!==prefix+file.name)throw Error('P2P 目录无效');
    names.add(file.name);
  }
  if(!names.has('index.m3u8')||names.size<2)throw Error('P2P 目录尚未完整');
  return value;
}
export async function verifySharedBytes(file:SharedFile,bytes:ArrayBuffer):Promise<boolean>{
  if(bytes.byteLength!==file.size_bytes)return false;
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  return [...hash].map(b=>b.toString(16).padStart(2,'0')).join('')===file.sha256;
}
// Preserve a conservative HTTP completion window and never wait through the playback deadline.
export function peerWaitMs(fileBytes:number,bufferSeconds:number,httpBytesPerSecond=500000):number{
  if(!Number.isFinite(bufferSeconds)||bufferSeconds<12||!Number.isFinite(httpBytesPerSecond)||httpBytesPerSecond<=0)return 0;
  return Math.max(0,Math.min(2000,(bufferSeconds-4-fileBytes/httpBytesPerSecond)*1000));
}
export class RoomP2PTransport {
  readonly stats:PeerStats={peerBytes:0,httpBytes:0,uploadedBytes:0,duplicateBytes:0,badHashes:0,fallbacks:0};
  private peers=new Map<string,Peer>();
  private cache=new Map<string,{data:ArrayBuffer;added:number}>();
  private cachedBytes=0;
  private files=new Map<string,SharedFile>();
  private directory?:SharedDirectory;
  private peerId?:string;
  private cursor=0;
  private nextId=1;
  private stopped=true;
  private lifecycle=0;
  private uploadAt=0;
  private timer?:ReturnType<typeof setTimeout>;
  private polling=false;
  private releaseBattery?:()=>void;
  private connection?:EventTarget;
  private onNetworkChange=()=>void this.stop();
  get active():boolean{return !this.stopped;}
  private nextAuthorization=0;
  private onVisibility=()=>{if(document.visibilityState==='hidden')void this.stop()};
  constructor(private api:ApiClient,readonly room:string,readonly job:string,private changed:()=>void=()=>{},private primary?:{session:string;outputGeneration:string}){}
  private directoryPath():string{return this.primary?`/playback-sessions/${this.primary.session}/distributed/directory`:`/rooms/${this.room}/compute/${this.job}/directory`;}
  async prepare():Promise<void>{
    const lifecycle=this.lifecycle;
    const value=validateSharedDirectory(await this.api<SharedDirectory>(this.directoryPath()),this.room,this.job,this.primary?.session,this.primary?.outputGeneration);
    if(lifecycle!==this.lifecycle)throw new DOMException('Aborted','AbortError');
    this.directory=value;this.files=new Map(value.files.map(file=>[file.url,file]));
  }
  async start(consent:{acknowledge_peer_addresses:boolean;confirm_current_network:boolean;upload_allowed:boolean}):Promise<void>{
    if(!this.stopped)await this.stop();
    const lifecycle=++this.lifecycle;
    const current=()=>{if(lifecycle!==this.lifecycle)throw new DOMException('Aborted','AbortError');};
    try {
    if(!consent.acknowledge_peer_addresses||!consent.confirm_current_network||!consent.upload_allowed)throw Error('启用前请确认上传与网络地址披露');
    if(document.visibilityState==='hidden')throw Error('后台页面不能启用上传');
    const batteryNavigator=navigator as Navigator & {getBattery?:()=>Promise<EventTarget & {level:number;charging:boolean}>};
    if(batteryNavigator.getBattery){const b=await batteryNavigator.getBattery();current();if(!b.charging&&b.level<=0.2)throw Error('低电量时暂停 P2P 上传');const low=()=>{if(!b.charging&&b.level<=0.2)void this.stop()};b.addEventListener('levelchange',low);b.addEventListener('chargingchange',low);this.releaseBattery=()=>{b.removeEventListener('levelchange',low);b.removeEventListener('chargingchange',low)};}
    await this.prepare();current();
    const value=this.directory!;
    const joined=await this.api<{peer_id:string;peers:string[];output_generation:string}>(this.primary?`/playback-sessions/${this.primary.session}/distributed/p2p`:`/rooms/${this.room}/compute/${this.job}/p2p`,'POST',consent);
    if(lifecycle!==this.lifecycle){if(uuidPattern.test(joined.peer_id))await this.api(`/room-p2p/${joined.peer_id}`,'DELETE').catch(()=>{});current();}
    if(joined.output_generation!==value.output_generation||!uuidPattern.test(joined.peer_id)||joined.peers.length>3)throw Error('P2P 输出代次已变化');
    this.peerId=joined.peer_id;this.stopped=false;document.addEventListener('visibilitychange',this.onVisibility);this.connection=(navigator as Navigator & {connection?:EventTarget}).connection;this.connection?.addEventListener('change',this.onNetworkChange);
    for(const id of joined.peers){current();await this.connect(id,true);}
    current();
    this.nextAuthorization=performance.now()+10000;this.timer=setTimeout(()=>void this.poll(),500);
    }catch(error){if(lifecycle===this.lifecycle)await this.stop();throw error;}
  }
  has(url:string):boolean{return this.files.has(new URL(url,location.origin).pathname);}
  private async sendSignal(recipient:string,kind:string,payload:object):Promise<void>{
    if(this.stopped||!this.peerId)throw Error('P2P 已关闭');
    await this.api(`/room-p2p/${this.peerId}/signal`,'POST',{recipient,kind,payload});
  }
  private async connect(id:string,offer:boolean):Promise<Peer>{
    const existing=this.peers.get(id);if(existing)return existing;
    if(!uuidPattern.test(id)||id===this.peerId||this.peers.size>=MAX_PEERS)throw Error('P2P 连接数量超过上限');
    // No STUN/TURN is configured or contacted automatically. Administrators must explicitly provision relay support separately.
    const pc=new RTCPeerConnection({iceServers:[],bundlePolicy:'max-bundle'});
    const peer:Peer={pc,pending:new Map(),cancelled:new Set(),uploads:new Set(),ice:[]};this.peers.set(id,peer);
    pc.onicecandidate=e=>{if(e.candidate)void this.sendSignal(id,'ice',e.candidate.toJSON()).catch(()=>this.drop(id))};
    pc.onconnectionstatechange=()=>{if(['closed','disconnected','failed'].includes(pc.connectionState))this.drop(id)};
    pc.ondatachannel=e=>this.channel(id,peer,e.channel);
    if(offer){this.channel(id,peer,pc.createDataChannel('rainsync-chunks-v1',{ordered:true}));const sdp=await pc.createOffer();await pc.setLocalDescription(sdp);await this.sendSignal(id,'offer',{type:sdp.type,sdp:sdp.sdp});}
    return peer;
  }
  private channel(id:string,peer:Peer,ch:RTCDataChannel):void{
    if(ch.label!=='rainsync-chunks-v1'||peer.channel){ch.close();return;}
    peer.channel=ch;ch.binaryType='arraybuffer';ch.bufferedAmountLowThreshold=32*1024;
    ch.onmessage=e=>{void this.receive(id,peer,e.data).catch(()=>this.drop(id));};ch.onclose=()=>this.drop(id);
  }
  private async receive(id:string,peer:Peer,message:unknown):Promise<void>{
    if(this.stopped)return;
    if(message instanceof ArrayBuffer){
      if(message.byteLength<9||message.byteLength>CHUNK_BYTES+8)throw Error('P2P 块长度无效');
      const view=new DataView(message),request=view.getUint32(0),offset=view.getUint32(4),pending=peer.pending.get(request);
      if(!pending){this.stats.duplicateBytes+=message.byteLength-8;return;}
      const bytes=new Uint8Array(message,8);if(offset!==pending.received||pending.received+bytes.length>pending.file.size_bytes)throw Error('P2P 块顺序或长度无效');
      pending.data.set(bytes,offset);pending.received+=bytes.length;
      if(pending.received===pending.file.size_bytes){const buffer=pending.data.buffer as ArrayBuffer;
        if(!await verifySharedBytes(pending.file,buffer)){peer.pending.delete(request);this.stats.badHashes++;pending.reject(Error('P2P 哈希校验失败'));this.drop(id);return;}
        if(this.stopped||peer.pending.get(request)!==pending)return;peer.pending.delete(request);this.stats.peerBytes+=buffer.byteLength;this.remember(pending.file,buffer);pending.resolve(buffer);this.changed();}
      return;
    }
    if(typeof message!=='string'||message.length>1024)throw Error('P2P 控制消息无效');
    const m=JSON.parse(message) as {type:string;id:number;name?:string;job?:string;generation?:string};
    if(!Number.isSafeInteger(m.id)||m.id<1||m.id>0xffffffff)throw Error('P2P 请求 ID 无效');
    if(m.type==='reject'){const pending=peer.pending.get(m.id);peer.pending.delete(m.id);pending?.reject(Error('P2P 分片暂不可用'));}
    else if(m.type==='cancel'){peer.cancelled.add(m.id);if(peer.cancelled.size>16){this.drop(id);}}
    else if(m.type==='request'){
      if(m.job!==this.job||m.generation!==this.directory?.output_generation||peer.uploads.size>=1)throw Error('P2P 请求绑定不匹配');
      const file=[...this.files.values()].find(f=>f.name===m.name),cached=file&&this.cache.get(file.sha256);
      if(!file||!cached||Date.now()-cached.added>60000||file.name==='index.m3u8'){peer.channel?.send(JSON.stringify({type:'reject',id:m.id}));return;}
      peer.uploads.add(m.id);void this.upload(peer,m.id,cached.data).catch(()=>this.drop(id)).finally(()=>{peer.uploads.delete(m.id);peer.cancelled.delete(m.id)});
    }else throw Error('P2P 控制类型无效');
  }
  private async upload(peer:Peer,id:number,data:ArrayBuffer):Promise<void>{
    const ch=peer.channel;if(!ch)return;
    for(let offset=0;offset<data.byteLength;offset+=CHUNK_BYTES){
      if(this.stopped||document.visibilityState==='hidden'||peer.cancelled.has(id)||ch.readyState!=='open')return;
      const n=Math.min(CHUNK_BYTES,data.byteLength-offset);
      const delay=Math.max(0,this.uploadAt-performance.now());this.uploadAt=Math.max(this.uploadAt,performance.now())+n/250000*1000;
      if(delay)await new Promise<void>(resolve=>setTimeout(resolve,delay));
      if(this.stopped||peer.cancelled.has(id)||ch.readyState!=='open')return;
      while(ch.bufferedAmount>HIGH_WATER){await new Promise<void>((resolve,reject)=>{const done=()=>{clearTimeout(timer);ch.removeEventListener('bufferedamountlow',done);resolve()};const timer=setTimeout(()=>{ch.removeEventListener('bufferedamountlow',done);reject(Error('P2P 发送背压超时'))},1000);ch.addEventListener('bufferedamountlow',done,{once:true});});if(this.stopped||peer.cancelled.has(id))return;}
      const frame=new ArrayBuffer(n+8),view=new DataView(frame);view.setUint32(0,id);view.setUint32(4,offset);new Uint8Array(frame,8).set(new Uint8Array(data,offset,n));ch.send(frame);this.stats.uploadedBytes+=n;this.changed();
    }
  }
  private remember(file:SharedFile,data:ArrayBuffer):void{
    if(this.stopped||file.name==='index.m3u8'||this.cache.has(file.sha256))return;
    for(const [hash,c]of this.cache){if(Date.now()-c.added>60000){this.cache.delete(hash);this.cachedBytes-=c.data.byteLength;}}
    while(this.cachedBytes+data.byteLength>CACHE_BYTES&&this.cache.size){const first=this.cache.entries().next().value!;this.cachedBytes-=first[1].data.byteLength;this.cache.delete(first[0]);}
    this.cache.set(file.sha256,{data,added:Date.now()});this.cachedBytes+=data.byteLength;
  }
  async load(url:string,bufferSeconds:number,signal:AbortSignal):Promise<ArrayBuffer>{
    const parsed=new URL(url,location.origin);if(parsed.origin!==location.origin)throw Error('P2P 地址不匹配');
    const file=this.files.get(parsed.pathname);if(!file)throw Error('P2P 分片未在可信目录中');
    const wait=file.name==='index.m3u8'?0:peerWaitMs(file.size_bytes,bufferSeconds);
    const ready=[...this.peers.values()].find(p=>p.channel?.readyState==='open'&&p.pending.size===0);
    if(!this.stopped&&wait>0&&ready){
      signal.throwIfAborted();
      let timer:ReturnType<typeof setTimeout>|undefined;let aborted:(()=>void)|undefined;const id=this.nextId++;if(this.nextId>0xffffffff)this.nextId=1;
      try{const bytes=await new Promise<ArrayBuffer>((resolve,reject)=>{
        ready.pending.set(id,{file,data:new Uint8Array(file.size_bytes),received:0,resolve,reject});
        timer=setTimeout(()=>reject(Error('P2P 播放截止时间回退')),wait);
        aborted=()=>reject(new DOMException('Aborted','AbortError'));signal.addEventListener('abort',aborted,{once:true});
        const pending=ready.pending.get(id)!;const originalResolve=pending.resolve,originalReject=pending.reject;
        pending.resolve=data=>{if(aborted)signal.removeEventListener('abort',aborted);originalResolve(data)};pending.reject=e=>{if(aborted)signal.removeEventListener('abort',aborted);originalReject(e)};
        ready.channel!.send(JSON.stringify({type:'request',id,name:file.name,job:this.job,generation:this.directory!.output_generation}));
      });return bytes;}catch(error){if(signal.aborted)throw error;this.stats.fallbacks++;}finally{if(timer)clearTimeout(timer);if(aborted)signal.removeEventListener('abort',aborted);const unfinished=ready.pending.get(id);if(unfinished)this.stats.duplicateBytes+=unfinished.received;ready.pending.delete(id);if(ready.channel?.readyState==='open')ready.channel.send(JSON.stringify({type:'cancel',id}));}
    }
    signal.throwIfAborted();const response=await fetch(file.url,{signal,credentials:'same-origin',cache:'no-store',redirect:'error'});
    if(!response.ok||!response.body)throw Error('HTTP 分片加载失败');
    const reader=response.body.getReader(),data=new Uint8Array(file.size_bytes);let received=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;if(received+value.byteLength>file.size_bytes)throw Error('HTTP 分片长度超过可信目录');data.set(value,received);received+=value.byteLength;}}catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
    const bytes=data.buffer;if(received!==file.size_bytes||!await verifySharedBytes(file,bytes))throw Error('HTTP 分片完整性校验失败');
    this.stats.httpBytes+=bytes.byteLength;this.remember(file,bytes);this.changed();return bytes;
  }
  private async poll():Promise<void>{
    if(this.stopped||!this.peerId||this.polling)return;this.polling=true;
    try{
      const reply=await this.api<{cursor:number;signals:{sender:string;kind:string;payload:RTCSessionDescriptionInit & RTCIceCandidateInit}[]}>(`/room-p2p/${this.peerId}?after=${this.cursor}`);
      if(this.stopped)return;this.cursor=reply.cursor;
      for(const s of reply.signals){const p=await this.connect(s.sender,false);
        if(s.kind==='offer'){await p.pc.setRemoteDescription(s.payload);for(const ice of p.ice)await p.pc.addIceCandidate(ice);p.ice=[];const a=await p.pc.createAnswer();await p.pc.setLocalDescription(a);await this.sendSignal(s.sender,'answer',{type:a.type,sdp:a.sdp});}
        else if(s.kind==='answer'){await p.pc.setRemoteDescription(s.payload);for(const ice of p.ice)await p.pc.addIceCandidate(ice);p.ice=[];}
        else if(s.kind==='ice'){if(p.pc.remoteDescription)await p.pc.addIceCandidate(s.payload);else{if(p.ice.length>=64)throw Error('P2P ICE 数量超过上限');p.ice.push(s.payload);}}
      }
      if(performance.now()>this.nextAuthorization){const fresh=validateSharedDirectory(await this.api<SharedDirectory>(this.directoryPath()),this.room,this.job,this.primary?.session,this.primary?.outputGeneration);if(fresh.output_generation!==this.directory?.output_generation)throw Error('P2P 输出代次变化');this.nextAuthorization=performance.now()+10000;}
    }catch{await this.stop();}finally{this.polling=false;if(!this.stopped)this.timer=setTimeout(()=>void this.poll(),1000);}
  }
  private drop(id:string):void{const p=this.peers.get(id);if(!p)return;this.peers.delete(id);for(const request of p.pending.values())request.reject(Error('P2P 连接已关闭'));p.pending.clear();p.channel?.close();p.pc.close();}
  async stop():Promise<void>{
    ++this.lifecycle;if(this.timer)clearTimeout(this.timer);this.stopped=true;document.removeEventListener('visibilitychange',this.onVisibility);this.releaseBattery?.();this.releaseBattery=undefined;this.connection?.removeEventListener('change',this.onNetworkChange);this.connection=undefined;
    for(const id of [...this.peers.keys()])this.drop(id);this.cache.clear();this.cachedBytes=0;
    const peer=this.peerId;this.peerId=undefined;if(peer)await this.api(`/room-p2p/${peer}`,'DELETE').catch(()=>{});this.changed();
  }
}
