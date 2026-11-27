import type { PluginIconProps } from "@getpaseo/plugin";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { coversIdleDot, locateSidebarDot, temporarilyHideDot, type NativeElement, type SidebarPlacement } from "./native-placement";

const SIZE = 12;
const anchorStyle: ViewStyle = { position: "absolute", left: 0, top: 0, width: 1, height: 1 };

export function NativeWorkspaceClock({ rowId, Icon, label, fallback }: {
  rowId: string;
  Icon: ComponentType<PluginIconProps>;
  label: string;
  fallback: ReactNode;
}) {
  const anchor = useRef<View>(null);
  const marker = useRef<View>(null);
  const [placement, setPlacement] = useState<SidebarPlacement>();
  useEffect(() => {
    function refresh() {
      let next: SidebarPlacement;
      try {
        next = locateSidebarDot(anchor.current as unknown as NativeElement | null, rowId, SIZE);
      } catch {
        next = { kind: "unsupported" };
      }
      setPlacement((old) => {
        if (old?.kind !== next.kind) return next;
        if (old.kind !== "idle" || next.kind !== "idle") return old;
        return old.dot === next.dot && Math.abs(old.x - next.x) < 0.5 && Math.abs(old.y - next.y) < 0.5 ? old : next;
      });
    }
    refresh();
    const timer = setInterval(refresh, 300);
    return () => clearInterval(timer);
  }, [rowId]);

  const [unavailable, setUnavailable] = useState(false);
  const dot = placement?.kind === "idle" ? placement : undefined;
  useLayoutEffect(() => {
    const current = dot;
    if (!current) return;
    try {
      const opacity = StyleSheet.flatten(current.style as ViewStyle)?.opacity;
      // A native build with different row styles uses the ordinary badge.
      if (typeof opacity !== "number" || opacity <= 0 || opacity >= 1) {
        setUnavailable(true);
        return;
      }
      setUnavailable(false);
      let restore: (() => void) | undefined;
      let attempts = 0;
      const timer = setInterval(() => {
        try {
          if (coversIdleDot(current, marker.current as unknown as NativeElement | null)) {
            restore = temporarilyHideDot(current, opacity);
          }
        } catch {
          // The host is transitioning, or its renderer does not support measurement.
        }
        if (restore) clearInterval(timer);
        else if (++attempts >= 6) {
          clearInterval(timer);
          setUnavailable(true);
        }
      }, 100);
      return () => {
        clearInterval(timer);
        try { restore?.(); } catch { /* The native node was removed. */ }
      };
    } catch {
      setUnavailable(true);
    }
  }, [dot?.slot, dot?.dot, dot?.style, dot?.x, dot?.y]);

  return <>
    <View ref={anchor} collapsable={false} style={anchorStyle} pointerEvents="none">
      {dot && !unavailable ? <View ref={marker} collapsable={false}
        accessible accessibilityRole="image" accessibilityLabel={label}
        pointerEvents="none" testID="paseo-heartbeat-native-sidebar-clock"
        style={{ position: "absolute", left: 0, top: 0, transform: [{ translateX: dot.x }, { translateY: dot.y }] }}
      >
        <Icon size={SIZE} color="" />
      </View> : null}
    </View>
    {placement?.kind === "unsupported" || (dot && unavailable) ? fallback : null}
  </>;
}
