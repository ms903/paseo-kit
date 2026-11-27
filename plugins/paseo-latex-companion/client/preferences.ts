export const scales = ["100", "110", "125", "150"] as const;
type Scale = typeof scales[number];
export interface Preferences { scale: Scale; tables: boolean }
export const defaults: Preferences = { scale: "100", tables: true };

export function parsePreferences(raw: string | null): Preferences {
  try {
    const value = raw && JSON.parse(raw);
    return {
      scale: scales.includes(value?.scale) ? value.scale : defaults.scale,
      tables: typeof value?.tables === "boolean" ? value.tables : defaults.tables,
    };
  } catch {
    return defaults;
  }
}

export interface Companion {
  read(): Preferences;
  subscribe(listener: () => void): () => void;
  update(patch: Partial<Preferences>): void;
  stop(): void;
}
