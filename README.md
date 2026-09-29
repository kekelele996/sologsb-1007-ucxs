# 口述历史转写与标注编辑器

面向口述史项目的本地优先校对工作台。应用预置普通话校订轨、方言原音轨和英文字幕轨示例，可不依赖后端完成完整编辑闭环。

## 功能

- 导入 SRT、VTT 或每行 `[00:12] 文本` 格式的带时间码文本。
- 在多个转写轨之间切换，校正发言人、开始/结束时间、正文和 1—5 级置信度。
- 标记低置信词句、方言表达和专有名词；按文本光标比例拆分片段，或与下一片段合并。
- 把片段关联到主题、事件和人物，重复关联自动去重。
- 添加审校批注、逐条回复并标记解决状态。
- 支持 50 步撤销/重做，`Ctrl/Cmd+Z`、`Ctrl/Cmd+Shift+Z` 快捷键。
- **写穿式本地保存**：每次修改（含正文逐字输入）即时写入 `localStorage`，没有防抖窗口，刷新、关闭标签页或突然断网都不会丢掉最后一次改动；`Ctrl/Cmd+S` 可手动触发保存。
- **离线可重入**：首次在线打开后由 Service Worker 预缓存应用外壳与全部静态资源，之后断网刷新/重进仍是完整编辑器，并原样找回刚才的批注与片段修改。
- **多标签页冲突不静默覆盖**：保存信封带 `saveId/parentSaveId` 世系，写入走乐观锁。两个标签页从同一版本分叉后，**后写的一方先看到冲突提示**；先写方的版本保留在共享位置，后写方的内容存为独立分叉草稿，由校对员选择「保留本页」或「载入对方版本」。即使两个页面物理上同刻写入（跨进程竞态），也会按世系识别兄弟版本；选择「保留本页」会带 `forced` 标记通知被覆盖的一方。冲突未解决期间两侧内容都各自落盘，刷新或离线重进都能原样恢复。
- 键盘校对：`J`/`↓` 下一片段，`K`/`↑` 上一片段，`R` 标记已校对，`M` 合并下一片段，`?` 打开快捷键帮助。
- 按当前轨道导出 SRT 字幕。

## 技术栈

- SolidStart 2 + SolidJS + TypeScript
- Kobalte（对话框、Tabs、Checkbox 等无障碍基础组件）
- Vite 8
- 浏览器 `localStorage` / `sessionStorage`、`BroadcastChannel`
- Service Worker（离线外壳预缓存）
- nginx 静态部署

## 开发

需要 Node.js 24 或更高版本。

```bash
npm install
npm run dev
```

开发服务器地址以 Vite 输出为准。

## 构建与预览

```bash
npm run build
npm run preview
```

生产构建输出到 `dist/client`，其中包含可直接部署的 `index.html`、哈希静态资源与 `sw.js`（Service Worker，每次构建按内容哈希生成预缓存清单）。

## 测试

纯 Node 的冲突协议单测（无需浏览器）：

```bash
npm test
```

浏览器端到端验证（离线重进、即时落盘、双标签分叉与冲突裁决）依赖 Playwright，需要额外安装后运行 `scripts/e2e.mjs`（先 `npm run build`）：

```bash
npm i -D playwright && npx playwright install chromium
npm run build && node scripts/e2e.mjs
```

## Docker

容器内由 nginx 监听 `80`，宿主端口按根端口表映射为 `10007`。

```bash
docker build -t sologsb-1007 .
docker run --rm -p 10007:80 sologsb-1007
```

访问 `http://localhost:10007`。

## 数据说明

项目、轨道、片段、批注和词条均保存在当前浏览器的 `localStorage` 中。只读预览或本地数据不会上传到服务器；清理浏览器站点数据会清除草稿。存储分三类键：

- `sologsb-1007-project-v1`：共享主信封（带保存世系，写入走乐观锁）；
- `sologsb-1007-draft-<tabId>`：冲突未决时本页的分叉稿，刷新/离线后原样找回，解决后删除；
- `sologsb-1007-outbox-<tabId>` / `sologsb-1007-incoming-<tabId>`：本页最近成功保存与对方兄弟版本的留底，用于跨进程同刻竞态后的恢复与裁决。

`<tabId>` 存在按标签页隔离的 `sessionStorage` 中，刷新保持、关签清除。多标签冲突不会自动合并，以避免覆盖人工校对结果。
