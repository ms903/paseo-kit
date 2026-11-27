interface NativeProps {
  testID?: string;
  style?: unknown;
}

/** Narrow adapter for the Fabric views in Paseo's 0.18 sidebar. */
export interface NativeElement {
  readonly parentElement?: NativeElement | null;
  readonly firstElementChild?: NativeElement | null;
  readonly nextElementSibling?: NativeElement | null;
  readonly __internalInstanceHandle?: { stateNode?: { canonical?: { currentProps?: NativeProps } } };
  getBoundingClientRect?(): { x: number; y: number; width: number; height: number };
  setNativeProps?(props: { style: { opacity: number } }): void;
}

function props(element: NativeElement | null | undefined) {
  return element?.__internalInstanceHandle?.stateNode?.canonical?.currentProps;
}

export type SidebarPlacement =
  | { kind: "idle"; slot: NativeElement; dot: NativeElement; style: unknown; x: number; y: number }
  | { kind: "busy" | "unsupported" };

export function locateSidebarDot(anchor: NativeElement | null, rowId: string, size: number): SidebarPlacement {
  const ancestors: NativeElement[] = [];
  for (let entry = anchor?.parentElement; entry && ancestors.length < 12; entry = entry.parentElement) {
    if (props(entry)?.testID === rowId) {
      const slot = ancestors.map((node) => node.firstElementChild)
        .find((node) => props(node)?.testID === "workspace-status-indicator-done");
      if (!slot) return { kind: "busy" };
      const dot = slot.firstElementChild;
      const style = props(dot)?.style;
      const origin = anchor?.getBoundingClientRect?.();
      const bounds = slot.getBoundingClientRect?.();
      if (dot && !dot.nextElementSibling && typeof dot.setNativeProps === "function" && style &&
          origin && bounds && bounds.width >= size && bounds.width <= 50 && bounds.height >= size) {
        const x = bounds.x - origin.x + (bounds.width - size) / 2;
        const y = bounds.y - origin.y + (bounds.height - size) / 2;
        if (Math.abs(x) < 75 && Math.abs(y) < 55) return { kind: "idle", slot, dot, style, x, y };
      }
      return { kind: "unsupported" };
    }
    const id = props(entry)?.testID;
    if (id?.startsWith("sidebar-workspace-row-")) break;
    ancestors.push(entry);
  }
  return { kind: "unsupported" };
}

/** Restore the actual previous opacity, and only if this is still the idle dot. */
export function temporarilyHideDot(placement: Extract<SidebarPlacement, { kind: "idle" }>, opacity: number) {
  const { slot, dot } = placement;
  const isIdleDot = () => props(slot)?.testID === "workspace-status-indicator-done" && slot.firstElementChild === dot;
  if (!isIdleDot()) return undefined;
  dot.setNativeProps!({ style: { opacity: 0 } });
  return () => {
    if (isIdleDot()) dot.setNativeProps!({ style: { opacity } });
  };
}

export function coversIdleDot(placement: Extract<SidebarPlacement, { kind: "idle" }>, marker: NativeElement | null) {
  const bounds = placement.slot.getBoundingClientRect?.();
  const clock = marker?.getBoundingClientRect?.();
  if (!bounds || !clock || bounds.width <= 0 || bounds.height <= 0 || clock.width <= 0 || clock.height <= 0) return false;
  return Math.abs(clock.x + clock.width / 2 - bounds.x - bounds.width / 2) < 1.5 &&
    Math.abs(clock.y + clock.height / 2 - bounds.y - bounds.height / 2) < 1.5;
}
