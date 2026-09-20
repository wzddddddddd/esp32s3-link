import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CheckCheck,
  ChevronRight,
  CircuitBoard,
  Clock3,
  Cloud,
  CloudUpload,
  Cpu,
  FolderOpen,
  HardDrive,
  LayoutDashboard,
  ListChecks,
  Menu,
  Pencil,
  Plus,
  Radio,
  RotateCcw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  formatSize,
  initialDevices,
  initialResources,
  kindLabels,
  statusLabels,
} from "./demo";
import type {
  DeviceFile,
  Page,
  Resource,
  ResourceKind,
  TransferTask,
} from "./types";
import { useWorkspaceTools } from "./workspace-tools";

const navigation: { id: Page; label: string; icon: LucideIcon }[] = [
  { id: "overview", label: "设备总览", icon: LayoutDashboard },
  { id: "resources", label: "资源库", icon: FolderOpen },
  { id: "send", label: "发送资源", icon: Send },
  { id: "tasks", label: "任务记录", icon: ListChecks },
  { id: "ota", label: "OTA 更新", icon: Cpu },
  { id: "settings", label: "设备设置", icon: Settings2 },
];
const pageTitles: Record<Page, [string, string]> = {
  overview: ["让设备，始终保持连接。", "管理你的设备，将喜欢的内容送到身边。"],
  resources: ["所有内容，归于一处。", "整理图片、小说与固件，准备下一次发送。"],
  send: ["把喜欢的内容，送到设备。", "选择资源和目标设备，创建一次下载任务。"],
  tasks: ["每一次传输，都有迹可循。", "查看下载进度、执行结果与等待中的任务。"],
  ota: ["下一版本，准备就绪。", "检查适用硬件，体验完整的固件更新流程。"],
  settings: [
    "你的设备，由你定义。",
    "管理演示设备，预览后续的连接与绑定功能。",
  ],
};
function ResourceVisual({
  resource,
  small = false,
}: {
  resource: Resource;
  small?: boolean;
}) {
  return (
    <div
      className={`resource-visual ${resource.kind} ${small ? "small" : ""} ${resource.id === "sample-image-2" ? "dusk" : ""}`}
    >
      {resource.preview ? (
        <img src={resource.preview} alt={resource.name} />
      ) : resource.kind === "image" ? (
        <>
          <span className="spectrum" />
          <span className="visual-caption">
            {resource.id === "sample-image-2" ? "DUSK / 02" : "SPECTRUM / 01"}
          </span>
        </>
      ) : resource.kind === "text" ? (
        <>
          <BookOpen size={small ? 22 : 38} strokeWidth={1.2} />
          {!small && (
            <>
              <b>{resource.name.replace(/\.txt$/i, "")}</b>
              <span>TEXT / UTF-8</span>
            </>
          )}
        </>
      ) : (
        <Cpu size={small ? 22 : 44} strokeWidth={1.2} />
      )}
    </div>
  );
}
export default function App() {
  const [page, setPage] = useState<Page>(() =>
    navigation.some((n) => n.id === location.hash.slice(1))
      ? (location.hash.slice(1) as Page)
      : "overview",
  );
  const [mobileMenu, setMobileMenu] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () => matchMedia("(max-width: 700px)").matches,
  );
  const [devices, setDevices] = useState(initialDevices);
  const [resources, setResources] = useState<Resource[]>(initialResources);
  const [tasks, setTasks] = useState<TransferTask[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [target, setTarget] = useState(initialDevices[0].id);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ResourceKind | "all">("all");
  const [toast, setToast] = useState("");
  const [preview, setPreview] = useState<Resource | null>(null);
  const [deviceFiles, setDeviceFiles] = useState<DeviceFile[]>([]);
  const [action, setAction] = useState<{
    kind: "send" | "ota" | "rename" | "delete" | "files";
    id?: string;
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [taskFilter, setTaskFilter] = useState("all");
  const [firmwareId, setFirmwareId] = useState("sample-firmware-1");
  const [confirmError, setConfirmError] = useState("");
  const actionDialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const urls = useRef<string[]>([]);
  useWorkspaceTools({ page, devices, resources, tasks });
  function navigate(next: Page) {
    setPage(next);
    location.hash = next;
    setMobileMenu(false);
    window.scrollTo(0, 0);
  }
  useEffect(() => {
    const f = () => {
      const id = location.hash.slice(1);
      setPage(navigation.some((n) => n.id === id) ? (id as Page) : "overview");
    };
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    const media = matchMedia("(max-width: 700px)");
    const update = () => {
      setIsMobile(media.matches);
      setMobileMenu(false);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => () => urls.current.forEach(URL.revokeObjectURL), []);
  useEffect(() => {
    if (preview) dialog.current?.showModal();
  }, [preview]);
  useEffect(() => {
    if (action) {
      setConfirmError("");
      actionDialog.current?.showModal();
    }
  }, [action]);
  useEffect(() => {
    if (
      !tasks.some(
        (t) =>
          ["waiting", "downloading", "verifying", "restarting"].includes(
            t.status,
          ) && devices.some((d) => d.id === t.deviceId && d.online),
      )
    )
      return;
    const timer = setTimeout(() => {
      const finished: TransferTask[] = [];
      const next = tasks.map((t) => {
        if (!devices.some((d) => d.id === t.deviceId && d.online)) return t;
        if (t.status === "waiting")
          return { ...t, status: "downloading" as const };
        if (t.status === "downloading")
          return t.progress < 100
            ? { ...t, progress: Math.min(t.progress + 16, 100) }
            : { ...t, status: "verifying" as const };
        if (t.status === "verifying" && t.kind === "firmware")
          return { ...t, status: "restarting" as const };
        if (t.status === "verifying" || t.status === "restarting") {
          finished.push(t);
          return { ...t, status: "completed" as const, progress: 100 };
        }
        return t;
      });
      setTasks(next);
      if (finished.length) {
        const nextFiles = [...deviceFiles];
        const changes = new Map<string, number>();
        for (const t of finished.filter((t) => t.kind !== "firmware")) {
          const previousIndex = nextFiles.findIndex(
            (f) =>
              f.deviceId === t.deviceId && f.resourceName === t.resourceName,
          );
          const previous =
            previousIndex >= 0
              ? nextFiles.splice(previousIndex, 1)[0]
              : undefined;
          changes.set(
            t.deviceId,
            (changes.get(t.deviceId) || 0) + t.size - (previous?.size || 0),
          );
          nextFiles.push({
            id: t.id,
            deviceId: t.deviceId,
            resourceName: t.resourceName,
            size: t.size,
            kind: t.kind,
          });
        }
        setDeviceFiles(nextFiles);
        setDevices((old) =>
          old.map((d) => ({
            ...d,
            used: d.used + (changes.get(d.id) || 0),
            version:
              finished.find((t) => t.deviceId === d.id && t.kind === "firmware")
                ?.version || d.version,
          })),
        );
      }
    }, 750);
    return () => clearTimeout(timer);
  }, [tasks, devices, deviceFiles]);
  async function importFiles(files: FileList | File[]) {
    const added: Resource[] = [];
    const rejected: string[] = [];
    for (const file of Array.from(files)) {
      const ext = file.name.split(".").pop()?.toLowerCase();
      const kind = ["png", "jpg", "jpeg", "webp"].includes(ext || "")
        ? "image"
        : ext === "txt"
          ? "text"
          : ext === "bin"
            ? "firmware"
            : null;
      if (!kind || file.size === 0 || file.size > 50 * 1024 * 1024) {
        rejected.push(file.name);
        continue;
      }
      const item: Resource = {
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        kind,
        addedAt: new Date().toISOString().slice(0, 10),
        origin: "local",
        file,
      };
      try {
        if (kind === "image") {
          item.preview = URL.createObjectURL(file);
          const url = item.preview;
          try {
            await new Promise<void>((resolve, reject) => {
              const img = new Image();
              img.onload = () => resolve();
              img.onerror = () => reject(new Error("Invalid image"));
              img.src = url;
            });
          } catch {
            URL.revokeObjectURL(url);
            rejected.push(file.name);
            continue;
          }
          urls.current.push(url);
        }
        if (kind === "text")
          item.excerpt = new TextDecoder("utf-8").decode(
            await file.slice(0, 16000).arrayBuffer(),
          );
      } catch {
        rejected.push(file.name);
        continue;
      }
      added.push(item);
    }
    setResources((old) => [...added, ...old]);
    setToast(
      `${added.length ? `已将 ${added.length} 个文件加入本次预览，尚未上传云端。` : ""}${rejected.length ? `未加入 ${rejected.length} 个文件：请检查格式、文件完整性和大小。支持非空 PNG / JPG / WebP / TXT / BIN，单文件不超过 50 MB。` : ""}`,
    );
    if (input.current) input.current.value = "";
  }
  const online = devices.filter((d) => d.online).length;
  const active = tasks.filter(
    (t) => !["completed", "cancelled", "failed"].includes(t.status),
  );
  const targetDevice = devices.find((d) => d.id === target)!;
  const sendResources = resources.filter(
    (r) => selected.includes(r.id) && r.kind !== "firmware",
  );
  const firmware = resources.find(
    (r) => r.id === firmwareId && r.kind === "firmware",
  );
  const totalBytes = sendResources.reduce((sum, r) => sum + r.size, 0);
  const availableFirmware = resources.filter(
    (r) =>
      r.kind === "firmware" &&
      r.version &&
      devices.some((d) => d.hardware === r.hardware && d.version !== r.version),
  );
  function validateTransfer(
    items: Resource[],
    allowOverwrite: boolean,
  ): string {
    if (!items.length) return "请先选择资源。";
    if (active.some((t) => t.deviceId === target && t.kind === "firmware"))
      return "此设备有尚未完成的 OTA 任务，请先完成或取消该任务。";
    const names = new Set<string>();
    let extra = 0;
    for (const r of items) {
      if (names.has(r.name)) return "所选资源存在同名文件，请先重命名。";
      names.add(r.name);
      if (
        active.some((t) => t.deviceId === target && t.resourceName === r.name)
      )
        return `「${r.name}」已有进行中的任务。`;
      const existing = deviceFiles.find(
        (f) => f.deviceId === target && f.resourceName === r.name,
      );
      if (existing && !allowOverwrite)
        return `设备已存在「${r.name}」，请勾选允许覆盖或先重命名。`;
      extra += Math.max(0, r.size - (existing?.size || 0));
      if (r.kind === "firmware") {
        if (active.some((t) => t.deviceId === target))
          return "请先完成或取消该设备的资源任务，再执行 OTA。";
        if (!r.version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(r.version))
          return "请填写有效版本号，例如 1.1.0。";
        if (r.hardware !== targetDevice.hardware)
          return "固件适用硬件与目标设备不一致。";
        if (r.version === targetDevice.version)
          return "设备已处于此版本，请选择其他版本。";
      }
    }
    const reserved = active
      .filter((t) => t.deviceId === target)
      .reduce((n, t) => n + t.size, 0);
    return extra + reserved > targetDevice.capacity - targetDevice.used
      ? "剩余存储空间不足（包括进行中任务占用）。"
      : "";
  }
  function createTransfer(items: Resource[], allowOverwrite: boolean) {
    const error = validateTransfer(items, allowOverwrite);
    if (error) {
      setConfirmError(error);
      return;
    }
    const created = items.map((r) => ({
      id: crypto.randomUUID(),
      deviceId: target,
      resourceId: r.id,
      resourceName: r.name,
      size: r.size,
      kind: r.kind,
      version: r.version,
      status: "waiting" as const,
      progress: 0,
      createdAt: new Date().toISOString(),
      overwrite: allowOverwrite,
    }));
    setTasks((old) => [...created, ...old]);
    setSelected([]);
    setOverwrite(false);
    actionDialog.current?.close();
    navigate("tasks");
    setToast("演示任务已创建。这里只模拟设备下载，不会实际传输文件。");
  }
  function retryTask(task: TransferTask) {
    if (!resources.some((r) => r.id === task.resourceId)) {
      setToast("原资源已被移除，请重新添加资源后创建任务。");
      return;
    }
    const d = devices.find((d) => d.id === task.deviceId)!;
    const reserved = active
      .filter((t) => t.deviceId === task.deviceId)
      .reduce((n, t) => n + t.size, 0);
    const duplicate = active.some(
      (t) =>
        t.deviceId === task.deviceId &&
        (t.resourceName === task.resourceName ||
          t.kind === "firmware" ||
          task.kind === "firmware"),
    );
    const existing = deviceFiles.some(
      (f) =>
        f.deviceId === task.deviceId && f.resourceName === task.resourceName,
    );
    if (
      duplicate ||
      reserved + task.size > d.capacity - d.used ||
      (existing && !task.overwrite) ||
      (task.kind === "firmware" && task.version === d.version)
    ) {
      setToast("无法重试：请检查重复任务、同名文件、存储空间或当前固件版本。");
      return;
    }
    setTasks((old) =>
      old.map((t) =>
        t.id === task.id
          ? { ...t, status: "waiting", progress: 0, error: undefined }
          : t,
      ),
    );
  }
  function editFirmware(field: "version" | "hardware", value: string) {
    setResources((old) =>
      old.map((r) => (r.id === firmwareId ? { ...r, [field]: value } : r)),
    );
  }
  const shown = resources.filter(
    (r) =>
      (filter === "all" || r.kind === filter) &&
      r.name.toLowerCase().includes(query.toLowerCase()),
  );
  function toggleSelection(id: string) {
    setSelected((old) =>
      old.includes(id) ? old.filter((i) => i !== id) : [...old, id],
    );
  }
  function resourceCards(items: Resource[]) {
    return (
      <div className="resource-grid">
        {items.map((r) => (
          <article className="resource-card" key={r.id}>
            <button
              className="preview-button"
              onClick={() => setPreview(r)}
              aria-label={`预览 ${r.name}`}
            >
              <ResourceVisual resource={r} />
            </button>
            <div className="resource-card-body">
              <div className="resource-name">
                <b title={r.name}>{r.name}</b>
                <input
                  type="checkbox"
                  aria-label={`选择 ${r.name}`}
                  checked={selected.includes(r.id)}
                  onChange={() => toggleSelection(r.id)}
                />
              </div>
              <div className="resource-meta">
                <span>
                  {kindLabels[r.kind]} · {formatSize(r.size)}
                </span>
                <span>{r.origin === "sample" ? "示例" : "本地"}</span>
              </div>
              {page === "resources" && (
                <div className="card-actions">
                  <button
                    className="text-button"
                    onClick={() => {
                      setRenameValue(r.name);
                      setAction({ kind: "rename", id: r.id });
                    }}
                  >
                    <Pencil size={12} /> 重命名
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`删除 ${r.name}`}
                    onClick={() => setAction({ kind: "delete", id: r.id })}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>
          </article>
        ))}
      </div>
    );
  }
  return (
    <div className="app-shell">
      <aside
        className={`sidebar ${mobileMenu ? "open" : ""}`}
        inert={isMobile && !mobileMenu}
      >
        <a
          className="brand"
          href="#overview"
          onClick={() => navigate("overview")}
        >
          <span className="brand-mark">
            <CircuitBoard size={24} />
          </span>
          <span>
            LINK<span className="brand-slash"> /</span>
          </span>
        </a>
        <div className="workspace-label">ESP32-S3 工作空间</div>
        <div className="nav-section-label">工作台</div>
        <nav aria-label="主导航">
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? "active" : ""}`}
              aria-current={page === id ? "page" : undefined}
              onClick={() => navigate(id)}
            >
              <Icon size={19} />
              <span>{label}</span>
              {id === "tasks" && active.length > 0 && (
                <span className="nav-count">{active.length}</span>
              )}
              {page === id && <span className="nav-active-mark" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="cloud-card">
            <Cloud size={21} />
            <b>云端连接待配置</b>
            <p>当前为本地演示工作空间</p>
            <button onClick={() => navigate("settings")}>
              查看接入准备 <ArrowUpRight size={15} />
            </button>
          </div>
          <div className="profile">
            <span className="avatar">L</span>
            <div>
              <b>个人工作空间</b>
              <small>框架预览 · v0.1.0</small>
            </div>
            <ShieldCheck size={18} />
          </div>
        </div>
      </aside>
      {mobileMenu && (
        <button
          className="sidebar-scrim"
          aria-label="关闭导航"
          onClick={() => setMobileMenu(false)}
        />
      )}
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button menu-button"
              aria-label="打开导航"
              onClick={() => setMobileMenu(!mobileMenu)}
            >
              <Menu size={21} />
            </button>
            <span>工作空间</span>
            <ChevronRight size={14} />
            <strong>{navigation.find((n) => n.id === page)?.label}</strong>
          </div>
          <div className="topbar-right">
            <span className="demo-pill">
              <span /> 演示模式
            </span>
            <span className="top-divider" />
            <span className="hardware-label">ESP32-S3</span>
            <span className="mini-avatar">L</span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {page === "overview"
                  ? "YOUR CONNECTED WORLD"
                  : `WORKSPACE / ${page.toUpperCase()}`}
              </div>
              <h1>{pageTitles[page][0]}</h1>
              <p>{pageTitles[page][1]}</p>
            </div>
            <button
              className="button primary"
              onClick={() =>
                page === "overview" ? navigate("send") : input.current?.click()
              }
            >
              {page === "overview" ? <Send size={17} /> : <Plus size={19} />}
              {page === "overview" ? "发送资源" : "添加本地资源"}
            </button>
          </div>
          <div className="demo-banner">
            <Sparkles size={16} />
            <span>
              你正在浏览演示工作空间。设备与任务为模拟数据，所选文件仅在本次页面中使用，不会上传或发送。
            </span>
            <span className="banner-tag">阶段 01</span>
          </div>
          <input
            ref={input}
            type="file"
            className="sr-only"
            aria-label="添加本地文件"
            accept=".png,.jpg,.jpeg,.webp,.txt,.bin"
            multiple
            onChange={(e) => e.target.files && void importFiles(e.target.files)}
          />
          {page === "overview" && (
            <>
              <div className="stats-grid">
                {[
                  {
                    label: "已绑定设备",
                    value: String(devices.length).padStart(2, "0"),
                    detail: `${online} 台模拟在线`,
                    icon: CircuitBoard,
                  },
                  {
                    label: "资源总数",
                    value: String(resources.length).padStart(2, "0"),
                    detail: `${resources.filter((r) => r.kind === "image").length} 张图片 · ${resources.filter((r) => r.kind === "text").length} 本小说`,
                    icon: FolderOpen,
                  },
                  {
                    label: "进行中的任务",
                    value: String(active.length).padStart(2, "0"),
                    detail: active.length
                      ? "演示任务执行中"
                      : "一切就绪，随时发送",
                    icon: ArrowDownToLine,
                  },
                  {
                    label: "可用固件",
                    value: String(availableFirmware.length).padStart(2, "0"),
                    detail: availableFirmware.length
                      ? "适用演示设备的其他版本"
                      : "暂无其他适用版本",
                    icon: Cpu,
                  },
                ].map((s) => (
                  <section className="stat-card" key={s.label}>
                    <div>
                      <span>{s.label}</span>
                      <s.icon size={20} />
                    </div>
                    <strong>{s.value}</strong>
                    <small>{s.detail}</small>
                  </section>
                ))}
              </div>
              <div className="overview-columns">
                <section>
                  <div className="section-heading">
                    <h2>
                      我的设备 <span>{devices.length}</span>
                    </h2>
                    <button
                      className="text-button"
                      onClick={() => navigate("settings")}
                    >
                      管理设备 <ArrowRight size={15} />
                    </button>
                  </div>
                  <div className="device-stack">
                    {devices.map((d) => (
                      <article
                        className={`device-card ${!d.online ? "offline" : ""}`}
                        key={d.id}
                      >
                        <div className="device-top">
                          <span className="device-icon">
                            <Smartphone size={29} strokeWidth={1.3} />
                          </span>
                          <div className="device-title">
                            <h3>{d.name}</h3>
                            <span>{d.id}</span>
                          </div>
                          <span
                            className={`status-pill ${d.online ? "online" : ""}`}
                          >
                            {d.online ? (
                              <Wifi size={12} />
                            ) : (
                              <WifiOff size={12} />
                            )}
                            {d.online ? "模拟在线" : "模拟离线"}
                          </span>
                        </div>
                        <div className="device-specs">
                          <span>
                            固件版本<b>v{d.version}</b>
                          </span>
                          <span>
                            存储方式
                            <b>
                              SD 卡 <small>演示</small>
                            </b>
                          </span>
                          <button
                            className="text-button"
                            onClick={() => {
                              setTarget(d.id);
                              navigate("send");
                            }}
                          >
                            发送资源 <ArrowUpRight size={15} />
                          </button>
                        </div>
                        <div className="storage-label">
                          <span>
                            <HardDrive size={13} /> 存储空间
                          </span>
                          <span>
                            {formatSize(d.used)}{" "}
                            <em>/ {formatSize(d.capacity)}</em>
                          </span>
                        </div>
                        <div className="storage-track">
                          <span
                            style={{ width: `${(d.used / d.capacity) * 100}%` }}
                          />
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
                <section className="quick-panel">
                  <div className="section-heading">
                    <h2>快速添加</h2>
                    <CloudUpload size={19} />
                  </div>
                  <button
                    className="dropzone"
                    onClick={() => input.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      void importFiles(e.dataTransfer.files);
                    }}
                  >
                    <span className="upload-icon">
                      <CloudUpload size={29} strokeWidth={1.5} />
                    </span>
                    <strong>将文件拖到这里</strong>
                    <span>或点击选择电脑中的文件</span>
                    <small>图片 / TXT 小说 / BIN 固件</small>
                    <span className="dropzone-action">
                      <Plus size={16} /> 选择文件
                    </span>
                  </button>
                  <div className="quick-note">
                    <ShieldCheck size={17} />
                    <p>
                      本地预览，无需上传。
                      <br />
                      <span>接入云端后，即可远程下发到设备。</span>
                    </p>
                  </div>
                </section>
              </div>
              <div className="section-heading resource-section-heading">
                <h2>最近资源</h2>
                <button
                  className="text-button"
                  onClick={() => navigate("resources")}
                >
                  查看全部 <ArrowRight size={15} />
                </button>
              </div>
              {resourceCards(resources.slice(0, 4))}
              <section className="activity-strip">
                <span className="activity-icon">
                  <Radio size={20} />
                </span>
                <div>
                  <b>
                    {tasks.length
                      ? `最近任务：${tasks[0].resourceName}`
                      : "你的下一次传输，从这里开始"}
                  </b>
                  <p>
                    {tasks.length
                      ? statusLabels[tasks[0].status]
                      : "选择一份资源，体验从发送到接收的完整流程。"}
                  </p>
                </div>
                <button
                  className="text-button"
                  onClick={() => navigate(tasks.length ? "tasks" : "send")}
                >
                  {tasks.length ? "查看任务" : "试一试"}{" "}
                  <ArrowRight size={16} />
                </button>
              </section>
            </>
          )}
          {page === "resources" && (
            <>
              <div className="toolbar">
                <div className="tabs" aria-label="资源分类">
                  {(["all", "image", "text", "firmware"] as const).map((f) => (
                    <button
                      key={f}
                      className={filter === f ? "selected" : ""}
                      aria-pressed={filter === f}
                      onClick={() => setFilter(f)}
                    >
                      {f === "all" ? "全部资源" : kindLabels[f]}{" "}
                      <span>
                        {
                          resources.filter((r) => f === "all" || r.kind === f)
                            .length
                        }
                      </span>
                    </button>
                  ))}
                </div>
                <label className="search">
                  <Search size={17} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索资源名称"
                    aria-label="搜索资源名称"
                  />
                </label>
              </div>
              {shown.length ? (
                resourceCards(shown)
              ) : (
                <div className="empty-state">
                  <FolderOpen size={36} />
                  <h3>没有找到资源</h3>
                  <p>更换搜索条件，或添加新的本地文件。</p>
                </div>
              )}
              {selected.length > 0 && (
                <div className="selection-bar">
                  <span>
                    已选择 <b>{selected.length}</b> 个资源
                  </span>
                  <button
                    className="text-button"
                    onClick={() => setSelected([])}
                  >
                    取消选择
                  </button>
                  <button
                    className="button primary"
                    onClick={() => navigate("send")}
                  >
                    <Send size={16} /> 发送所选资源
                  </button>
                </div>
              )}
            </>
          )}
          {page === "send" && (
            <>
              <div className="flow-steps">
                <span className="current">
                  01 <b>选择资源</b>
                </span>
                <ChevronRight size={15} />
                <span>
                  02 <b>选择设备</b>
                </span>
                <ChevronRight size={15} />
                <span>
                  03 <b>确认发送</b>
                </span>
              </div>
              <div className="send-layout">
                <section className="panel">
                  <div className="section-heading">
                    <h2>选择要发送的内容</h2>
                    <span className="muted">
                      已选 {sendResources.length} 项
                    </span>
                  </div>
                  <div className="resource-list">
                    {resources
                      .filter((r) => r.kind !== "firmware")
                      .map((r) => (
                        <label
                          className={`resource-row ${selected.includes(r.id) ? "checked" : ""}`}
                          key={r.id}
                        >
                          <input
                            type="checkbox"
                            checked={selected.includes(r.id)}
                            onChange={() => toggleSelection(r.id)}
                          />
                          <ResourceVisual resource={r} small />
                          <span className="row-name">
                            <b>{r.name}</b>
                            <small>
                              {kindLabels[r.kind]} · {formatSize(r.size)} ·{" "}
                              {r.origin === "sample" ? "示例资源" : "本地文件"}
                            </small>
                          </span>
                        </label>
                      ))}
                    {!resources.some((r) => r.kind !== "firmware") && (
                      <p className="muted">
                        还没有图片或小说，先添加本地文件。
                      </p>
                    )}
                  </div>
                  <button
                    className="add-row"
                    onClick={() => input.current?.click()}
                  >
                    <Plus size={17} /> 添加电脑中的文件
                  </button>
                  {selected.some(
                    (id) =>
                      resources.find((r) => r.id === id)?.kind === "firmware",
                  ) && (
                    <p className="inline-note">
                      所选固件不包含在资源发送中，请前往{" "}
                      <button
                        className="text-button"
                        onClick={() => {
                          setFirmwareId(
                            selected.find(
                              (id) =>
                                resources.find((r) => r.id === id)?.kind ===
                                "firmware",
                            )!,
                          );
                          navigate("ota");
                        }}
                      >
                        OTA 更新
                      </button>{" "}
                      单独操作。
                    </p>
                  )}
                </section>
                <aside className="panel send-summary">
                  <h2>发送到</h2>
                  <label className="field">
                    目标设备
                    <select
                      value={target}
                      onChange={(e) => setTarget(e.target.value)}
                    >
                      {devices.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name} · {d.online ? "模拟在线" : "模拟离线"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="target-summary">
                    <Smartphone size={27} />
                    <div>
                      <b>{targetDevice.name}</b>
                      <span>{targetDevice.id}</span>
                    </div>
                  </div>
                  <dl className="details">
                    <div>
                      <dt>文件数量</dt>
                      <dd>{sendResources.length} 个</dd>
                    </div>
                    <div>
                      <dt>资源大小</dt>
                      <dd>{totalBytes ? formatSize(totalBytes) : "—"}</dd>
                    </div>
                    <div>
                      <dt>剩余空间（演示）</dt>
                      <dd>
                        {formatSize(targetDevice.capacity - targetDevice.used)}
                      </dd>
                    </div>
                  </dl>
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={overwrite}
                      onChange={(e) => setOverwrite(e.target.checked)}
                    />{" "}
                    允许覆盖设备上的同名文件
                  </label>
                  <div className="inline-note">
                    <Clock3 size={16} />
                    <span>
                      {targetDevice.online
                        ? "设备模拟在线，创建任务后自动演示下载过程。"
                        : "设备模拟离线，任务将等待。可在设备设置中模拟上线。"}
                    </span>
                  </div>
                  <button
                    className="button primary full-width"
                    disabled={!sendResources.length}
                    onClick={() => setAction({ kind: "send" })}
                  >
                    <Send size={17} /> 确认发送（演示）
                  </button>
                  <p className="fine-print">文件仅用于本地预览，刷新后清空。</p>
                </aside>
              </div>
            </>
          )}
          {page === "tasks" && (
            <>
              <div className="toolbar">
                <div className="tabs">
                  {[
                    { id: "all", label: "全部任务" },
                    { id: "active", label: "进行中" },
                    { id: "completed", label: "已完成" },
                    { id: "failed", label: "失败 / 取消" },
                  ].map((f) => (
                    <button
                      key={f.id}
                      className={taskFilter === f.id ? "selected" : ""}
                      aria-pressed={taskFilter === f.id}
                      onClick={() => setTaskFilter(f.id)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
                <span className="muted">
                  共 {tasks.length} 项 · 仅保留本次会话
                </span>
              </div>
              <div className="task-list">
                {tasks
                  .filter(
                    (t) =>
                      taskFilter === "all" ||
                      (taskFilter === "active"
                        ? !["completed", "failed", "cancelled"].includes(
                            t.status,
                          )
                        : taskFilter === "failed"
                          ? ["failed", "cancelled"].includes(t.status)
                          : t.status === taskFilter),
                  )
                  .map((t) => (
                    <article className="task-card" key={t.id}>
                      <div className="task-top">
                        <span className="task-icon">
                          {t.kind === "firmware" ? (
                            <Cpu size={24} />
                          ) : (
                            <ArrowDownToLine size={24} />
                          )}
                        </span>
                        <div className="task-info">
                          <h3>{t.resourceName}</h3>
                          <p>
                            {devices.find((d) => d.id === t.deviceId)?.name}{" "}
                            <span>
                              · {formatSize(t.size)} ·{" "}
                              {new Date(t.createdAt).toLocaleTimeString(
                                "zh-CN",
                                { hour: "2-digit", minute: "2-digit" },
                              )}
                            </span>
                          </p>
                        </div>
                        <span
                          className={`status-pill ${t.status === "completed" ? "online" : t.status === "failed" ? "error" : ""}`}
                        >
                          {statusLabels[t.status]}
                        </span>
                      </div>
                      <div className="task-progress">
                        <progress
                          max="100"
                          value={t.progress}
                          aria-label={`${t.resourceName} 模拟下载进度`}
                        />
                        <span>{t.progress}%</span>
                      </div>
                      <div className="task-bottom">
                        <span>
                          {t.error ||
                            (t.status === "completed"
                              ? t.kind === "firmware"
                                ? `模拟设备已重新上线，版本 v${t.version}`
                                : "已加入演示设备文件列表，未发生真实传输。"
                              : !devices.find((d) => d.id === t.deviceId)
                                    ?.online &&
                                  !["failed", "cancelled"].includes(t.status)
                                ? "设备离线，等待恢复连接。"
                                : t.status === "cancelled"
                                  ? "任务已取消，未继续执行。"
                                  : "模拟进度，不代表真实设备状态。")}
                        </span>
                        <div>
                          {t.status === "waiting" && (
                            <button
                              className="text-button"
                              onClick={() =>
                                setTasks((old) =>
                                  old.map((x) =>
                                    x.id === t.id
                                      ? { ...x, status: "cancelled" }
                                      : x,
                                  ),
                                )
                              }
                            >
                              取消任务
                            </button>
                          )}
                          {["downloading", "verifying"].includes(t.status) && (
                            <button
                              className="text-button"
                              onClick={() =>
                                setTasks((old) =>
                                  old.map((x) =>
                                    x.id === t.id
                                      ? {
                                          ...x,
                                          status: "failed",
                                          error: "模拟网络错误。可重试此任务。",
                                        }
                                      : x,
                                  ),
                                )
                              }
                            >
                              模拟失败
                            </button>
                          )}
                          {["failed", "cancelled"].includes(t.status) && (
                            <button
                              className="text-button"
                              onClick={() => retryTask(t)}
                            >
                              <RotateCcw size={14} /> 重试
                            </button>
                          )}
                        </div>
                      </div>
                    </article>
                  ))}
              </div>
              {!tasks.some(
                (t) =>
                  taskFilter === "all" ||
                  (taskFilter === "active"
                    ? !["completed", "failed", "cancelled"].includes(t.status)
                    : taskFilter === "failed"
                      ? ["failed", "cancelled"].includes(t.status)
                      : t.status === taskFilter),
              ) && (
                <div className="empty-state">
                  <ListChecks size={38} />
                  <h3>这里还没有任务</h3>
                  <p>创建一次演示发送，查看设备下载的完整过程。</p>
                  <button className="button" onClick={() => navigate("send")}>
                    去发送资源 <ArrowRight size={16} />
                  </button>
                </div>
              )}
            </>
          )}
          {page === "ota" && (
            <div className="send-layout">
              <section className="panel">
                <div className="section-heading">
                  <h2>固件版本</h2>
                  <span className="status-pill">仅演示</span>
                </div>
                {resources
                  .filter((r) => r.kind === "firmware")
                  .map((r) => (
                    <button
                      className={`firmware-option ${firmwareId === r.id ? "selected" : ""}`}
                      key={r.id}
                      onClick={() => setFirmwareId(r.id)}
                      aria-pressed={firmwareId === r.id}
                    >
                      <Cpu size={29} />
                      <span>
                        <b>{r.name}</b>
                        <small>
                          {r.version ? `v${r.version}` : "版本待填写"} ·{" "}
                          {formatSize(r.size)} ·{" "}
                          {r.origin === "sample"
                            ? "示例，无真实固件"
                            : "本地文件"}
                        </small>
                      </span>
                      <span className="radio-indicator" />
                    </button>
                  ))}
                {!resources.some((r) => r.kind === "firmware") && (
                  <p className="muted">请先添加 BIN 固件文件。</p>
                )}
                {firmware && (
                  <div className="firmware-details">
                    <h3>固件信息</h3>
                    <div className="form-grid">
                      <label className="field">
                        版本号
                        <input
                          value={firmware.version || ""}
                          placeholder="例如 1.1.0"
                          maxLength={40}
                          onChange={(e) =>
                            editFirmware("version", e.target.value)
                          }
                        />
                      </label>
                      <label className="field">
                        适用硬件
                        <select
                          value={firmware.hardware || ""}
                          onChange={(e) =>
                            editFirmware("hardware", e.target.value)
                          }
                        >
                          <option value="">请选择适用硬件</option>
                          <option value="ESP32-S3-DEMO">
                            ESP32-S3-DEMO（演示）
                          </option>
                        </select>
                      </label>
                    </div>
                    <h3>更新说明</h3>
                    <p>
                      {firmware.notes ||
                        "此固件仅用于界面演示，尚未解析分区、验证签名或校验硬件兼容性。"}
                    </p>
                  </div>
                )}
                <div className="inline-note">
                  <ShieldCheck size={18} />
                  <span>
                    第一阶段仅检查已填型号和版本。真实 OTA
                    还需设备端支持签名校验、分区检查与失败回退。
                  </span>
                </div>
              </section>
              <aside className="panel send-summary">
                <h2>更新设备</h2>
                <label className="field">
                  目标设备
                  <select
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    {devices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} · {d.online ? "模拟在线" : "模拟离线"}
                      </option>
                    ))}
                  </select>
                </label>
                <dl className="details">
                  <div>
                    <dt>当前版本</dt>
                    <dd>v{targetDevice.version}</dd>
                  </div>
                  <div>
                    <dt>目标版本</dt>
                    <dd>
                      {firmware?.version ? `v${firmware.version}` : "待选择"}
                    </dd>
                  </div>
                  <div>
                    <dt>硬件型号</dt>
                    <dd>{targetDevice.hardware}</dd>
                  </div>
                </dl>
                <ol className="ota-steps">
                  <li>下载固件</li>
                  <li>校验完整性</li>
                  <li>安装并重启</li>
                  <li>确认新版本上线</li>
                </ol>
                {firmware && (
                  <p className="validation-message">
                    {validateTransfer([firmware], false)}
                  </p>
                )}
                <button
                  className="button primary full-width"
                  disabled={!firmware || !!validateTransfer([firmware], false)}
                  onClick={() => setAction({ kind: "ota" })}
                >
                  <Cpu size={17} /> 开始 OTA 演示
                </button>
                <p className="fine-print">不会烧录或更改真实设备。</p>
              </aside>
            </div>
          )}
          {page === "settings" && (
            <>
              <div className="section-heading">
                <h2>设备管理</h2>
                <span className="muted">示例设备 · 实际绑定尚未接入</span>
              </div>
              <div className="settings-devices">
                {devices.map((d) => (
                  <section className="panel settings-device" key={d.id}>
                    <div className="device-top">
                      <span className="device-icon">
                        <Smartphone size={27} />
                      </span>
                      <div className="device-title">
                        <h3>{d.name}</h3>
                        <span>{d.id}</span>
                      </div>
                      <span
                        className={`status-pill ${d.online ? "online" : ""}`}
                      >
                        {d.online ? "模拟在线" : "模拟离线"}
                      </span>
                    </div>
                    <label className="field">
                      设备名称
                      <input
                        value={d.name}
                        maxLength={24}
                        onChange={(e) =>
                          setDevices((old) =>
                            old.map((item) =>
                              item.id === d.id
                                ? { ...item, name: e.target.value }
                                : item,
                            ),
                          )
                        }
                        onBlur={() =>
                          setDevices((old) =>
                            old.map((item) =>
                              item.id === d.id && !item.name.trim()
                                ? { ...item, name: item.id }
                                : item,
                            ),
                          )
                        }
                      />
                    </label>
                    <dl className="details">
                      <div>
                        <dt>硬件型号</dt>
                        <dd>{d.hardware}</dd>
                      </div>
                      <div>
                        <dt>当前固件</dt>
                        <dd>v{d.version}</dd>
                      </div>
                      <div>
                        <dt>支持资源</dt>
                        <dd>PNG / JPG / WebP / TXT（演示）</dd>
                      </div>
                      <div>
                        <dt>屏幕尺寸</dt>
                        <dd>待硬件确定</dd>
                      </div>
                    </dl>
                    <div className="device-setting-actions">
                      <button
                        className="button"
                        onClick={() =>
                          setDevices((old) =>
                            old.map((item) =>
                              item.id === d.id
                                ? { ...item, online: !item.online }
                                : item,
                            ),
                          )
                        }
                      >
                        {d.online ? <WifiOff size={15} /> : <Wifi size={15} />}
                        {d.online ? "模拟离线" : "模拟上线"}
                      </button>
                      <button
                        className="text-button"
                        onClick={() => setAction({ kind: "files", id: d.id })}
                      >
                        查看演示文件 <ArrowRight size={15} />
                      </button>
                    </div>
                  </section>
                ))}
              </div>
              <section className="panel connection-panel">
                <div className="section-heading">
                  <h2>真实连接准备</h2>
                  <span className="status-pill">第二阶段</span>
                </div>
                <div className="connection-grid">
                  <div>
                    <Cloud size={22} />
                    <h3>云端服务</h3>
                    <p>待选择云平台，接通资源存储、下载任务和设备状态。</p>
                  </div>
                  <div>
                    <ShieldCheck size={22} />
                    <h3>登录与设备绑定</h3>
                    <p>待接入账号登录、设备配对凭证与访问权限。</p>
                  </div>
                  <div>
                    <Cpu size={22} />
                    <h3>设备端程序</h3>
                    <p>待确定存储、屏幕和固件分区，接入联网下载与 OTA。</p>
                  </div>
                </div>
                <p className="inline-note">
                  当前无需填写账号密码或密钥。更改的名称、设备状态和演示任务在刷新后恢复默认值。
                </p>
              </section>
            </>
          )}
          <footer>
            <span>LINK / 设备与资源管理台</span>
            <span>本地演示 · 无真实设备连接</span>
          </footer>
        </main>
      </div>
      {toast && (
        <div role="status" className="toast">
          <CheckCheck size={20} />
          <span>{toast}</span>
          <button
            className="icon-button"
            aria-label="关闭提示"
            onClick={() => setToast("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <dialog
        ref={dialog}
        className="modal"
        onClose={() => setPreview(null)}
        onClick={(e) => {
          if (e.target === e.currentTarget) dialog.current?.close();
        }}
      >
        {preview && (
          <>
            <div className="modal-header">
              <div>
                <span className="eyebrow">RESOURCE PREVIEW</span>
                <h2>{preview.name}</h2>
              </div>
              <button
                className="icon-button"
                aria-label="关闭预览"
                onClick={() => dialog.current?.close()}
              >
                <X />
              </button>
            </div>
            <div className="preview-content">
              {preview.kind === "text" ? (
                <pre>{preview.excerpt}</pre>
              ) : (
                <ResourceVisual resource={preview} />
              )}
            </div>
            <p className="muted">
              {kindLabels[preview.kind]} · {formatSize(preview.size)} ·{" "}
              {preview.origin === "sample"
                ? "示例资源，无实际文件"
                : "仅在当前页面保留"}
              {preview.kind === "text" && " · UTF-8 预览，最多显示前 16 KB"}
            </p>
            <div className="modal-actions">
              <button
                className="button primary"
                onClick={() => {
                  setSelected([preview.id]);
                  if (preview.kind === "firmware") setFirmwareId(preview.id);
                  dialog.current?.close();
                  navigate(preview.kind === "firmware" ? "ota" : "send");
                }}
              >
                使用此资源 <ArrowRight size={16} />
              </button>
            </div>
          </>
        )}
      </dialog>
      <dialog
        ref={actionDialog}
        className="modal"
        onClose={() => setAction(null)}
        onClick={(e) => {
          if (e.target === e.currentTarget) actionDialog.current?.close();
        }}
      >
        {action && (
          <>
            <div className="modal-header">
              <h2>
                {
                  {
                    send: "确认演示发送",
                    ota: "确认 OTA 演示",
                    rename: "重命名资源",
                    delete: "移除预览资源",
                    files: "设备文件（演示）",
                  }[action.kind]
                }
              </h2>
              <button
                className="icon-button"
                aria-label="关闭对话框"
                onClick={() => actionDialog.current?.close()}
              >
                <X size={21} />
              </button>
            </div>
            {(action.kind === "send" || action.kind === "ota") && (
              <>
                <p className="dialog-description">
                  目标设备：<b>{targetDevice.name}</b> ·{" "}
                  {targetDevice.online ? "模拟在线" : "模拟离线"}
                </p>
                <ul className="confirm-list">
                  {(action.kind === "ota"
                    ? firmware
                      ? [firmware]
                      : []
                    : sendResources
                  ).map((r) => (
                    <li key={r.id}>
                      <span>{r.name}</span>
                      <small>{formatSize(r.size)}</small>
                    </li>
                  ))}
                </ul>
                <p className="inline-note">
                  {action.kind === "ota"
                    ? "将模拟固件下载、校验、重启和版本回报，不会更新真实硬件。"
                    : `仅创建本地演示任务，不会上传或发送文件。同名文件策略：${overwrite ? "允许覆盖" : "禁止覆盖"}。`}
                </p>
                <p role="alert" className="validation-message">
                  {confirmError ||
                    validateTransfer(
                      action.kind === "ota"
                        ? firmware
                          ? [firmware]
                          : []
                        : sendResources,
                      overwrite,
                    )}
                </p>
                <div className="modal-actions">
                  <button
                    className="button"
                    onClick={() => actionDialog.current?.close()}
                  >
                    返回检查
                  </button>
                  <button
                    className="button primary"
                    disabled={
                      !!validateTransfer(
                        action.kind === "ota"
                          ? firmware
                            ? [firmware]
                            : []
                          : sendResources,
                        overwrite,
                      )
                    }
                    onClick={() =>
                      createTransfer(
                        action.kind === "ota"
                          ? firmware
                            ? [firmware]
                            : []
                          : sendResources,
                        overwrite,
                      )
                    }
                  >
                    创建演示任务 <ArrowRight size={16} />
                  </button>
                </div>
              </>
            )}
            {action.kind === "rename" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const r = resources.find((r) => r.id === action.id)!;
                  const value = renameValue.trim();
                  if (
                    !value ||
                    /[\\/:*?"<>|]/.test(value) ||
                    value.split(".").pop()?.toLowerCase() !==
                      r.name.split(".").pop()?.toLowerCase()
                  ) {
                    setConfirmError("请输入有效文件名，并保留原文件扩展名。");
                    return;
                  }
                  if (
                    resources.some(
                      (other) => other.id !== r.id && other.name === value,
                    )
                  ) {
                    setConfirmError("已有同名资源，请使用其他名称。");
                    return;
                  }
                  setResources((old) =>
                    old.map((item) =>
                      item.id === r.id ? { ...item, name: value } : item,
                    ),
                  );
                  actionDialog.current?.close();
                  setToast("资源名称已更新，仅影响本次预览。");
                }}
              >
                <label className="field">
                  资源名称
                  <input
                    autoFocus
                    value={renameValue}
                    maxLength={120}
                    onChange={(e) => setRenameValue(e.target.value)}
                  />
                </label>
                <p role="alert" className="validation-message">
                  {confirmError}
                </p>
                <div className="modal-actions">
                  <button className="button primary" type="submit">
                    保存名称
                  </button>
                </div>
              </form>
            )}
            {action.kind === "delete" && (
              <>
                <p className="dialog-description">
                  从本次预览中移除「
                  {resources.find((r) => r.id === action.id)?.name}
                  」？电脑上的原文件不会被删除。
                </p>
                <p className="validation-message" role="alert">
                  {active.some((t) => t.resourceId === action.id)
                    ? "此资源有进行中的任务，完成或取消任务后再移除。"
                    : ""}
                </p>
                <div className="modal-actions">
                  <button
                    className="button"
                    onClick={() => actionDialog.current?.close()}
                  >
                    保留
                  </button>
                  <button
                    className="button danger"
                    disabled={active.some((t) => t.resourceId === action.id)}
                    onClick={() => {
                      const r = resources.find((r) => r.id === action.id);
                      if (r?.preview) URL.revokeObjectURL(r.preview);
                      setResources((old) =>
                        old.filter((r) => r.id !== action.id),
                      );
                      setSelected((old) =>
                        old.filter((id) => id !== action.id),
                      );
                      actionDialog.current?.close();
                      setToast("资源已从预览中移除。");
                    }}
                  >
                    移除资源
                  </button>
                </div>
              </>
            )}
            {action.kind === "files" && (
              <>
                <p className="muted">
                  这里只显示本次演示发送的图片与小说，未读取真实 SD 卡。
                </p>
                {deviceFiles
                  .filter((f) => f.deviceId === action.id)
                  .map((f) => (
                    <div className="file-entry" key={f.id}>
                      <FolderOpen size={18} />
                      <span>
                        {f.resourceName}
                        <small>{formatSize(f.size)}</small>
                      </span>
                      <button
                        className="icon-button"
                        aria-label={`移除演示文件 ${f.resourceName}`}
                        disabled={active.some(
                          (t) =>
                            t.deviceId === f.deviceId &&
                            t.resourceName === f.resourceName,
                        )}
                        onClick={() => {
                          setDeviceFiles((old) =>
                            old.filter((file) => file.id !== f.id),
                          );
                          setDevices((old) =>
                            old.map((d) =>
                              d.id === f.deviceId
                                ? { ...d, used: Math.max(0, d.used - f.size) }
                                : d,
                            ),
                          );
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                {!deviceFiles.some((f) => f.deviceId === action.id) && (
                  <div className="empty-state compact">
                    <FolderOpen size={30} />
                    <p>还没有演示文件，先发送一个资源试试。</p>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </dialog>
    </div>
  );
}
