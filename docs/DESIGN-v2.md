# SpanTunnel v2.0 设计文档

> 依据 [`ROADMAP.md`](ROADMAP.md) 版本节奏，v2.0 包含三项功能：
> **A** `~/.ssh/config` 一次性批量导入 · **B** 反向转发「允许远端局域网访问」规则级开关 · **C** 跨隧道日志全文检索。
> 本文档为闸门 M0 交付物；UI 部分配套高保真原型 [`ui-v2-prototype.html`](ui-v2-prototype.html)（闸门 M1）。
> 实施计划存档：`~/.claude/plans/vast-nibbling-widget.md`。

## 0. 决策记录（已与用户确认）

| 决策项 | 结论 |
|---|---|
| 导入范围 | 只导入含转发项（LocalForward / RemoteForward / DynamicForward）的 Host 条目；无转发 Host 仅计数不进草稿 |
| 导入方式 | 一次性批量导入（勾选式），不做增量同步；`Include` 指令不跟进解析，仅提示条数 |
| 绑定开关粒度 | 每条 `-R` 规则独立开关，默认关（服务器侧仅绑 127.0.0.1） |
| 检索形态 | 独立跨隧道检索视图（工具栏入口），按隧道分组、命中行 ± 上下文、关键词高亮、可跳转日志视图 |

## 1. 数据模型变更与兼容策略（零迁移）

### 1.1 `rules[]` 新字段 `bindAll`

- 类型布尔，仅 `type === 'R'` 有意义；取 ssh 语义「绑所有接口」命名。
- **兼容 = 缺省即默认**：旧文档无该字段 → falsy → 维持 v1 行为（仅绑回环）。不加 schemaVersion、不批量改写 db。
- 防丢失要点：`saveForm()` 对 rules 是白名单式重组，必须显式带上
  `bindAll: r.type === 'R' ? !!r.bindAll : false`；`blankRule()` 默认 `bindAll: false`。
- 编辑入口只在表单；列表视图对 `R && bindAll` 显示只读琥珀徽标 `LAN`（避免新增列表直写 db 路径）。
- JSON 导出/导入自然透传，无需改动。

### 1.2 导入产物：标准隧道文档

与 `saveForm()` 产物同构，一次性写入 db，不记溯源字段。字段映射：

| 隧道文档字段 | ssh_config 来源 | 缺省 |
|---|---|---|
| `name` | Host 首别名 | — |
| `host` | `HostName` ‖ Host 首别名 | — |
| `port` | `Port` | 22 |
| `user` | `User` ‖ 引擎侧 `os.userInfo().username` | — |
| `auth` | 有 `IdentityFile` → `{method:'key', keyPath:第一个(保留 ~ 原样)}`；无 → `{method:'agent'}` | agent |
| `options.proxyJump` | `ProxyJump` 原样（逗号多跳 `-J` 直接接受） | '' |
| `options.localBindHost` | L/D 转发带 bind 前缀且各条一致、非回环 → 用之 | '127.0.0.1' |
| `rules[]` | `LocalForward`→L、`RemoteForward`→R（bind 为 `0.0.0.0`/`*` → `bindAll:true`，与 config 语义精确对齐）、`DynamicForward`→D | — |

不写入任何秘密（ssh_config 本就不含密码；导入的 key 认证隧道如需 passphrase 在编辑表单补填）。

### 1.3 条目取舍与草稿标注（页面层过滤）

- 通配符 Host 块（含 `*`/`?` 别名）整体跳过；`Match` 块整体跳过；两者计入摘要（列出别名）。
- 与现有隧道 `host+port+user` 相同 → 「疑似已存在」徽标；草稿集内 L/D `localPort` 冲突 → 「端口冲突」徽标；导入前对每条草稿异步 `checkKey(keyPath)` 失败 → 「私钥缺失」徽标。**徽标均不阻断勾选**。
- 同名 Host 块出现多次：解析器如实返回两个 entry，不合并（页面按两行草稿呈现）。

## 2. 功能 A：`engine/ssh-config.js` 解析器

无第三方依赖（vendor/ 仅 Vue），手写轻量解析器。导出 `{ parse, readAndParse, defaultConfigPath }`。

- `defaultConfigPath()` → `~/.ssh/config`（`os.homedir()` 拼接）。
- `readAndParse(p)`：p 缺省读默认路径；成功 `{ok:true, path, result}`；文件缺失/不可读 `{ok:false, error}`（页面 toast）。
- `parse(text)` 输出：

