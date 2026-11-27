# 维护 Paseo 插件

维护仓库为 `ms903/paseo-kit`。默认分支 `main` 是 Git 安装检查更新时使用的来源。目录名、manifest 的 `id` 以及旧 Git 标签都是用户安装记录的一部分。修复和重构应保留这些标识。

## 本地开发

在仓库根目录执行以下命令。插件分别保有自己的 npm 锁文件和依赖目录。尤其是 `ccusage-stats`，daemon 安装插件时会在该插件目录内查找 ccusage 的平台二进制。

```sh
npm ci
npm run install:all
npm run typecheck
npm test
npm run check:builds
npm run check:mobile
```

根目录脚本会发现每个插件的 manifest。构建检查比较已提交的公式插件入口与重新构建的结果；移动端检查验证网页专用代码的边界，并在模拟的 iOS 和 Android 环境调用公式插件入口。

以下命令使用锁定的 Paseo CLI，在临时 daemon 中安装并启动六个插件。GitHub Actions 的 **CI → Run workflow** 也能选用 npm 当前的 `latest` 进行同一检查。

```sh
npm ci --prefix scripts/host-smoke
npm run smoke:host
```

需要试用改动时，在隔离的 Paseo 主机中按绝对路径安装相应目录。修改已安装的本地源码后，可单独重新加载插件并查看状态。

```sh
paseo plugin reload tab-recovery
paseo plugin ls
paseo plugin logs tab-recovery
```

对公式插件的源码修改还需要在其目录执行 `npm run build`，同时提交重新生成的 `index.client.ts`。Git 安装直接加载这个入口。[构建说明](../plugins/paseo-latex-companion/README.md)

## 跟进新版 Paseo

1. 对照官方 GitHub 稳定版及 npm 的 `@getpaseo/cli`、`@getpaseo/plugin` 的 `latest`。区分实际验证的主机版本和每个 manifest 声明的最低版本。[官方 Release](https://github.com/getpaseo/paseo/releases/latest)
2. 检查该版本的插件 SDK、daemon 和 app 中与此次改动相关的 API。升级各受影响插件的开发依赖和锁文件。保留兼容路径的插件可继续声明较早的最低版本。
3. 跑通仓库检查，在独立 daemon 上从 Git 或本地目录安装候选版本。记录 CLI 和 app 版本，分别检查激活状态、实际操作结果、重新加载后的状态。仅观察到 `running` 时，记录为启动验证。
4. 记录复现条件、修复及实际验证过的平台。使用以下操作作为三个主要插件的回归入口。

| 插件 | 验证操作 |
| --- | --- |
| tab-recovery | 在隔离工作区归档一个可恢复的顶层 agent，从 **Closed agents** 重新打开，确认 agent 和工作区正确。重复点击时只应恢复一次。 |
| media-studio | 在 Media 面板打开一段本地素材并播放或定位；上传并重新下载一个跨分块大小的文件，比较原始内容。单独记录 SSH、硬件编码和原生端覆盖情况。 |
| file-download | 在网页文件预览中按保存快捷键，核对下载名和内容；在编辑器内检查正常保存。多主机连接要核对下载来自当前主机。 |

## 发布和回退

插件独立发布。在修改了运行时代码的插件里更新 `package.json` 版本及其锁文件根条目，并在仓库更新记录写明影响与验证范围。验证合并后的提交后，给该插件建立形如 `tab-recovery-v0.1.0` 的标签。Release 说明中写入安装命令、依赖和用户能观察到的变化。

下面以标签恢复为例。Git 的 `--ref` 可选择分支、标签或提交。安装时选择某个标签只影响这次选择；以后运行普通的 `update` 仍会检查远端默认分支。

```sh
paseo plugin install git:ms903/paseo-kit:plugins/tab-recovery --ref tab-recovery-v0.1.0
paseo plugin update tab-recovery --check
paseo plugin update tab-recovery --ref tab-recovery-v0.1.0
```

## 来源与历史

各插件目录包含入口、manifest、依赖和用户说明。历史审查与设计记录保存在同一仓库，记录中的版本和测试结论属于当时的发布。[早期修复](history/fixes.zh-CN.md) · [下载与标签恢复设计](history/file-download-and-tab-recovery.zh-CN.md) · [主机监控收录记录](history/host-monitor-registry.zh-CN.md)

Apache-2.0 原始声明和第三方许可证随源码保留。更新内置库或字体时，一并核对对应的许可证。[NOTICE](../NOTICE) · [公式插件依赖许可证](../plugins/paseo-latex-companion/licenses)
