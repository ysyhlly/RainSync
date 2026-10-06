import type { RoomPermission } from "../../shared/api/types";
export const roomPermissionOptions: { value: RoomPermission; label: string }[] =
  [
    { value: "invite", label: "邀请观看者" },
    { value: "kick", label: "移除成员" },
    { value: "close", label: "关闭房间" },
    { value: "play", label: "播放" },
    { value: "pause", label: "暂停" },
    { value: "seek", label: "跳转进度" },
    { value: "set_rate", label: "调整倍速" },
    { value: "change_media", label: "更换影片 / 自动下一部" },
    { value: "queue", label: "管理待播 / 导入影片" },
  ];
