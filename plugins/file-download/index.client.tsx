import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createHostCheck, downloadFile, downloadFocusedFile, NOT_A_FILE } from "./client/downloads";
import { createHistoryPanel } from "./client/history-panel";
import { DownloadSettingsScreen } from "./client/settings-screen";
import { watchSaveShortcut } from "./client/shortcut-settings";
import { NoticeHost } from "./client/notice-host";
import { listenForSaveShortcut, readFocusedTab } from "./client/web";

export default function contribute(client: PluginClientContext) {
  const ownsServer = createHostCheck(client.rpc);
  client.addSettingsScreen({ id: "downloads", title: "Downloads", icon: "Download", Component: DownloadSettingsScreen });

  client.addCommandCenterItem({
    id: "download-current-file",
    title: "Download current file",
    icon: "Download",
    keywords: ["download", "save", "file", "export"],
    context: "workspace",
    onSelect({ workspace, rpc }) {
      const focused = readFocusedTab();
      // Paseo shows a thrown error as a toast.
      if (!focused?.filePath || focused.workspaceId !== workspace.id ||
          (workspace.hostId && focused.serverId !== workspace.hostId)) throw new Error(NOT_A_FILE);
      void downloadFile(rpc, workspace.id, focused.filePath);
    },
  });
  client.addCommandCenterItem({
    id: "open-downloads",
    title: "Open downloads",
    icon: "FolderDown",
    keywords: ["download", "history", "files"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("downloads");
    },
  });
  client.addWorkspacePanel({
    id: "downloads",
    title: "Downloads",
    icon: "FolderDown",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: createHistoryPanel(client.rpc),
  });
  client.addSidebarFooterItem({ id: "notices", title: "Download notices", Component: NoticeHost });

  return watchSaveShortcut(client, () => listenForSaveShortcut((event) => {
    if (downloadFocusedFile(client.rpc, ownsServer)) event.preventDefault();
  }));
}
