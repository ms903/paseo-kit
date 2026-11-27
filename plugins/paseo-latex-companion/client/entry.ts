import { Platform } from "react-native";

export default function contribute(): () => void {
  if (Platform.OS !== "web" || typeof document === "undefined") return () => {};
  // The web bundle is evaluated only in a browser. Native clients connected
  // to this daemon do not need a DOM or a compatible browser regex engine.
  return startWebCompanion(document);
}

declare function startWebCompanion(document: Document): () => void;
