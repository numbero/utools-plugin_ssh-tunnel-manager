---
name: utools-plugin-dev
description: uTools 插件（launcher 插件应用）开发、调试、主题化与发布的全流程指引。涉及 plugin.json 配置、preload 预加载脚本、window.utools API（数据库/动态指令/窗口/系统）、插件图标与深浅色适配、打包发布到插件市场时使用此技能；即使用户只说"做个 uTools 插件""插件图标不显示""preload 不生效"等也应触发。
---

# uTools 插件开发

uTools 插件 = **Node.js 本地能力（preload）+ Web 前端（index.html）**，跑在 uTools 的 Electron 容器里。
官方文档总入口：<https://www.u-tools.cn/docs/developer/docs.html>；快速开始：<https://www.u-tools.cn/docs/developer/welcome.html>。
本技能中的平台事实均以官网文档为准，关键知识点附 URL；版本差异以你开发时的官方文档为准（先 fetch 核实再下结论）。

## 1. 插件骨架

目录与配置见官方文档：
- 目录结构：<https://www.u-tools.cn/docs/developer/information/file-structure.html>
- plugin.json：<https://www.u-tools.cn/docs/developer/information/plugin-json.html>
- preload：<https://www.u-tools.cn/docs/developer/information/preload.html>
- Node.js 能力：<https://www.u-tools.cn/docs/developer/information/preload-js/nodejs.html>

最小结构：

```
plugin.json     # main(入口html) / logo(必填) / preload(可选) / features(指令,≥1) / pluginSetting{single,height}
index.html      # 渲染层页面
preload.js      # 可选：Node 能力入口，先于页面脚本执行
```

`features[].cmds` 决定搜索框如何唤起插件（字符串或 regex/over/files/window 等匹配对象）。
字段权威定义可对照官方 JSON Schema：<https://github.com/uTools-Labs/utools-api-types/blob/main/resource/utools.schema.json>

## 2. 运行模型与分层铁律

- **preload 跑在 Electron 渲染进程**（nodeIntegration 开启），不是纯 Node 主进程：可 `require` 全部 Node 原生模块（child_process/fs/os…），但全局是浏览器环境（见 §3 坑 1）。
- **页面层**通过 `window.utools` 访问宿主 API；preload 通过给 `window` 挂自定义属性向页面暴露方法。
- 推荐分层：**页面层独占 utools API 与持久化；preload 层只做系统 I/O**，经 `window.api.*`（全部返回 Promise）桥接。这样页面可在普通浏览器里用内存 shim -preview，preload 可脱离 uTools 单测。

## 3. 踩坑清单（本清单来自真实项目，官方文档不写）

1. **渲染进程定时器没有 unref**：preload 里 `setInterval(...)` 返回 number，链式 `.unref()` 直接 TypeError 且 **preload 静默崩溃**——页面照常渲染、功能全假。一切 `.unref()` 调用先 `typeof x.unref === 'function'` 守护。排查入口：插件窗口 DevTools Console 的 `Unable to load preload script: …`。
2. **`window.utools` 注入时机可能晚于页面脚本解析**：不要在解析期做"有无 utools"的判定并装兜底模拟——静默 fallback 是最坏容错（UI 正常但数据库/进程零痕迹）。正确做法：延迟引导（轮询等待就绪再 bootstrap）、对 utools 的访问用惰性代理（`new Proxy({}, {get:(_,k)=>window.utools[k]})`）。
3. **环境版本红线**：渲染层约 Chromium 91、preload 约 Node 14/16（以官方文档当前表述为准）。禁用 `structuredClone`、`fetch`(页面外)、`crypto.randomUUID`、`String.replaceAll`、`Array.at`、逻辑赋值(`??=`)、ES module 页面脚本等；可选链/空值合并/async 可用。
4. **常驻子进程**：要"宿主退出进程不死"，`spawn(cmd, args, {detached:true, stdio:'pipe'})` 后立刻 `child.unref()`（ChildProcess 的 unref 在渲染进程存在，与坑 1 的定时器不同）。重新接管用「argv 身份标记 + `process.kill(pid,0)` + ps 校验」防 PID 复用：给子进程 argv 塞一个 `-o SetEnv=KEY=<id>` 之类的标记，接管前 `ps -ww -o command= -p <pid>` 校验标记与目标主机都在。
5. **秘密不进 utools.db**：db 文档可能云同步；密码/密钥 passphrase 存 `utools.dbCryptoStorage`（加密 KV，同步 API），db 文档里只留布尔标记；秘密只经内存传入子进程 stdin，不进 argv/env/日志。
6. **preload 变更不热更新**：页面改动可 DevTools 重载，preload/engine 改动需重新进入插件或重启 uTools。

