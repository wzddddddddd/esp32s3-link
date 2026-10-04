import { useEffect, useRef, useState } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import {
  CircuitBoard,
  CloudUpload,
  FolderOpen,
  Send,
  ListChecks,
  LogOut,
  Plus,
  Cpu,
  RefreshCw,
} from "lucide-react";
import {
  cloudStatus,
  snapshot,
  uploadResource,
  type CloudDevice,
  type CloudResource,
  type CloudTask,
} from "./cloud/client";
import { formatSize } from "./demo";
import CloudFiles from './CloudFiles';
import CloudOta from './CloudOta';
import StoragePanel from './StoragePanel';
import { mediaCategories, fileCategory } from './media';
import { mediaIcons } from './MediaDirectory';
import './studio.css';
import OfflineDialog from './OfflineDialog';
import { deviceOnline, OFFLINE_MESSAGE, offlineError, mergePresence } from './cloud/presence';
import { usePresenceClock } from './cloud/usePresenceClock';

const labels = {
  devices: "设备与存储",
  resources: "云端文件库",
  send: "发送云端资源",
  tasks: "传输任务",
  ota: "固件与升级",
  files: "设备媒体库",
};
type View = keyof typeof labels;
const errorText = (e: unknown) =>
  e && typeof e === "object" && "message" in e
    ? String(e.message)
    : "操作失败，请稍后重试。";