```js
{
  entries: [{
    kind: 'host' | 'match',
    aliases: [],          // Host 别名列表（Match 为原始条件串按空白拆分）
    wildcard: false,      // 任一别名含 * 或 ?
    line: 0,              // 块起始行号（1-based，UI 显示来源）
    hostName: '', port: 22, user: '',
    identityFiles: [],    // 累加，保序
    proxyJump: '',
    forwards: [{ dir: 'L'|'R'|'D', bind, port, targetHost, targetPort, line, raw }],
    hasForward: false,
    skipReason: '' | 'wildcard' | 'match',
  }],
  includes: [{ path, line }],   // v2.0 不跟进，仅提示
  errors: [{ line, text }],     // 畸形行（不抛异常、不丢整块）
}
```

### 2.1 语法规则（对齐 OpenSSH readconf 的可观察行为）

1. 关键字大小写不敏感，值保留原样；分隔支持空白与 `=`（`Port=2222` 合法）。
2. 仅整行 `#` 开头为注释；**不剥离行内 `#`**（OpenSSH 将行内 # 视为值的一部分）。
3. `Host` / `Match` 开新块；首个块之前的全局区关键字全部忽略（不进任何 entry）。
4. 同块内重复的单值关键字（HostName/Port/User/ProxyJump）**首个生效**（OpenSSH 语义）；`IdentityFile`、转发指令累加。
5. 不支持续行反斜杠（OpenSSH 本就不支持）；CRLF / BOM / tab 预处理归一。
6. `Include` 记入 `includes[]`，不读取不展开。

### 2.2 转发指令格式

- `LocalForward|RemoteForward [bind:]port host:hostport`：第一 token 按 `:` 拆——1 段 = port、2 段 = bind:port；RemoteForward 的 port 映射为规则的 `localPort`（远端监听端口，与 v1 R 约定一致），`host:hostport` 映射 `remoteHost/remotePort`。
- `DynamicForward [bind:]port`：仅监听端，无 target。
- IPv6 支持方括号写法 `[::1]:80`。
- 畸形（裸多冒号、port 非数字/越界 1–65535、L/R 缺 target）→ 记 `errors[]`（行号 + 原文），该行忽略，块保留。

### 2.3 边界情况表（fixture 全覆盖，18 项）

| # | 用例 | 期望 |
|---|---|---|
| 1 | 空文本 / 全注释 | entries=[]，errors=[] |
| 2 | 完整单块（Host/HostName/Port/User/IdentityFile×2/ProxyJump/L+R+D） | 全字段正确、forwards 3 条 |
| 3 | `Host *` | skipReason='wildcard' |
| 4 | `Host a *` 混合 | wildcard=true，整块跳过，别名保留 |
| 5 | `Match host x` 块 | kind='match'，skipReason='match' |
| 6 | `Include ~/.ssh/conf.d/*` | includes 1 条，不展开 |
| 7 | `LocalForward 8080`（缺 target） | errors 1 条，块保留 |
| 8 | `DynamicForward 1080` / `DynamicForward 127.0.0.1:1080` | D 无 bind / bind='127.0.0.1' |
| 9 | `RemoteForward 0.0.0.0:9000 127.0.0.1:9000` | dir=R，bind='0.0.0.0'（页面据此置 bindAll:true） |
| 10 | 小写关键字 `host`/`hostname`/`localforward` | 与大小写规范写法等价 |
| 11 | `Port=2222` | port=2222 |
| 12 | 同块两行 HostName | 首个生效 |
| 13 | 同名 Host 块 ×2 | 返回两个 entry，不合并 |
| 14 | CRLF + BOM + tab 混排 | 正常解析 |
| 15 | IPv6 `LocalForward [::1]:8080 ::1:80` 方括号写法 | bind='::1' |
| 16 | 端口 70000 / abc | errors 记录，行忽略 |
| 17 | 裸 `Host`（无别名） | errors 记录，块跳过 |
| 18 | 全局区 `ForwardAgent yes`（首块前） | 忽略，不进 entry |

## 3. 功能 B：`-R` 绑定开关

### 3.1 引擎改动（engine/ssh-args.js `ruleToArgs` L24-27）

签名不变（`bindHost` 参数仍只作用于 L/D）；R 分支：

