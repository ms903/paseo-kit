import type { PluginTheme } from "@getpaseo/plugin";
import { defineTranslations, useTranslation } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { SwatchDot } from "./charts";
import { agentSeriesKey, agentSwatch } from "./data";
import { agentLabel } from "./format";
import { FONT } from "./summary";

type HoverState = PressableStateCallbackType & { hovered?: boolean };

const en = {
  allAgents: "All agents",
  filter: "Filter report by agent, {{agent}}",
  clear: "Clear agent filter",
  group: "Report agent",
};
const translations = typeof defineTranslations === "function" && typeof useTranslation === "function"
  ? defineTranslations({ resources: { en, "zh-CN": {
    allAgents: "全部 Agent",
    filter: "按 Agent 筛选报表，当前为 {{agent}}",
    clear: "清除 Agent 筛选",
    group: "报表 Agent",
  } } }) : null;
const useFilterLabel: () => (key: keyof typeof en, options?: { agent: string }) => string = translations
  ? () => useTranslation(translations).t
  : () => (key, options) => en[key].replace("{{agent}}", options?.agent ?? "");

export function AgentFilterButton({ theme, agent, open, toggle, clear }: {
  theme: PluginTheme;
  agent: string | null;
  open: boolean;
  toggle(): void;
  clear(): void;
}) {
  const t = useFilterLabel();
  const label = agent === null ? t("allAgents") : agentLabel(agent);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "100%" }}>
      <Pressable
        testID="usage-agent-filter"
        accessibilityRole="button"
        accessibilityLabel={t("filter", { agent: label })}
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        onPress={toggle}
        style={({ hovered, pressed }: HoverState) => ({
          flexDirection: "row", alignItems: "center", gap: 7, minHeight: 44, minWidth: 0, flexShrink: 1,
          paddingHorizontal: 10, borderRadius: 7, borderWidth: 1, borderColor: theme.colors.border,
          backgroundColor: agent !== null || hovered || pressed ? theme.colors.surface2 : theme.colors.surface1,
        })}
      >
        <Icon name="Filter" size={14} color={theme.colors.foregroundMuted} />
        <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: FONT.body, color: theme.colors.foreground }}>{label}</Text>
        <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
      </Pressable>
      {agent !== null ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t("clear")} onPress={clear}
          style={({ hovered, pressed }: HoverState) => ({
            minWidth: 44, minHeight: 44, borderRadius: 7, alignItems: "center", justifyContent: "center",
            backgroundColor: hovered || pressed ? theme.colors.surface2 : undefined,
          })}>
          <Icon name="X" size={15} color={theme.colors.foregroundMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

export function AgentFilterOptions({ theme, options, order, agent, onSelect }: {
  theme: PluginTheme;
  options: readonly string[];
  order: readonly string[];
  agent: string | null;
  onSelect(agent: string | null): void;
}) {
  const t = useFilterLabel();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={t("group")} style={{
      flexDirection: "row", flexWrap: "wrap", gap: 6, padding: 8, borderRadius: 8, borderWidth: 1,
      borderColor: theme.colors.border, backgroundColor: theme.colors.surface1,
    }}>
      {[null, ...options].map((option) => {
        const checked = agent === option;
        const label = option === null ? t("allAgents") : agentLabel(option);
        return (
          <Pressable key={agentSeriesKey(option)} accessibilityRole="radio" accessibilityState={{ checked }} aria-checked={checked}
            accessibilityLabel={label} onPress={() => onSelect(option)}
            style={({ hovered, pressed }: HoverState) => ({
              flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, minWidth: 44, maxWidth: "100%",
              paddingHorizontal: 9, borderRadius: 6, borderWidth: 1,
              borderColor: checked ? theme.colors.accent : theme.colors.border,
              backgroundColor: checked || hovered || pressed ? theme.colors.surface2 : theme.colors.surface0,
            })}>
            {option === null ? null : <SwatchDot swatch={agentSwatch(theme, order, option)} />}
            <Text style={{ flexShrink: 1, fontSize: FONT.body, color: theme.colors.foreground, fontWeight: checked ? "600" : "400" }}>
              {label}
            </Text>
            {checked ? <Icon name="Check" size={13} color={theme.colors.foreground} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}