export default function CloudApp({
  client,
  projectUrl,
  onDemo,
}: {
  client: SupabaseClient;
  projectUrl: string;
  onDemo: () => void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const now = usePresenceClock();
  const [offlinePopup, setOfflinePopup] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [email, setEmail] = useState("");
  const [view, setView] = useState<View>("devices");
  const [devices, setDevices] = useState<CloudDevice[]>([]);
  const [resources, setResources] = useState<CloudResource[]>([]);
  const [tasks, setTasks] = useState<CloudTask[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [lastSync, setLastSync] = useState("");
  const [target, setTarget] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [query, setQuery] = useState("");
  const [mediaRoot, setMediaRoot] = useState('/music');
  const [mediaBusy, setMediaBusy] = useState(false);
  const [resourceCategory, setResourceCategory] = useState('all');
  const [deviceName, setDeviceName] = useState("我的 ESP32-S3");
  const [provision, setProvision] = useState<{
    device_id: string;
    token: string;
  } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [preview, setPreview] = useState<{
    name: string;
    url?: string;
    text?: string;
  } | null>(null);
  const files = useRef<HTMLInputElement>(null);
  const provisionDialog = useRef<HTMLDialogElement>(null);
  const confirmDialog = useRef<HTMLDialogElement>(null);
  const previewDialog = useRef<HTMLDialogElement>(null);
  const syncSequence = useRef(0);
  const acting = useRef(false);
  const sessionUser = useRef<string | undefined>(undefined);
  sessionUser.current = session?.user.id;
  useEffect(() => {
    let alive = true;
    void client.auth.getSession().then(({ data, error }) => {
      if (alive) {
        setSession(data.session);
        setAuthReady(true);
        if (error) setError(error.message);
      }
    });
    const { data } = client.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setAuthReady(true);
    });
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, [client]);
  async function refresh() {
    const owner = sessionUser.current;
    if (!owner) return;
    const sequence = ++syncSequence.current;
    const state = await snapshot(client);
    if (sequence !== syncSequence.current || owner !== sessionUser.current)
      return;
    setDevices(current => state.devices.map(row => mergePresence(current.find(item => item.id === row.id) ?? row, row)));
    setResources(state.resources);
    setTasks(state.tasks);
    setLastSync(new Date().toLocaleTimeString("zh-CN"));
  }
  useEffect(() => {
    setDevices([]);
    setResources([]);
    setTasks([]);
    setTarget("");
    setResourceId("");
    setLastSync("");
    setProvision(null);
    setPreview(null);
    ++syncSequence.current;
    if (!session?.user.id) return;
    let live = true;
    const tick = async () => {
      if (!live || document.hidden) return;
      try {
        await refresh();
      } catch (e) {
        if (live) setError(`同步失败：${errorText(e)}`);
      }
    };
    void tick();
    const deviceUpdates = client.channel(`device-capacity-${session.user.id}-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'link_devices', filter: `owner_id=eq.${session.user.id}` }, payload => {
        if (!live) return;
        const row = payload.new as CloudDevice & { owner_id: string };
        if (row.owner_id !== session.user.id) return;
        setDevices(current => current.map(item => item.id === row.id ? mergePresence(item, row) : item));
      }).subscribe();
    let pollingPresence = false;
    const presenceAbort = new AbortController();
    const presencePoll = setInterval(() => {
      if (!live || document.hidden || pollingPresence) return;
      pollingPresence = true;
      void client.from('link_devices').select('id,wifi_connected,presence_seen')
        .abortSignal(AbortSignal.any([presenceAbort.signal, AbortSignal.timeout(3000)])).then(result => {
        if (!live || result.error) return;
        setDevices(current => current.map(item => mergePresence(item, result.data?.find(row => row.id === item.id) ?? {})));
      }).then(() => { pollingPresence = false; }, () => { pollingPresence = false; });
    }, 3000);
    const timer = setInterval(() => void tick(), 15000);
    return () => {
      live = false;
      clearInterval(timer);
      clearInterval(presencePoll);
      presenceAbort.abort();
      void client.removeChannel(deviceUpdates).catch(() => {});
    };
  }, [session?.user.id, client]);
  useEffect(() => {
    if (provision) provisionDialog.current?.showModal();
  }, [provision]);
  useEffect(() => {
    if (confirm) confirmDialog.current?.showModal();
  }, [confirm]);
  useEffect(() => {
    if (preview) previewDialog.current?.showModal();
  }, [preview]);
  useEffect(
    () => () => {
      if (preview?.url) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );
  async function run(label: string, action: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true;
    setBusy(label);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (e) {
      if (offlineError(e)) { setOfflinePopup(true); setError(OFFLINE_MESSAGE); }
      else setError(errorText(e));
    } finally {
      acting.current = false;
      setBusy("");
    }
  }
  async function upload(selected: FileList | null) {
    if (!selected) return;
    const batch = Array.from(selected);
    await run("准备上传", async () => {
      let completed = 0;
      const failures: string[] = [];
      for (const file of batch) {
        try {
          await uploadResource(client, file, setBusy);
          completed++;
        } catch (e) {
          failures.push(`${file.name}：${errorText(e)}`);
        }
      }
      await refresh();
      setMessage(`${completed} 个文件已保存到私有云端。`);
      if (failures.length) setError(failures.join("；"));
    });
    if (files.current) files.current.value = "";
  }
  async function openPreview(resource: CloudResource) {
    await run("读取私有资源", async () => {
      const { data, error } = await client.storage
        .from("link-resources")
        .download(resource.storage_path);
      if (error) throw error;
      if (resource.kind === "text")
        setPreview({
          name: resource.name,
          text: await data.slice(0, 16000).text(),
        });
      else if (resource.kind === "image")
        setPreview({ name: resource.name, url: URL.createObjectURL(data) });
      else setMessage("固件已保存。请到“固件与升级”页面选择主应用 BIN 并开始升级。");
    });
  }
  const device = devices.find((d) => d.id === target);
  const resource = resources.find((r) => r.id === resourceId);
  const online = (d: CloudDevice) => navigator.onLine && deviceOnline(d, now);
  function requireConnection() {
    if (device && navigator.onLine && deviceOnline(device)) return true;
    setOfflinePopup(true); setError(OFFLINE_MESSAGE); return false;
  }
  if (!authReady) return <div className="cloud-loading">正在检查登录状态…</div>;
  if (!session)
    return (
      <div className="cloud-welcome">
        <div className="eyebrow">LINK / PRIVATE WORKSPACE</div>
        <h1>登录你的设备工作空间</h1>
        <p>资源只对你的账号与已配对设备开放。</p>
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            void run("发送登录邮件", async () => {
              const result = await client.auth.signInWithOtp({
                email: email.trim(),
                options: {
                  shouldCreateUser: false,
                  emailRedirectTo: `${location.origin}${location.pathname}`,
                },
              });
              if (result.error) throw result.error;
              setMessage(
                "登录邮件已请求，请检查邮箱并在本浏览器打开链接。未受邀账号无法登录。",
              );
            });
          }}
        >
          <label className="field">
            已获邀请的邮箱
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <button className="button primary full-width" disabled={!!busy}>
            {busy || "发送登录链接"}
          </button>
          <p className="muted">
            首次使用需要在云端后台邀请账号并授权工作空间。
          </p>
          {error && (
            <p className="validation-message" role="alert">
              {error}
            </p>
          )}
          {message && <p role="status">{message}</p>}
        </form>
        <button className="text-button" onClick={onDemo}>
          查看独立演示模式 →
        </button>
      </div>
    );
  return (
    <div className="cloud-console">
      <OfflineDialog open={offlinePopup} onClose={() => setOfflinePopup(false)} />
      <header className="cloud-header">
        <a className="brand" href="#">
          <span className="brand-mark">
            <CircuitBoard />
          </span>
          LINK <span className="cloud-brand-name">媒体工作台</span>
        </a>
        <span className="status-pill online">私有工作空间</span>
        <span className="cloud-user">{session.user.email}</span>
        <button
          className="text-button"
          disabled={!!busy}
          onClick={() =>
            void run("退出登录", async () => {
              const result = await client.auth.signOut();
              if (result.error) throw result.error;
            })
          }
        >
          <LogOut size={16} /> 退出
        </button>
      </header>
      <div className="cloud-body">
        <nav className="cloud-nav" aria-label="云端导航">
          <div className="cloud-nav-caption">设备</div>
          <button disabled={mediaBusy} className={`nav-item ${view === 'devices' ? 'active' : ''}`} onClick={() => setView('devices')} aria-current={view === 'devices' ? 'page' : undefined}><CircuitBoard size={18} />设备与存储</button>
          <div className="cloud-nav-caption">设备内容</div>
          {mediaCategories.map(item => { const Icon = mediaIcons[item.kind]; return <button key={item.root} disabled={mediaBusy} className={`nav-item ${view === 'files' && mediaRoot === item.root ? 'active' : ''}`} onClick={() => { setMediaRoot(item.root); setView('files'); }} aria-current={view === 'files' && mediaRoot === item.root ? 'page' : undefined}><Icon size={18} />{item.title}</button>; })}
          <div className="cloud-nav-caption">工作空间</div>
          {(
            [
              { id: "resources", icon: FolderOpen },
              { id: "send", icon: Send },
              { id: "tasks", icon: ListChecks },
              { id: "ota", icon: Cpu },
            ] as const
          ).map(({ id, icon: Icon }) => (
            <button
              key={id}
              disabled={mediaBusy}
              className={`nav-item ${view === id ? "active" : ""}`}
              onClick={() => setView(id)}
              aria-current={view === id ? "page" : undefined}
            >
              <Icon size={18} />
              {labels[id]}
            </button>
          ))}
          <div className="cloud-nav-foot"><span className="cloud-nav-device-dot" />{devices.filter(online).length} 台设备在线<small>通过 Wi-Fi 连接你的设备</small></div>
          <button className="text-button" disabled={mediaBusy} onClick={onDemo}>
            切换到演示模式
          </button>
        </nav>
        <main className="cloud-main">
          <div className="page-heading">
            <div>
              <h1>{view === 'files' ? mediaCategories.find(item => item.root === mediaRoot)?.title : labels[view]}</h1>
              <p>
                {view === 'files' ? mediaCategories.find(item => item.root === mediaRoot)?.help : lastSync
                  ? `最近同步 ${lastSync} · 设备进度由真实回报更新`
                  : "正在连接你的工作空间"}
              </p>
            </div>
            <button
              className="button"
              disabled={!!busy}
              onClick={() => void run("同步中", refresh)}
            >
              <RefreshCw size={15} /> 刷新
            </button>
          </div>
          {error && (
            <div role="alert" className="cloud-error">
              {error}
              <button className="text-button" onClick={() => setError("")}>
                关闭提示
              </button>
            </div>
          )}
          {message && (
            <div role="status" className="inline-note">
              {message}
            </div>
          )}
          {busy && (
            <div role="status" className="inline-note">
              {busy}…
            </div>
          )}
          {view === "files" && <CloudFiles key={session.user.id} client={client} devices={devices} categoryRoot={mediaRoot} onCategoryChange={setMediaRoot} onBusyChange={setMediaBusy} />}
          {view === "devices" && (
            <>
              <form
                className="panel"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run("登记设备", async () => {
                    const result = await client.rpc("link_register_device", {
                      p_name: deviceName.trim(),
                      p_hardware: "ESP32-S3",
                    });
                    if (result.error) throw result.error;
                    setProvision(result.data);
                    await refresh();
                  });
                }}
              >
                <h2>登记一台 ESP32-S3</h2>
                <p className="muted">
                  登记后生成独立设备凭证。需要将凭证配置到设备程序，设备报到后才会显示在线。
                </p>
                <label className="field">
                  设备名称
                  <input
                    value={deviceName}
                    onChange={(e) => setDeviceName(e.target.value)}
                    required
                    maxLength={40}
                  />
                </label>
                <button className="button primary" disabled={!!busy}>
                  <Plus size={17} /> 登记设备
                </button>
              </form>
              <div className="settings-devices cloud-device-list">
                {devices.map((d) => (
                  <section className="panel" key={d.id}>
                    <div className="section-heading">
                      <h2>{d.name}</h2>
                      <span
                        className={`status-pill ${online(d) ? "online" : ""}`}
                      >
                        {!d.last_seen
                          ? "等待首次报到"
                          : online(d)
                            ? "在线"
                            : "离线"}
                      </span>
                    </div>
                    <dl className="details">
                      <div>
                        <dt>设备编号</dt>
                        <dd className="mono">{d.id}</dd>
                      </div>
                      <div>
                        <dt>固件</dt>
                        <dd>{d.firmware_version || "等待设备回报"}</dd>
                      </div>
                      <div><dt>运行模式</dt><dd>{d.firmware_mode === 'recovery' ? 'OTA 恢复程序' : '主程序'}</dd></div>
                      <div>
                        <dt>剩余空间</dt>
                        <dd>
                          {d.capacity_bytes
                            ? formatSize(d.capacity_bytes - d.used_bytes)
                            : "等待设备回报"}
                        </dd>
                      </div>
                      <div>
                        <dt>最后联系</dt>
                        <dd>
                          {d.last_seen
                            ? new Date(d.last_seen).toLocaleString("zh-CN")
                            : "尚未连接"}
                        </dd>
                      </div>
                    </dl>
                    {d.capacity_bytes > 0 && <div className="device-space"><progress aria-label={`${d.name} SD 卡使用率`} max={d.capacity_bytes} value={d.used_bytes} /><span>已用 {formatSize(d.used_bytes)} / 总量 {formatSize(d.capacity_bytes)}</span></div>}
                    <details className="device-capacity-detail"><summary>查看 Flash 分区与运行内存</summary><StoragePanel storage={d.storage} /></details>
                    <button
                      className="button"
                      onClick={() => {
                        setTarget(d.id);
                        setView("send");
                      }}
                    >
                      发送资源
                    </button>
                  </section>
                ))}
              </div>
              {!devices.length && lastSync && (
                <p className="muted">
                  还没有设备。若登记提示未授权，请先在 Supabase 后台授权此账号。
                </p>
              )}
            </>
          )}
          {view === "resources" && (
            <>
              <nav className="media-category-tabs cloud-resource-filters" aria-label="云端资源分类">{[{ kind: 'all', label: '全部' }, ...mediaCategories.filter(item => item.kind !== 'file')].map(item => <button key={item.kind} aria-pressed={resourceCategory === item.kind} onClick={() => setResourceCategory(item.kind)}>{item.label}</button>)}</nav>
              <input
                ref={files}
                className="sr-only"
                type="file"
                multiple
                accept=".png,.jpg,.jpeg,.webp,.txt,.bin"
                onChange={(e) => void upload(e.target.files)}
              />
              <div className="toolbar">
                <label className="search">
                  <input
                    placeholder="搜索云端资源"
                    aria-label="搜索云端资源"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <button
                  className="button primary"
                  disabled={!!busy}
                  onClick={() => files.current?.click()}
                >
                  <CloudUpload size={18} /> 上传到私有云端
                </button>
              </div>
              <div className="resource-list">
                {resources
                  .filter((r) =>
                    r.name.toLowerCase().includes(query.toLowerCase()) && (resourceCategory === 'all' || fileCategory(r.name) === resourceCategory),
                  )
                  .map((r) => (
                    <article className="panel cloud-resource-row" key={r.id}>
                      {(() => { const Icon = mediaIcons[fileCategory(r.name) as keyof typeof mediaIcons]; return <Icon size={24} />; })()}
                      <div>
                        <h3>{r.name}</h3>
                        <p className="muted">
                          {formatSize(r.size_bytes)} ·{" "}
                          {r.kind === "image"
                            ? "图片"
                            : r.kind === "text"
                              ? "TXT 小说"
                              : r.kind === "file" ? "普通文件" : "固件存档"}{" "}
                          · {new Date(r.created_at).toLocaleDateString("zh-CN")}
                        </p>
                      </div>
                      <button
                        className="text-button"
                        disabled={!!busy || r.kind === "file"}
                        onClick={() => void openPreview(r)}
                      >
                        {r.kind === "firmware" ? "查看说明" : "预览"}
                      </button>
                      <button
                        className="button"
                        disabled={r.kind === "firmware" || r.kind === "file" || r.size_bytes === 0}
                        onClick={() => {
                          setResourceId(r.id);
                          setView("send");
                        }}
                      >
                        发送
                      </button>
                    </article>
                  ))}
              </div>
              {!!resources.length && !resources.some(r => r.name.toLowerCase().includes(query.toLowerCase()) && (resourceCategory === 'all' || fileCategory(r.name) === resourceCategory)) && (
                <div className="empty-state">
                  <CloudUpload size={32} />
                  <h3>没有找到匹配的资源</h3>
                  <p>切换分类或尝试其他关键词。音乐和视频也可以从对应的设备页面直接上传。</p>
                </div>
              )}
              {!resources.length && (
                <div className="empty-state">
                  <CloudUpload size={32} />
                  <h3>上传第一份资源</h3>
                  <p>选择 TXT 或图片，文件会保存在你的私有存储空间。</p>
                </div>
              )}
            </>
          )}
          {view === "send" && (
            <section className="panel">
              <h2>创建设备下载任务</h2>
              <label className="field">
                目标设备
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="">请选择设备</option>
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} · {online(d) ? "在线" : "离线 / 待报到"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                云端资源
                <select
                  value={resourceId}
                  onChange={(e) => setResourceId(e.target.value)}
                >
                  <option value="">请选择图片或小说</option>
                  {resources
                    .filter((r) => (r.kind === "image" || r.kind === "text") && r.size_bytes > 0)
                    .map((r) => (
                      <option value={r.id} key={r.id}>
                        {r.name} · {formatSize(r.size_bytes)}
                      </option>
                    ))}
                </select>
              </label>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={overwrite}
                  onChange={(e) => setOverwrite(e.target.checked)}
                />{" "}
                允许替换设备上的同名文件
              </label>
              <p className="inline-note">
                仅在设备 Wi-Fi 在线时发送；离线操作不会创建任务。
              </p>
              <button
                className="button primary"
                disabled={
                  !!busy || !device || !resource || !["image", "text"].includes(resource.kind) || resource.size_bytes === 0
                }
                onClick={() => { if (requireConnection()) setConfirm(true); }}
              >
                <Send size={17} /> 确认发送
              </button>
            </section>
          )}
          {view === "tasks" && (
            <div className="task-list">
              {tasks.map((t) => (
                <article className="task-card" key={t.id}>
                  <div className="section-heading">
                    <h2>{t.resource_name}</h2>
                    <span
                      className={`status-pill ${t.status === "completed" ? "online" : ""}`}
                    >
                      {cloudStatus[t.status] || t.status}
                    </span>
                  </div>
                  <p className="muted">
                    {devices.find((d) => d.id === t.device_id)?.name ||
                      t.device_id}{" "}
                    · {new Date(t.created_at).toLocaleString("zh-CN")}
                  </p>
                  <div className="task-progress">
                    <progress
                      value={t.bytes_received}
                      max={t.size_bytes}
                      aria-label={`${t.resource_name} 设备回报进度`}
                    />
                    <span>
                      {Math.floor((t.bytes_received / t.size_bytes) * 100)}%
                    </span>
                  </div>
                  <div className="task-bottom">
                    <span>
                      {t.error ||
                        (t.status === "waiting"
                          ? "等待真实设备领取，尚未开始传输。"
                          : t.status === "completed"
                            ? "设备已回报完整文件校验通过。"
                            : "根据设备回报更新；请保持设备联网。")}
                    </span>
                    {t.status === "waiting" && (
                      <button
                        className="text-button"
                        disabled={!!busy}
                        onClick={() =>
                          void run("取消任务", async () => {
                            const result = await client.rpc(
                              "link_cancel_task",
                              { p_task_id: t.id },
                            );
                            if (result.error) throw result.error;
                            await refresh();
                          })
                        }
                      >
                        取消任务
                      </button>
                    )}
                  </div>
                </article>
              ))}
              {!tasks.length && (
                <div className="empty-state">
                  <ListChecks size={32} />
                  <h3>还没有下载任务</h3>
                  <p>上传资源并选择设备后，即可创建任务。</p>
                </div>
              )}
            </div>
          )}
          {view === "ota" && <CloudOta client={client} devices={devices} resources={resources} refresh={refresh} onBusyChange={setMediaBusy} blocked={!!busy} />}
          <footer>
            <span>LINK / 私有云端工作空间</span>
            <span>HTTPS · 账号隔离 · 设备独立凭证</span>
          </footer>
        </main>
      </div>
      <dialog
        className="modal"
        ref={provisionDialog}
        onClose={() => setProvision(null)}
      >
        {provision && (
          <>
            <h2>保存设备凭证</h2>
            <p className="muted">
              设备密钥仅显示这一次，请保存在自己的安全位置，后续配置到
              ESP32。不要放入公开仓库或截图分享。
            </p>
            <label className="field">
              设备编号
              <input readOnly value={provision.device_id} />
            </label>
            <label className="field">
              设备密钥
              <input readOnly value={provision.token} />
            </label>
            <label className="field">
              设备接口
              <input
                readOnly
                value={`${projectUrl}/functions/v1/device-gateway`}
              />
            </label>
            <button
              className="button primary"
              onClick={() => provisionDialog.current?.close()}
            >
              我已保存，关闭
            </button>
          </>
        )}
      </dialog>
      <dialog
        className="modal"
        ref={confirmDialog}
        onClose={() => setConfirm(false)}
      >
        <h2>确认发送到设备</h2>
        <p className="dialog-description">
          将「{resource?.name}」发送给「{device?.name}」。同名文件：
          {overwrite ? "允许覆盖" : "禁止覆盖"}。
        </p>
        <p className="muted">发送前会再次检查设备联网状态，离线时不创建任务。</p>
        {error && (
          <p className="validation-message" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            className="button"
            disabled={!!busy}
            onClick={() => confirmDialog.current?.close()}
          >
            返回
          </button>
          <button
            className="button primary"
            disabled={!!busy || !device || !resource}
            onClick={() =>
              void run("创建任务", async () => {
                if (!requireConnection()) return;
                const result = await client.rpc("link_create_task", {
                  p_device_id: target,
                  p_resource_id: resourceId,
                  p_overwrite: overwrite,
                });
                if (result.error) throw result.error;
                confirmDialog.current?.close();
                setView("tasks");
                setMessage("任务已创建，等待设备实际执行。");
                await refresh();
              })
            }
          >
            创建下载任务
          </button>
        </div>
      </dialog>
      <dialog
        className="modal"
        ref={previewDialog}
        onClose={() => setPreview(null)}
      >
        {preview && (
          <>
            <div className="modal-header">
              <h2>{preview.name}</h2>
              <button
                className="button"
                onClick={() => previewDialog.current?.close()}
              >
                关闭
              </button>
            </div>
            {preview.url ? (
              <img
                className="cloud-preview-image"
                src={preview.url}
                alt={preview.name}
              />
            ) : (
              <pre className="cloud-preview-text">{preview.text}</pre>
            )}
            <p className="muted">私有资源预览；TXT 最多显示前 16 KB。</p>
          </>
        )}
      </dialog>
    </div>
  );
}
