# 更新记录

## Paseo 0.18.1 维护版

| 插件 | 版本 | 变化 |
| --- | --- | --- |
| tab-recovery | 0.1.0 | 新版主机直接调用 daemon 恢复归档会话，旧版主机沿用 CLI。并发恢复、缓存以及打开标签时的导航都按主机和工作区区分。 |
| media-studio | 0.1.0 | 关闭输入框媒体提示后停止其目录扫描；启用时分批查询，覆盖超过 200 个目录的主机。重载可交接正在上传和排队的文件，并按主机隔离上传任务和播放位置。 |
| file-download | 0.1.0 | 下载快捷键校验主机归属，支持 Windows 文件名和大量工作区中的相对路径。分块传输期间检测文件变化，避免拼接出混合内容。 |

六个插件保留原安装地址。使用 Paseo SDK 的五个插件均已更新开发依赖至 0.18.1。LaTeX Companion 继续分发原有 1.0.0 构建，新增构建一致性检查。

已在 Linux 上用真实 daemon 验证六个插件可加载。另在 Paseo 0.11.1、0.15.0 和 0.18.1 验证了主机监控数据与 ccusage 会话统计。维护步骤和回归入口见[维护指南](docs/maintenance.md)。

## LaTeX Companion 1.0.0

首次独立发布，用于 Better Paseo 接管的 Markdown 正文和表格。插件自带 KaTeX 和字体。[版本与下载](https://github.com/ms903/paseo-kit/releases/tag/paseo-latex-companion-v1.0.0)

[早期修复记录](docs/history/fixes.zh-CN.md)
