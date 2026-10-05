import type {PlaybackRequest,PlaybackPlan,DistributedComputePlaybackIntent} from '../../../../../packages/protocol';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha=/^[a-f0-9]{64}$/;
export function validDistributedIntent(value:DistributedComputePlaybackIntent|undefined):value is DistributedComputePlaybackIntent {
 return !!value&&value.schema_version===1&&uuid.test(value.job_id)&&uuid.test(value.output_generation)&&Object.keys(value).length===3;
}
export function sameDistributedIntent(a:DistributedComputePlaybackIntent|undefined,b:DistributedComputePlaybackIntent|undefined):boolean {
 return a===undefined&&b===undefined||validDistributedIntent(a)&&validDistributedIntent(b)&&a.job_id===b.job_id&&a.output_generation===b.output_generation;
}
export function matchesDistributedPlaybackPlan(request:PlaybackRequest,plan:PlaybackPlan):boolean {
 const wanted=request.distributed_compute,f=plan.distributed_compute;
 if(!wanted)return f===undefined;
 if(!validDistributedIntent(wanted)||!f||f.schema_version!==1||f.job_id!==wanted.job_id||f.output_generation!==wanted.output_generation
  ||!uuid.test(plan.session_id)||plan.plan_generation!==request.plan_generation||plan.media_generation!==request.media_generation||plan.transport!=='hls'
  ||!['remux','transcode'].includes(plan.delivery_mode)||plan.rebuild_on_seek!==false||!Number.isInteger(f.attempt)||f.attempt<1||f.attempt>3||!sha.test(f.qualification_sha256)||!sha.test(f.manifest_sha256)
  ||plan.playback_url!==`/api/v1/playback-sessions/${plan.session_id}/distributed/files/index.m3u8`||f.directory_url!==`/api/v1/playback-sessions/${plan.session_id}/distributed/directory`
  ||f.video_codec!=='h264'||!Number.isInteger(f.width)||f.width<1||f.width>16384||!Number.isInteger(f.height)||f.height<1||f.height>16384
  ||!Number.isInteger(f.source_video_index)||f.source_video_index<0||f.source_video_index>65535||typeof f.p2p_enabled!=='boolean'
  ||!Number.isFinite(f.source_duration_ms)||f.source_duration_ms<=0||f.source_duration_ms>1800000||plan.duration_ms!==f.source_duration_ms
  ||!Number.isFinite(plan.timeline_origin_ms)||Math.abs(plan.timeline_origin_ms)>1||!Number.isFinite(f.timestamp_shift_ms)
  ||request.audio_index!=null&&request.audio_index!==f.source_audio_index||plan.selected_audio_track!==(f.source_audio_index??undefined)
  ||plan.native_platform!==undefined||plan.advanced_playback!==undefined||plan.local_hls_ladder!==undefined||plan.upstream_profile!==undefined
  ||plan.http_file_fallback_version!==undefined||plan.static_hls_fallback_version!==undefined||plan.pending_job_id!==undefined||plan.subtitle_mode!=='none'||plan.subtitle_tracks.length!==0)return false;
 if(f.source_audio_index===null){if(f.audio_codec!==null||f.audio_channels!==null||f.audio_sample_rate!==null||plan.audio_tracks.length!==0)return false;}
 else if(!Number.isInteger(f.source_audio_index)||f.source_audio_index<0||f.source_audio_index>65535||f.audio_codec!=='aac'
  ||!Number.isInteger(f.audio_channels)||f.audio_channels!<1||f.audio_channels!>2||!Number.isInteger(f.audio_sample_rate)||f.audio_sample_rate!<8000||f.audio_sample_rate!>48000
  ||plan.audio_tracks.length!==1||plan.audio_tracks[0].index!==f.source_audio_index)return false;
 const ranges=plan.seekable_media_ranges_ms;
 return !!ranges&&ranges.length===1&&ranges[0].start_ms===plan.timeline_origin_ms&&ranges[0].end_ms===plan.duration_ms;
}
