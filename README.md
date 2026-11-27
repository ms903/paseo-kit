# ms903 的 Paseo 插件库

[English](README.en.md) · [维护指南](docs/maintenance.md) · [更新记录](CHANGELOG.md)

这里是 ms903 维护和发布 Paseo 插件的仓库。本轮兼容基线是 **Paseo 0.18.1**。每个插件独立安装和更新，已有安装继续使用原来的插件 ID 和 Git 路径。[Paseo v0.18.1](https://github.com/getpaseo/paseo/releases/tag/v0.18.1)

| 插件 | 用途 | 使用条件 |
| --- | --- | --- |
| [tab-recovery](plugins/tab-recovery) | 找回当前工作区已归档的主 agent，并重新打开标签页 | 从命令面板选择 **Reopen a closed agent** |
| [media-studio](plugins/media-studio) | 在会话中审阅图片、视频和音频，发送带时间码的批注，传输媒体文件 | 播放和上传使用网页或桌面端；预览和转码需要 daemon 主机上的 FFmpeg |
| [file-download](plugins/file-download) | 用 Ctrl+S 或 Cmd+S 下载当前预览的文件，包括工作区外的预览 | 网页或桌面端；光标位于文件编辑器时继续保存编辑 |
| [paseo-latex-companion](plugins/paseo-latex-companion) | 在 Better Paseo 接管的 Markdown 正文及表格中排版公式 | 网页或桌面端，同时启用官方 Better Paseo 及其 Markdown 设置 |
| [host-monitor](plugins/host-monitor) | 在侧边栏查看所选主机的 CPU、内存、磁盘、网络和 GPU 指标 | GPU 指标取决于主机硬件及驱动 |
| [ccusage-stats](plugins/ccusage-stats) | 查看 agent 的 token 用量、估算费用和历史报表 | daemon 使用 npm 安装锁定的 ccusage 运行时依赖 |

## 安装和更新

在目标 daemon 的 **Settings → Plugins** 启用插件。按需运行对应行即可安装。

```sh
paseo plugin install git:ms903/paseo-kit:plugins/tab-recovery
paseo plugin install git:ms903/paseo-kit:plugins/media-studio
paseo plugin install git:ms903/paseo-kit:plugins/file-download
paseo plugin install git:ms903/paseo-kit:plugins/paseo-latex-companion
paseo plugin install git:ms903/paseo-kit:plugins/host-monitor
paseo plugin install git:ms903/paseo-kit:plugins/ccusage-stats
```

已从本仓库安装的插件可以原地更新。以标签恢复为例，先查看更新，再应用并确认当前版本。

```sh
paseo plugin update tab-recovery --check
paseo plugin update tab-recovery
paseo plugin ls
```

Git 安装跟随记录的来源。若某个插件仍显示其他仓库为来源，请先核对安装记录和设置。需要重现某个版本时，在安装命令后加 `--ref <tag-or-commit>`，或运行 `paseo plugin update <id> --ref <tag-or-commit>`。[Paseo 的 Git 插件安装说明](https://github.com/getpaseo/paseo/blob/v0.18.1/docs/plugins.md#install-a-git-source)

## 开发和许可

每个插件的源码、manifest 和依赖锁文件都在 `plugins/<id>/`。根目录的检查命令、兼容性验证步骤和版本发布约定见[维护指南](docs/maintenance.md)。

本仓库源自 [a31521424/paseo-kit](https://github.com/a31521424/paseo-kit)，保留了原作者署名和提交历史。项目采用 Apache-2.0。公式插件内置 KaTeX、Marked 和字体，其各自的许可证随源码分发。[LICENSE](LICENSE) · [NOTICE](NOTICE) · [第三方许可证](plugins/paseo-latex-companion/licenses)
