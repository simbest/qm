import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  chatToResponse,
  createGatewayServer,
  parseTextToolCall,
  responsesToChat,
} from "../plugins/glm-responses/server.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

test("converts Responses messages, tools, and tool outputs to Chat Completions", () => {
  const chat = responsesToChat(
    {
      instructions: "Use tools.",
      input: [
        { role: "user", content: [{ type: "input_text", text: "Fetch news" }] },
        { type: "function_call", call_id: "call_1", name: "execute", arguments: '{"cmd":"fetch"}' },
        { type: "function_call_output", call_id: "call_1", output: "done" },
      ],
      tools: [
        {
          type: "function",
          name: "execute",
          description: "Run a command",
          parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
          strict: false,
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
      stream: true,
    },
    "glm-5.2",
  );
  assert.match(chat.messages[0].content, /^Use tools\./);
  assert.deepEqual(chat.messages.slice(1), [
    { role: "user", content: "Fetch news" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "execute", arguments: '{"cmd":"fetch"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "done" },
  ]);
  assert.equal(chat.tools[0].function.name, "execute");
  assert.equal(chat.stream_options.include_usage, true);
  assert.match(chat.messages[0].content, /native function-calling interface/);
});

test("converts textual GLM function markup to a native tool call", () => {
  const call = parseTextToolCall(
    '准备执行。<function_calls><invoke name="execute"><parameter name="command">baidu-hotlist --limit 5</parameter></invoke></function_calls>',
    [
      {
        type: "function",
        name: "execute",
        parameters: {
          type: "object",
          required: ["command", "purpose"],
          properties: { command: { type: "string" }, purpose: { type: "string" } },
        },
      },
    ],
  );
  assert.equal(call.name, "execute");
  assert.deepEqual(JSON.parse(call.arguments), {
    command: "baidu-hotlist --limit 5",
    purpose: "Complete the user's requested task with the configured tool.",
  });
});

test("converts a non-streaming Chat Completion tool call to a Response", () => {
  const response = chatToResponse(
    {
      id: "chat_1",
      choices: [
        {
          message: {
            content: "",
            tool_calls: [{ id: "call_9", type: "function", function: { name: "execute", arguments: '{"cmd":"x"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    },
    "gpt-5.6-sol",
  );
  assert.equal(response.model, "gpt-5.6-sol");
  assert.deepEqual(response.output[0], {
    id: response.output[0].id,
    call_id: "call_9",
    type: "function_call",
    name: "execute",
    arguments: '{"cmd":"x"}',
    status: "completed",
  });
  assert.equal(response.usage.total_tokens, 13);
});

test("relays streaming text as Responses SSE events", async (t) => {
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.model, "glm-5.2");
    assert.equal(body.stream, true);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"，世界"}}]}\n\n');
    res.write('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}\n\n');
    res.end("data: [DONE]\n\n");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const gateway = createGatewayServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    upstreamModel: "glm-5.2",
    apiKey: "test-key",
    timeoutMs: 5000,
    maxBodyBytes: 100000,
  });
  const gatewayPort = await listen(gateway);
  t.after(() => gateway.close());

  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "say hello", stream: true }),
  });
  assert.equal(response.status, 200);
  const events = await response.text();
  assert.match(events, /response\.created/);
  assert.match(events, /response\.output_text\.delta/);
  assert.match(events, /你好/);
  assert.match(events, /response\.completed/);
  assert.match(events, /"total_tokens":9/);
});

test("relays streaming tool calls with stable call ids", async (t) => {
  const upstream = createServer(async (req, res) => {
    for await (const _ of req) void 0;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_real","function":{"name":"execute","arguments":"{\\\"cmd\\\":"}}]}}]}\n\n',
    );
    res.write(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\\"fetch\\\"}"}}]}}]}\n\n',
    );
    res.end("data: [DONE]\n\n");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());
  const gateway = createGatewayServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    upstreamModel: "glm-5.2",
    apiKey: "test-key",
    timeoutMs: 5000,
    maxBodyBytes: 100000,
  });
  const gatewayPort = await listen(gateway);
  t.after(() => gateway.close());

  const response = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input: "fetch",
      tools: [{ type: "function", name: "execute", parameters: { type: "object", properties: {} } }],
      stream: true,
    }),
  });
  const events = await response.text();
  assert.match(events, /response\.function_call_arguments\.delta/);
  assert.match(events, /"call_id":"call_real"/);
  assert.match(events, /"arguments":"\{\\"cmd\\":\\"fetch\\"\}"/);
  assert.match(events, /response\.completed/);
});
