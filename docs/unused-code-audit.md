# 未使用代码审计

日期：2026-11-06。基准提交：`f79d847f209d5f71ce39293d29f3d2185bbd14a0`。
分支：`codex/remove-proven-unused-code`。以下删除依据在修改源码前记录，行号均指基准提交。

原目录出现其他任务的并行修改及分支切换，因此本次工作放在独立 Git 工作树；不包含或修改其他任务的补丁。

## 审计范围与入口

- 前端：`index.html` → `src/main.tsx` → `App.tsx`。使用 TypeScript AST 遍历所有已跟踪 TS/TSX 的 import、export-from，检查运行入口、Vite/Vitest 配置与四个测试文件的可达性；没有发现不可达的 TS/TSX 文件。
- 函数、类、变量及类型：使用已有 TypeScript language service 的 `findReferences` 检索所有已跟踪 TS/TSX，包括测试；没有发现完全无符号引用的声明。只有内部使用的公开导出不因此删除。
- 桌面：`src-tauri/build.rs`、`src-tauri/src/main.rs` → `agent_relay_lib::run()` → `lib.rs` 中的 tray/updater、`relay-core` 模块。检查模块声明、Tauri 命令注册和字符串调用。
- Worker：`workers/relay/wrangler.toml` 的 `main = "src/index.ts"`、`RELAY_ROOM`/`RelayRoom` 绑定、平台事件回调，以及 `tests/worker.test.ts`。
- Rust：仓库文本检索函数、结构体、枚举和常量名称。仅出现一次的声明全部是由测试宏调用的 13 个测试；不能按文本引用数删除。
- 检查 CSS 类名、运行时类名生成、配置、文档和注释。未发现可删除的整块注释代码或被常量关闭的应用功能实现。

## 第一批：删除前证据

### 仓库范围搜索

在基准提交、添加本报告之前运行以下命令，搜索隐藏配置，并排除 Git 数据、依赖、生成输出及本地构建缓存：

```powershell
rg -n --hidden --pcre2 -g '!.git' -g '!node_modules' -g '!dist' -g '!target' -g '!target-verified' -g '!src-tauri/gen' -g '!workers/relay/.wrangler' '(?<![\w-])(toolbar-divider|reasoning-title|reasoning-body)(?![\w-])|\.reasoning(?![\w-])' .
```

结果全部位于 `src/styles.css`：

```text
213: .toolbar-divider
332: .reasoning, .tool-activity, .tool-activity-group
333: .reasoning>summary, .tool-activity>summary, .tool-activity-group>summary
334: .reasoning>summary::-webkit-details-marker, ...
335: .reasoning>summary:hover, ...
336: .reasoning>summary:focus-visible, ...
337: .reasoning-title, .activity-title
343: .reasoning[open]>summary .activity-chevron, ...
354: .reasoning-body
355: .reasoning .markdown
```

以上输出只省略 CSS 声明内容及同一规则中仍保留的其他选择器，不省略命中位置。

```powershell
rg -n --glob '*.{ts,tsx,rs}' '\bItem\b|\bProcessItems\b' src tests crates src-tauri workers/relay/src
```

完整调用点结果：

```text
src/Transcript.tsx:57:  const Item = memo(function Item(...)
src/Transcript.tsx:86:  function ProcessItems(...)
src/Transcript.tsx:96:  : <Item ... item={group.items[0]} ... />
src/Transcript.tsx:152: {users.map(item => <Item ... />)}
src/Transcript.tsx:156: <ProcessItems items={process} ... />
src/Transcript.tsx:158: {results.map(item => <Item ... />)}
```

`Item` 与 `ProcessItems` 均未导出。搜索 `import(`、`import.meta.glob`、`require(`、`eval(`、`new Function` 未发现源码中的动态加载/求值路径。不能通过外部传入的字符串直接调用这两个局部组件。

### 每项删除的判断

| 编号 | 删除项及基准位置 | 入口可达性证明 | 测试是否使用 |
| --- | --- | --- | --- |
| D1 | `Transcript.tsx:76–77`，`Item` 的 `enteredReviewMode` 分支 | `Turn` 的 users 仅包含 userMessage；results 仅包含 plan、contextCompaction、exitedReviewMode、符合条件的 agentMessage。enteredReviewMode 进入 process，在 `ProcessItems:89–96` 中必定作为 tools 交给 ToolActivityGroup，不会进入 Item。 | `rg` 找不到测试直接调用 Item；`tests/transcript.test.tsx` 仅通过 Transcript 进入同一分流链，未覆盖此死分支。 |
| D2 | `Transcript.tsx:80–81`，`Item` 的 reasoning 分支 | `Turn:135` 在创建 users、results、process 之前过滤掉所有 reasoning。所有 Item 调用都来自这三个集合。 | 测试没有直接入口或对该分支的引用；现有 Transcript 测试同样经过过滤。 |
| D3 | `Transcript.tsx:82–83`，`Item` 的 default 分支及第 7 行的 ToolActivity 导入 | users/results 仅产生 switch 已处理的类型；process 中只有非工具项才调用 Item，可能类型为 userMessage/agentMessage/plan/reasoning，其中 reasoning 已由上游过滤。因此 default 没有可到达的输入。未知类型仍由 ToolActivityGroup → ToolActivity 处理。 | 测试不直接使用 Item；命令输出测试经过 ToolActivityGroup，保留真正使用的 ToolActivity 实现与导出。 |
| D4 | `Transcript.tsx:89`，ProcessItems 对 userMessage/plan/reasoning 的冗余排除 | process 已移除 users 和所有 answers，而所有 plan 都属于 answers，reasoning 更早已过滤。非工具类型只剩 agentMessage，条件可等价改为 `item.type !== "agentMessage"`。 | 测试没有其他 ProcessItems 调用；保留相同调用链上的现有测试。 |
| D5 | `styles.css:213`，整个 `.toolbar-divider` 规则 | 全仓搜索只有定义；没有任何 JSX、DOM API、模板或测试生成这个类名。 | 没有命中。 |
| D6 | `styles.css:332–337,343` 中 7 个 reasoning 选择器分支 | 全仓类选择器搜索只有 CSS 定义；组件不生成 reasoning/reasoning-title 类。`Turn:135` 已过滤 reasoning 消息。仅删选择器列表里的对应项，保留工具活动的全部声明。 | 没有类名引用。 |
| D7 | `styles.css:354–355`，整个 `.reasoning-body` 和 `.reasoning .markdown` 规则 | 同 D6，DOM 不生成这些类。`ReactMarkdown` 使用 `skipHtml`，没有允许输入 HTML 注入这些类名的渲染器。 | 没有类名引用。 |

