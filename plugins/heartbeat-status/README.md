# Heartbeat Status

在 Paseo 中查看哪些 agent 仍有定时心跳。蓝色转圈继续表示正在执行的工作。心跳标识在两次触发之间也会显示，直到该 agent 和它的后代都没有启用中的心跳。

## 安装

需要 Paseo 0.18.1 或更高版本。在 daemon 的 **Settings → Plugins** 启用插件，然后运行：

```sh
paseo plugin install git:ms903/paseo-kit:plugins/heartbeat-status
paseo plugin ls
```

## 查看心跳

- 在网页或桌面端，打开的 agent 标签上会多一个心跳图标，工作区侧栏的状态点旁也会显示图标。这样即使 agent 空闲、蓝圈停转，仍能看出它在等待下一次心跳。
- 插件约每 10 秒刷新一次。网页标记依赖 Paseo 的标签与工作区标识；在原生移动端或找不到对应位置时，使用 Paseo 的工作区徽标和会话输入区显示心跳。
- 例如 A 派生了 B，B 又派生了 C。只给 C 设置一个心跳，A、B、C 都会显示标识。取消 C 的心跳后，若没有其他启用中的心跳，这三个标识会在下次刷新时消失。
- 使用 Better Paseo 的 Tasks 看板时，可以点击卡片的 **Open tab** 查看对应标签。
- 只统计 Paseo 中针对现有 agent 的活动 heartbeat。创建新 agent 的定时任务、普通后台命令及网络连接保活均不计入。

插件只读取状态。心跳连同 agent 关系均来自所连接的 daemon；在多主机环境中，需在要查看的 daemon 上分别安装。后续使用 `paseo plugin update heartbeat-status` 更新。
