# 插件独立更新

直接从 `git:ms903/paseo-kit:plugins/<id>` 安装时，Paseo 比较安装提交和仓库默认分支的最新提交。因此只发一个插件时，其他 Git 安装也可能出现更新提示。`paseo plugin update <id> --ref <该插件的发布标签>` 可以单独升级指定插件。在 Kit 注册表安装后，Paseo 则比较该插件条目所指向的正式发布提交。[Paseo 插件来源说明](https://github.com/getpaseo/paseo/blob/v0.18.1/docs/plugins.md#install-from-a-registry)

## 在 Ubuntu daemon 上使用

以下用法在 Paseo 0.18.1 上验证。Kit 注册表地址为 `https://raw.githubusercontent.com/ms903/paseo-kit/plugin-registry`。

在启动目标 daemon 的环境中设置 `PASEO_PLUGIN_REGISTRY`，然后在空闲时重启该 daemon。使用 systemd 时，把变量加到实际启动该 daemon 的服务。使用 Paseo CLI 管理 daemon 时，可以这样启动默认实例。

```sh
paseo daemon stop
PASEO_PLUGIN_REGISTRY=https://raw.githubusercontent.com/ms903/paseo-kit/plugin-registry paseo daemon start
```

在 Paseo 的插件浏览页确认能找到 Kit 的发布条目。新安装从该目录选择插件，或在同一台 daemon 上运行对应的命令。

```sh
paseo plugin add ms903/ccusage-stats
paseo plugin update ccusage-stats --check
```

注册表安装会记住完整的目录地址。装完需要的 Kit 插件后，可以移除 `PASEO_PLUGIN_REGISTRY` 并重启 daemon，恢复官方目录的浏览入口。已经通过 Kit 注册表安装的插件仍从 Kit 获取各自的更新。

## 迁移已安装的插件

Paseo 0.18.1 要求先移除同 ID 的旧来源才能换来源，`plugin remove` 也会删除该插件的 daemon 设置。建议每次迁移一个插件，并先备份 `$PASEO_HOME/plugin-settings/<id>`。默认数据目录是 `~/.paseo`。用 `paseo plugin ls --json` 记下该插件的来源和 `installation.currentRevision`，以便按原提交回退。

确认已启用上面的 Kit 注册表后，可用下面的方式迁移 Token Usage。`kit_daemon_dir` 应指向实际在用的 daemon 数据目录。

```sh
(
  set -e
  kit_plugin=ccusage-stats
  kit_daemon_dir="${PASEO_HOME:-$HOME/.paseo}"
  kit_backup="$(mktemp -d)"
  if [ -d "$kit_daemon_dir/plugin-settings/$kit_plugin" ]; then
    cp -a "$kit_daemon_dir/plugin-settings/$kit_plugin" "$kit_backup/"
  fi
  printf '插件设置备份目录 %s\n' "$kit_backup"
  paseo plugin remove "$kit_plugin" --home "$kit_daemon_dir"
  if [ -d "$kit_backup/$kit_plugin" ]; then
    mkdir -p "$kit_daemon_dir/plugin-settings"
    cp -a "$kit_backup/$kit_plugin" "$kit_daemon_dir/plugin-settings/"
  fi
  paseo plugin add "ms903/$kit_plugin" --home "$kit_daemon_dir"
  paseo plugin update "$kit_plugin" --check --home "$kit_daemon_dir"
)
```

新安装默认启用。原来停用的插件可用 `paseo plugin disable <id>` 恢复停用状态。如果安装失败，可用 `paseo plugin install git:ms903/paseo-kit:plugins/<id> --ref <旧提交>` 回到原 Git 安装。通过 `paseo plugin ls --json` 确认 `installation.identity.registry` 指向 Kit 后，日常在 App 的插件页更新即可。

## 维护发布目录

照常在 `main` 合并代码，为要发布的插件创建对应的 GitHub Release，例如 `ccusage-stats-v0.2.0`。**Publish plugin registry** 工作流从各插件最新的正式 Release 生成目录，并将完整目录写入 `plugin-registry` 分支。单纯向 `main` 合并代码时，已发布的条目仍指向各自的 Release。

工作流也可手动运行。需要回退时，可把回退代码作为该插件的新修订版本发布。这样已有安装会通过同一个注册表条目看到更新。
