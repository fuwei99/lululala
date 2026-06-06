import { randomUUID } from "node:crypto";

/**
 * Format standard OpenAI tools array into XML instructions for the system prompt.
 */
export function formatToolsToSystemPrompt(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  
  let toolsList = "";
  for (const t of tools) {
    if (t.type !== "function" || !t.function) continue;
    const name = t.function.name;
    const desc = t.function.description || "No description provided.";
    const params = JSON.stringify(t.function.parameters || {});
    toolsList += `#### Tool: \`${name}\`\nDescription: ${desc}\nParameters: ${params}\n\n`;
  }

  return [
    "### [CRITICAL] TOOL CALLING INSTRUCTIONS",
    "",
    "If you want to call a tool, you MUST output an XML block wrapped in <tool_call> and </tool_call> tags.",
    "DO NOT output any other XML tags except below or markdown tag (eg:```xml) for tool calls.",
    "",
    "IMPORTANT: For simple string parameters, place the raw text directly inside the tag (NO escape needed). However, if a parameter expects an Array or Object, you MUST output valid JSON format inside the tag.",
    "",
    "Format:",
    "<tool_call>",
    "  <tool name=\"tool_name\">",
    "    <arguments>",
    "      <arg_name>value</arg_name>",
    "    </arguments>",
    "  </tool>",
    "</tool_call>",
    "",
    "### AVAILABLE TOOLS",
    "",
    toolsList.trim()
  ].join("\n");
}

/**
 * Serializes standard tool calls from history back to the XML format.
 */
export function toolCallsToXml(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return "";
  let xml = "";
  for (const tc of toolCalls) {
    if (tc.type !== "function" || !tc.function) continue;
    const name = tc.function.name;
    let argsXml = "";
    try {
      const args = typeof tc.function.arguments === "string" 
        ? JSON.parse(tc.function.arguments) 
        : tc.function.arguments;
      if (args && typeof args === "object") {
        for (const [key, val] of Object.entries(args)) {
          if (val && (typeof val === "object" || Array.isArray(val))) {
            argsXml += `      <${key}>${JSON.stringify(val)}</${key}>\n`;
          } else {
            argsXml += `      <${key}>${val !== undefined ? val : ""}</${key}>\n`;
          }
        }
      }
    } catch (e) {
      argsXml += `      <raw_args>${tc.function.arguments}</raw_args>\n`;
    }
    xml += `<tool_call>\n  <tool name="${name}">\n    <arguments>\n${argsXml}    </arguments>\n  </tool>\n</tool_call>\n`;
  }
  return xml.trim();
}

/**
 * Preprocess history messages, converting JSON tool calls and responses into their XML equivalents.
 */
export function preprocessHistoryMessages(messages, isClaude) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((msg) => {
    let content = msg.content;
    if (content === null || content === undefined) {
      content = "";
    } else if (typeof content !== "string") {
      content = JSON.stringify(content);
    }
    
    // Convert tool calls in assistant message
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const xmlCalls = toolCallsToXml(msg.tool_calls);
      content = content ? `${content.trim()}\n\n${xmlCalls}` : xmlCalls;
    }
    
    // Convert tool response message
    if (msg.role === "tool") {
      const toolName = msg.name || "unknown_tool";
      content = `<tool_response name="${toolName}">\n  <result>${content.trim()}</result>\n</tool_response>`;
    }
    
    return {
      ...msg,
      role: (msg.role === "tool" && isClaude) ? "user" : msg.role,
      content,
    };
  });
}

/**
 * Inject tools instructions and schema into the conversation messages.
 */
