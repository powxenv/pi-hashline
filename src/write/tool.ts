import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { normalizeToLF } from "../hashline/diff";
import { formatHashlineReadPreview } from "../read/tool";
import { resolveToCwd } from "../shared/paths";
import { throwIfAborted } from "../shared/runtime";
import { getFileSnapshot } from "../shared/snapshot";
import { writeFileAtomically } from "../shared/fs-write";

const WRITE_PROMPT_SNIPPET = "Write a UTF-8 text file and return fresh hashline anchors";

const WRITE_PROMPT_GUIDELINES = [
  "Use write for new files or complete rewrites.",
  "Use the returned anchors for immediate follow-up edits in the same file.",
];

export function registerWriteTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "write",
    label: "Write",
    description: "Create or overwrite a UTF-8 text file. Parent directories are created automatically. The result returns fresh LINE#HASH anchors for follow-up edits.",
    promptSnippet: WRITE_PROMPT_SNIPPET,
    promptGuidelines: WRITE_PROMPT_GUIDELINES,
    parameters: Type.Object(
      {
        path: Type.String({ description: "Path to write" }),
        content: Type.String({ description: "Complete file content" }),
      },
      { additionalProperties: false },
    ),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal);
      const absolutePath = resolveToCwd(params.path, ctx.cwd);
      const normalized = normalizeToLF(params.content);
      await writeFileAtomically(absolutePath, normalized);
      const snapshot = await getFileSnapshot(absolutePath);
      const preview = formatHashlineReadPreview(normalized, { continuation: false });

      return {
        content: [{ type: "text", text: preview.text }],
        details: {
          snapshotId: snapshot.snapshotId,
          truncation: preview.truncation,
        },
      };
    },
  });
}
