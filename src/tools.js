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
    "### [CRITICAL] TOOL CALLING PROTOCOL",
    "",
    "If you decide to call one or more tools, you MUST wrap all tool calls inside a single `<tool_calls>` and `</tool_calls>` block.",
    "You can make multiple tool calls (parallel calling) by listing multiple `<invoke>` blocks sequentially inside this single container.",
    "",
    "CRITICAL RULES:",
    "1. Once you output the closing `</tool_calls>` tag, you MUST immediately STOP generating any further text, explanations, or conversational responses. Do not write anything after </tool_calls>.",
    "2. If you need to make multiple tool calls, they MUST be grouped together inside a SINGLE `<tool_calls>` block. DO NOT output multiple separate `<tool_calls>` blocks.",
    "3. DO NOT output any conversational text or explanation inside the `<tool_calls>` block, or between individual `<invoke>` blocks.",
    "4. For simple string parameters, place the raw text directly inside the `<parameter>` tag and set `string=\"true\"`. For all other types (numbers, booleans, arrays, objects), pass the value in JSON format and set `string=\"false\"`.",
    "",
    "Format:",
    "<tool_calls>",
    "  <invoke name=\"tool_name_1\">",
    "    <parameter name=\"param_name_1\" string=\"true\">value_1</parameter>",
    "  </invoke>",
    "  <invoke name=\"tool_name_2\">",
    "    <parameter name=\"param_name_a\" string=\"false\">[\"item_1\", \"item_2\"]</parameter>",
    "  </invoke>",
    "</tool_calls>",
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
  let xml = "<tool_calls>\n";
  for (const tc of toolCalls) {
    if (tc.type !== "function" || !tc.function) continue;
    const name = tc.function.name;
    xml += `  <invoke name="${name}">\n`;
    try {
      const args = typeof tc.function.arguments === "string" 
        ? JSON.parse(tc.function.arguments) 
        : tc.function.arguments;
      if (args && typeof args === "object") {
        for (const [key, val] of Object.entries(args)) {
          if (typeof val === "string") {
            xml += `    <parameter name="${key}" string="true">${val}</parameter>\n`;
          } else {
            xml += `    <parameter name="${key}" string="false">${JSON.stringify(val)}</parameter>\n`;
          }
        }
      }
    } catch (e) {
      xml += `    <!-- Error parsing arguments, outputting raw: -->\n`;
      xml += `    <parameter name="raw_arguments" string="true">${tc.function.arguments}</parameter>\n`;
    }
    xml += `  </invoke>\n`;
  }
  xml += "</tool_calls>";
  return xml;
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
    "<tool_calls>",
    "  <invoke name=\"tool_name\">",
    "    <parameter name=\"param_name\" string=\"true\">value</parameter>",
    "  </invoke>",
    "</tool_calls>"
  ].join("\n");
  
  const newMessages = [...messages];
  newMessages[lastIndex] = {
    ...lastMsg,
    content: `${lastMsg.content || ""}\n${reminder}`.trim()
  };
  return newMessages;
}

/**
 * Parse XML tool calls in `<tool_calls>` format.
 * Matches `<invoke name="...">...</invoke>` and `<parameter name="..." string="true|false">...</parameter>`
 * using robust regex with positive lookaheads for missing closing tags.
 */
