# LaTeX Companion for Better Paseo

让官方 Better Paseo 继续接管回复 Markdown，同时显示行内和独立公式。两个插件分别安装，可以单独更新。KaTeX 和字体已打包，公式在当前客户端排版。

## 从 GitHub 安装

在 Paseo 守护进程所在的机器上运行以下命令，也可以在 **设置 → 插件 → 插件来源** 填入相同的 Git 来源。

```sh
paseo plugin install git:ms903/paseo-kit:plugins/paseo-latex-companion
```

安装后，同时启用官方 **Better Paseo** 和 **LaTeX Companion for Better Paseo**，并在原版的设置里开启 **回复使用插件 Markdown**。

![Paseo 0.18 网页端与 Better Paseo 1.7.0 同时启用时的表格公式](preview.png)

## 公式显示设置

打开 **设置 → 当前主机 → 插件 → LaTeX Companion for Better Paseo**。公式字号可选 100%、110%、125% 和 150%，默认 100%。关闭 **排版表格中的公式** 会恢复 Better Paseo 的原始表格，正文里的公式继续排版。

这两个阅读偏好保存在当前浏览器或桌面客户端，同一客户端打开的其他标签页也会更新。不同设备可以使用各自的字号。

## 使用 ZIP 安装

从 [v1.1.0 Release](https://github.com/ms903/paseo-kit/releases/tag/paseo-latex-companion-v1.1.0) 下载插件 ZIP。

1. 将 ZIP 解压到运行 **Paseo 守护进程** 的机器上，保留解压目录。如果连接的是 WSL 或远程主机，请使用那台主机上的目录。
2. 在该主机的 **设置 → 插件 → 插件来源** 中填入包含 `paseo-plugin.json` 的目录绝对路径，点击安装。也可在终端执行 `paseo plugin install "目录的绝对路径"`。预构建包可以直接安装，无需运行 npm。
3. 同时启用官方 **Better Paseo** 和 **LaTeX Companion for Better Paseo**。在原版 Better Paseo 的设置里开启 **回复使用插件 Markdown**。如果此前启用过替代版 **Better Paseo LaTeX**，请停用那个替代版。

打开一条已有的助手回复即可查看。支持正文和表格中的 `$…$`、`\(…\)`，以及单独成段的 `$$…$$`、`\[…\]`。例如公式 `$\eta\lambda_E \ge |X_E^\top r_K|_\infty/n$` 的两条竖线会留在同一单元格。代码示例保留原样。

## 兼容范围

本插件用于 Paseo 网页端和使用网页渲染的桌面端。已在 Paseo 0.18.0 的 Chromium 网页端测试官方 Better Paseo 1.6.5 和 1.7.0，以及保持本插件启用时从前者升级到后者。还在 Paseo 0.18.1 的 Chromium 网页端复测了与 Better Paseo 1.7.0 共存时的正文及表格公式。原生 iOS 和 Android 客户端目前只显示原版 Better Paseo 的输出。

Better Paseo 负责回复、表格、工具栏和复制操作。本插件在回复可见后，从 Better Paseo 的 Markdown 块读取源码，只对含公式的内容增加排版。宿主的表格解析器可能在排版之前就把绝对值竖线当成列分隔符。此时本插件从原文恢复显示，取完整原文请使用表格的 **Copy as Markdown**；按单元格选择复制仍取原版解析的内容。

两个插件有独立的标识与文件。Better Paseo 尚无公开的公式扩展接口，因此本插件需要识别其界面标记和 React 组件属性。如果将来上游改变这些结构，公式功能可能需要更新适配。停用本插件就会恢复原版显示。

[Better Paseo 上游讨论](https://github.com/RoundRedDot/better-paseo/issues/24) · [Paseo 插件文档](https://paseo.sh/docs/plugins)

## 从源码构建

源码位于 `client/`，发布入口为自包含的 `index.client.ts`。在 Node.js 24 下运行 `npm ci`、`npm test` 和 `npm run build` 即可重新生成入口。第三方字体与代码许可证位于 `licenses/`。
