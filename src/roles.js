function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text || "";
      if (part?.type === "input_text") return part.text || "";
      if (part?.type === "image_url") return `[image_url:${part.image_url?.url || ""}]`;
      if (part?.type === "input_image") return `[input_image:${part.image_url || part.url || ""}]`;
      return `[${part?.type || "content"}:${JSON.stringify(part)}]`;
    })
    .join("\n");
}

function normalizeRole(role) {
  if (role === "system" || role === "developer" || role === "assistant" || role === "tool") {
    return role;
  }
  return "user";
}

export function applyLatencyHint(prompt, hintText) {
  if (!hintText || typeof hintText !== "string") return prompt;
  return [
    "<<<SYSTEM>>>\n" + hintText.trim() + "\n<<<END_SYSTEM>>>",
    "",
    prompt,
  ].join("\n");
}

export function formatMessagesAsStructuredPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages must be a non-empty array");
  }

  if (
    messages.length === 1 &&
    normalizeRole(messages[0]?.role) === "user" &&
    !messages[0]?.name &&
    !messages[0]?.tool_call_id
  ) {
    return contentToText(messages[0].content);
  }

  const header = [
    "OpenAI-compatible transcript. Priority: SYSTEM > DEVELOPER > TOOL > USER.",
    "Follow higher-priority instructions. Answer only as ASSISTANT.",
  ].join("\n");

  const blocks = messages.map((message) => {
    const role = normalizeRole(message.role);
    const label = role.toUpperCase();
    const suffix = message.name ? ` (${message.name})` : "";
    const tool = message.tool_call_id ? ` [tool_call_id=${message.tool_call_id}]` : "";
    return `<<<${label}${suffix}${tool}>>>\n${contentToText(message.content)}\n<<<END_${label}>>>`;
  });

  return [header, ...blocks, "<<<ASSISTANT>>>"].join("\n\n");
}
