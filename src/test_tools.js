import assert from "node:assert";
import {
  formatToolsToSystemPrompt,
  preprocessHistoryMessages,
  parseAllToolCalls,
  stripToolCalls,
  XmlToolCallStreamTransformer
} from "./tools.js";

// Test 1: formatToolsToSystemPrompt
function testFormatTools() {
  console.log("Running testFormatTools...");
  const tools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get current weather for a location",
        parameters: {
          type: "object",
          properties: {
            location: { type: "string" },
            unit: { type: "string", enum: ["celsius", "fahrenheit"] }
          },
          required: ["location"]
        }
      }
    }
  ];

  const prompt = formatToolsToSystemPrompt(tools);
  assert.ok(prompt.includes("get_weather"));
  assert.ok(prompt.includes("Get current weather for a location"));
  assert.ok(prompt.includes("<tool_call>"));
  console.log("testFormatTools passed!");
}

// Test 2: preprocessHistoryMessages
function testPreprocessHistory() {
  console.log("Running testPreprocessHistory...");
  const messages = [
    {
      role: "assistant",
      content: "Here is the weather:",
      tool_calls: [
        {
          id: "call_123",
          type: "function",
          function: {
            name: "get_weather",
            arguments: JSON.stringify({ location: "San Francisco", unit: "celsius" })
          }
        }
      ]
    },
    {
      role: "tool",
      name: "get_weather",
      content: "Cloudy, 18C"
    }
  ];

  const processedClaude = preprocessHistoryMessages(messages, true);
  // Role mapping check
  assert.strictEqual(processedClaude[0].role, "assistant");
  assert.strictEqual(processedClaude[1].role, "user"); // tool maps to user for Claude
  assert.ok(processedClaude[0].content.includes("<tool_call>"));
  assert.ok(processedClaude[0].content.includes("<location>San Francisco</location>"));
  assert.ok(processedClaude[1].content.includes("<tool_response name=\"get_weather\">"));

  const processedOther = preprocessHistoryMessages(messages, false);
  assert.strictEqual(processedOther[1].role, "tool"); // remains tool
  console.log("testPreprocessHistory passed!");
}

// Test 3: parseAllToolCalls and stripToolCalls
function testParsingAndStripping() {
  console.log("Running testParsingAndStripping...");
  const sample = `
Some conversational thoughts.
<tool_call>
  <tool name="get_weather">
    <arguments>
      <location>Paris</location>
      <unit>celsius</unit>
    </arguments>
  </tool>
</tool_call>
And some trailing thoughts.
  `;

  const calls = parseAllToolCalls(sample);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].name, "get_weather");
  assert.strictEqual(calls[0].arguments.location, "Paris");
  assert.strictEqual(calls[0].arguments.unit, "celsius");

  const stripped = stripToolCalls(sample);
  assert.ok(!stripped.includes("get_weather"));
  assert.ok(stripped.includes("Some conversational thoughts."));
  assert.ok(stripped.includes("And some trailing thoughts."));
  console.log("testParsingAndStripping passed!");
}

// Test 4: XmlToolCallStreamTransformer basic stream
async function testStreamTransformerBasic() {
  console.log("Running testStreamTransformerBasic...");
  const chunks = [
    "Hello! I will query the weather now.\n",
    "<tool_call>\n",
    "  <tool name=\"get_weather\">\n",
    "    <arguments>\n",
    "      <location>New York</location>\n",
    "      <unit>fahrenheit</unit>\n",
    "    </arguments>\n",
    "  </tool>\n",
    "</tool_call>\n",
    "Hope this helps!"
  ];

  const tools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        parameters: {
          type: "object",
          properties: {
            location: { type: "string" },
            unit: { type: "string" }
          }
        }
      }
    }
  ];

  let emittedContent = "";
  const emittedToolCalls = [];

  const transformer = new XmlToolCallStreamTransformer({
    tools,
    onContent: (text) => {
      emittedContent += text;
    },
    onToolCall: (tc) => {
      emittedToolCalls.push(tc);
    }
  });

  for (const chunk of chunks) {
    transformer.write(chunk);
  }
  transformer.flush();

  assert.strictEqual(emittedContent.trim(), "Hello! I will query the weather now.\n\nHope this helps!".trim());
  
  // Verify tool calls reconstruction
  const nameCall = emittedToolCalls.find(tc => tc.name !== undefined);
  assert.strictEqual(nameCall.name, "get_weather");

  const argsChunks = emittedToolCalls.filter(tc => tc.argumentsChunk !== undefined).map(tc => tc.argumentsChunk).join("");
  const parsedArgs = JSON.parse(argsChunks);
  assert.strictEqual(parsedArgs.location, "New York");
  assert.strictEqual(parsedArgs.unit, "fahrenheit");
  console.log("testStreamTransformerBasic passed!");
}

