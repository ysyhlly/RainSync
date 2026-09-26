<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from "vue";
import Hls from "hls.js";
import { detectCapabilities } from "../../../packages/player-core";
import { useSession } from "./api";
import {
  Clock,
  Corrector,
  target,
  reconnectDelay,
} from "../../../packages/sync-engine";
import type { RoomState, PlaybackPlan } from "../../../packages/protocol";
const reload = () => window.location.reload();
const session = useSession();
const error = ref("");
const busy = ref(false);
const username = ref("admin");
const password = ref("");
const rooms = ref<any[]>([]),
  media = ref<any[]>([]),
  sources = ref<any[]>([]),
  agents = ref<any[]>([]),
  playlist = ref<any[]>([]),
  messages = ref<any[]>([]);
const room = ref<any>(null),
  state = ref<RoomState | null>(null),
  connected = ref(false),
  tab = ref("watch"),
  video = ref<HTMLVideoElement>(),
  waiting = ref(false),
  blocked = ref(false);
const roomName = ref("雨夜放映室"),
  chat = ref(""),
  search = ref(""),
  invite = ref(""),
  joinRoom = ref(""),
  joinToken = ref(""),
  mode = ref("auto");
const sourceName = ref(""),
  sourceKind = ref("local"),
  sourceRoot = ref("/media"),
  sourceUrl = ref(""),
  sourceUser = ref(""),
  sourceToken = ref("");
const sourceHeaders = ref("{}");
const newUser = ref(""),
  newPassword = ref(""),
  agentName = ref("我的 NAS"),
  pairCode = ref("");
const tracks = ref<PlaybackPlan["audio_tracks"]>([]),
  subtitles = ref<PlaybackPlan["subtitle_tracks"]>([]),
  audioIndex = ref<number | undefined>();
const duration = ref(0),
  position = ref(0);
let socket: WebSocket | undefined,
  hls: Hls | undefined,
  plan: PlaybackPlan | undefined,
  retry: ReturnType<typeof setTimeout> | undefined;
let attempt = 0,
  connectionSerial = 0,
  loadSerial = 0;
const clock = new Clock(),
  corrector = new Corrector();
