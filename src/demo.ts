import type { Device, Resource } from "./types";
export const MB = 1024 * 1024;
export const initialDevices: Device[] = [
  {
    id: "S3-DEMO-01",
    name: "桌面播放器",
    online: true,
    hardware: "ESP32-S3-DEMO",
    version: "1.0.0",
    capacity: 8192 * MB,
    used: 1260 * MB,
    lastSeen: "演示连接",
  },
  {
    id: "S3-DEMO-02",
    name: "随身阅读器",
    online: false,
    hardware: "ESP32-S3-DEMO",
    version: "1.0.0",
    capacity: 4096 * MB,
    used: 580 * MB,
    lastSeen: "演示离线",
  },
];
export const initialResources: Resource[] = [
  {
    id: "sample-image-1",
    name: "光谱渐变.png",
    kind: "image",
    size: 246 * 1024,
    addedAt: "2026-09-20",
    origin: "sample",
  },
  {
    id: "sample-text-1",
    name: "漫游手记.txt",
    kind: "text",
    size: 86 * 1024,
    addedAt: "2026-09-20",
    origin: "sample",
    excerpt:
      "漫游手记\n\n第一章 · 出发\n\n清晨，窗外的天色刚刚亮起。我把几本书装进行囊，带着音乐，开始一段没有预定终点的旅程。\n\n沿途的风景慢慢掠过，每一个停留的地方，都值得留下一页记录。\n\n—— 这是用于预览排版的原创演示文本。",
  },
  {
    id: "sample-image-2",
    name: "暮色屏保.png",
    kind: "image",
    size: 182 * 1024,
    addedAt: "2026-09-19",
    origin: "sample",
  },
  {
    id: "sample-firmware-1",
    name: "esp32-s3_v1.1.0.bin",
    kind: "firmware",
    size: Math.round(2.4 * MB),
    addedAt: "2026-09-19",
    origin: "sample",
    version: "1.1.0",
    hardware: "ESP32-S3-DEMO",
    notes:
      "演示更新说明：优化资源列表的显示，改善阅读体验。此条目没有真实固件文件。",
  },
];
export const kindLabels = { image: "图片", text: "小说", firmware: "固件" };
export const statusLabels = {
  waiting: "等待设备",
  downloading: "模拟下载中",
  verifying: "模拟校验中",
  restarting: "模拟重启中",
  completed: "演示完成",
  failed: "演示失败",
  cancelled: "已取消",
};
export function formatSize(n: number) {
  return n >= 1024 * MB
    ? `${(n / (1024 * MB)).toFixed(1)} GB`
    : n >= MB
      ? `${(n / MB).toFixed(1)} MB`
      : `${Math.max(1, Math.round(n / 1024))} KB`;
}
