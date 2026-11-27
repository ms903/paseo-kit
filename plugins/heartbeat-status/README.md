# Heartbeat Status

在 Paseo 中查看哪些 agent 仍有定时心跳。蓝色转圈继续表示正在执行的工作。心跳标识在两次触发之间也会显示，直到该 agent 和它的后代都没有启用中的心跳。

<picture>
  <source media="(prefers-reduced-motion: reduce)" srcset="preview/tabs.png">
  <img src="preview/tabs.gif" width="245" alt="只有带有定时心跳的评估与训练标签显示长指针连续转动的小钟">
</picture>

[浅色界面](preview/light.png) · [深色界面](preview/dark.png)

## 安装

需要 Paseo 0.18.1 或更高版本。在 daemon 的 **Settings → Plugins** 启用插件，然后运行：

```sh
paseo plugin install git:ms903/paseo-kit:plugins/heartbeat-status
paseo plugin ls
```

## 外观设置

打开 **设置 → 当前主机 → 插件 → Heartbeat Status**，可以选择青绿（默认）、蓝、紫或琥珀，也可以关闭指针动画。设置即时生效。默认的青绿在浅色主题使用 Teal 60，在深色主题使用 Teal 30。四组配色在 Paseo 的浅色和深色选中行上都达到 3∶1 的图标对比度。[IBM Design Language 色板](https://www.ibm.com/design/language/color/) · [W3C 非文本对比度](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)

## 查看心跳

- 在网页或桌面端，标签标题旁的小钟表示仍有启用中的定时心跳。表盘固定，长指针匀速连续扫过表盘。空闲工作区的小钟显示在原来灰点的位置。开始执行时依然能看到 Paseo 的运行状态。将鼠标放在小钟上，可以查看本会话与子会话各自的心跳数。
- 在原生手机端，空闲工作区有心跳时，小钟会显示在行首灰点的位置。运行、待输入和多选会使用原来的状态图标。布局无法识别时，标题下方会显示只有图标的徽章。
- 指针表示心跳仍启用。实际触发时间由 Paseo 的心跳计划决定。系统开启“减少动态效果”时，指针保持静止。
- 插件约每 10 秒刷新一次心跳。网页和原生侧栏适配都根据 Paseo 的行标识确认位置。原生会话仍可从输入区查看心跳详情。
- 例如 A 派生了 B，B 又派生了 C。只给 C 设置一个心跳，A、B、C 都会显示标识。取消 C 的心跳后，若没有其他启用中的心跳，这三个标识会在下次刷新时消失。
- 使用 Better Paseo 的 Tasks 看板时，可以点击卡片的 **Open tab** 查看对应标签。
- 只统计 Paseo 中针对现有 agent 的活动 heartbeat。创建新 agent 的定时任务、普通后台命令及网络连接保活均不计入。

插件只读取状态。心跳连同 agent 关系均来自所连接的 daemon；在多主机环境中，需在要查看的 daemon 上分别安装。已安装旧版本时，运行 `paseo plugin update heartbeat-status` 即可原地更新。
