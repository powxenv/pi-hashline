import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReadTool } from "./src/read/tool";
import { registerEditTool } from "./src/edit/tool";
import { registerWriteTool } from "./src/write/tool";
import { registerGrepTool } from "./src/grep/tool";
import { registerOutlineTool } from "./src/outline/tool";
import { registerLsTool } from "./src/ls/tool";
import { registerFindTool } from "./src/find/tool";
import { registerAstSearchTool } from "./src/ast-search/tool";
import { registerRtk } from "./src/rtk";

export default function (pi: ExtensionAPI): void {
  registerReadTool(pi);
  registerEditTool(pi);
  registerWriteTool(pi);
  registerGrepTool(pi);
  registerOutlineTool(pi);
  registerLsTool(pi);
  registerFindTool(pi);
  registerAstSearchTool(pi);
  registerRtk(pi);
}
