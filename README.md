# SSH 隧道管理器 · uTools 插件

管理本机 SSH 端口转发隧道的 uTools 插件：本地转发（-L）、反向转发（-R）、动态 SOCKS（-D），
一键启停、后台常驻（退出 uTools 隧道不断）、状态可视、日志可查。

- 产品设计文档：[`docs/PRD.md`](docs/PRD.md)
- 高保真交互原型：[`docs/ui-prototype.html`](docs/ui-prototype.html)（浏览器直接打开体验）

## 目录结构

```
plugin.json          # uTools 插件配置（指令：SSH 隧道 / 新建 SSH 隧道）
index.html           # 页面（Vue 3 全局构建，无构建步骤）
preload.js           # 引擎入口：挂 window.api（不触碰 utools API）
engine/              # 纯 Node 层：ssh 参数/spawn/状态机/日志/端口/agent/标记
  ssh-args.js        #   参数拼装（-N -T、-L/-R/-D、保活、SetEnv 身份标记…）
  spawner.js         #   detached spawn + unref；PID 复用防御（ps 校验）
  manager.js         #   状态机 stopped→starting→running/error；watchdog；自动重连；adopt 接管
  prompt.js          #   密码/passphrase 提示词探测（setsid 无 tty → stdin 写密码）
  markers.js         #   stderr 错误分类正则表
  ports.js           #   本地端口预检（试绑）/ 就绪探活（试连）
  logs.js            #   ~/.utools-ssh-tunnel/logs/<id>.log（tee，>1MB 截尾）
  agent.js           #   SSH_AUTH_SOCK 解析链（env→launchctl→登录 shell）
  platform.js        #   macOS 实现 / Windows 预留
js/                  # 页面层（独占 utools API 与持久化）
css/ vendor/ assets/
```

## 本地开发与载入

1. 安装 [uTools](https://www.u-tools.cn/)（macOS）。
2. 打开 uTools → 插件中心搜索「**开发者工具**」安装 → 打开 → 「应用开发」→ 选择本目录载入。
3. 在 uTools 搜索框输入「SSH 隧道」进入插件；右上角菜单可开开发者工具（⌘⌥I 或 Ctrl+Shift+I）调试。
4. 修改页面代码后在开发者工具重载；**preload/engine 变更需重新进入插件**（preload 不支持热更新）。

无需任何构建步骤：Vue 3 以全局构建本地化在 `vendor/`，符合 uTools「不动态加载外部 JS」规则。

## 使用

- **新建/编辑隧道**：连接（主机/端口/用户）+ 认证（密钥文件+passphrase / 密码 / ssh-agent）+ 多条转发规则 + 高级选项（跳板机、保活、超时、主机密钥校验、自动重连、系统 ssh_config）。
- **启停**：卡片按钮或工具栏全部启动/停止；uTools 搜索框输入「启动/停止 <隧道名>」静默执行并系统通知。
- **状态**：已停止 / 连接中 / 运行中（含时长）/ 错误（中文原因分类）；运行中卡片标「常驻」表示接管自上次会话。
- **日志**：每隧道独立日志文件，uTools 退出期间也保留。
- **安全**：密码与 passphrase 存 `utools.dbCryptoStorage`（加密、不导出、不云同步）；秘密只经内存进子进程 stdin。
- **导入/导出**：JSON（不含密码）。

## 端到端验证（macOS 本机 sshd）

```bash
# 1. 开启本机 sshd：系统设置 → 通用 → 共享 → 远程登录
# 2. 准备测试密钥
ssh-keygen -t ed25519 -f ~/.ssh/utm_test_key -N ""
cat ~/.ssh/utm_test_key.pub >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
# 3. 远端服务
python3 -m http.server 18000 &
```

在插件中新建隧道：主机 `localhost`、用户 `$USER`、认证「密钥文件」选 `~/.ssh/utm_test_key`，
规则「本地转发 18080 → 127.0.0.1:18000」，启动后：

```bash
curl -s http://127.0.0.1:18080            # 应返回 python 目录页
lsof -nP -iTCP:18080 -sTCP:LISTEN         # 监听者应为 ssh
```

**常驻接管**：启动隧道后 ⌘Q 完全退出 uTools → `pgrep -fl 'ssh.*-N'` 仍可见进程、curl 仍通 →
重开插件，卡片应显示「运行中 · 常驻」且时长连续；点停止后 pgrep 归零。

其余用例（SOCKS、反向、密码/agent 认证、端口冲突、外部 kill、主题）见 `docs/PRD.md` 验收矩阵。

## 已知限制（v1）

- macOS 为主；Windows/Linux 代码预留未验证。
- 被接管的常驻隧道无实时日志管道（历史日志仍可读）。
- 自动重连仅在插件进程在场时生效（uTools 完全退出期间断开需重开后手动/接管）。
- 反向转发服务器侧仅绑定 127.0.0.1（安全默认）。

## v2 备选

从 `~/.ssh/config` 批量导入、隧道分组、连接历史、流量统计、日志全文检索。
