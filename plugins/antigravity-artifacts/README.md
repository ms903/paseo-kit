# Antigravity Artifacts

在 Antigravity 会话的「+」菜单选择 **Antigravity 产物**，也可在命令面板搜索 **打开 Antigravity 产物**。可以筛选文件、预览文本和图片、复制 daemon 路径，或把路径插入当前会话的输入框。

需要 Paseo 0.18.1 及以上，以及 Linux daemon。在目标 daemon 上安装。

```sh
paseo plugin install git:ms903/paseo-kit:plugins/antigravity-artifacts
```

产物来自 daemon 用户的 `~/.gemini/antigravity-cli/brain`。如果 daemon 使用 `GEMINI_DIR`，插件从对应目录读取。可见范围包括当前 Antigravity 会话及 Paseo 登记在同一工作区的直接子 Agent。Antigravity 只在内部记录的子代理需要先由 Paseo 提供会话关系。

文本按原文展示，上限 128 KB。图片预览上限 2 MB。可复制大型图片、文档、音视频的路径，在 Paseo 文件预览中打开，或交给现有的 Media Studio 和文件下载功能处理。

此插件只提供产物功能。若已安装 Antigravity Console，继续从原入口管理 Google 账号。要去掉独立的 5H／7D 额度行，在 **设置 → 侧边栏 → 底部** 关闭 **Antigravity 控制台**。

产物面板设计参考 [Kel077/paseo-antigravity-console](https://github.com/Kel077/paseo-antigravity-console/tree/db762dbe295665d70e24d3e00078b29184340c86)。
