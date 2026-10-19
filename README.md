# Live Server++ for Zed

> It's Truly Live —— 无需保存，边打字边在浏览器里看到效果。

这是 [vscode-live-server-plus-plus](https://github.com/ritwickdey/vscode-live-server-plus-plus) 的 Zed 版本：一个面向 HTML / CSS / JS 项目的本地静态服务器，编辑器里的**未保存内容**会实时推送到浏览器。

## 功能

| 功能 | 说明 |
| --- | --- |
| **无需保存** | HTML、CSS、JS 的未保存内容直接由服务器提供，并实时推送到浏览器 |
| **HTML 无刷新更新** | 默认 `hot` 策略：在页面上原地对比并修补 DOM，保留滚动位置、输入框内容和 JS 状态 |
| **CSS 无刷新更新** | 样式表在后台加载完成后再替换，不会闪烁 |
| JS 修改 | 自动整页刷新（`<script>` 内容变化时同样会整页刷新） |
| 磁盘文件变化 | 没在 Zed 中打开的文件（图片、构建产物等）被修改时也会刷新 |
| 可自定义 | 端口、服务根目录、首页文件、刷新延迟、浏览器、刷新策略 |
| 自动打开浏览器 | 默认浏览器 / Chrome / Firefox / Edge，或者不打开 |
| 端口占用 | 端口被占用时自动尝试后续端口 |
| 其它 | 目录列表页、Range 请求（音视频拖动）、防目录穿越、服务重启后页面自动重连刷新 |

## 使用

Zed 扩展目前没有状态栏和命令面板 API，所以开关放在了 **Code Actions（代码操作）** 菜单里：

1. 打开任意 HTML / CSS / JS 文件；
2. 按 `Cmd + .`（Linux / Windows：`Ctrl + .`），或点击行号旁的 ⚡ 图标；
3. 选择：
   - **Live Server++: Go Live (start server)** —— 启动服务并在浏览器中打开当前 HTML 文件（非 HTML 文件则打开根目录）
   - **Live Server++: Open /xxx.html in browser** —— 服务运行时，在浏览器中打开当前文件
   - **Live Server++: Stop server (port 5555)** —— 关闭服务

启动后 Zed 会弹出通知显示访问地址，例如 `Live Server++ is live at http://127.0.0.1:5555/`。

> 如果想打开项目就自动启动，设置 `"autoStart": true`。

## 设置

在 Zed 的 `settings.json`（全局）或项目内 `.zed/settings.json` 中配置：

```jsonc
{
  "lsp": {
    "live-server-plus-plus": {
      "settings": {
        "port": 5555,                 // 0 表示随机端口；被占用时自动尝试后续 20 个端口
        "host": "127.0.0.1",          // 设为 "0.0.0.0" 可在局域网（如手机）访问
        "root": "./",                 // 服务根目录，相对于项目根目录，例如 "./sub_folder1/sub_folder2"
        "indexFile": "index.html",    // 访问目录时使用的首页文件
        "timeout": 300,               // 编辑后推送到浏览器前的延迟（毫秒，防抖）
        "browser": "default",         // "default" | "chrome" | "firefox" | "microsoft-edge" | 其它应用名/命令 | null（不打开）
        "reloadingStrategy": "hot",   // "hot"：原地修补 DOM | "partial-reload"：替换 <body> | "reload"：整页刷新
        "autoStart": false,           // 语言服务器启动时就开启 HTTP 服务
        "openBrowserOnStart": true,   // 通过 "Go Live" 启动时是否打开浏览器
        "watchFiles": true,           // 监听磁盘上未在 Zed 中打开的文件
        "ignore": ["**/node_modules/**", "**/.git/**"] // 磁盘监听忽略的 glob（相对于 root）
      }
    }
  }
}
```

修改设置后立即生效；若改了 `port` / `host` / `root` / `watchFiles` 且服务正在运行，会自动重启服务。

与 VS Code 版设置的对应关系：`liveServer++.port` → `port`，`liveServer++.root` → `root`，`liveServer++.browser` → `browser`，`liveServer++.indexFile` → `indexFile`，`liveServer++.timeout` → `timeout`，`liveServer++.reloadingStrategy` → `reloadingStrategy`。

### 其它可选配置

- 使用自定义 Node.js：`"lsp": { "live-server-plus-plus": { "binary": { "path": "/usr/local/bin/node" } } }`（默认使用 Zed 自带的 Node.js）。
- 只在部分语言启用：例如不想在 JavaScript 文件里出现这些代码操作：

  ```json
  { "languages": { "JavaScript": { "language_servers": ["!live-server-plus-plus", "..."] } } }
  ```

  注意：JS 文件不再被跟踪后，其未保存内容不会被提供，保存后会通过磁盘监听触发刷新。
- 不喜欢行号旁一直显示 ⚡ 图标：在设置中加入 `"inline_code_actions": false`，`Cmd + .` 仍然可用。

## 工作原理

Zed 扩展运行在 WebAssembly 沙箱中，不能直接监听端口或订阅编辑器内容变化。本扩展的做法是：

```
┌──────────── Zed ────────────┐   LSP (stdio)    ┌──────── live-server.js (Node) ────────┐   WebSocket   ┌── 浏览器 ──┐
│ HTML/CSS/JS buffer 修改     │ ───────────────▶ │ 保存每个 buffer 的最新内容（含未保存）  │ ────────────▶ │ client.js  │
│ Code Action: Go Live / Stop │ ◀─────────────── │ HTTP 静态服务 + 注入 client.js          │ ◀──── HTTP ── │ DOM 修补   │
└─────────────────────────────┘ showMessage /    └────────────────────────────────────────┘               └────────────┘
                                showDocument
```

- `src/lib.rs`：Rust 扩展（编译为 `wasm32-wasip2`）。它把内置的 `server/*.js` 写入扩展工作目录，并让 Zed 用自带的 Node.js 以**语言服务器**的身份启动它，同时把 `lsp.live-server-plus-plus` 的设置传给它。
- `server/live-server.js`：零依赖的 Node.js 程序。作为语言服务器，它通过 `textDocument/didChange`（全量同步）拿到编辑器里的实时内容；同时运行 HTTP 服务和一个最小实现的 WebSocket 服务。
- `server/client.js`：注入到每个 HTML 页面的脚本，负责接收更新：DOM 原地修补（按 `id` 匹配移动节点、向前查找处理插入/删除）、样式表无闪烁替换、必要时整页刷新。
- 打开浏览器默认通过 LSP 的 `window/showDocument` 交给 Zed 处理；指定浏览器时直接启动对应程序。

## 注意事项

### 安装时提示 `Failed to install dev extension: compiling Rust extension`

Zed 编译扩展时直接调用 `PATH` 中的 `cargo` / `rustc`。如果同时装了 **Homebrew 的 Rust**（`brew install rust`）和 **rustup**，且 `/opt/homebrew/bin` 排在 `~/.cargo/bin` 前面，Zed 会用 Homebrew 的工具链。它没有 `wasm32-wasip2` target，也无法补装，日志（`zed: open log`）中会看到：

```
error[E0463]: can't find crate for `core`
  = note: the `wasm32-wasip2` target may not be installed
```

先用 `which -a cargo rustc` 确认实际用的是哪一个，然后二选一：

1. **卸载 Homebrew 的 Rust（推荐）**：`brew uninstall rust`（可先用 `brew uses --installed rust` 确认没有其它包依赖它）；
2. **调整 PATH 顺序**：在 `~/.zshrc` **末尾**加入 `export PATH="$HOME/.cargo/bin:$PATH"`。

之后**完全退出 Zed（`Cmd + Q`）再重新打开**（Zed 只在启动时读取一次 shell 环境），用 `which cargo rustc` 确认指向 `~/.cargo/bin`，再重新 Install Dev Extension。

### 使用上的局限

与原版一样：如果页面大量依赖 JavaScript 动态修改 DOM，`hot` 策略可能会覆盖脚本对 DOM 的改动，此时建议使用 `"reloadingStrategy": "reload"`。

另外：

- 每个 Zed 项目（worktree）各自运行一个服务；多个项目同时 Go Live 时会使用不同端口。
- `HTML` 语言由 Zed 官方的 HTML 扩展提供，请确保已安装（打开 `.html` 文件时 Zed 通常会自动提示）。
- 代码操作菜单是唯一的开关入口（Zed 目前没有给扩展开放状态栏/命令面板）。

## 开发

需要通过 [rustup](https://rustup.rs) 安装 Rust（Zed 会自动安装 `wasm32-wasip2` target；如果 Rust 不是 rustup 安装的，需要自行提供该 target）。

1. 在 Zed 中打开扩展页面（`zed: extensions`），点击 **Install Dev Extension**，选择本目录；
2. 修改代码后，在扩展页面点击 **Rebuild**；
3. 查看日志：`zed: open log`，或用 `zed --foreground` 启动；语言服务器的输出在 `dev: open language server logs` 里（选择 `Live Server++`）。

测试（需要 Node.js ≥ 18；浏览器测试需要本机安装 Chrome/Chromium，否则自动跳过，也可通过 `CHROME_PATH` 指定）：

```sh
npm test                                   # 或：node --test test/*.test.js
cargo build --release --target wasm32-wasip2
```

## 目录结构

```
extension.toml        # 扩展清单：声明语言服务器 live-server-plus-plus（HTML / CSS / JavaScript）
Cargo.toml
src/lib.rs            # Zed 扩展（Rust → WASM）
server/live-server.js # LSP + HTTP + WebSocket 服务（Node.js，零依赖）
server/client.js      # 注入浏览器的热更新脚本
test/                 # 端到端测试（LSP/HTTP/WebSocket）与无头 Chrome 测试
```

## License

MIT
