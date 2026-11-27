# ms903 的 Paseo 插件库

[English](README.en.md) · [维护指南](docs/maintenance.md) · [更新记录](CHANGELOG.md)

这里是 ms903 维护和发布 Paseo 插件的仓库。本轮兼容基线是 **Paseo 0.18.1**。每个插件独立安装和更新，已有安装继续使用原来的插件 ID 和 Git 路径。[Paseo v0.18.1](https://github.com/getpaseo/paseo/releases/tag/v0.18.1)

| 插件 | 用途 | 使用条件 |
| --- | --- | --- |
| [heartbeat-status](plugins/heartbeat-status) | 标出自己或子 agent 有启用中心跳的会话 | Paseo 0.18.1 及以上，在网页和桌面端的 agent 标签、工作区侧栏查看 |
| [tab-recovery](plugins/tab-recovery) | 找回当前工作区已归档的主 agent，并重新打开标签页 | 从命令面板选择 **Reopen a closed agent** |
| [media-studio](plugins/media-studio) | 在会话中审阅图片、视频和音频，发送带时间码的批注，传输媒体文件 | 播放和上传使用网页或桌面端；预览和转码需要 daemon 主机上的 FFmpeg |
| [file-download](plugins/file-download) | 用 Ctrl+S 或 Cmd+S 下载当前预览的文件，包括工作区外的预览 | 网页或桌面端；光标位于文件编辑器时继续保存编辑 |
| [paseo-latex-companion](plugins/paseo-latex-companion) | 在 Better Paseo 接管的 Markdown 正文及表格中排版公式 | 网页或桌面端，同时启用官方 Better Paseo 及其 Markdown 设置 |
| [host-monitor](plugins/host-monitor) | 在侧边栏查看所选主机的 CPU、内存、磁盘、网络和 GPU 指标 | GPU 指标取决于主机硬件及驱动 |
| [ccusage-stats](plugins/ccusage-stats) | 在同一会话查看 token 用量、输出速度、估算费用和历史报表 | daemon 使用 npm 安装锁定的 ccusage 运行时依赖 |

## 安装和更新

在目标 daemon 的 **Settings → Plugins** 启用插件。按需运行对应行即可安装。

```sh
paseo plugin install git:ms903/paseo-kit:plugins/heartbeat-status
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

Windows PowerShell 下，如果七个插件都要使用，下面这段可以一次处理已有和新安装。它会安装缺少的插件，更新来自本仓库的 Git 安装，并列出其他来源的同名安装。

```powershell
$installed = @(paseo plugin ls --json | Out-String | ConvertFrom-Json)
$plugins = 'ccusage-stats', 'heartbeat-status', 'tab-recovery', 'media-studio',
           'file-download', 'host-monitor', 'paseo-latex-companion'
foreach ($id in $plugins) {
    $item = $installed | Where-Object { $_.id -eq $id }
    if (-not $item) {
        paseo plugin install "git:ms903/paseo-kit:plugins/$id"
    } elseif ($item.installation.identity.remote -eq 'https://github.com/ms903/paseo-kit.git') {
        paseo plugin update $id
    } else {
        Write-Host "$id 已从其他来源安装，请按原安装方式更新"
        continue
    }
    if ($LASTEXITCODE -ne 0) { break }
}
```

Git 安装跟随记录的来源。若某个插件仍显示其他仓库为来源，请先核对安装记录和设置。需要重现某个版本时，在安装命令后加 `--ref <tag-or-commit>`，或运行 `paseo plugin update <id> --ref <tag-or-commit>`。[Paseo 的 Git 插件安装说明](https://github.com/getpaseo/paseo/blob/v0.18.1/docs/plugins.md#install-a-git-source)

## 在 Paseo 内配置

打开 **设置 → 当前主机 → 插件**，选择已安装的插件即可看到开关和选项。需要停用整个插件时，可用同一页顶部的启用开关。

| 插件 | 可调内容 | 默认值 |
| --- | --- | --- |
| Heartbeat Status | 时钟颜色（青绿、蓝、紫、琥珀），指针动画 | 青绿、连续转动，跟随系统“减少动态效果” |
| Token Usage（ccusage-stats） | 会话速度开关、输入区显示口径（实时／解码均速／整轮）、实时统计窗口 | 开启，实时，5 秒 |
| Closed agents（tab-recovery） | 每个工作区显示的已关闭 agent 数量 | 50，可选 10 或 25 |
| Download file（file-download） | Ctrl+S / Cmd+S 下载预览文件 | 开启。关闭后仍可从命令面板下载 |
| Host Monitor | CPU、内存、GPU、磁盘、网络的侧栏开关，CPU 与内存刷新间隔 | 五项均开启，2 秒 |
| Media Studio | 输入框媒体提示、回合媒体卡、agent 工具与提供商、播放画质、硬件编码、FFmpeg 与目录、远程主机 | 输入框提示和媒体卡关闭，自动画质，硬件编码开启 |
| LaTeX Companion | 公式字号、表格公式 | 100%，表格排版开启；显示偏好保存在当前客户端 |

心跳图标采用 IBM Carbon 色板，浅色和深色主题使用不同色阶。Token Usage 的输出速度参考 Drenalol 的 Turn Speed，计量来源和估算标记在会话内显示。[IBM 色板](https://www.ibm.com/design/language/color/) · [Turn Speed](https://github.com/Drenalol/paseo-turn-speed)

## 开发和许可

每个插件的源码、manifest 和依赖锁文件都在 `plugins/<id>/`。根目录的检查命令、兼容性验证步骤和版本发布约定见[维护指南](docs/maintenance.md)。

本仓库源自 [a31521424/paseo-kit](https://github.com/a31521424/paseo-kit)，保留了原作者署名和提交历史。项目采用 Apache-2.0。公式插件内置 KaTeX、Marked 和字体，其各自的许可证随源码分发。[LICENSE](LICENSE) · [NOTICE](NOTICE) · [第三方许可证](plugins/paseo-latex-companion/licenses)
