# Supabase 云端接入

## 当前项目

- 组织：LINK Workspace（Free）
- 项目：esp32s3-link，引用 `rtoljcxkyqikeiheouyt`
- 区域：新加坡
- 项目地址：`https://rtoljcxkyqikeiheouyt.supabase.co`
- 网站：`https://wzddddddddd.github.io/esp32s3-link/`
- 设备接口：`https://rtoljcxkyqikeiheouyt.supabase.co/functions/v1/device-gateway`

数据库迁移：`supabase/migrations/202609200001_link_cloud.sql`。已通过 SQL Editor 初始化，不能重复执行创建脚本；新的修改应添加后续迁移。原生 Supabase 迁移历史表不会自动记录 SQL Editor 的操作，后续改用 CLI 前需核对并修复迁移历史。

Edge Function 源码：`supabase/functions/device-gateway/index.ts`。它使用 Supabase 自动注入的服务端环境变量。该函数不使用用户 JWT，而在代码内验证独立的设备密钥；`verify_jwt=false` 仅适用于这个具备自定义设备认证的函数。

## 网站账号

1. Authentication → Users 邀请项目所有者的邮箱。Site URL 已设为正式网站。
2. 在 SQL Editor 将该已邀请用户授权到工作空间（将邮箱换成确定要授权的邮箱）：

```sql
insert into private.link_members(user_id)
select id from auth.users where lower(email)=lower('OWNER_EMAIL')
on conflict do nothing;
```

3. 用户在邮箱里打开邀请链接。后续从网站请求登录邮件；不需要在网站设置密码。若旧邀请链接已失效，从登录页请求新链接。

公开注册、匿名登录关闭。默认 Supabase 邮件服务有发送次数和收件人限制，只适合当前项目所有者测试；多人使用前应配置自己的邮件服务。本站不会存储邮箱密码。

撤销账号工作空间权限：管理员从 `private.link_members` 移除相应用户。设备接口同样检查该授权状态。

## 资源与任务

- 文件桶 `link-resources` 为私有桶；不生成公共资源地址。
- 浏览器只允许写入自己的 UUID 目录，禁止直接更新已登记文件。
- 文件上传后，服务端从存储元数据读取大小、MIME，登记资源；浏览器计算 SHA-256，设备最终核对实际文件。
- 允许格式：PNG/JPG/WebP/TXT/BIN；单文件 50 MiB。该限制不代表硬件兼容能力。
- 第一版云端支持上传、预览和任务创建/取消。资源重命名、云端删除、任务重试和设备撤销的网页入口待扩展；演示版中的对应功能不会影响云端。
- 每账号最多登记 10 台设备，每台最多 20 项待执行任务。实际免费额度与流量以 Supabase 控制台为准。
- 网站每 15 秒刷新一次，隐藏标签页停止轮询。设备 90 秒内有回报视为在线。

## 设备认证

网站“我的设备”登记设备后只显示一次独立密钥。数据库仅保存密钥的 SHA-256。保存在设备私有配置中，不提交公开 Git 仓库。

HTTP POST 请求头：

```text
Content-Type: application/json
x-device-id: <设备 UUID>
x-device-token: <设备独立密钥>
```

### 1. 心跳

```json
{"action":"heartbeat","payload":{"hardware":"ESP32-S3","firmware_version":"0.1.0","capacity_bytes":8388608,"used_bytes":0,"files":[]}}
```

`files` 可包含 `{"name":"book.txt","size":1024}`，最多 1000 项；列表超过限制时省略此字段，设备仍必须在写文件前自行检查同名覆盖。

### 2. 领取 / 恢复任务

```json
{"action":"claim","payload":{}}
```

返回 `task:null` 表示无任务，或需要先上报心跳。非空任务包括 `id,name,kind,size_bytes,sha256,overwrite,status,bytes_received,download_url,url_expires_in`。

下载地址有效期 900 秒。重新 claim 返回同一项未完成任务并刷新地址，不会重复创建任务。同一设备串行执行任务，文件完成后先上报更新后的容量和清单，再领取下一项。

### 3. 进度与完成

```json
{"action":"progress","payload":{"task_id":"TASK_UUID","status":"downloading","bytes_received":1024}}
```

顺序：`downloading → verifying → completed`。进入 verifying 时字节数必须等于文件总大小；completed 还必须包含与资源一致的 `observed_sha256`。不可从 downloading 直接标记 completed。

失败时发送 `status:"failed"` 和 `error`。bytes_received 必须单调递增。设备重启后需保留已确认的进度与临时文件；第一版不支持从 0 重试已回报更多字节的活动任务，无法恢复时应回报 failed，再重新创建设备任务。

设备应先下载到临时文件、校验哈希、执行同名覆盖检查，再完成保存。网页上“完成”信任已认证设备的回报，服务端不能直接检查真实 SD 卡。

## 验证与边界

`npm run test:cloud` 使用本地 PostgreSQL 兼容运行时验证生产迁移：成员权限、账号隔离、匿名拒绝、私有存储、错误设备密钥拒绝、任务重复领取、进度状态限制、哈希校验、取消限制、OTA 拒绝。

线上检查已确认匿名表访问、缺失设备凭证和错误设备凭证均返回 401。真实硬件联网、断线恢复、文件格式和 OTA 仍待设备端实现后验证。

`docs/cloud-contract.md` 是早期设计草案。当前可用协议以上述实际实现为准。
