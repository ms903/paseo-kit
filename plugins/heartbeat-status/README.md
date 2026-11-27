# Heartbeat Status

在 Paseo 中查看哪些 agent 仍有定时心跳。蓝色转圈继续表示正在执行的工作。心跳标识在两次触发之间也会显示，直到该 agent 和它的后代都没有启用中的心跳。

<picture>
  <source media="(prefers-reduced-motion: reduce)" srcset="preview/tabs.png">
  <img src="preview/tabs.gif" width="245" alt="只有带有定时心跳的评估与训练标签显示走动的小钟">
</picture>

[浅色界面](preview/light.png) · [深色界面](preview/dark.png)

## 安装

需要 Paseo 0.18.1 或更高版本。在 daemon 的 **Settings → Plugins** 启用插件，然后运行：

```sh
paseo plugin install git:ms903/paseo-kit:plugins/heartbeat-status
paseo plugin ls
```

## 查看心跳

- 在网页或桌面端，标签标题旁的小钟表示仍有启用中的定时心跳。表盘固定，长指针轻轻走动。空闲工作区的小钟显示在原来灰点的位置。开始执行时依然能看到 Paseo 的运行状态。将鼠标放在小钟上，可以查看本会话与子会话各自的心跳数。
- 指针表示心跳仍启用。实际触发时间由 Paseo 的心跳计划决定。系统开启“减少动态效果”时，指针保持静止。
- 插件约每 10 秒刷新一次。网页标记依赖 Paseo 的标签与工作区标识；在原生移动端或找不到对应位置时，使用 Paseo 的工作区徽标和会话输入区显示心跳。
- 例如 A 派生了 B，B 又派生了 C。只给 C 设置一个心跳，A、B、C 都会显示标识。取消 C 的心跳后，若没有其他启用中的心跳，这三个标识会在下次刷新时消失。
- 使用 Better Paseo 的 Tasks 看板时，可以点击卡片的 **Open tab** 查看对应标签。
- 只统计 Paseo 中针对现有 agent 的活动 heartbeat。创建新 agent 的定时任务、普通后台命令及网络连接保活均不计入。

插件只读取状态。心跳连同 agent 关系均来自所连接的 daemon；在多主机环境中，需在要查看的 daemon 上分别安装。已安装旧版本时，运行 `paseo plugin update heartbeat-status` 即可原地更新。