## 4. 常用 API 速查（均见官方 API 参考）

- 事件（onPluginEnter/onPluginOut，enter 回调收 `{code,type,payload}` 做指令分发）：<https://www.u-tools.cn/docs/developer/utools-api/events.html>
- 窗口（`isDarkColors()` 判深色、`setExpendHeight(px)` 调窗高、`showNotification(body[,code])`、`outPlugin()` 退后台）：<https://www.u-tools.cn/docs/developer/utools-api/window.html>
- 数据存储（`db.put/get/allDocs` PouchDB 风格；`dbStorage` KV；`dbCryptoStorage` 加密 KV）：<https://www.u-tools.cn/docs/developer/utools-api/db.html>
- 动态指令（`setFeature({code,cmds,explain,icon,mainHide})` / `removeFeature` / `getFeatures`；`mainHide:true` 命中后不显窗，配合 `showNotification`+`outPlugin` 做静默执行）：<https://www.u-tools.cn/docs/developer/utools-api/features.html>
- 系统（`showOpenDialog/showSaveDialog` 文件对话框等）：<https://www.u-tools.cn/docs/developer/utools-api/system.html>

## 5. 图标与主题适配

平台约束（Schema 与发布校验实测）：
- `logo` 只收 **PNG/JPG**，发布时**尺寸 ≤256×256**；`features[].icon` 收 png/jpg/**svg**。
- **没有双图标字段**（无 darkIcon/@dark 约定）。主题自适应的可行路径：
  1. SVG 内嵌 `@media (prefers-color-scheme: dark){…}` 切换配色——Chromium 渲染 SVG 图标时按系统配色求值；
  2. 运行时按解析主题用 `setFeature` 重注册动态指令的 `icon`（深/浅两个 svg 文件）；
  3. 应用内图标用内联 SVG + CSS 变量着色，跟随任意主题切换（含手动覆盖）。
- 手动主题三态（跟随/浅/深）模式：选择持久化 `dbStorage`；「跟随」时 `matchMedia('(prefers-color-scheme: dark)')` 监听系统变化；页面根元素 `data-theme` 属性 + CSS 令牌双主题。

## 6. 调试与发布

- 调试：开发者工具插件载入目录，见 <https://www.u-tools.cn/docs/developer/basic/debug-plugin.html>；第一个插件 walkthrough：<https://www.u-tools.cn/docs/developer/basic/first-plugin.html>
- 打包离线包：<https://www.u-tools.cn/docs/developer/basic/offline-plugin.html>；发布市场：<https://www.u-tools.cn/docs/developer/basic/publish-plugin.html>
- **产物目录模式**：写 `build.sh` 把运行必需文件（plugin.json/index.html/preload/js/css/vendor/assets）拷到独立 `dist/`（`find dist -name '.DS_Store' -delete` 剔垃圾），发布/打包选 `dist/`；docs、设计稿、仓库元数据不带进包。`dist/` 入 .gitignore。
- 发布对话框会校验 logo 格式与尺寸（"logo 必须是 PNG、JPG 图片""建议不超过 256x256"），栅格化可用浏览器 canvas：SVG → `drawImage` → `toDataURL('image/png')`。

## 7. 验证套路

- 引擎层（preload 依赖）可在纯 Node 下 smoke test（注意坑 1 的差异：纯 Node 定时器有 unref，测不出渲染进程崩溃——uTools 内验证不可省）。
- 页面层用浏览器 + 内存 shim（模拟 utools/api）跑交互回归；真实集成必须在 uTools 内冷启动验证。
- 涉及系统服务（如 sshd）的 e2e：macOS 无 TTY 时 `sudo` 不可用、`systemsetup` 需 FDA，可用 `osascript -e 'do shell script "…" with administrator privileges'` + `launchctl enable/kickstart system/<label>` 路径。