export function parseXmlToolCalls(text) {
  if (!text) return [];
  const results = [];
  
  const invokePattern = /<invoke\s+name=["']([^"']+)["']\s*\/?>([\s\S]*?)(?:<\/invoke>|(?=<invoke\s+name=)|(?=<\/tool_calls>)|$)/gi;
  const paramPattern = /<parameter\s+name=["']([^"']+)["']\s+string=["'](true|false)["']\s*\/?>([\s\S]*?)(?:<\/parameter>|(?=<parameter\s+name=)|(?=<invoke\s+name=)|(?=<\/tool_calls>)|$)/gi;

  let invokeMatch;
  invokePattern.lastIndex = 0;

  while ((invokeMatch = invokePattern.exec(text)) !== null) {
    const name = invokeMatch[1].trim();
    const isSelfClosing = invokeMatch[0].trim().endsWith("/>");
    const invokeContent = isSelfClosing ? "" : invokeMatch[2];
    
    const args = {};
    let paramMatch;
    paramPattern.lastIndex = 0;
    
    while ((paramMatch = paramPattern.exec(invokeContent)) !== null) {
      const pName = paramMatch[1].trim();
      const isString = paramMatch[2].toLowerCase() === "true";
      const isParamSelfClosing = paramMatch[0].trim().endsWith("/>");
      const pVal = isParamSelfClosing ? "" : paramMatch[3].trim();
      
      if (isString) {
        args[pName] = pVal;
      } else {
        try {
          args[pName] = JSON.parse(pVal);
        } catch (e) {
          if (pVal === "true") args[pName] = true;
          else if (pVal === "false") args[pName] = false;
          else if (!isNaN(pVal) && pVal !== "") args[pName] = Number(pVal);
          else args[pName] = pVal;
        }
      }
    }
    
    if (name) {
      results.push({ name, arguments: args });
    }
  }
  
  return results;
}

export function parseToolCallAny(text) {
  const parsed = parseXmlToolCalls(text);
  return parsed.length > 0 ? parsed[0] : null;
}

export function parseAllToolCalls(text) {
  if (!text) return [];
  const containerMatch = /<tool_calls>([\s\S]*?)<\/tool_calls>/i.exec(text);
  if (!containerMatch && /<tool_calls>/i.test(text)) return [];
  const contentToSearch = containerMatch ? containerMatch[1] : text;
  return parseXmlToolCalls(contentToSearch);
}

export function hasUnclosedToolCalls(text) {
  if (!text) return false;
  const lowerText = String(text).toLowerCase();
  const startIdx = lowerText.lastIndexOf("<tool_calls>");
  if (startIdx === -1) return false;
  const endIdx = lowerText.indexOf("</tool_calls>", startIdx);
  return endIdx === -1;
}

/**
 * Strips XML tool call definitions from user-visible text content.
 */
export function stripToolCalls(text) {
  if (!text) return "";
  return text.replace(/<tool_calls>[\s\S]*?(?:<\/tool_calls>|$)/gi, "").trim();
}

/**
 * Stateful XML to standard OpenAI Tool Call stream transformer.
 * Implements stream interception, buffering, and auto-truncation on end tag.
 */
export class XmlToolCallStreamTransformer {
  constructor({ tools, onContent, onToolCall }) {
    this.tools = tools || [];
    this.onContent = onContent;
    this.onToolCall = onToolCall;
    
    this.buffer = "";
    this.inToolCalls = false;
    this.toolCallsBuffer = "";
    this.toolCallsParsed = false;
    this.toolCallIndex = 0;
  }
  
  write(chunk) {
    if (this.toolCallsParsed) {
      return;
    }
    
    if (!this.inToolCalls) {
      this.buffer += chunk;
      
      const idx = this.buffer.indexOf("<tool_calls>");
      if (idx !== -1) {
        const before = this.buffer.slice(0, idx);
        if (before) this.onContent(before);
        
        this.inToolCalls = true;
        this.toolCallsBuffer = this.buffer.slice(idx + "<tool_calls>".length);
        this.buffer = "";
      } else {
        if (this.buffer.length > 12) {
          let partialMatch = false;
          for (let i = 1; i < 12; i++) {
            const endSlice = this.buffer.slice(-i);
            if ("<tool_calls>".startsWith(endSlice)) {
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
      }
    } else {
      this.toolCallsBuffer += chunk;
      
      const endIdx = this.toolCallsBuffer.indexOf("</tool_calls>");
      if (endIdx !== -1) {
        const xmlContent = this.toolCallsBuffer.slice(0, endIdx);
        this.parseAndEmit(xmlContent);
        
        this.inToolCalls = false;
        this.toolCallsParsed = true;
        this.toolCallsBuffer = "";
      }
    }
  }
  
  parseAndEmit(xmlContent) {
    const parsedCalls = parseXmlToolCalls(xmlContent);
    for (const call of parsedCalls) {
      const toolCallId = `call_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      this.onToolCall({
        index: this.toolCallIndex,
        id: toolCallId,
        name: call.name,
      });
      this.onToolCall({
        index: this.toolCallIndex,
        id: toolCallId,
        argumentsChunk: JSON.stringify(call.arguments),
      });
      this.toolCallIndex++;
    }
  }

  hasUnclosedToolCalls() {
    return this.inToolCalls;
  }
  
  flush() {
    if (this.toolCallsParsed) {
      return;
    }
    
    if (this.inToolCalls) {
      return;
    } else {
      if (this.buffer) {
        this.onContent(this.buffer);
      }
    }
    this.buffer = "";
  }
}
