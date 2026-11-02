# Workers 中继部署

`workers/relay/` 提供 Cloudflare Workers 与 Durable Objects 密文中继，实现来自 relay-kit，保留原 MIT 许可。

## 部署步骤

准备一个可以创建 Workers 与 SQLite Durable Objects 的 Cloudflare 账号，在项目根目录执行：

```powershell
cd workers/relay
npm install
npx wrangler login
Copy-Item wrangler.toml wrangler.local.toml
# 编辑 wrangler.local.toml，填写自己的域名，再执行部署。
npm run deploy
```

部署入口和配置：

- `src/index.ts`：Worker 路由和 `RelayRoom` Durable Object。
- `wrangler.toml`：通用配置模板，默认名称 `agent-relay`，绑定名 `RELAY_ROOM`，迁移标签 `v1`。
- `wrangler.local.toml`：实际部署配置，已被 Git 忽略；个人域名等部署信息只放在这里。`npm run deploy` 使用此文件。已有本地配置时无需再次复制。
- 无数据库密码、模型密钥或 Codex 登录凭据需要上传。
- 默认关闭 Workers 应用观测日志；账号级网络／访问日志由你的 Cloudflare 配置决定。

部署成功后，将根地址填到 Relay 的“异地连接”或“设置 → 默认 Workers 中继地址”。例如：

```text
https://agent-relay.<your-subdomain>.workers.dev
```

两端都主动发起 WSS 连接。不要在应用中填 `/agent` 或 `/c/...` 路径，应用会自行生成路由。地址不接受用户名、密码、查询参数或片段。

## 自定义域名

若默认域名在两端网络间不可达，可以在 Cloudflare 托管的域名下配置自定义子域名，并使用该 HTTPS 根地址。在未跟踪的 `wrangler.local.toml` 中配置：

```toml
routes = [{ pattern = "relay.example.com", custom_domain = true }]
```

该配置应位于文件顶层，在 `[durable_objects]` 之前，并取消模板中的注释。若只使用默认域名，在本地配置中设置 `workers_dev = true`。实际域名不应提交到仓库或写入公开发布说明。重新部署后，为新的配对邀请使用新域名。当前已配对设备的端点不跟随默认中继设置自动迁移。

## 传输协议

- 发起邀请端：`/agent?th=sha256(routingToken)`，发送 `register`。
- 加入端：`/c/<routingToken>/__alma_e2e__`。
- Worker 生成 tunnel ID，封装／拆解 `wopen/wmsg/wclose`。
- P-256、HKDF 与 AES-GCM 握手在桌面端完成，Worker 不具有会话解密密钥。
- 控制消息在加密前按 128 KiB 分片，经密文和 Base64 包装后保持低于 1 MiB。
- 每对设备至多一个活动控制隧道；同一加密隧道支持双方 Codex 请求与事件。

中继兼容 relay-kit 的路由与加密握手，但 Relay 的加密后内容是自定义双向 Codex 控制消息，不是 relay-kit 手机端通用 HTTP 代理。因此不能把原项目的手机客户端当作 Relay 工作台使用。

## 故障处理

- 无法连通：确认两端能访问同一个 HTTPS 根地址，以及 Worker 与 Durable Object 已一起部署。
- 配对已被替换：相同配对被另一 Relay 实例注册。关闭多余实例，再在设备详情中点击“重新连接”。
- 邀请端离线：加入端会重试；中继等待上限和应用握手超时可能使单次尝试提前结束，稍后连接恢复会重新握手。
- 密钥错误或重放帧：桌面端拒绝认证或关闭会话，不会降低到明文。
- 需要限制使用人群：在 Cloudflare 侧配置适合 WebSocket 的入口访问控制。不要把额外登录挑战直接插入现有协议，当前桌面端不处理 Cloudflare Access 的交互登录。

费用、配额和域名策略以你的 Cloudflare 账号控制台为准。本项目没有内置自动付费、资源扩容或后台部署逻辑。
