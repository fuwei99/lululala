const live = process.argv.includes("--live");
const base = process.env.LMARENA_BRIDGE_URL || "http://127.0.0.1:8787";

async function main() {
  const health = await fetch(`${base}/health`).then((r) => r.json());
  console.log("health", health);

  const models = await fetch(`${base}/v1/models?hidden=1`).then((r) => r.json());
  console.log("hidden model count", models.data?.length);
  console.log("first hidden model", models.data?.[0]);

  if (!live) return;

  const body = {
    model: "openaiResponses/gpt-5.5",
    messages: [
      { role: "system", content: "Reply exactly BRIDGE_SMOKE_OK." },
      { role: "user", content: "Confirm." },
    ],
  };
  const completion = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());
  console.log(JSON.stringify(completion, null, 2));

  const streamBody = {
    ...body,
    stream: true,
    messages: [
      { role: "system", content: "Reply exactly BRIDGE_STREAM_OK." },
      { role: "user", content: "Confirm." },
    ],
  };
  const streamResponse = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(streamBody),
  });
  let streamText = "";
  const decoder = new TextDecoder();
  for await (const chunk of streamResponse.body) {
    streamText += decoder.decode(chunk, { stream: true });
  }
  console.log(
    JSON.stringify(
      {
        streamStatus: streamResponse.status,
        streamContentType: streamResponse.headers.get("content-type"),
        containsSentinel: streamText.includes("BRIDGE_STREAM_OK"),
        containsDone: streamText.includes("[DONE]"),
        preview: streamText.split(/\n/).filter(Boolean).slice(0, 8),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
