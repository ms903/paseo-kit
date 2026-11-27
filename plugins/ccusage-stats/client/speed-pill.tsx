import { useSettings, type PluginButtonIconProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef } from "react";
import { CCUSAGE_SETTINGS } from "../shared/settings";
import { useFocusedAgentComposer, type ReadAgentComposer } from "./composer-focus";
import { observedPause } from "./live-speed-display";
import { formatRate } from "./speed-format";
import { useSpeedMessages } from "./speed-messages";
import { useLiveSpeed, type TurnSpeedRuntime } from "./turn-speed";

type Basis = "live" | "decode" | "whole-turn";
export type SpeedPillLabel = { label: string; detail: string };
export type PublishSpeed = (mount: object, value?: SpeedPillLabel) => void;

type IconProps = Pick<PluginButtonIconProps, "size" | "color"> & {
  agentId: string;
  readAgentComposer: ReadAgentComposer;
  turnSpeed: TurnSpeedRuntime;
  publish: PublishSpeed;
};

export function UsagePillIcon(props: IconProps) {
  const settings = useSettings(CCUSAGE_SETTINGS);
  if (settings.status !== "ready" || !settings.values.showSessionSpeed) {
    return <Icon name="Coins" size={props.size} color={props.color} />;
  }
  return <FocusedIcon {...props} basis={settings.values.speedPillBasis} windowSeconds={settings.values.speedWindowSeconds} />;
}

type ObservedIconProps = IconProps & {
  basis: Basis;
  windowSeconds: number;
};

function FocusedIcon(props: ObservedIconProps) {
  const focused = useFocusedAgentComposer(props.agentId, props.readAgentComposer);
  return focused
    ? <ObservedIcon {...props} />
    : <Icon name="Coins" size={props.size} color={props.color} />;
}

function ObservedIcon({ agentId, turnSpeed, basis, windowSeconds, publish, size, color }: ObservedIconProps) {
  const { t, locale } = useSpeedMessages();
  const mount = useRef({}).current;
  const view = useLiveSpeed({ runtime: turnSpeed, agentId, windowSeconds });
  const pause = observedPause(view);
  let label: string | undefined;
  let detail: string | undefined;
  if (view?.phase === "running") {
    const { summary } = view;
    // A recent rate expires while generation is parked. Use the observed decode rate
    // for that paused state and identify its basis in the pill's tooltip.
    const actualBasis = basis === "live" && pause ? "decode" : basis;
    const rate = actualBasis === "live" ? view.liveTokPerSec
      : actualBasis === "decode" ? summary.tokPerSecDecode
      : summary.partial ? null : summary.tokPerSecTurn;
    if (rate !== null && Number.isFinite(rate) && rate > 0) {
      label = t("shortRate", { value: `${actualBasis === "live" || summary.approx ? "≈" : ""}${formatRate(rate, locale)}` });
      const basisLabel = actualBasis === "live" ? "liveBasis" : actualBasis === "decode" ? "decodeBasis" : "adjustedTurn";
      detail = `${label} · ${t(basisLabel)}${pause ? ` · ${t(pause)}` : ""}`;
    } else if (pause) {
      label = t("paused");
      detail = t(pause);
    }
  }
  useEffect(() => { publish(mount, label && detail ? { label, detail } : undefined); }, [mount, publish, label, detail]);
  useEffect(() => () => publish(mount), [mount, publish]);
  return <Icon name={pause ? "Pause" : label ? "Zap" : "Coins"} size={size} color={color} />;
}
