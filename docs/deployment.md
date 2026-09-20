# GitHub Pages 发布记录

- GitHub 账号：`wzddddddddd`
- 独立公开仓库：https://github.com/wzddddddddd/esp32s3-link
- 站点：https://wzddddddddd.github.io/esp32s3-link/
- 发布分支：`main`
- 工作流：`Deploy LINK to GitHub Pages`，手动触发。
- 当前正式入口已连接 Supabase，提供邮箱登录、私有资源存储和设备任务接口。独立演示模式仍使用模拟数据；真实硬件下载与 OTA 尚待固件接入。具体配置和边界见 `supabase.md`。

## 本地目录与后续更新

日常编辑目录继续使用 `web_wifi/`。独立 GitHub 仓库的本地发布副本位于 `web_wifi/.deploy/repository/`，该目录已被父项目忽略，避免改动原 ESP32 工程的 Git 远程配置或提交历史。

后续发布时，将网站源文件同步到该副本，检查差异后提交并推送，然后手动运行 GitHub Actions 工作流。不要同步 `node_modules/`、`dist/`、`.env`、`.deploy/` 或任何设备/管理员凭证。

独立仓库的 `.github/workflows/github-pages.yml` 必须保留；`deployment/github-pages.yml` 是同内容的可复用模板。

也可将独立仓库克隆到其他目录并直接在其根目录开发。构建输出采用相对资源路径，页面采用 hash 导航，适配 GitHub Pages 子路径。
