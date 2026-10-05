<script setup lang="ts">
import {ref,onMounted,onBeforeUnmount} from 'vue';
import {useSession} from '../auth/session.store';
interface Node {id:string;name:string;enabled:boolean;healthy:boolean;slots:number|null;output_budget_bytes:number|null;capabilities:string[]|null;running:number}
const session=useSession(),nodes=ref<Node[]>([]),enabled=ref(false),busy=ref(false),error=ref('');let live=true;
async function load(){try{const r=await session.api<{enabled:boolean;nodes:Node[]}>('/agents/compute');if(live){nodes.value=r.nodes;enabled.value=r.enabled}}catch(e){error.value=e instanceof Error?e.message:String(e)}}
async function change(node:Node){busy.value=true;error.value='';try{await session.api(`/agents/${node.id}/compute-policy`,'POST',{enabled:!node.enabled,slots:node.slots??1,output_budget_bytes:node.output_budget_bytes??67108864});await load()}catch(e){error.value=e instanceof Error?e.message:String(e)}finally{busy.value=false}}
onMounted(load);onBeforeUnmount(()=>{live=false});
</script>
<template>
<details class="compute-policy-panel">
 <summary>NAS 本地计算（需单独授权）</summary>
 <p class="helper">授权目录读取与允许执行 FFmpeg 是两个权限。开启后，配套计算进程只执行固定的 HLS 转封装或 480p H.264 配方；默认一个任务槽、64 MiB 产物上限。</p>
 <p v-if="!enabled" class="helper">服务器尚未配置专用计算产物目录，本地计算保持关闭。</p>
 <p v-if="error" role="alert">{{error}}</p>
 <button :disabled="busy" @click="load">刷新计算节点</button>
 <article v-for="node in nodes" :key="node.id" class="admin-row">
  <div><strong>{{node.name}}</strong><p class="helper">{{node.enabled?'已允许计算':'未允许计算'}} · {{node.healthy?'最近心跳正常':'没有有效计算心跳'}} · 执行中 {{node.running}}<span v-if="node.capabilities?.length"> · {{node.capabilities.join('、')}}</span></p></div>
  <button :disabled="busy||!enabled" @click="change(node)">{{node.enabled?'停止计算授权':'允许固定配方计算'}}</button>
 </article>
</details>
</template>