D5–D7 还核对了 `className`、DOM 类名操作和 Markdown 组件配置，避免把动态生成的 CSS 类误判为无引用。

## 单独保留的项目

| 项目 | 原因 |
| --- | --- |
| 全部现存 TS/TSX 源文件、函数、类和组件 | 都有入口/测试引用或符号使用，没有证据支持整项删除。 |
| `src/workbench.ts` 的 `applyEvent` 再导出、`relay-core` 的 `pub mod`/`pub use`（包括 `codex::discover`） | 公开 API 或兼容入口；只因仓库内消费者使用另一条路径而删除会改变契约。 |
| `src-tauri/src/lib.rs` 注册的命令，以及 updater 命令 | 前端通过 `command(name)`/`invoke` 按字符串调用，注册宏也是入口。 |
| Worker 默认 fetch 导出、RelayRoom、webSocketMessage/webSocketClose/alarm 等回调 | Wrangler 配置和平台按名称调用；不是普通显式调用图。 |
| Rust `#[test]`/`#[tokio::test]` 函数 | 测试框架调用；单次文本出现不能证明未使用。 |
| `cfg(windows)`、平台专用 keyring、托盘和 updater 发布模式路径 | 跨平台或不同构建模式使用，不因当前 Windows/debug 运行未执行而删除。 |
| `public/relay-icon-*.png`、`docs/assets` 图标变体 | 设计源素材及可按 URL 访问的静态资源；应用导入图无法证明外部/人工用途已经结束。 |
| `wrangler.toml` 的注释 routes 示例 | 部署指南让使用者复制配置并填写自定义域名，是操作模板而非废弃实现。 |
| Worker 的 `workers_dev = false`、`preview_urls = false`、observability.enabled = false | 这些是部署行为设置；删除会改变默认行为，不是被关闭的冗余实现。 |
| 默认关闭的共享状态、兼容旧版 Codex 的读取路径 | 共享可通过 UI 启用；兼容分支由外部主机版本/数据决定，不能证明永远不运行。 |

## 执行与验证

本次仅一批相关源码删除，改动 `src/Transcript.tsx` 与 `src/styles.css`。本报告是证据交付物，不计入删除行数。

删除前、删除后的独立工作树验证结果：

| 命令 | 删除前 | 删除后 |
| --- | --- | --- |
| 根目录 `npm test` | 4 个文件、17 项通过 | 4 个文件、17 项通过 |
| 根目录 `npm run build`（tsc + Vite） | 通过 | 通过 |
| `cargo test --workspace` | 桌面 2 项 + relay-core 11 项通过；doc-tests 0 项失败 | 桌面 2 项 + relay-core 11 项通过；doc-tests 0 项失败 |
| `cargo build --workspace` | 通过 | 通过 |
| Worker 目录 `npm run build`（tsc + Wrangler dry-run） | 通过 | 通过 |

- 本批未出现失败，无须回滚。没有增加测试文件或测试脚本。
- 额外用现有 PostCSS 比较基准版本与结果：恰好删除 10 个选择器分支；其余 652 组选择器、声明、所属 at-rule 与顺序完全一致。
- `git diff --check` 通过。
- 构建仍有基线已有的 Vite 大体积 chunk 提示、Rust crypto 的 3 处弃用警告和 Windows 链接器提示；没有新增构建失败。
- Rust 使用现有构建缓存目录 `D:/alone/agent-relay/target`，Cargo 自身的文件锁协调并行构建；被编译的项目清单与源码来自本次独立工作树。
- 验证范围为 Windows 上的现有测试与常规构建，未执行跨平台运行或安装包签名打包。

## 最终数量

- 删除文件：**0**。没有发现可证明完全未使用的源码文件或目录。
- 修改源码文件：**2**（`src/Transcript.tsx`、`src/styles.css`）。
- 源码 Git diff：**18 行删除、9 行新增，净减少 9 行**。新增行是保留既有选择器和简化条件的改写，不是新增功能。
- 清理内容：3 个不可达渲染分支、相关无用导入、3 种不可能的分组类型检查、10 个 CSS 选择器分支（其中 3 个完整 CSS 规则被删除）。
- 新增证据文件：本报告，独立于源码删减统计。
- 不删除公共 API、不确定用途资源或其他任务的改动；未推送、未合并。
