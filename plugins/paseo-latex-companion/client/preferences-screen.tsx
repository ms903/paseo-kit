import { SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useSyncExternalStore } from "react";
import { scales, type Companion } from "./preferences";

export function FormulaSettings({ companion, chinese }: { companion: Companion; chinese: boolean }) {
  const values = useSyncExternalStore(companion.subscribe, companion.read, companion.read);
  return (
    <SettingsSection title={chinese ? "此客户端的公式显示" : "Formula display on this client"}>
      <SettingsCard>
        <SettingsSelect label={chinese ? "公式字号" : "Formula size"} value={values.scale}
          options={scales.map(value => ({ value, label: value + "%" }))}
          onValueChange={scale => companion.update({ scale })} />
        <SettingsSwitch label={chinese ? "排版表格中的公式" : "Typeset formulas in tables"} value={values.tables}
          onValueChange={tables => companion.update({ tables })} />
      </SettingsCard>
    </SettingsSection>
  );
}
