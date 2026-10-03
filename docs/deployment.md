# GitHub Pages 发布记录

- GitHub 账号：`wzddddddddd`
- 独立公开仓库：https://github.com/wzddddddddd/esp32s3-link
- 站点：https://wzddddddddd.github.io/esp32s3-link/
- 发布分支：`main`
- 工作流：`Deploy LINK to GitHub Pages`，推送网站修改到 main 自动发布，也可手动触发。
- 2026-10-03 正式入口已发布 SD 文件传输和远程音乐控制，文件与音乐数据库扩展、device-gateway 同步更新。真实设备音乐目录读取已验证；OTA 仍未启用。具体配置和边界见 `supabase.md` 与 `file-transfer.md`。
- 新版提交：`b606656`；发布记录：https://github.com/wzddddddddd/esp32s3-link/actions/runs/37102296508 。
- 音乐目录显示修复：`acf2530`；自动发布配置：`0a3eea1`。第 5 次发布成功：https://github.com/wzddddddddd/esp32s3-link/actions/runs/37105651741 。目录显示在音乐操作区下方，逐页显示，读取类命令最多等待 90 秒；完成记录可以点击「显示目录」重新打开返回内容。
- 最终目录自动滚动与实际播放错误提示：`9b19794`，第 7 次发布成功：https://github.com/wzddddddddd/esp32s3-link/actions/runs/37106185058 。真实设备目录读取返回 `11.mp3`；旧固件播放状态报告 `error=257`（内存不足），更新音频 DMA 初始化后的固件需要上板确认。

## 本地目录与后续更新

日常编辑目录继续使用 `web_wifi/`。独立 GitHub 仓库的本地发布副本位于 `web_wifi/.deploy/repository/`，该目录已被父项目忽略，避免改动原 ESP32 工程的 Git 远程配置或提交历史。

后续发布时，将网站源文件同步到该副本，检查差异后提交并推送。main 的网站代码更新会自动运行 GitHub Actions 工作流。不要同步 `node_modules/`、`dist/`、`.env`、`.deploy/` 或任何设备/管理员凭证。

独立仓库的 `.github/workflows/github-pages.yml` 必须保留；`deployment/github-pages.yml` 是同内容的可复用模板。

也可将独立仓库克隆到其他目录并直接在其根目录开发。构建输出采用相对资源路径，页面采用 hash 导航，适配 GitHub Pages 子路径。
