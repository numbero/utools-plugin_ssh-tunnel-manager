# SpanTunnel · uTools SSH 隧道管理插件

SpanTunnel：管理本机 SSH 端口转发隧道的 uTools 插件，本地转发（-L）、反向转发（-R）、动态 SOCKS（-D），
一键启停、后台常驻（退出 uTools 隧道不断）、状态可视、日志可查。

- 产品设计文档：[`docs/PRD.md`](docs/PRD.md)
- 高保真交互原型：[`docs/ui-prototype.html`](docs/ui-prototype.html)（浏览器直接打开体验）
- v2.0 设计文档 / 原型：[`docs/DESIGN-v2.md`](docs/DESIGN-v2.md) · [`docs/ui-v2-prototype.html`](docs/ui-v2-prototype.html)
- 演进规划：[`docs/ROADMAP.md`](docs/ROADMAP.md)
- 演进规划（v2+）：[`docs/ROADMAP.md`](docs/ROADMAP.md)

## 目录结构

```
plugin.json          # uTools 插件配置（指令：SSH 隧道 / 新建 SSH 隧道）
index.html           # 页面（Vue 3 全局构建，无构建步骤）
preload.js           # 引擎入口：挂 window.api（不触碰 utools API）
engine/              # 纯 Node 层：ssh 参数/spawn/状态机/日志/端口/agent/标记
  ssh-args.js        #   参数拼装（-N -T、-L/-R/-D、保活、SetEnv 身份标记、-R 绑定开关…）
  ssh-config.js      #   ~/.ssh/config 轻量解析器（v2.0：批量导入）
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
test/                # smoke-v2.js（引擎冒烟）/ e2e-v2.js（真实 sshd 端到端，临时高端口 sshd 自动清理）
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
- **`~/.ssh/config` 导入（v2.0）**：工具栏「从 ~/.ssh/config 导入」——仅含转发指令
  （LocalForward/RemoteForward/DynamicForward）的 Host 进草稿，勾选批量生成隧道；
  通配符 Host 与 Match 块跳过、Include 仅提示；HostName/Port/User/IdentityFile/ProxyJump
  直接映射现有数据模型；`RemoteForward 0.0.0.0:` 自动置 LAN 开关。不写入任何秘密。
- **反向转发 LAN 开关（v2.0）**：每条 -R 规则可开「允许远端局域网访问」（远端绑 0.0.0.0，
  默认仅 127.0.0.1）。**安全须知**：仅当远端 sshd 配置 `GatewayPorts yes|clientspecified`
  时实际生效，否则服务端静默降级为仅监听回环；开启前请确认远端防火墙/安全组。
- **日志全文检索（v2.0）**：工具栏「日志全文检索」——跨隧道搜索
  `~/.utools-ssh-tunnel/logs/*.log`，按隧道分组、命中行 ± 上下文、关键词高亮、
  大小写开关、可跳转对应日志视图（返回仍回检索页）；已删隧道的遗留日志同样可检索。

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

### 自动化测试

```bash
node test/smoke-v2.js   # 引擎冒烟：ssh-config 解析 18 边界 / bindAll 参数 / 日志检索（23 项）
node test/e2e-v2.js     # 真实 sshd e2e：临时 sshd :2222 + http :18000，自动清理（9 项）
```

e2e 覆盖：bindAll 关仅回环 / 开 + `GatewayPorts clientspecified` 绑 wildcard 且 LAN 可达 /
开 + GatewayPorts 缺省静默降级回环 / -R 远端端口占用 error(remoteport) / L·R·D 连通 /
检索与 `grep -n` 对照。不碰系统 22 端口与 `/etc/ssh/sshd_config`。

## 已知限制（v1）

- macOS 为主；Windows/Linux 代码预留未验证。
- 被接管的常驻隧道无实时日志管道（历史日志仍可读）。
- 自动重连仅在插件进程在场时生效（uTools 完全退出期间断开需重开后手动/接管）。
- 反向转发服务器侧仅绑定 127.0.0.1（安全默认）。

## 发布产物

`./build.sh` 生成独立产物目录 `dist/`：仅含运行必需文件（plugin.json、页面、引擎、样式、Vue、图标），
不带 docs/设计稿与仓库元数据。uTools 开发者工具「发布新版 / 打包离线安装包」时选择 `dist/` 目录。
`dist/` 不入库（见 .gitignore）；改代码后重新 `./build.sh` 再发布。

## 版本记录

- **v2.0（0.2.0，2026-09-06）**：`~/.ssh/config` 批量导入、反向转发 LAN 绑定开关、跨隧道日志全文检索；
  空状态重构（双 CTA + 类型标签）；信息密度优化（统计卡片化/标签化/明细折叠）。
- **v1（0.1.0）**：三类型转发、常驻接管、动态指令、主题三态、加密秘密存储、导入导出。

后续备选（隧道分组、连接历史、流量统计、离线断线自愈、常驻实时日志）见 [`docs/ROADMAP.md`](docs/ROADMAP.md)。
