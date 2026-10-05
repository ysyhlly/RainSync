<script setup lang="ts">
import {ref,onMounted,onBeforeUnmount,watch} from 'vue';
import Hls from 'hls.js';
import {useSession} from '../auth/session.store';
import type {DistributedComputePlaybackIntent} from '../../../../../packages/protocol';
import type {PeerStats} from './room-p2p';
const props=defineProps<{
 roomId:string;mediaGeneration:number;audioIndex?:number;activeJob?:string;sharing:boolean;stats?:PeerStats;
 activate:(intent:DistributedComputePlaybackIntent,audioIndex?:number|null)=>Promise<void>;
 original:()=>Promise<void>;
 share:(consent:{acknowledge_peer_addresses:boolean;confirm_current_network:boolean;upload_allowed:boolean})=>Promise<void>;
 stopSharing:()=>Promise<void>;
}>();
type Job={id:string;status:string;recipe:string;attempt:number;output_generation?:string;primary_qualified:boolean;selected_audio_index:number|null};
const session=useSession(),jobs=ref<Job[]>([]),enabled=ref(false),p2pEnabled=ref(false),busy=ref(false),error=ref(''),selected=ref(''),recipe=ref('h264_480p_hls_v1'),addresses=ref(false),network=ref(false),upload=ref(false);
const sourceProbeReady=ref(false),sourceAudioTracks=ref<{index:number;label:string;language:string}[]>([]),audioChoice=ref('current');
let timer:ReturnType<typeof setTimeout>|undefined,alive=true,serial=0;
async function load(){
 if(timer)clearTimeout(timer);const version=serial;
 try{const reply=await session.api<{enabled:boolean;p2p_enabled:boolean;jobs:Job[];source_probe_ready:boolean;source_audio_tracks:typeof sourceAudioTracks.value}>(`/rooms/${props.roomId}/compute`);if(!alive||version!==serial)return;enabled.value=reply.enabled;p2pEnabled.value=reply.p2p_enabled;jobs.value=reply.jobs;sourceProbeReady.value=reply.source_probe_ready===true;sourceAudioTracks.value=Array.isArray(reply.source_audio_tracks)?reply.source_audio_tracks:[];}
 catch(e){if(alive&&version===serial)error.value=e instanceof Error?e.message:String(e)}
 finally{if(alive&&version===serial)timer=setTimeout(()=>void load(),2000)}
}
async function act(action:()=>Promise<void>){if(busy.value)return;busy.value=true;error.value='';const version=serial;try{await action()}catch(e){if(alive&&version===serial)error.value=e instanceof Error?e.message:String(e)}finally{if(alive&&version===serial)busy.value=false}}
async function probeSource(){
 const version=serial;await session.api('/playback-candidates','POST',{room_id:props.roomId,media_generation:props.mediaGeneration,audio_index:props.audioIndex??null,position_ms:0});
 if(!alive||serial!==version)return;await load();
 if(!sourceProbeReady.value)throw Error('原片音轨尚未完成版本校验，请重新探测或重载原片源');
}
async function prepare(){await act(async()=>{
 const version=serial;if(!sourceProbeReady.value&&audioChoice.value==='current'&&props.audioIndex===undefined)await probeSource();
 if(!alive||serial!==version)return;
 const chosen=audioChoice.value==='current'?(props.audioIndex??sourceAudioTracks.value[0]?.index??null):Number(audioChoice.value);
 const result=await session.api<{id:string}>(`/rooms/${props.roomId}/compute`,'POST',{media_generation:props.mediaGeneration,recipe:recipe.value,audio_index:chosen});
 if(!alive||serial!==version)return;selected.value=result.id;await load();
})}
async function activate(){await act(async()=>{const job=jobs.value.find(j=>j.id===selected.value&&j.status==='ready'&&j.primary_qualified);if(!job?.output_generation)throw Error('完整产物尚未通过主播放资格校验');await props.activate({schema_version:1,job_id:job.id,output_generation:job.output_generation},job.selected_audio_index)})}
async function share(){await act(async()=>{if(!addresses.value||!network.value||!upload.value)throw Error('请先确认当前网络、上传与地址披露');await props.share({acknowledge_peer_addresses:addresses.value,confirm_current_network:network.value,upload_allowed:upload.value})})}
watch(()=>[props.roomId,props.mediaGeneration,session.epoch],()=>{serial++;if(timer)clearTimeout(timer);selected.value='';jobs.value=[];sourceProbeReady.value=false;sourceAudioTracks.value=[];audioChoice.value='current';addresses.value=network.value=upload.value=false;busy.value=false;error.value='';void load()});
watch(()=>props.sharing,(sharing,previous)=>{if(previous&&!sharing)addresses.value=network.value=upload.value=false});
onMounted(load);onBeforeUnmount(()=>{alive=false;serial++;if(timer)clearTimeout(timer)});
</script>
<template>
<details class="distributed-compute-panel">
 <summary>NAS 本地计算与主播放器分片共享</summary>
 <p class="helper">NAS 生成完整产物后，服务器独立校验编码、原片时间轴和音轨。选择合格产物会替换主播放器输入，继续跟随房间播放、暂停、速率与跳转；默认使用 HTTP。</p>
 <p v-if="!enabled" class="helper">服务器未开启 NAS 本地计算。</p>
 <p v-if="error" role="alert">{{error}}</p>
 <label>计算配方 <select v-model="recipe" :disabled="busy"><option value="h264_480p_hls_v1">480p H.264 转码</option><option value="remux_hls_v1">HLS 转封装（合格 H.264/AAC）</option></select></label>
 <label>原片音轨 <select v-model="audioChoice" :disabled="busy"><option value="current">当前主播放器音轨 / 首个已探测音轨</option><option v-for="track in sourceAudioTracks" :key="track.index" :value="String(track.index)">{{track.label}} · {{track.language}} · #{{track.index}}</option></select></label>
 <button :disabled="busy||!enabled" @click="act(probeSource)">探测并读取原片音轨</button>
 <p v-if="!sourceProbeReady" class="helper">索引不代表音轨已探测。未选定音轨时会先探测当前原片，再生成；探测失败请重试或重载原片源，不会静默丢弃声音。</p>
 <p v-else-if="sourceAudioTracks.length===0" class="helper">已核对当前原片：没有音轨。</p>
 <button :disabled="busy||!enabled" @click="prepare">按当前原片音轨生成产物</button>
 <label>房间内计算产物 <select v-model="selected" :disabled="busy"><option value="">选择产物</option><option v-for="job in jobs" :key="job.id" :value="job.id">{{job.recipe}} · {{job.status}} · 第 {{job.attempt}} 次 · {{job.id.slice(0,8)}}</option></select></label>
 <button :disabled="busy||!jobs.some(j=>j.id===selected&&j.status==='ready'&&j.primary_qualified)" @click="activate">用于房间主播放器</button>
 <button v-if="activeJob" :disabled="busy" @click="act(original)">主播放器改回原片源</button>
 <p v-if="activeJob" class="helper" role="status">主播放器使用合格 NAS 产物 {{activeJob.slice(0,8)}}，时间轴仍属于原片。</p>
 <fieldset v-if="p2pEnabled" :disabled="busy"><legend>主播放器 P2P 上传默认关闭</legend>
  <p class="helper">仅共享相同房间、相同产物代次的已校验分片。直连可能让参与者获知对方网络地址，已下载的数据无法撤回。未配置 STUN/TURN；启动、缓冲不足、超时或坏片使用 HTTP。后台、网络变化、离开或撤销授权会停止共享，重新分享需再次确认。</p>
  <label><input v-model="addresses" type="checkbox">我了解对方可能获知我的网络地址</label><br>
  <label><input v-model="network" type="checkbox">我确认当前网络允许上传</label><br>
  <label><input v-model="upload" type="checkbox">允许本次上传，合计上限 2 Mbps</label><br>
  <button :disabled="!addresses||!network||!upload||!activeJob||sharing||!Hls.isSupported()" @click="share">启用主播放器分片共享</button>
  <button :disabled="!sharing" @click="act(stopSharing)">立即退出共享，继续 HTTP 播放</button>
  <p v-if="stats" role="status">Peer 接收 {{stats.peerBytes}} B · HTTP {{stats.httpBytes}} B · 上传 {{stats.uploadedBytes}} B · 回退 {{stats.fallbacks}} 次 · 坏片 {{stats.badHashes}} 次 · 重复 {{stats.duplicateBytes}} B</p>
 </fieldset>
</details>
</template>
