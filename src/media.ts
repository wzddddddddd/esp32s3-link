export const mediaCategories = [
  { kind: 'music', label: '音乐', title: '我的音乐', root: '/music', accept: '.mp3', help: '管理 SD 卡里的歌曲，发送 MP3，或让设备开始播放。', format: 'MP3' },
  { kind: 'video', label: '视频', title: '视频库', root: '/video', accept: '.avi,.mp4,.mjpeg', help: '集中管理视频文件，发送到设备后，在设备的视频页面打开。', format: 'AVI / MJPEG' },
  { kind: 'novel', label: '小说', title: '我的书架', root: '/novels', accept: '.txt', help: '把喜欢的小说放进书架，发送 UTF-8 TXT 到设备阅读。', format: 'UTF-8 TXT' },
  { kind: 'image', label: '图片', title: '图片库', root: '/images', accept: 'image/*', help: '整理设备里的图片，也可以从电脑发送新的图片文件。', format: '图片文件' },
  { kind: 'file', label: '全部文件', title: '文件管理', root: '/', accept: '', help: '查看 SD 卡目录，管理其他文件和文件夹。', format: '所有文件' },
] as const;
export type MediaCategory = typeof mediaCategories[number];
export function categoryForPath(path: string): MediaCategory {
  return mediaCategories.find(item => item.root !== '/' && (path === item.root || path.startsWith(item.root + '/'))) ?? mediaCategories[4];
}
export function fileCategory(name: string): string {
  if (/\.(mp3|wav|flac|aac|ogg)$/i.test(name)) return 'music';
  if (/\.(avi|mp4|mjpeg|mov|mkv)$/i.test(name)) return 'video';
  if (/\.(txt|epub)$/i.test(name)) return 'novel';
  if (/\.(png|jpe?g|webp|bmp|gif)$/i.test(name)) return 'image';
  return 'file';
}
