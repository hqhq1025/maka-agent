import type { MakaTool } from '@maka/runtime';

/**
 * The Computer Use tools a given turn may see.
 *
 * Two reasons to withhold them, and they are different in kind. A model without
 * vision cannot read the screenshots every observation returns, so offering it
 * the tools wastes a turn. A user who has not turned Computer Use on has not
 * agreed to Maka reading their screen and pressing their buttons at all.
 *
 * Gating here rather than at dispatch is deliberate: the surface is assembled
 * per turn, so the switch takes effect on the next message with no restart, and
 * a model that cannot see a tool does not try to use it and does not have to be
 * told no.
 */
export function computerUseToolsForModel(
  tools: readonly MakaTool[],
  computerUseTools: readonly MakaTool[],
  supportsVision: boolean,
  enabled = true,
): MakaTool[] {
  if ((supportsVision && enabled) || computerUseTools.length === 0) return [...tools];
  const computerUseToolNames = new Set(computerUseTools.map((tool) => tool.name));
  return tools.filter((tool) => !computerUseToolNames.has(tool.name));
}
