# SD 文件传输部署与使用

0.3.0 增加远程音乐和文件删除：已有两份迁移之后，追加 `202610030002_remote_commands.sql` 并更新网站。板端分别打开 **BLE**、**WiFi** 应用；蓝牙配网不再自动启动 Wi-Fi。框架及扩展方法见 `display/docs/communication_framework.md`。

新增页面使用现有 Supabase 项目，不能只部署网页。

2026-10-03 已发布文件传输、音乐控制和删除功能：两份扩展 SQL 已应用，device-gateway 已更新，GitHub Pages 工作流第 4 次发布成功（代码提交 b606656）。已在真实设备上通过网页读取 `/music/11.mp3`，目录命令完成。以下为后续更新步骤。

同日第 5 次发布修复音乐目录的显示流程：进入「SD 文件传输」→「全部音乐」→目录中歌曲旁的「播放」。列表在文件上传工具上方，分页内容逐页出现，读取失败/超时会恢复按钮；历史 list 完成记录的「显示目录」可恢复结果。目录为空会明确显示。播放请求被接受后，通过初始化注入的观察回调请求设备 music 应用展开播放器；Wi-Fi 保持运行。自动跳转需要使用 `display/releases/remote_music_20261003/display_example.bin` 或对应源码构建，主应用写入偏移 `0x120000`。此版本只编译交付，未由代理烧录；设备界面跳转仍需上板验证。

第 7 次发布让目录获取后自动滚动至结果，并显示实际播放失败原因。旧固件联调中 `music.play` 被接受，但 `music.status` 报 `error=257`/`position_ms=0`；不能将任务完成当成已经发声。新版固件扬声器启动就设为双声道、16 KiB DMA，避免播放时从单声道扩容申请额外 16 KiB 内部内存；MP3 和视频管线回归通过，未烧录。视频 128 KiB PCM 缓冲保留，DMA 调度余量降低，设备实测仍必要。

目录迟到恢复修复：实际 `/music` 请求在 16:22:24 提交、16:26:34 完成，耗时约 250 秒。现在 90 秒只释放前台等待，已知编号的目录任务继续处理；页面按同一设备和任务编号观察，返回后自动显示并继续分页。同一目录等待期间重复点击不会再提交。切换设备/目录、取消读取或执行文件修改后，旧结果不会覆盖当前目录。观察期间保持页面打开；以前已经完成的记录仍可用「显示目录」打开，不能把历史结果当成新的设备读取。

第 8 次发布后，新请求 `b721e41a-1289-4c09-8bda-7bfdee82bdda` 在 16:45:10 提交、16:49:46 领取、16:50:07 完成，约 298 秒。90 秒后按钮恢复，再次点击「全部音乐」仍只有这一个新任务，迟到的 `11.mp3` 自动显示并带「播放」按钮。没有通过历史「显示目录」恢复。已确认网页恢复流程；设备响应速度和新版固件播放跳转尚未上板验证。

板端云端 worker 同步修复：心跳失败不会阻止领取命令，新命令与待确认结果优先于旧资源传输。待确认结果保持重发，避免响应丢失后重复写入文件；HTTP 失败记录操作、阶段、状态码、耗时和内存，不记录凭证。对应固件见 `display/releases/late_directory_20261003/`，仅交付，未烧录。

1. 在现有项目先确认 `202609200001_link_cloud.sql` 已应用，再在 SQL Editor 执行 `supabase/migrations/202610030001_file_commands.sql`。不要重复执行旧迁移。
2. 用已有部署流程发布 `supabase/functions/device-gateway/index.ts`。CLI 示例：`supabase functions deploy device-gateway --project-ref rtoljcxkyqikeiheouyt --no-verify-jwt`。函数自己校验设备 UUID + 设备密钥；不要求设备持有用户 JWT。`SUPABASE_SERVICE_ROLE_KEY` 只由服务端环境提供。
3. 运行 `npm ci`、`npm run test:cloud`、`npm run build`，按现有 GitHub Pages 工作流发布 `dist/`。不要把设备密钥、管理员密钥写进前端配置。
4. 网站注册设备后，在新版 Android 的真实 BLE 模式中保存 Wi-Fi 和该设备的凭据。主板分别打开 BLE 与 WiFi；显示 Wi-Fi 地址后等待云端心跳。
5. 网页选「SD 文件传输」，选设备后刷新目录。路径 `/novels` 对应 SD 的 `novels` 文件夹。下发和接收都通过现有私有云端中转。

支持 `list`、`mkdir`、`put`、`get` 四种命令。文件校验成功且设备确认后标记完成。目录传输拆成有序目录/文件命令，取消保留已完成项。同一设备最多 30 个等待/执行命令，本界面逐个等待完成，因此离线时不会塞满整目录。

设备新增 action：`command_claim`、`command_progress`、`command_result`。仍使用 `x-device-id`、`x-device-token`。下载使用同项目 Storage 签名 URL；上传使用 `createSignedUploadUrl(...,{upsert:true})` 返回 URL 的 HTTP PUT。网关每次领取都刷新签名 URL。

普通文件/零字节文件从 SD 文件页传输。旧「发送资源」只接受非空图片/TXT，旧 OTA 仍禁用。没有上传/下载 Flash 分区的接口。

`npm run test:cloud` 运行旧云端回归和新增文件命令数据库测试；PGlite 模拟 Supabase 的 auth/storage schemas，不代替线上 Storage 签名接口联调。新 SQL、新网关和新网站必须共同部署；已有网站未部署时，旧图片/TXT下发仍可用，新文件页不可用。

限制：单文件 50 MiB；路径 240 UTF-8 字节；云端资源名称 120 UTF-8 字节；目录 16 层、10000 项；目录 ZIP 原始文件总计 150 MiB。Chrome/Edge 可下发空目录；回退目录选择器只提供非空目录。大目录建议分批。
