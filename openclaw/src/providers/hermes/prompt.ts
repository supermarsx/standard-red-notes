import type { ToolDescriptor } from "../types.js";

/**
 * Renders the canonical Nous-Hermes function-calling system block.
 *
 * Hermes 2 Pro / Hermes 3 models do NOT use the native OpenAI/Ollama `tools`
 * parameter. Instead the available tools are injected into the system prompt
 * inside `<tools>...</tools>` as a JSON array, and the model is instructed to
 * emit calls as text wrapped in `<tool_call>...</tool_call>`.
 *
 * The caller's `baseSystem` is preserved and composed with the function-calling
 * contract. When there are no tools, the base system is returned unchanged.
 */
export function buildHermesSystemPrompt(
  baseSystem: string,
  tools: ToolDescriptor[],
): string {
  if (tools.length === 0) {
    return baseSystem;
  }

  const toolJson = tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));

  // Pretty-printed so the model sees a clean schema; Hermes training data
  // uses indented JSON inside the <tools> block.
  const rendered = JSON.stringify(toolJson, null, 2);

  const block = [
    "You are a function-calling AI model. You are provided with function",
    "signatures inside <tools></tools> XML tags. You may call one or more",
    "functions to assist with the user query. Don't make assumptions about what",
    "values to plug into functions. Here are the available tools:",
    "<tools>",
    rendered,
    "</tools>",
    "",
    "For each function call return a JSON object with the function name and",
    "arguments within <tool_call></tool_call> XML tags as follows:",
    '<tool_call>{"name": <function-name>, "arguments": <args-dict>}</tool_call>',
  ].join("\n");

  const trimmedBase = baseSystem.trim();
  return trimmedBase ? `${trimmedBase}\n\n${block}` : block;
}
