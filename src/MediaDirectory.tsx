import { Music2, Film, BookOpen, Image, File, Folder, Play, Download, Trash2, ArrowRight, Search, FolderOpen } from 'lucide-react';
import type { Entry } from './cloud/files';
import type { MediaCategory } from './media';
import { formatSize } from './demo';

export const mediaIcons = { music: Music2, video: Film, novel: BookOpen, image: Image, file: File };
export default function MediaDirectory({ category, entries, path, ready, state, searching, onOpen, onPlay, onReceive, onDelete, onRefresh }: {
  category: MediaCategory; entries: Entry[]; path: string; ready: boolean; state: string; searching: boolean;
  onOpen: (entry: Entry) => void; onPlay: (entry: Entry) => void; onReceive: (entry: Entry) => void; onDelete: (entry: Entry) => void; onRefresh: () => void;
}) {
  const CategoryIcon = mediaIcons[category.kind];
  const cards = ['video', 'novel', 'image'].includes(category.kind);
  if (!entries.length) return <div className={`media-empty ${state === 'loading' || state === 'waiting' ? 'is-loading' : ''}`}>
    {searching ? <Search size={36} /> : <CategoryIcon size={42} strokeWidth={1.25} />}
    <h3>{searching ? '没有找到匹配的文件' : state === 'loading' || state === 'waiting' ? '正在读取设备目录' : state === 'complete' ? `这里还没有${category.label === '全部文件' ? '文件' : category.label}` : `读取你的${category.label === '全部文件' ? '文件' : category.label}`}</h3>
    <p>{searching ? '试试其他关键词，或清空搜索。' : state === 'loading' || state === 'waiting' ? '文件返回后会自动显示，请保持设备联网。' : state === 'complete' ? '使用右侧的发送区域，把电脑中的文件存到设备。' : '文件保存在设备的 SD 卡中，读取后即可管理。'}</p>
    {!searching && !['loading', 'waiting', 'complete'].includes(state) && <button className="media-primary" disabled={!ready} onClick={onRefresh}><FolderOpen size={16} />获取目录</button>}
  </div>;
  return <div className={`media-entries ${cards ? 'media-card-grid' : 'media-track-list'}`}>
    {!cards && <div className="media-list-head"><span>文件名称</span><span>大小 / 格式</span><span>操作</span></div>}
    {entries.map(entry => {
      const Icon = entry.directory ? Folder : CategoryIcon;
      const ext = entry.name.includes('.') ? entry.name.split('.').pop()!.toUpperCase() : '文件';
      const playable = !entry.directory && (path === '/music' || path.startsWith('/music/')) && /\.mp3$/i.test(entry.name);
      return <article key={entry.name} className={`media-entry ${entry.directory ? 'is-folder' : ''} media-${category.kind}`}>
        <div className="media-file-art" aria-hidden="true"><Icon size={cards ? 34 : 21} strokeWidth={1.5} />{cards && !entry.directory && <span>{ext}</span>}</div>
        <div className="media-file-name"><h3 title={entry.name}>{entry.name}</h3><span>{entry.directory ? '文件夹' : cards ? `${formatSize(entry.size)} · ${ext}` : '设备 SD 卡'}</span></div>
        {!cards && <div className="media-file-meta">{entry.directory ? '—' : <>{formatSize(entry.size)}<span>{ext}</span></>}</div>}
        <div className="media-entry-actions">
          {entry.directory && <button disabled={!ready} onClick={() => onOpen(entry)}><ArrowRight size={16} />打开</button>}
          {playable && <button className="media-play" disabled={!ready} onClick={() => onPlay(entry)} aria-label={`播放 ${entry.name}`}><Play size={15} fill="currentColor" />播放</button>}
          <button className="media-icon-button" disabled={!ready} onClick={() => onReceive(entry)} title={entry.directory ? '接收文件夹 ZIP' : '接收到电脑'} aria-label={`接收 ${entry.name}`}><Download size={17} /></button>
          {!entry.directory && <button className="media-icon-button media-delete" disabled={!ready} onClick={() => onDelete(entry)} title="删除设备文件" aria-label={`删除 ${entry.name}`}><Trash2 size={16} /></button>}
        </div>
      </article>;
    })}
  </div>;
}