export function injectToolsIntoMessages(messages, tools) {
  if (!Array.isArray(tools) || tools.length === 0) return messages;
  
  const toolsSystemPrompt = formatToolsToSystemPrompt(tools);
  
  // Find the first system/developer message
  const sysIndex = messages.findIndex(m => m.role === "system" || m.role === "developer");
  
  const newMessages = [...messages];
  if (sysIndex !== -1) {
    const originalContent = messages[sysIndex].content || "";
    newMessages[sysIndex] = {
      ...messages[sysIndex],
      content: `${originalContent}\n\n${toolsSystemPrompt}`.trim()
    };
  } else {
    newMessages.unshift({
      role: "system",
      content: toolsSystemPrompt
    });
  }
  return newMessages;
}

/**
 * Append the format reminder at the very end of the user prompt/messages to prevent format drift.
 */
export function appendToolCallReminder(messages, tools) {
  if (!Array.isArray(tools) || tools.length === 0 || messages.length === 0) return messages;
  
  const lastIndex = messages.length - 1;
  const lastMsg = messages[lastIndex];
  
  const reminder = [
    "",
    "[TOOLCALL_FORMAT_REMINDER]:",
    "<tool_call>",
    "  <tool name=\"tool_name\">",
    "    <arguments>",
    "      <param_name>value</param_name>",
    "    </arguments>",
    "  </tool>",
    "</tool_call>"
  ].join("\n");
  
  const newMessages = [...messages];
  newMessages[lastIndex] = {
    ...lastMsg,
    content: `${lastMsg.content || ""}\n${reminder}`.trim()
  };
  return newMessages;
}

/**
 * Single XML tool call parser with truncation/missing closing tags fallback.
 */
export function parseToolCallAny(text) {
  if (!text) return null;
  
  let name = null;
  const nameMatch1 = text.match(/<name>([\s\S]*?)<\/name>/i);
  if (nameMatch1) {
    name = nameMatch1[1].trim();
  } else {
    const nameMatch2 = text.match(/<(?:tool|tool_call)\s+name=["']([^"']+)["']/i);
    if (nameMatch2) {
      name = nameMatch2[1].trim();
    }
  }
  
  if (!name) return null;
  
  const args = {};
  const argsSection = text.match(/<arguments>([\s\S]*?)<\/arguments>/i);
  const contentToSearch = argsSection ? argsSection[1] : text;
  
  // Tag matcher with lookahead fallback for missing closing tags
  const tagPattern = /<([^>/\s]+)>([\s\S]*?)(?:<\/\1>|(?=<\/arguments>)|(?=<\/tool_call>)|(?=<\/tool>)|$)/gi;
  
  let match;
  tagPattern.lastIndex = 0;
  
  while ((match = tagPattern.exec(contentToSearch)) !== null) {
    const tag = match[1];
    const val = match[2];
    
    if (["name", "arguments", "tool_call", "tool"].includes(tag.toLowerCase())) {
      continue;
    }
    
    const valStripped = val.trim();
    if (
      (valStripped.startsWith("{") && valStripped.endsWith("}")) ||
      (valStripped.startsWith("[") && valStripped.endsWith("]"))
    ) {
      try {
        args[tag] = JSON.parse(valStripped);
      } catch (e) {
        args[tag] = valStripped;
      }
    } else {
      args[tag] = valStripped;
    }
  }
  
  return { name, arguments: args };
}

/**
 * Parse all tool calls present in the text content.
 */
export function parseAllToolCalls(text) {
  if (!text) return [];
  
  const toolCallBlocks = [];
  const regex = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const blockContent = match[1].trim();
    if (blockContent) {
      toolCallBlocks.push(blockContent);
    }
  }
  
  if (toolCallBlocks.length === 0) {
    if (/<tool\s+name=/i.test(text)) {
      toolCallBlocks.push(text);
    }
  }
  
  const results = [];
  for (const block of toolCallBlocks) {
    const parsed = parseToolCallAny(block);
    if (parsed) {
      results.push(parsed);
    }
  }
  
  return results;
}

/**
 * Strips XML tool call definitions from user-visible text content.
 */
export function stripToolCalls(text) {
  if (!text) return "";
  return text.replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, "").trim();
}

