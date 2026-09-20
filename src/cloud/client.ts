import { createClient, type SupabaseClient } from "@supabase/supabase-js";
export interface CloudConfig {
  supabaseUrl: string;
  publishableKey: string;
}
export interface CloudDevice {
  id: string;
  name: string;
  hardware: string;
  firmware_version: string;
  capacity_bytes: number;
  used_bytes: number;
  last_seen: string | null;
  files: { name: string; size: number }[];
}
export interface CloudResource {
  id: string;
  name: string;
  kind: "image" | "text" | "firmware";
  size_bytes: number;
  sha256: string;
  storage_path: string;
  created_at: string;
}
export interface CloudTask {
  id: string;
  device_id: string;
  resource_id: string;
  resource_name: string;
  kind: string;
  size_bytes: number;
  status: string;
  bytes_received: number;
  error: string | null;
  created_at: string;
}
export const cloudStatus: Record<string, string> = {
  waiting: "等待设备领取",
  downloading: "设备下载中",
  verifying: "设备校验中",
  completed: "设备已确认完成",
  failed: "下载失败",
  cancelled: "已取消",
};
export function makeClient(config: CloudConfig): SupabaseClient {
  const url = new URL(config.supabaseUrl);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".supabase.co") ||
    url.pathname !== "/"
  )
    throw new Error("云端项目地址无效，请填写 Supabase HTTPS 项目地址。");
  const key = config.publishableKey;
  if (!key.startsWith("sb_publishable_")) {
    let role = "";
    try {
      role = JSON.parse(
        atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
      ).role;
    } catch {
      /* Invalid public config. */
    }
    if (role !== "anon")
      throw new Error(
        "网站只能配置 publishable 或 anon 公钥，不能配置管理员密钥。",
      );
  }
  return createClient(url.origin, key, {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
    },
  });
}
export async function snapshot(client: SupabaseClient) {
  const access = await client.rpc("link_is_member");
  if (access.error) throw access.error;
  if (!access.data)
    throw new Error(
      "账号已登录，但尚未获准使用此工作空间，请由项目所有者授权。",
    );
  const results = await Promise.all([
    client
      .from("link_devices")
      .select(
        "id,name,hardware,firmware_version,capacity_bytes,used_bytes,last_seen,files",
      )
      .order("created_at", { ascending: false }),
    client
      .from("link_resources")
      .select("*")
      .order("created_at", { ascending: false }),
    client
      .from("link_tasks")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  for (const result of results) if (result.error) throw result.error;
  return {
    devices: results[0].data as CloudDevice[],
    resources: results[1].data as CloudResource[],
    tasks: results[2].data as CloudTask[],
  };
}
export async function uploadResource(
  client: SupabaseClient,
  file: File,
  progress: (text: string) => void,
) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  const mime: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    txt: "text/plain",
    bin: "application/octet-stream",
  };
  if (
    !extension ||
    !mime[extension] ||
    !file.size ||
    file.size > 50 * 1024 * 1024 ||
    file.name.length > 120
  )
    throw new Error(
      "请选择非空图片、TXT 或 BIN，单个文件最多 50 MB，文件名最多 120 字。",
    );
  const kind =
    extension === "txt" ? "text" : extension === "bin" ? "firmware" : "image";
  if (kind === "image") {
    const bitmap = await createImageBitmap(file);
    bitmap.close();
  }
  const auth = await client.auth.getUser();
  if (auth.error || !auth.data.user) throw new Error("请先登录。");
  progress(`正在校验 ${file.name}`);
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
    ),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const path = `${auth.data.user.id}/${crypto.randomUUID()}/payload`;
  progress(`正在上传 ${file.name}`);
  const uploaded = await client.storage
    .from("link-resources")
    .upload(path, file, {
      contentType: mime[extension],
      upsert: false,
      cacheControl: "3600",
    });
  if (uploaded.error) throw uploaded.error;
  progress(`正在登记 ${file.name}`);
  const registered = await client.rpc("link_register_resource", {
    p_path: path,
    p_name: file.name,
    p_kind: kind,
    p_sha256: hash,
  });
  if (registered.error) {
    const cleanup = await client.storage.from("link-resources").remove([path]);
    throw new Error(
      `文件登记失败：${registered.error.message}${cleanup.error ? "。临时文件未能清理，请在存储后台检查。" : ""}`,
    );
  }
}
