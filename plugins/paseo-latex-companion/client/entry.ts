import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createElement } from "react";
import { Platform } from "react-native";
import type { Companion } from "./preferences";
import { FormulaSettings } from "./preferences-screen";

export default function contribute(client: PluginClientContext): () => void {
  if (Platform.OS !== "web" || typeof document === "undefined") return () => {};
  const companion = startWebCompanion(document);
  const isChinese = () => client.i18n?.locale?.startsWith("zh") ?? false;
  const unregister = client.addSettingsScreen({
    id: "formulas", icon: "Sigma", title: isChinese() ? "公式显示" : "Formula display",
    Component: () => createElement(FormulaSettings, { companion, chinese: isChinese() }),
  });
  return () => { unregister(); companion.stop(); };
}

declare function startWebCompanion(document: Document): Companion;