```js
// 默认服务器侧仅绑回环；bindAll 显式要求 0.0.0.0（需远端 sshd GatewayPorts 配合）
var rbind = rule.bindAll === true ? '0.0.0.0' : '127.0.0.1';
return ['-R', rbind + ':' + lp + ':' + rule.remoteHost + ':' + Number(rule.remotePort)];
```

**不加任何 `ssh -o` 选项**：`GatewayPorts` 是 sshd 端配置，客户端无法强制。远端 `GatewayPorts no`（默认）时，服务端会把显式 0.0.0.0 **静默改回 loopback**——进程照常运行、无报错，这正是 UI 风险文案要讲清的行为。`enabledLocalPorts` / manager 状态机 / adopt 均不受影响（R 不参与本地探活；argv 中 `UTM_TUNNEL` 标记不变）。

### 3.2 UI 与文案

- 表单规则行：`type === 'R'` 时行下方渲染子行——`.sw` 开关（v-model `r.bindAll`）+ 标签「允许远端局域网访问（远端绑 0.0.0.0）」。
- 开启时展示琥珀风险提示，三要点：
  1. 开启后该远端端口对**远端所在网络内所有主机**可见；
  2. 仅当远端 sshd 配置 `GatewayPorts yes` 或 `clientspecified` 时才实际生效，否则服务端静默降级为仅监听 127.0.0.1；
  3. 开启前请确认远端防火墙 / 云安全组策略。
- 列表视图：R 且 bindAll 的规则在映射文本后追加琥珀 `LAN` 徽标；`ruleMapText` R 分支追加 `' · LAN'` 供检索/导出等文本场景。

## 4. 功能 C：跨隧道日志全文检索

### 4.1 引擎改动（engine/logs.js 新增，其余导出不动）

```js
listFiles()  // ensure() → readdirSync 过滤 /\.log$/ → [{id, file, size, mtime}]，mtime 倒序；异常 []
search(keyword, opts)
// opts: { caseSensitive=false, context=1, maxHitsPerFile=50, maxFiles=100 }
// 返回 { keyword, scanned, elapsedMs, files: [{ id, file, truncated,
//        hits: [{ lineNo(1-based), text(截400字符), before:[str], after:[str] }] }] }
// files 只含命中 > 0 的文件；空 keyword 返回空结果
```

实现要点：

- 逐文件 `readFileSync utf8` → `split('\n')`；rotate 机制已保证单文件 ≤1MB，最坏 100×1MB 同步读数百 ms，配页面 loading 态可接受，`maxFiles/maxHitsPerFile` 双上限兜底（取 mtime 最新的 maxFiles 个）。
- 不区分大小写用**两侧 toLowerCase + indexOf**，不用 RegExp——免关键词转义注入。
- 相邻命中的上下文允许重叠，UI 按命中块渲染。
- id → 隧道名映射由页面层 store 补齐；**已删除隧道的遗留日志文件同样可检索**（组头显示 id）。

### 4.2 桥接（三处同改）

```js
// preload.js（同步值包 Promise 风格）
parseSshConfig: (p) => Promise.resolve(sshConfig.readAndParse(p)),
logFiles: () => Promise.resolve(logs.listFiles()),
logSearch: (kw, opts) => Promise.resolve(logs.search(kw, opts)),
```

- `js/api.js` `installApiShim` 增三个浏览器预览模拟（parseSshConfig 返回含 L+R 块 / D 块 / wildcard / match / 无转发 / Include 的固定样例；logSearch 返回带 before/after 的命中样例）。
- 调用侧（openSshImport / doSearch）先判 api 方法存在性，缺失时 toast 提示（防旧 preload 缓存未刷新）。

### 4.3 页面交互

- 工具栏新入口「日志检索」（icon-btn）→ `S.view='search'`（窗高 600）。
- 检索视图：头部（返回 / 输入框回车即搜 / `Aa` 大小写敏感 chip / 搜索按钮）+ 摘要（「N 个文件命中 M 处 · 扫描 X 文件 · Yms」）+ 结果按隧道分组：
  - 组头：隧道名（或 id）+ 命中数 + truncated 提示 + 「查看日志」按钮；
  - 命中块：before 上下文（暗色）→ 命中行（`<mark>` 高亮 + 行号）→ after 上下文；
  - loading 态与空态（复用 `.empty`）。