// Test 5: XmlToolCallStreamTransformer with unclosed tags (truncation fallback)
async function testStreamTransformerTruncation() {
  console.log("Running testStreamTransformerTruncation...");
  const chunks = [
    "Sure, let me check the temperature.\n",
    "<tool_call>\n",
    "  <tool name=\"get_weather\">\n",
    "    <arguments>\n",
    "      <location>London" // truncated here!
  ];

  const tools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        parameters: {
          type: "object",
          properties: {
            location: { type: "string" }
          }
        }
      }
    }
  ];

  let emittedContent = "";
  const emittedToolCalls = [];

  const transformer = new XmlToolCallStreamTransformer({
    tools,
    onContent: (text) => {
      emittedContent += text;
    },
    onToolCall: (tc) => {
      emittedToolCalls.push(tc);
    }
  });

  for (const chunk of chunks) {
    transformer.write(chunk);
  }
  transformer.flush();

  assert.strictEqual(emittedContent.trim(), "Sure, let me check the temperature.");
  const nameCall = emittedToolCalls.find(tc => tc.name !== undefined);
  assert.strictEqual(nameCall.name, "get_weather");

  const argsChunks = emittedToolCalls.filter(tc => tc.argumentsChunk !== undefined).map(tc => tc.argumentsChunk).join("");
  const parsedArgs = JSON.parse(argsChunks);
  assert.strictEqual(parsedArgs.location, "London");
  console.log("testStreamTransformerTruncation passed!");
}

// Test 6: XmlToolCallStreamTransformer with nested HTML/XML inside parameter
async function testStreamTransformerNestedTags() {
  console.log("Running testStreamTransformerNestedTags...");
  const chunks = [
    "<tool_call>\n",
    "  <tool name=\"write_file\">\n",
    "    <arguments>\n",
    "      <path>index.html</path>\n",
    "      <content><div>Hello &lt; World</div></content>\n",
    "    </arguments>\n",
    "  </tool>\n",
    "</tool_call>"
  ];

  const tools = [
    {
      type: "function",
      function: {
        name: "write_file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" }
          }
        }
      }
    }
  ];

  let emittedContent = "";
  const emittedToolCalls = [];

  const transformer = new XmlToolCallStreamTransformer({
    tools,
    onContent: (text) => {
      emittedContent += text;
    },
    onToolCall: (tc) => {
      emittedToolCalls.push(tc);
    }
  });

  for (const chunk of chunks) {
    transformer.write(chunk);
  }
  transformer.flush();

  const nameCall = emittedToolCalls.find(tc => tc.name !== undefined);
  assert.strictEqual(nameCall.name, "write_file");

  const argsChunks = emittedToolCalls.filter(tc => tc.argumentsChunk !== undefined).map(tc => tc.argumentsChunk).join("");
  const parsedArgs = JSON.parse(argsChunks);
  assert.strictEqual(parsedArgs.path, "index.html");
  assert.strictEqual(parsedArgs.content.trim(), "<div>Hello &lt; World</div>");
  console.log("testStreamTransformerNestedTags passed!");
}

async function runAll() {
  testFormatTools();
  testPreprocessHistory();
  testParsingAndStripping();
  await testStreamTransformerBasic();
  await testStreamTransformerTruncation();
  await testStreamTransformerNestedTags();
  console.log("All tests passed successfully!");
}

runAll().catch(e => {
  console.error("Test suite failed:", e);
  process.exitCode = 1;
});
