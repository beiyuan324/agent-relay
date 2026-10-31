# 第三方来源

## relay-kit

参考项目：`https://github.com/nanami-0713/relay-kit`，分析基线提交 `25a142d`。

- `workers/relay/src/index.ts` 来自该项目，保留其 MIT 许可于 `workers/relay/LICENSE`。
- Rust 加密层依据该项目 `PROTOCOL.md`、`packages/core/src/crypto.ts` 和 `packages/core/src/e2e.ts` 独立移植。
- 本项目增加双向 Codex 控制协议；没有实现 relay-kit 的通用 HTTP、WebSocket 端口代理产品界面。

MIT License — Copyright (c) 2026 nanami-0713。完整授权文本见 `workers/relay/LICENSE`。

## 应用图标

应用图标为本项目制作，基础图形由 GPT Image 2.5 生成并经后期处理，资源位于 `public/relay-icon.png` 和 `src-tauri/icons/`。

## 界面图标

界面图标使用 `lucide-react`，其许可为 ISC；授权文本随依赖分发。