- **日志回跳改造**：抽 `openLogFor(id, name)`（`openLog(t)` 转调）；`S.log` 增 `origin` 字段记录进入前视图，`closeLog` 返回 `origin || 'list'`——从检索页跳日志后「返回」仍回检索页。
- 高亮实现（Chromium 91 安全）：`hl(text)` = `escapeHtml(text)` 后以 `escapeHtml(query)` 做 **split/join** 包 `<mark>`（规避 replaceAll），配 `v-html`。

## 5. UI 汇总（原型 ui-v2-prototype.html 覆盖三屏）

**信息密度原则（用户反馈确认）**：页面文字信息最小化——统计一律用数字卡片（`.stat-grid`：大数字+小标签）或标签（`.chip`/`.badge`/`.rtag`）呈现；明细（跳过原因、Include、解析告警）默认折叠进 `<details>`；草稿行的转发规则用类型色小标签（`R :9000 · LAN`、`L 18080`、`D 11080`）代替多行文本；风险提示保留但压缩为三行短句。

1. **导入模态**（`.modal.wide` 560px，仿 confirm 模态结构）：路径行 → 四宫格统计卡（可导入/跳过/Include 未解析/解析告警）→ `<details>` 折叠明细标签 → 全选 + 草稿行（checkbox｜名称+徽标｜user@host:port｜规则标签行｜来源行号 L12）→ 「取消 / 导入所选(n)」。入口：工具栏导入按钮旁新 icon-btn「从 ~/.ssh/config 导入」。
2. **表单 R 规则子行**：规则行下方开关 + 开启态琥珀风险提示（三行短句）；列表卡片 `LAN` 徽标。
3. **检索视图**：见 §4.3；摘要行改为标签组（`N 处命中` chip + 文件数/扫描数/耗时 badge + 关键词标签）。

样式全部走现有令牌（`:root` / `[data-theme="dark"]`），新增 class：`.chip.warn`、`.rule-wrap/.rule-sub/.hint.warn`、`.modal.wide/.import-*`、`.search-head/.sres-group/.sres-hit`、`mark`——深浅主题免新增变量。

## 6. 兼容性与安全声明

- v1 数据零迁移；v1 隧道行为不变（bindAll 缺省回落）。
- 不新增动态指令（features.js 不动）；不新增任何秘密存储路径；导入不读密码。
- 秘密流向、日志 tee、detached spawn、adopt 校验链全部沿用 v1，不改 manager/spawner。
- `build.sh` 不改（engine/js/css 整目录复制；`test/` 天然不进 dist）；plugin.json version 0.1.0 → 0.2.0。

## 7. 验收矩阵增补（开发完成后并入 PRD.md）

| 组 | 用例 |
|---|---|
| A 导入 | 18 边界项解析正确；仅含转发条目进草稿；三类跳过有摘要；三种徽标正确且不阻断；导入产物可直接启动（真实 sshd 验证 L/R/D）；不含任何秘密 |
| B 绑定 | 默认关（argv `-R 127.0.0.1:`，旧文档兼容）；开启后 argv 含 `0.0.0.0:` 且 UTM_TUNNEL 标记仍在；风险三要素展示；列表 LAN 徽标；GatewayPorts no 时静默降级不崩、状态机不受影响 |
| C 检索 | 按隧道分组；上下文行正确；行号与 `grep -n` 对照一致；大小写开关生效；truncated 提示；跳转日志后返回仍在检索页；已删隧道遗留日志可检索 |

## 8. e2e 验证方案（GatewayPorts 环境）

**方案 A（推荐，可自动化可还原）**：临时 sshd 高端口——`ssh-keygen -t ed25519 -f /tmp/utmd/hk -N ''` + 最小 sshd_config（`Port 2222` / HostKey / `GatewayPorts clientspecified` / `UsePAM yes`）+ `sudo /usr/sbin/sshd -f /tmp/utmd/sshd_config -D -e`。不碰系统 22 端口与 `/etc/ssh/sshd_config`，测完 kill 即还原；sudo 无 TTY 时走 osascript GUI 授权既有套路。

用例：① bindAll 关 → `lsof -nP -i :<rport> -sTCP:LISTEN` 仅 127.0.0.1；② 开 + clientspecified → `*:<rport>`，`nc -z <lan-ip> <rport>` 通；③ 开 + `GatewayPorts no` → 仍 127.0.0.1（验证「静默降级」文案属实）；④ -R 端口占用 → error 状态呈现（回归）；⑤ fixture config 导入产物直接启动，nc 验 L/R/D 连通；⑥ 检索结果与 `grep -n` 行号条数一致。