/**
 * Stateful XML to standard OpenAI Tool Call stream transformer.
 */
export class XmlToolCallStreamTransformer {
  constructor({ tools, onContent, onToolCall }) {
    this.tools = tools || [];
    this.onContent = onContent;
    this.onToolCall = onToolCall;
    
    this.buffer = "";
    this.inToolCall = false;
    this.toolCallId = null;
    this.toolName = null;
    this.emittedName = false;
    
    this.inArguments = false;
    this.emittedArgumentsStart = false;
    this.currentParam = null;
    this.currentParamType = "string";
    this.emittedParamName = false;
    this.emittedParamQuote = false;
    this.paramCount = 0;
    
    this.toolCallIndex = 0;
  }
  
  getParamType(toolName, paramName) {
    const tool = this.tools.find(t => t.function?.name === toolName);
    if (!tool) return "string";
    const params = tool.function?.parameters;
    if (!params || !params.properties) return "string";
    const prop = params.properties[paramName];
    if (!prop) return "string";
    return prop.type || "string";
  }

  write(chunk) {
    this.buffer += chunk;
    
    for (;;) {
      if (!this.inToolCall) {
        const idx = this.buffer.indexOf("<tool_call>");
        if (idx !== -1) {
          const before = this.buffer.slice(0, idx);
          if (before) this.onContent(before);
          
          this.inToolCall = true;
          this.toolCallId = `call_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
          this.buffer = this.buffer.slice(idx + "<tool_call>".length);
          continue;
        }
        
        if (this.buffer.length > 10) {
          let partialMatch = false;
          for (let i = 1; i < 11; i++) {
            const endSlice = this.buffer.slice(-i);
            if ("<tool_call>".startsWith(endSlice)) {
              const before = this.buffer.slice(0, this.buffer.length - i);
              if (before) this.onContent(before);
              this.buffer = endSlice;
              partialMatch = true;
              break;
            }
          }
          if (!partialMatch) {
            this.onContent(this.buffer);
            this.buffer = "";
          }
        }
        break;
      } else {
        const tagMatch = this.buffer.match(/<([^>]+)>/);
        if (!tagMatch) {
          if (this.inArguments && this.currentParam && this.emittedParamName) {
            const startIdx = this.buffer.indexOf("<");
            let textToEmit = "";
            if (startIdx !== -1) {
              textToEmit = this.buffer.slice(0, startIdx);
              this.buffer = this.buffer.slice(startIdx);
            } else {
              textToEmit = this.buffer;
              this.buffer = "";
            }
            
            if (textToEmit) {
              if (this.currentParamType === "string" && !this.emittedParamQuote) {
                this.onToolCall({
                  index: this.toolCallIndex,
                  id: this.toolCallId,
                  argumentsChunk: `"`
                });
                this.emittedParamQuote = true;
              }
              this.onToolCall({
                index: this.toolCallIndex,
                id: this.toolCallId,
                argumentsChunk: textToEmit
              });
            }
          }
          break;
        }
        
        const tagContent = tagMatch[1];
        const tagFull = tagMatch[0];
        const tagIndex = tagMatch.index;
        
        const textBeforeTag = this.buffer.slice(0, tagIndex);
        if (textBeforeTag && this.inArguments && this.currentParam && this.emittedParamName) {
          if (this.currentParamType === "string" && !this.emittedParamQuote) {
            this.onToolCall({
              index: this.toolCallIndex,
              id: this.toolCallId,
              argumentsChunk: `"`
            });
            this.emittedParamQuote = true;
          }
          this.onToolCall({
            index: this.toolCallIndex,
            id: this.toolCallId,
            argumentsChunk: textBeforeTag
          });
        }
        
        this.buffer = this.buffer.slice(tagIndex + tagFull.length);
        
        const isClosing = tagContent.startsWith("/");
        const tagName = (isClosing ? tagContent.slice(1) : tagContent.split(/\s+/)[0]).toLowerCase();
        
        if (!isClosing) {
          if (tagName === "tool") {
            const nameMatch = tagContent.match(/name=["']([^"']+)["']/i);
            if (nameMatch) {
              this.toolName = nameMatch[1];
              this.onToolCall({
                index: this.toolCallIndex,
                id: this.toolCallId,
                name: this.toolName
              });
              this.emittedName = true;
            }
          } else if (tagName === "name" && !this.emittedName) {
            this.currentParam = "name_tag";
          } else if (tagName === "arguments") {
            this.inArguments = true;
            this.onToolCall({
              index: this.toolCallIndex,
              id: this.toolCallId,
              argumentsChunk: "{"
            });
            this.emittedArgumentsStart = true;
          } else if (this.inArguments) {
            this.currentParam = tagContent;
            this.currentParamType = this.getParamType(this.toolName, this.currentParam);
            this.emittedParamName = false;
            this.emittedParamQuote = false;
            
            let prefix = this.paramCount > 0 ? ", " : "";
            prefix += `"${this.currentParam}": `;
            
            this.onToolCall({
              index: this.toolCallIndex,
              id: this.toolCallId,
              argumentsChunk: prefix
            });
            this.emittedParamName = true;
            this.paramCount++;
          }
        } else {
          if (tagName === "tool_call") {
            if (this.inArguments && this.emittedArgumentsStart) {
              this.onToolCall({
                index: this.toolCallIndex,
                id: this.toolCallId,
                argumentsChunk: "}"
              });
            }
            this.inToolCall = false;
            this.toolCallIndex++;
            this.toolName = null;
            this.emittedName = false;
            this.inArguments = false;
            this.emittedArgumentsStart = false;
            this.currentParam = null;
            this.paramCount = 0;
          } else if (tagName === "arguments") {
            if (this.emittedArgumentsStart) {
              this.onToolCall({
                index: this.toolCallIndex,
                id: this.toolCallId,
                argumentsChunk: "}"
              });
              this.emittedArgumentsStart = false;
            }
            this.inArguments = false;
          } else if (tagName === "tool") {
            // Do nothing
          } else if (this.inArguments && tagName === this.currentParam?.toLowerCase()) {
            if (this.currentParamType === "string" && this.emittedParamQuote) {
              this.onToolCall({
                index: this.toolCallIndex,
                id: this.toolCallId,
                argumentsChunk: `"`
              });
            }
            this.currentParam = null;
          } else if (tagName === "name" && this.currentParam === "name_tag") {
            if (textBeforeTag) {
              this.toolName = textBeforeTag.trim();
              this.onToolCall({
                index: this.toolCallIndex,
                id: this.toolCallId,
                name: this.toolName
              });
              this.emittedName = true;
            }
            this.currentParam = null;
          }
        }
      }
    }
  }
  
  flush() {
    if (this.inToolCall) {
      if (this.inArguments && this.currentParam && this.emittedParamName) {
        if (this.currentParamType === "string" && !this.emittedParamQuote) {
          this.onToolCall({
            index: this.toolCallIndex,
            id: this.toolCallId,
            argumentsChunk: `"`
          });
          this.emittedParamQuote = true;
        }
        if (this.buffer) {
          this.onToolCall({
            index: this.toolCallIndex,
            id: this.toolCallId,
            argumentsChunk: this.buffer
          });
        }
        if (this.currentParamType === "string" && this.emittedParamQuote) {
          this.onToolCall({
            index: this.toolCallIndex,
            id: this.toolCallId,
            argumentsChunk: `"`
          });
        }
      }
      if (this.emittedArgumentsStart) {
        this.onToolCall({
          index: this.toolCallIndex,
          id: this.toolCallId,
          argumentsChunk: "}"
        });
      }
    } else {
      if (this.buffer) {
        this.onContent(this.buffer);
      }
    }
    this.buffer = "";
  }
}
