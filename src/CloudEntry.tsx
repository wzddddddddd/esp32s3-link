import { lazy, Suspense, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
const App = lazy(() => import("./App"));
const CloudApp = lazy(() => import("./CloudApp"));
import { makeClient } from "./cloud/client";

export default function CloudEntry() {
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [projectUrl, setProjectUrl] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [demo, setDemo] = useState(
    new URLSearchParams(location.search).get("mode") === "demo",
  );
  useEffect(() => {
    let active = true;
    void fetch(`${import.meta.env.BASE_URL}cloud-config.json`, {
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("无法读取云端配置，请稍后刷新。");
        const config = await response.json();
        if (active && config.supabaseUrl && config.publishableKey) {
          setClient(makeClient(config));
          setProjectUrl(new URL(config.supabaseUrl).origin);
        }
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "读取配置失败");
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, []);
  if (!ready)
    return (
      <div className="cloud-loading" role="status">
        正在读取工作空间…
      </div>
    );
  if (demo)
    return (
      <>
        <div className="mode-switch">
          <span>独立演示工作空间</span>
          <button onClick={() => setDemo(false)}>返回云端入口 →</button>
        </div>
        <Suspense fallback={<div className="cloud-loading">加载演示界面…</div>}>
          <App />
        </Suspense>
      </>
    );
  if (client)
    return (
      <Suspense fallback={<div className="cloud-loading">加载云端界面…</div>}>
        <CloudApp
          client={client}
          projectUrl={projectUrl}
          onDemo={() => setDemo(true)}
        />
      </Suspense>
    );
  return (
    <div className="cloud-welcome">
      <div className="eyebrow">LINK / CLOUD WORKSPACE</div>
      <h1>连接你的云端工作空间</h1>
      <p>云端接入代码已准备好，等待 Supabase 项目配置。</p>
      <div className="panel">
        <h2>接入进度</h2>
        <ol className="ota-steps">
          <li>网站已部署到 GitHub Pages</li>
          <li>等待登录并创建 Supabase 项目</li>
          <li>初始化私有存储与设备任务接口</li>
          <li>配置项目地址，验证实际上传</li>
        </ol>
        <p className="muted">
          尚未连接云端；此页面不会上传文件或保存设备任务。
        </p>
        {error && (
          <p className="validation-message" role="alert">
            {error}
          </p>
        )}
        <button className="button primary" onClick={() => setDemo(true)}>
          先查看演示网站
        </button>
      </div>
    </div>
  );
}
