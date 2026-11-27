import { useComposers, type PluginComposer } from "@getpaseo/plugin/client";

export type ReadAgentComposer = (agentId: string) => PluginComposer | undefined;

const supportsComposerFocus = typeof useComposers === "function";
const useFocusedComposer = supportsComposerFocus
  ? () => useComposers({ focused: true })[0]
  : () => undefined;

export function useFocusedAgentComposer(
  agentId: string,
  readAgentComposer: ReadAgentComposer | undefined,
  legacyPopover = false,
): boolean {
  // Paseo keeps hidden tabs mounted. The focused and named selectors share the
  // same cached composer snapshot; only the focused one needs a subscription.
  const focused = useFocusedComposer();
  return supportsComposerFocus ? focused !== undefined && focused === readAgentComposer?.(agentId) : legacyPopover;
}
