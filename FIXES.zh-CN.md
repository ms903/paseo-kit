# 修复记录

基于上游 `9ab5b3a6f15d13c64026fb15b1ff2e7dbfeec22e`。

| 原审查项 | 处理 |
| --- | --- |
| host-monitor Linux MemAvailable 正则 | 原审查误报：此提交已经使用 `/m`；保留实现。 |
| 同名上传、截帧覆盖文件 | 用排他硬链接发布，原文件及软链接不会被替换；上传保存发布日志以恢复丢失的远程响应。 |
| 上传任务 ID 冲突 | 新文件使用随机 ID；续传显式传 ID 并核对完整内容指纹；任务内修改串行执行。 |
| 扫描超预算 | 流式遍历，逐条检查数量和时间；最多两个本地扫描，排队时间计入预算；合并同目录请求。 |
| 默认自动扫描和 SSH 范围 | 自动回合卡、输入框扫描默认关闭，SSH 默认无主机。 |
| 远程 macOS find、软链接 | Python 3 跨平台扫描；GNU/BSD stat 都跟随软链接。 |
| 等待回调残留、播放会话竞争 | 回调超时即移除；计入正在启动的播放任务；满额不驱逐现有播放；空闲/无输出会话回收。 |
| FFmpeg 后台任务 | 共享并发限制；插件释放时终止关键帧索引任务。 |
| 传输列表误清理 | 仅清理完成和取消的任务，保留暂停、重试及失败项。 |
| 远程残片清理丢记录 | 删除失败持续保留清理记录；未完成上传增加总容量与任务数配额。 |
| 缓存、笔记、保存帧增长 | 写入时检查配额；设置页提供用量和缓存/过期传输清理。完成上传属于用户文件。 |
| 下载内存、快捷键 | file-download 流式写盘并可取消；两个插件的内存回退上限均为 64 MiB；仅文件预览认领保存快捷键，避开输入和编辑器。 |
| 笔记队列增长 | 已完成 Promise 释放索引；删除笔记也通过临时文件原子写入。 |
| ccusage 缓存 | 按完成时间计新鲜度；刷新最短间隔一分钟；session ID 过期淘汰及容量限制。 |
| tab-recovery 枚举和重复恢复 | 工作区共享 30 秒枚举缓存；恢复前直接刷新目标状态，合并同一 Agent 的并发恢复。 |
| Antigravity 用量和费用 | 读取各端会话 SQLite 及 WAL，解码调用 token；按官方价格和上下文档位计费，合并现有日/周/月/会话报表。 |

价格来源：
- https://aistudio.google.com/docs/pricing
- https://platform.claude.com/docs/en/about-claude/pricing

Antigravity 数据格式参考：
- https://github.com/VasiHemanth/tokentelemetry/blob/main/backend/antigravity_usage.py

验证命令：`npm test`、`npm run typecheck`、CI 客户端浏览器 API 检查。
