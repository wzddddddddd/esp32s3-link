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
  ShieldCheck,
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

const labels = {
  devices: "我的设备",
  resources: "云端资源",
  send: "发送资源",
  tasks: "任务记录",
  ota: "OTA 更新",
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
    setDevices(state.devices);
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
    const timer = setInterval(() => void tick(), 15000);
    return () => {
      live = false;
      clearInterval(timer);
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
      setError(errorText(e));
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
      else setMessage("固件已保存。真实 OTA 暂未启用。");
    });
  }
  const device = devices.find((d) => d.id === target);
  const resource = resources.find((r) => r.id === resourceId);
  const online = (d: CloudDevice) =>
    !!d.last_seen && Date.now() - new Date(d.last_seen).getTime() < 90000;
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
      <header className="cloud-header">
        <a className="brand" href="#">
          <span className="brand-mark">
            <CircuitBoard />
          </span>
          LINK /
        </a>
        <span className="status-pill online">真实云端</span>
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
          {(
            [
              { id: "devices", icon: CircuitBoard },
              { id: "resources", icon: FolderOpen },
              { id: "send", icon: Send },
              { id: "tasks", icon: ListChecks },
              { id: "ota", icon: Cpu },
            ] as const
          ).map(({ id, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${view === id ? "active" : ""}`}
              onClick={() => setView(id)}
              aria-current={view === id ? "page" : undefined}
            >
              <Icon size={18} />
              {labels[id]}
            </button>
          ))}
          <button className="text-button" onClick={onDemo}>
            切换到演示模式
          </button>
        </nav>
        <main className="cloud-main">
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR PRIVATE CLOUD</div>
              <h1>{labels[view]}</h1>
              <p>
                {lastSync
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
                    r.name.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((r) => (
                    <article className="panel cloud-resource-row" key={r.id}>
                      <FolderOpen size={24} />
                      <div>
                        <h3>{r.name}</h3>
                        <p className="muted">
                          {formatSize(r.size_bytes)} ·{" "}
                          {r.kind === "image"
                            ? "图片"
                            : r.kind === "text"
                              ? "TXT 小说"
                              : "固件存档"}{" "}
                          · {new Date(r.created_at).toLocaleDateString("zh-CN")}
                        </p>
                      </div>
                      <button
                        className="text-button"
                        disabled={!!busy}
                        onClick={() => void openPreview(r)}
                      >
                        {r.kind === "firmware" ? "查看说明" : "预览"}
                      </button>
                      <button
                        className="button"
                        disabled={r.kind === "firmware"}
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
                    .filter((r) => r.kind !== "firmware")
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
                任务创建后等待设备领取。设备离线时会保留任务；网页不会自行推进下载进度。
              </p>
              <button
                className="button primary"
                disabled={
                  !!busy || !device || !resource || resource.kind === "firmware"
                }
                onClick={() => setConfirm(true)}
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
          {view === "ota" && (
            <section className="panel">
              <ShieldCheck size={32} />
              <h2>先验证资源传输，再启用真实 OTA</h2>
              <p className="muted">
                你可以上传固件存档，但当前云端接口会拒绝固件更新任务。需要确认设备分区、签名校验、断电恢复和回滚机制，再开放实际更新。
              </p>
              <button className="button" onClick={() => setView("resources")}>
                管理固件存档
              </button>
            </section>
          )}
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
        <p className="muted">会创建真实云端任务，设备配置完成并联网后执行。</p>
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
