import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReadTool } from "./src/read/tool";
import { registerEditTool } from "./src/edit/tool";
import { registerWriteTool } from "./src/write/tool";
import { registerGrepTool } from "./src/grep/tool";
import { registerRtk } from "./src/rtk";

export default function (pi: ExtensionAPI): void {
  registerReadTool(pi);
  registerEditTool(pi);
  registerWriteTool(pi);
  registerGrepTool(pi);
  registerRtk(pi);
}