const owner = computed(
  () =>
    !!state.value &&
    (state.value.controller_user_id === session.user?.id ||
      session.user?.admin),
);
const library = computed(() =>
  media.value.filter((m) =>
    m.title.toLowerCase().includes(search.value.toLowerCase()),
  ),
);
const currentTitle = computed(
  () =>
    media.value.find((m) => m.id === state.value?.media_id)?.title ??
    "选择一部影片，让此刻相连",
);
async function run(action: () => Promise<void>) {
  error.value = "";
  busy.value = true;
  try {
    await action();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
async function refresh() {
  [rooms.value, media.value] = await Promise.all([
    session.api("/rooms"),
    session.api("/media"),
  ]);
  if (session.user?.admin)
    [sources.value, agents.value] = await Promise.all([
      session.api("/sources"),
      session.api("/agents"),
    ]);
}
async function login() {
  await session.api("/auth/login", "POST", {
    username: username.value,
    password: password.value,
  });
  password.value = "";
  await session.load();
  await refresh();
}
async function createRoom() {
  const r = await session.api("/rooms", "POST", { name: roomName.value });
  await refresh();
  await enter(rooms.value.find((x) => x.id === r.id));
}
async function enter(r: any) {
  room.value = r;
  state.value = null;
  tab.value = "watch";
  loadSerial++;
  await stopPlayback();
  connect();
  playlist.value = await session.api(`/rooms/${r.id}/playlist`);
  messages.value = await session.api(`/rooms/${r.id}/messages`);
}
function connect() {
  clearTimeout(retry);
  connectionSerial++;
  const serial = connectionSerial;
  socket?.close();
  connected.value = false;
  if (!room.value) return;
  socket = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/v1/ws`,
  );
  socket.onopen = () => {
    if (serial !== connectionSerial) return;
    connected.value = true;
    attempt = 0;
    socket!.send(
      JSON.stringify({
        type: "RESUME",
        room_id: room.value.id,
        revision: state.value?.revision ?? 0,
        clock_epoch: state.value?.clock_epoch,
      }),
    );
    clock.reset();
    for (let i = 0; i < 8; i++)
      setTimeout(() => {
        if (serial === connectionSerial) sampleClock();
      }, i * 150);
  };
  socket.onclose = () => {
    if (serial !== connectionSerial) return;
    connected.value = false;
    retry = setTimeout(connect, reconnectDelay(attempt++));
  };
  socket.onmessage = (event) => {
    if (serial !== connectionSerial) return;
    const v = JSON.parse(event.data);
    if (v.type === "CLOCK_SYNC_REPLY") {
      clock.sample(v.t1, v.t2, v.t3, performance.now());
      return;
    }
    if (v.type === "CHAT") {
      messages.value.push(v);
      return;
    }
    if (v.type === "ERROR") error.value = v.error;
    if (v.state) {
      const old = state.value;
      const next = v.state as RoomState;
      if (
        old &&
        old.clock_epoch === next.clock_epoch &&
        next.revision < old.revision
      )
        return;
      state.value = next;
      if (!old || old.media_generation !== next.media_generation) {
        corrector.reset();
        audioIndex.value = undefined;
        void run(() => loadMedia());
      } else if (v.action?.type === "SEEK") void run(() => applyState(true));
      else void applyState();
    }
  };
}
function sampleClock() {
  if (socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ type: "CLOCK_SYNC", t1: performance.now() }));
}
function send(type: string, payload?: unknown) {
  if (!connected.value || !owner.value || !state.value) return;
  socket?.send(
    JSON.stringify({
      protocol_version: 1,
      type,
      payload,
      room_id: room.value.id,
      command_id: crypto.randomUUID(),
      expected_revision: state.value.revision,
      media_generation: state.value.media_generation,
    }),
  );
}
async function stopPlayback() {
  hls?.destroy();
  hls = undefined;
  if (video.value) {
    video.value.pause();
    video.value.removeAttribute("src");
    video.value.load();
  }
  const old = plan;
  plan = undefined;
  if (old)
    await session
      .api(`/playback-sessions/${old.session_id}`, "DELETE")
      .catch(() => {});
}
async function loadMedia() {
  const s = state.value;
  if (!s?.media_id) return;
  const serial = ++loadSerial;
  await stopPlayback();
  await nextTick();
  if (serial !== loadSerial || !video.value) return;
  const p: PlaybackPlan = await session.api("/playback-sessions", "POST", {
    room_id: s.room_id,
    media_generation: s.media_generation,
    mode: mode.value,
    audio_index: audioIndex.value,
    position_ms: target(s, clock.now()),
    capabilities: detectCapabilities(
      video.value,
      Hls.isSupported() ? window.MediaSource : undefined,
    ),
  });
  if (serial !== loadSerial) {
    await session.api(`/playback-sessions/${p.session_id}`, "DELETE");
    return;
  }
  plan = p;
  tracks.value = p.audio_tracks;
  subtitles.value = p.subtitle_tracks;
  const el = video.value;
  waiting.value = true;
  if (
    p.transport === "hls" &&
    !el.canPlayType("application/vnd.apple.mpegurl") &&
    Hls.isSupported()
  ) {
    hls = new Hls({
      maxBufferLength: 20,
      maxMaxBufferLength: 60,
      backBufferLength: 30,
    });
    hls.loadSource(p.playback_url);
    hls.attachMedia(el);
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        error.value = "媒体加载失败：" + data.details;
        waiting.value = false;
      }
    });
  } else el.src = p.playback_url;
  el.onloadedmetadata = () => {
    duration.value = p.duration_ms ? p.duration_ms / 1000 : el.duration;
    void applyState(true);
  };
}
async function applyState(force = false) {
  const s = state.value,
    el = video.value;
  if (!s || !el || !plan || el.readyState < 1) return;
  const relative = (target(s, clock.now()) - plan.timeline_origin_ms) / 1000;
  const expected = Math.max(0, relative);
  if (
    force &&
    plan.rebuild_on_seek &&
    (relative < -0.5 || expected > el.duration + 1)
  ) {
    await loadMedia();
    return;
  }
  if (force || s.playback_status !== "playing") {
    if (Math.abs(el.currentTime - expected) > 0.15) el.currentTime = expected;
  }
  if (s.playback_status === "playing") {
    if (el.paused)
      try {
        await el.play();
        blocked.value = false;
      } catch {
        blocked.value = true;
      }
  } else el.pause();
}
async function enablePlayback() {
  if (video.value) {
    await video.value.play();
    blocked.value = false;
    await applyState(true);
  }
}
function tick() {
  const s = state.value,
    el = video.value;
  if (!s || !el || !plan) return;
  position.value = el.currentTime + plan.timeline_origin_ms / 1000;
  if (!connected.value || s.playback_status !== "playing") return;
  const expected = (target(s, clock.now()) - plan.timeline_origin_ms) / 1000;
  const adjustment = corrector.step(
    (expected - el.currentTime) * 1000,
    s.playback_rate,
    performance.now(),
    waiting.value || el.seeking || blocked.value || el.readyState < 2,
  );
  el.playbackRate = adjustment.rate;
  if (adjustment.seek) {
    if (
      plan.rebuild_on_seek &&
      (expected < -0.5 || expected > el.duration + 1)
    ) {
      void loadMedia();
    } else el.currentTime = Math.max(0, expected);
  }
}
async function choose(id: string) {
  send("CHANGE_MEDIA", { media_id: id });
}
async function makeInvite() {
  const v = await session.api(`/rooms/${room.value.id}/invites`, "POST");
  invite.value = JSON.stringify(v);
}
async function join() {
  await session.api(`/rooms/${joinRoom.value}/join`, "POST", {
    token: joinToken.value,
  });
  await refresh();
}
async function addSource() {
  await session.api("/sources", "POST", {
    name: sourceName.value,
    kind: sourceKind.value,
    config: {
      root: sourceRoot.value,
      url: sourceUrl.value,
      user_id: sourceUser.value,
      token: sourceToken.value,
      headers:
        sourceKind.value === "http" ? JSON.parse(sourceHeaders.value) : {},
    },
  });
  sourceToken.value = "";
  await refresh();
}
async function scan(id: string) {
  await session.api(`/sources/${id}/test`, "POST");
  await refresh();
}
async function addQueue(id: string) {
  await session.api(`/rooms/${room.value.id}/playlist`, "POST", {
    media_id: id,
  });
  playlist.value = await session.api(`/rooms/${room.value.id}/playlist`);
}
function sendChat() {
  if (!chat.value.trim() || !connected.value) return;
  socket?.send(JSON.stringify({ type: "CHAT", body: chat.value }));
  chat.value = "";
}
function format(s: number) {
  if (!Number.isFinite(s)) return "--:--";
  return `${Math.floor(s / 60)}:${Math.floor(s % 60)
    .toString()
    .padStart(2, "0")}`;
}
const statusTimer = setInterval(() => {
  if (connected.value && state.value && video.value)
    socket?.send(
      JSON.stringify({
        type: "CLIENT_STATUS",
        status: {
          buffering: waiting.value || blocked.value,
          drift_ms: target(state.value, clock.now()) - position.value * 1000,
        },
      }),
    );
}, 5000);
const timer = setInterval(tick, 500),
  clockTimer = setInterval(sampleClock, 30000),
  renewTimer = setInterval(() => {
    if (plan)
      void session
        .api(`/playback-sessions/${plan.session_id}`, "POST")
        .catch(() => {
          error.value = "播放会话已失效，请重新加载";
        });
  }, 600000);
function wake() {
  if (document.visibilityState === "visible") {
    clock.reset();
    sampleClock();
    void applyState(true);
  }
}
onMounted(() => {
  document.addEventListener("visibilitychange", wake);
  void run(async () => {
    try {
      await session.load();
    } catch {
      return;
    }
    await refresh();
  });
});
onBeforeUnmount(() => {
  connectionSerial++;
  clearTimeout(retry);
  socket?.close();
  clearInterval(statusTimer);
  clearInterval(timer);
  clearInterval(clockTimer);
  clearInterval(renewTimer);
  document.removeEventListener("visibilitychange", wake);
  void stopPlayback();
});
</script>

<template>
  <div class="shell">
    <aside class="rail">
      <a class="brand" href="/">雨<span>RainSync</span></a>
      <div class="rail-line"></div>
      <button
        aria-label="一起看"
        :class="{ active: tab === 'watch' }"
        @click="tab = 'watch'"
      >
        ◉ <span>一起看</span></button
      ><button
        aria-label="片源管理"
        v-if="session.user?.admin"
        :class="{ active: tab === 'settings' }"
        @click="tab = 'settings'"
      >
        ⚙ <span>片源管理</span>
      </button>
      <div class="rail-bottom">
        让远方，同频。<small>SELF-HOSTED CINEMA</small>
      </div>
    </aside>
    <main>
      <header>
        <div class="breadcrumb">
          YOUR PRIVATE CINEMA <span>/</span>
          {{ tab === "settings" ? "设置" : (room?.name ?? "放映室") }}
        </div>
        <div class="identity" v-if="session.user">
          <i :class="{ online: connected }"></i>{{ session.user.username
          }}<button
            class="text"
            @click="
              run(async () => {
                await session.api('/auth/logout', 'POST');
                reload();
              })
            "
          >
            退出
          </button>
        </div>
      </header>
      <div class="notice error" v-if="error" role="alert">
        {{ error }}<button class="text" @click="error = ''">关闭</button>
      </div>
      <section class="login card" v-if="!session.user">
        <div class="eyebrow">WELCOME TO RAINSYNC</div>
        <h1>相隔很远，<br />也能看到同一刻。</h1>
        <p>登录你的私人影院，邀请朋友一起看。</p>
        <form @submit.prevent="run(login)">
          <label
            >用户名<input
              v-model="username"
              autocomplete="username"
              required /></label
          ><label
            >密码<input
              v-model="password"
              type="password"
              autocomplete="current-password"
              required /></label
          ><button class="primary" :disabled="busy">进入影院 →</button>
        </form>
      </section>
      <template v-else-if="tab === 'watch'">
        <section class="heading">
          <div>
            <div class="eyebrow">GOOD FILMS, SHARED MOMENTS</div>
            <h1>{{ room?.name ?? "今晚，一起看什么？" }}</h1>
            <p>
              {{
                room
                  ? "你的片源，你们的放映时刻。"
                  : "创建一个房间，把此刻分享给远方的人。"
              }}
            </p>
          </div>
          <button v-if="room" @click="run(makeInvite)">邀请朋友 ↗</button>
        </section>
        <div v-if="invite" class="notice">
          <label
            >房间邀请（24 小时有效）<input
              readonly
              :value="invite"
              @focus="($event.target as HTMLInputElement).select()"
          /></label>
        </div>
        <section class="room-picker card">
          <select
            aria-label="选择房间"
            @change="
              run(() =>
                enter(
                  rooms.find(
                    (r) => r.id === ($event.target as HTMLSelectElement).value,
                  ),
                ),
              )
            "
          >
            <option value="">选择放映室</option>
            <option v-for="r in rooms" :key="r.id" :value="r.id">
              {{ r.name }}
            </option>
          </select>
          <form @submit.prevent="run(createRoom)">
            <input
              aria-label="新房间名称"
              v-model="roomName"
              maxlength="120"
            /><button :disabled="busy">＋ 创建房间</button>
          </form>
          <details>
            <summary>通过邀请加入</summary>
            <form @submit.prevent="run(join)">
              <input v-model="joinRoom" placeholder="房间 ID" required /><input
                v-model="joinToken"
                placeholder="邀请 token"
                required
              /><button>加入</button>
            </form>
          </details>
        </section>
        <div class="watch-grid" v-if="room">
          <section class="screen-area">
            <div class="screen">
              <video
                ref="video"
                playsinline
                @waiting="waiting = true"
                @canplay="waiting = false"
                @playing="waiting = false"
                @error="error = '无法播放此格式，可切换兼容转码后重载'"
              >
                <track
                  v-for="t in subtitles"
                  :key="t.index"
                  kind="subtitles"
                  :src="t.url ?? undefined"
                  :srclang="t.language"
                  :label="t.label"
                />
              </video>
              <div v-if="!state?.media_id" class="empty-screen">
                <div class="film-icon">▷</div>
                <h2>好戏，等你开场</h2>
                <p>从下方媒体库中选择一部影片</p>
              </div>
              <button
                v-if="blocked"
                class="primary autoplay"
                @click="run(enablePlayback)"
              >
                点击加入播放</button
              ><span v-if="waiting && state?.media_id" class="buffering"
                >正在准备影片…</span
              >
            </div>
            <div class="transport">
              <button
                :disabled="!owner || !connected || !state?.media_id"
                @click="
                  send(state?.playback_status === 'playing' ? 'PAUSE' : 'PLAY')
                "
              >
                {{
                  state?.playback_status === "playing" ? "Ⅱ 暂停" : "▷ 播放"
                }}</button
              ><span>{{ format(position) }} / {{ format(duration) }}</span
              ><input
                aria-label="播放进度"
                type="range"
                min="0"
                :max="Number.isFinite(duration) ? duration : 0"
                :value="position"
                :disabled="!owner || !connected"
                @change="
                  send('SEEK', {
                    position_ms:
                      Number(($event.target as HTMLInputElement).value) * 1000,
                  })
                "
              /><select
                aria-label="房间倍速"
                :disabled="!owner || !connected"
                :value="state?.playback_rate ?? 1"
                @change="
                  send('SET_RATE', {
                    rate: Number(($event.target as HTMLSelectElement).value),
                  })
                "
              >
                <option :value="0.5">0.5×</option>
                <option :value="1">1×</option>
                <option :value="1.5">1.5×</option>
                <option :value="2">2×</option>
              </select>
            </div>
            <div class="now-playing">
              <div>
                <small>NOW SHOWING</small>
                <h2>{{ currentTitle }}</h2>
              </div>
              <span class="status" :class="{ live: connected }">{{
                connected ? "● 已连接" : "○ 正在重连"
              }}</span>
            </div>
            <div class="playback-options">
              <label
                >播放方式<select v-model="mode">
                  <option value="auto">自动适配</option>
                  <option value="direct">直接播放</option>
                  <option value="remux">转封装</option>
                  <option value="transcode">兼容转码</option>
                </select></label
              ><button :disabled="!state?.media_id" @click="run(loadMedia)">
                重新加载</button
              ><label v-if="tracks.length > 1"
                >音轨<select v-model="audioIndex" @change="run(loadMedia)">
                  <option v-for="t in tracks" :key="t.index" :value="t.index">
                    {{ t.label }} · {{ t.language }}
                  </option>
                </select></label
              ><label v-if="subtitles.length"
                >字幕<select
                  @change="
                    video &&
                    Array.from(video.textTracks).forEach(
                      (t, i) =>
                        (t.mode =
                          i ===
                          Number(($event.target as HTMLSelectElement).value)
                            ? 'showing'
                            : 'disabled'),
                    )
                  "
                >
                  <option value="-1">关闭</option>
                  <option v-for="(t, i) in subtitles" :key="t.index" :value="i">
                    {{ t.label }} · {{ t.language }}
                  </option>
                </select></label
              ><label
                >音量<input
                  aria-label="音量"
                  type="range"
                  min="0"
                  max="1"
                  step=".05"
                  value="1"
                  @input="
                    video &&
                    (video.volume = Number(
                      ($event.target as HTMLInputElement).value,
                    ))
                  "
              /></label>
            </div>
          </section>
          <aside class="chat card">
            <div class="chat-title">房间聊天 <span>LIVE</span></div>
            <div class="chat-log" aria-live="polite">
              <div class="chat-welcome">
                同一场电影，<br />不同地方的你们。<small
                  >分享感想，从一句话开始。</small
                >
              </div>
              <article v-for="m in messages" :key="m.id">
                <b>{{ m.username }}</b>
                <p>{{ m.body }}</p>
              </article>
            </div>
            <form @submit.prevent="sendChat">
              <input
                v-model="chat"
                aria-label="聊天消息"
                placeholder="说点什么…"
                maxlength="2000"
                :disabled="!connected"
              /><button :disabled="!connected">↑</button>
            </form>
          </aside>
        </div>
        <section class="library">
          <div class="section-title">
            <h2>
              媒体库 <span>{{ library.length }}</span>
            </h2>
            <input
              v-model="search"
              aria-label="搜索影片"
              placeholder="搜索影片…"
            />
          </div>
          <div v-if="!media.length" class="empty-library card">
            媒体库还是空的。{{
              session.user.admin
                ? "前往「片源管理」添加并扫描你的片源。"
                : "请管理员添加影片。"
            }}
          </div>
          <div class="media-grid">
            <article
              v-for="(m, index) in library"
              :key="m.id"
              class="media-card"
            >
              <button
                class="poster"
                :class="`poster-${index % 4}`"
                :disabled="!room || !owner || !connected"
                @click="choose(m.id)"
              >
                <small>{{ m.kind.toUpperCase() }}</small
                ><span>▷</span><strong>{{ m.title }}</strong>
              </button>
              <h3>{{ m.title }}</h3>
              <div class="media-meta">
                {{ m.duration_ms ? format(m.duration_ms / 1000) : "点播影片"
                }}<button
                  v-if="owner"
                  class="text"
                  @click="run(() => addQueue(m.id))"
                >
                  ＋ 待播
                </button>
              </div>
            </article>
          </div>
        </section>
        <section v-if="room && playlist.length" class="card queue">
          <h2>待播列表</h2>
          <div v-for="p in playlist" :key="p.id">
            <span>{{ p.title }}</span
            ><button :disabled="!owner" @click="choose(p.media_id)">播放</button
            ><button
              v-if="owner"
              @click="
                run(async () => {
                  await session.api(
                    `/rooms/${room.id}/playlist/${p.id}`,
                    'DELETE',
                  );
                  playlist = await session.api(`/rooms/${room.id}/playlist`);
                })
              "
            >
              移除
            </button>
          </div>
        </section>
      </template>
      <section v-else class="settings">
        <div class="eyebrow">MAKE IT YOURS</div>
        <h1>连接你的媒体世界</h1>
        <div class="settings-grid">
          <section class="card">
            <h2>添加片源</h2>
            <form @submit.prevent="run(addSource)">
              <label>名称<input v-model="sourceName" required /></label
              ><label
                >类型<select v-model="sourceKind">
                  <option value="local">本地挂载目录</option>
                  <option value="http">HTTP MP4 / HLS</option>
                  <option value="jellyfin">Jellyfin</option>
                  <option value="emby">Emby</option>
                </select></label
              ><label v-if="sourceKind === 'local'"
                >容器内路径<input v-model="sourceRoot" /></label
              ><label v-else
                >媒体或服务 URL<input
                  v-model="sourceUrl"
                  type="url"
                  required /></label
              ><template v-if="['jellyfin', 'emby'].includes(sourceKind)"
                ><label
                  >专用账户 User ID<input
                    v-model="sourceUser"
                    required /></label
                ><label
                  >访问令牌<input
                    v-model="sourceToken"
                    type="password"
                    required /></label></template
              ><label v-if="sourceKind === 'http'"
                >请求头 JSON（可选）<textarea
                  v-model="sourceHeaders"
                  spellcheck="false"
                ></textarea></label
              ><button class="primary" :disabled="busy">添加片源</button>
            </form>
            <div v-for="s in sources" :key="s.id" class="source-row">
              <span
                >{{ s.name }} <small>{{ s.kind }}</small></span
              ><button
                :disabled="busy || s.kind === 'agent'"
                @click="run(() => scan(s.id))"
              >
                检测并扫描
              </button>
            </div>
          </section>
          <section class="card">
            <h2>连接 NAS Agent</h2>
            <p>Agent 主动连接服务器，无需开放 NAS 入站端口。</p>
            <form
              @submit.prevent="
                run(async () => {
                  const v = await session.api('/agents', 'POST', {
                    name: agentName,
                  });
                  pairCode = v.pair_code;
                  await refresh();
                })
              "
            >
              <label>设备名称<input v-model="agentName" required /></label
              ><button>生成 10 分钟配对码</button>
            </form>
            <textarea
              v-if="pairCode"
              readonly
              :value="pairCode"
              aria-label="Agent 配对码"
            ></textarea>
            <div v-for="a in agents" :key="a.id" class="source-row">
              <span
                >{{ a.name
                }}<small>{{
                  a.revoked ? "已撤销" : (a.last_seen ?? "等待连接")
                }}</small></span
              ><button
                :disabled="a.revoked"
                @click="
                  run(async () => {
                    await session.api(`/agents/${a.id}`, 'DELETE');
                    await refresh();
                  })
                "
              >
                撤销
              </button>
            </div>
            <h2>创建观看账户</h2>
            <form
              @submit.prevent="
                run(async () => {
                  await session.api('/users', 'POST', {
                    username: newUser,
                    password: newPassword,
                  });
                  newPassword = '';
                  newUser = '';
                })
              "
            >
              <label>用户名<input v-model="newUser" required /></label
              ><label
                >密码（至少 12 字符）<input
                  v-model="newPassword"
                  type="password"
                  minlength="12"
                  required /></label
              ><button>创建账户</button>
            </form>
          </section>
        </div>
      </section>
      <footer>
        RainSync <span>让每一次播放，都有陪伴。</span
        ><small>PRIVATE · CONNECTED · IN SYNC</small>
      </footer>
    </main>
  </div>
</template>
