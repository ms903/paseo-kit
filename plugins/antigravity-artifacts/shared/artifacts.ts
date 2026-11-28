import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const MAX_ARTIFACTS = 100;
export const MAX_DEPTH = 4;
export const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
const entityId = z.string().min(1).max(160);

export function isArtifactSegment(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !name.startsWith(".") &&
    !/[\\/\p{Cc}]/u.test(name) && name !== "node_modules";
}

export function isAntigravity(provider: string | null | undefined): boolean {
  return provider?.split("/")[0] === "antigravity";
}

export const artifactPath = z.string().max(1024).refine((value) => {
  const parts = value.split("/");
  return parts.length <= MAX_DEPTH && parts.every(isArtifactSegment);
});

const scope = z.object({ agentId: entityId, workspaceId: entityId });
const artifactRef = z.object({
  ownerAgentId: entityId,
  conversationId: uuid,
  path: artifactPath,
});
const artifact = artifactRef.extend({
  kind: z.enum(["image", "text", "file"]),
  ownerTitle: z.string().nullable(),
  bytes: z.number().int().nonnegative(),
  modifiedAt: z.number(),
});
export type Artifact = z.infer<typeof artifact>;

export const listArtifacts = defineRpc({
  name: "artifacts.list",
  input: scope,
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("unavailable") }),
    z.object({ status: z.literal("waiting") }),
    z.object({ status: z.literal("unsupported") }),
    z.object({ status: z.literal("ready"), conversationId: uuid, items: z.array(artifact).max(MAX_ARTIFACTS), limited: z.boolean() }),
  ]),
});

export const readArtifact = defineRpc({
  name: "artifacts.read",
  input: scope.extend({ rootConversationId: uuid, artifact: artifactRef }),
  output: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("image"), absolutePath: z.string(), dataUri: z.string() }),
    z.object({ kind: z.literal("text"), absolutePath: z.string(), text: z.string(), truncated: z.boolean() }),
    z.object({ kind: z.literal("file"), absolutePath: z.string() }),
    z.object({ kind: z.literal("tooLarge"), absolutePath: z.string() }),
  ]),
});
