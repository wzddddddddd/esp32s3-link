# 云端与设备接口草案（尚未实现）

此文档用于第二、三阶段对接，不表示下列接口已存在。供应商、域名、权限模型和实际设备能力确定后再冻结协议。

## 基本约定

- HTTPS，JSON，UTF-8。服务器生成资源/任务 ID 和时间戳；字节数使用整数。
- 浏览器使用用户会话；设备使用独立、可撤销的凭证。服务器验证所有权，不信任浏览器提供的设备 ID。
- 文件存储与任务数据分开：资源包含 `id, name, kind, size, sha256, storageKey, createdAt`；固件另含 `version, hardwareRevision, chip, partitionRequirements, signature`。
- 资源记录在上传完成且服务器确认大小及校验信息后才可创建任务。不能信任客户端声称的 MIME、长度或哈希。
- 下载 URL 短期有效，设备可刷新地址继续任务。对 URL 重定向及目标主机设限制。
- 设备容量、支持格式、屏幕尺寸和固件版本由设备心跳上报。网页预检不替代设备端校验。

## 浏览器接口

| 方法与路径                     | 作用                                               |
| ------------------------------ | -------------------------------------------------- |
| GET /v1/devices                | 当前用户的设备及最近心跳                           |
| POST /v1/device-bindings       | 用短期配对码绑定设备                               |
| PATCH /v1/devices/:id          | 修改设备名称                                       |
| DELETE /v1/device-bindings/:id | 解除绑定并处理凭证撤销                             |
| POST /v1/uploads               | 创建限大小、限类型的上传授权                       |
| POST /v1/uploads/:id/complete  | 云端确认上传完成，生成资源                         |
| GET /v1/resources              | 分页查询资源                                       |
| PATCH /v1/resources/:id        | 修改名称及固件发布信息                             |
| DELETE /v1/resources/:id       | 检查活动任务引用后移除资源                         |
| POST /v1/tasks                 | 创建任务，携带幂等键、目标设备、资源 ID 和覆盖策略 |
| GET /v1/tasks                  | 读取任务进度，支持游标                             |
| POST /v1/tasks/:id/cancel      | 取消尚未领取的任务；与领取操作原子互斥             |
| POST /v1/tasks/:id/retry       | 重新验证兼容性、版本和空间，创建新的尝试           |
| GET /v1/devices/:id/files      | 查询设备最近回报的资源清单                         |

资源上传进度、设备下载进度是独立阶段。网页提交任务成功只表示任务已排队，不表示文件已经到达设备。

## 设备接口

| 方法与路径                             | 作用                                         |
| -------------------------------------- | -------------------------------------------- |
| POST /v1/device/heartbeat              | 上报固件、空间、能力、活动任务与文件清单版本 |
| POST /v1/device/tasks/claim            | 原子领取当前任务，返回租约与资源清单         |
| POST /v1/device/tasks/:id/progress     | 幂等上报阶段、字节数、错误码及尝试 ID        |
| POST /v1/device/tasks/:id/download-url | 刷新当前任务的临时下载地址                   |
| POST /v1/device/files/report           | 同步资源清单                                 |

设备按可配置间隔轮询（可从 10–30 秒起步），失败时退避并加入随机抖动。设备离线时任务保留；任务租约避免重复领取，同一任务重试保持幂等。实际轮询间隔需按云服务免费请求额度调整。

## 状态与可靠性

普通资源：`queued → downloading → verifying → completed`。

OTA：`queued → downloading → verifying → installing → rebooting → awaiting_version → completed`。

失败包含可读原因和稳定错误码，例如 `NO_SPACE / INCOMPATIBLE_HARDWARE / HASH_MISMATCH / DOWNLOAD_TIMEOUT / SIGNATURE_INVALID / BOOT_ROLLBACK`。取消仅允许未开始任务。

资源先写临时文件，校验通过后再原子替换；失败不破坏旧文件。续传依赖服务器 Range 支持及校验规则。重启后从持久化任务记录恢复。

OTA 必须检查芯片、板型、分区大小及固件真实性，使用适配的 OTA 分区和回滚机制。固件版本报告是完成依据，不能以文件下载结束作为更新成功。供电中断、签名失败和回滚都要在真实硬件上验证。

## 后续待决策

云平台与网络可达性；最大文件、总配额、保留期限；SD 卡或内部 Flash；图片尺寸和编码；TXT 编码；固件分区、签名及回退方式。当前网页的 50 MB 导入限制和 ESP32-S3-DEMO 型号均为演示约定。
