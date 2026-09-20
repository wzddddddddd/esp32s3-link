# LINK / ESP32-S3 设备与资源管理台

第一阶段可交互网站框架。使用 React、TypeScript、Vite，输出静态网站，可部署到 GitHub Pages。

- 网站：https://wzddddddddd.github.io/esp32s3-link/
- 独立仓库：https://github.com/wzddddddddd/esp32s3-link
- GitHub Pages 使用 Actions 发布；网页仍是演示模式，尚未连接云端或真实设备。

## 当前可以使用

- 设备总览、资源库、发送资源、任务记录、OTA、设备设置六个页面。
- 选择或拖入 PNG、JPG、WebP、TXT、BIN 文件（非空且单文件不超过 50 MB；这是预览限制，不是硬件限制）。
- 图片预览、UTF-8 TXT 前 16 KB 预览、资源分类/搜索/重命名/移除。
- 单个或多个图片/小说向示例设备发送的完整演示；同名文件覆盖确认、容量检查、重复任务检查。
- 离线等待、模拟上线恢复、取消等待任务、模拟失败、失败重试。
- OTA 型号和版本字段检查、下载/校验/重启/版本回报的演示。
- 演示设备名称调整、在线状态切换、查看和移除本次演示接收的文件。
- 桌面及手机响应式页面，键盘操作与原生对话框。

## 重要边界

**没有云端、登录服务或真实设备连接。** 所有状态仅存在浏览器内存；刷新即恢复默认值，关闭页面会丢失选中的本地文件引用。没有文件上传、真实下载下发、硬件兼容性检测、固件签名验证或真实 OTA。示例资源不包含可下载的真实固件。示例设备容量、版本、型号、资源格式仅用于交互演示。

本地预览资源与真实文件上传明确区分。真实服务适配接口见 `src/types.ts` 的 `CloudGateway`；云端协议草案见 `docs/cloud-contract.md`。

## 本地运行

需要 Node.js 22 或更新的受支持版本。

```powershell
npm ci
npm run dev
```

打开终端显示的本地地址。当前开发预览使用 `http://127.0.0.1:5173/`。

```powershell
npm run build
npm run preview
```

`npm run build` 进行 TypeScript 检查并生成 `dist/`。不要直接双击 HTML；请使用 HTTP 预览。开发依赖锁定在 `package-lock.json`。

## GitHub Pages 部署

独立仓库已配置 `.github/workflows/github-pages.yml`。更新网站代码并推送后，在 Actions 手动运行 `Deploy LINK to GitHub Pages` 发布。以下为迁移到其他仓库时的配置步骤。

1. 确认目标仓库。若整个 ESP32S3_MP3 仓库用于部署，网页路径保留为 `web_wifi`；若新建专用网站仓库，将本目录内容作为仓库根目录。
2. 将 `deployment/github-pages.yml` 放入**目标仓库根目录**的 `.github/workflows/github-pages.yml`。
3. 在仓库 Settings → Pages 中选择 GitHub Actions。
4. 工作流会根据 `web_wifi/package.json` 是否存在选择网站目录，兼容以上两种仓库结构。
5. 提交后在 Actions 手动运行 `Deploy LINK to GitHub Pages`。

采用 `base: './'` 和 hash 导航，兼容 `用户名.github.io/仓库名/` 子路径；刷新 `/#resources` 等页面无需服务端路由。

GitHub Pages 只承载前端，设备凭证和管理员密钥不能放在网页代码或公开仓库中。未来浏览器端配置只放公开服务地址，身份由云端认证服务管理。

## 文件结构

```text
src/App.tsx              六个页面与演示交互
src/styles.css          主题与响应式布局
src/types.ts            资源、设备、任务和云端接口类型
src/demo.ts             明确标注的演示数据
src/workspace-tools.ts  可选的只读 WebMCP 工作空间检查
docs/cloud-contract.md  后续云端与设备协议草案
deployment/            GitHub Pages 工作流模板
```

后续接入时，将模拟任务推进替换为云端任务状态查询；线上模式不得继续使用模拟计时器。设备只有在成功回报下载校验结果后才能标记完成，OTA 要在重启后回报目标版本才算成功。
