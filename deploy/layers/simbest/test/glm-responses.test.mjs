import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  chatToResponse,
  createGatewayServer,
  inferToutiaoPlan,
  normalizeToutiaoResponse,
  normalizeToutiaoPlan,
  parseTextToolCall,
  planToutiaoRequest,
  responsesToChat,
  routedToutiaoCall,
  toutiaoCommandFromPlan,
  toutiaoResultFromInput,
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

test("adds the Toutiao result contract only to explicit retrieval conversations", () => {
  const toutiao = responsesToChat(
    {
      input: [
        { role: "user", content: [{ type: "input_text", text: "抓取今日头条娱乐新闻并总结" }] },
        { type: "function_call_output", call_id: "call_1", output: "{}" },
      ],
      tools: [{ type: "function", name: "execute", parameters: { type: "object", properties: {} } }],
    },
    "glm-5.2",
  );
  assert.match(toutiao.messages[0].content, /结构化结果 JSON/);
  assert.match(toutiao.messages[0].content, /publication time/);
  assert.match(toutiao.messages[0].content, /Do not invent/);

  const writing = responsesToChat({ input: "帮我起草一份请假申请" }, "glm-5.2");
  assert.doesNotMatch(writing.messages[0].content, /结构化结果 JSON/);
});

test("binds the summary contract to the executed retrieval scope", () => {
  const result = {
    site: "今日头条",
    request: {
      mode: "top",
      topics: [],
      channels: [],
      query: null,
      timeRange: "today",
      sortBy: "importance",
      limit: 8,
    },
    categories: [],
  };
  const chat = responsesToChat(
    {
      input: [
        { role: "user", content: "读取一下今日头条，今天都有什么重要新闻" },
        { type: "function_call_output", call_id: "call_1", output: JSON.stringify(result) },
      ],
      tools: [{ type: "function", name: "execute", parameters: { type: "object", properties: {} } }],
    },
    "glm-5.2",
  );
  assert.match(chat.messages[0].content, /broad top-news request with no requested topic/);
  assert.match(chat.messages[0].content, /never claim they requested or care about a topic/);
});

test("converts textual GLM function markup to a native tool call", () => {
  const call = parseTextToolCall(
    '准备执行。<function_calls><invoke name="execute"><parameter name="command">toutiao-fetch --topic "地缘政治"</parameter></invoke></function_calls>',
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
    command: 'toutiao-fetch --topic "地缘政治"',
    purpose: "Complete the user's requested task with the configured tool.",
  });
});

test("infers top, topic, channel, and search plans without adding demonstration topics", () => {
  assert.deepEqual(inferToutiaoPlan("读取一下今日头条，今天都有什么重要新闻"), {
    mode: "top",
    topics: [],
    channels: [],
    query: null,
    timeRange: "today",
    sortBy: "importance",
    limit: 8,
  });
  assert.deepEqual(inferToutiaoPlan("总结今日头条最近三天的科技和财经新闻"), {
    mode: "topic",
    topics: ["科技", "财经"],
    channels: [],
    query: null,
    timeRange: "3d",
    sortBy: "importance",
    limit: 5,
  });
  assert.equal(inferToutiaoPlan("看看今日头条娱乐频道最近有什么新闻").mode, "channel");
  assert.deepEqual(inferToutiaoPlan("搜索今日头条中关于雷军的近期报道"), {
    mode: "search",
    topics: [],
    channels: [],
    query: "雷军",
    timeRange: "7d",
    sortBy: "importance",
    limit: 5,
  });
  const normalized = normalizeToutiaoPlan(
    {
      mode: "topic",
      topics: ["地缘政治", "娱乐八卦"],
      channels: [],
      query: null,
      timeRange: "7d",
      sortBy: "latest",
      limit: 10,
    },
    "总结今日头条最近三天的科技和财经新闻",
  );
  assert.deepEqual(normalized.topics, ["科技", "财经"]);
  assert.equal(normalized.timeRange, "3d");
  assert.equal(normalized.sortBy, "importance");
  assert.equal(
    normalizeToutiaoPlan({ mode: "search", query: "iPhone", limit: 1 }, "搜索今日头条中关于iPhone的近期报道").limit,
    5,
  );
});

test("accepts a valid model plan and falls back when planning fails", async (t) => {
  const requests = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                '```json\n{"mode":"search","topics":[],"channels":[],"query":"雷军","timeRange":"7d","sortBy":"importance","limit":6}\n```',
            },
          },
        ],
      }),
    );
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());
  const config = {
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    upstreamModel: "glm-5.2",
    apiKey: "test-key",
    timeoutMs: 5000,
    plannerTimeoutMs: 5000,
  };
  const planned = await planToutiaoRequest(config, "搜索今日头条中关于雷军的近期报道，给我6条");
  assert.equal(planned.mode, "search");
  assert.equal(planned.query, "雷军");
  assert.equal(planned.limit, 6);
  assert.match(requests[0].messages[0].content, /do not add demonstration topics/i);

  const failed = await planToutiaoRequest(
    { ...config, upstreamBaseUrl: "http://127.0.0.1:1", plannerTimeoutMs: 1000 },
    "读取一下今日头条，今天都有什么重要新闻",
  );
  assert.equal(failed.mode, "top");
  assert.deepEqual(failed.topics, []);
});

test("builds shell-safe commands from validated plans", () => {
  const command = toutiaoCommandFromPlan({
    mode: "search",
    topics: [],
    channels: [],
    query: "雷军'; echo hacked #",
    timeRange: "7d",
    sortBy: "importance",
    limit: 5,
  });
  assert.equal(
    command,
    `toutiao-fetch --mode search --query '雷军'"'"'; echo hacked #' --time-range 7d --sort-by importance --limit 5`,
  );
});

test("routes only explicit Toutiao retrieval requests to validated fetch commands", () => {
  const tools = [
    {
      type: "function",
      name: "execute",
      parameters: { type: "object", properties: {} },
    },
  ];
  const call = routedToutiaoCall({
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "帮我抓取一下今日头条，总结地缘政治和娱乐八卦新闻" }],
      },
    ],
    tools,
  });
  assert.equal(call.name, "execute");
  const args = JSON.parse(call.arguments);
  assert.match(args.command, /--mode topic/);
  assert.match(args.command, /--topic '地缘政治'/);
  assert.match(args.command, /--topic '娱乐八卦'/);
  const top = routedToutiaoCall({ input: "读取一下今日头条，今天都有什么重要新闻", tools });
  assert.match(JSON.parse(top.arguments).command, /--mode top/);
  assert.doesNotMatch(JSON.parse(top.arguments).command, /地缘政治|娱乐八卦/);
  assert.equal(routedToutiaoCall({ input: "抓取今日头条新闻", tools })?.name, "execute");
  assert.equal(routedToutiaoCall({ input: "抓取今日头条新闻" }), null);
  assert.equal(routedToutiaoCall({ input: "帮我起草一份请假申请", tools }), null);
  assert.equal(
    routedToutiaoCall({
      instructions: "You write a short title for a chat conversation. Output ONLY the title.",
      input: "用户说：读取一下今日头条，今天都有什么重要新闻",
      tools,
    }),
    null,
  );
  assert.equal(
    routedToutiaoCall({
      input: [
        { role: "user", content: "抓取今日头条新闻" },
        { type: "function_call_output", call_id: "call_1", output: "{}" },
      ],
      tools,
    }),
    null,
  );
});

test("rebuilds a valid structured Toutiao result and removes unsupported scheduling offers", () => {
  const result = {
    site: "今日头条",
    categories: [
      {
        category: "娱乐八卦",
        items: [
          {
            category: "娱乐八卦",
            title: '助理"反水"爆料',
            source: "示例来源",
            publishedAt: "2026-08-05T01:00:00.000Z",
            url: "https://www.toutiao.com/article/1/",
            contentExcerpt: '前助理称艺人要求"陪泡"，相关方尚未回应。',
          },
        ],
      },
    ],
  };
  const input = [
    {
      type: "function_call_output",
      call_id: "call_1",
      output: `${JSON.stringify(result)}\n\n[exit 0]`,
    },
  ];
  assert.deepEqual(toutiaoResultFromInput(input), result);
  const normalized = normalizeToutiaoResponse(
    `## 娱乐八卦\n\n**助理"反水"爆料**\n- **摘要**：模型生成的可靠摘要。\n- **来源**：示例来源\n- **链接**：https://www.toutiao.com/article/1/\n\n### 结构化结果\n\n\`\`\`json\n{"broken":"quote " here"}\n\`\`\`\n\n需要我每天定时推送吗？`,
    result,
  );
  assert.doesNotMatch(normalized, /定时推送/);
  assert.equal(normalized.match(/```json/g)?.length, 1);
  const json = normalized.match(/```json\n([\s\S]*?)\n```/u)?.[1];
  assert.ok(json);
  assert.deepEqual(JSON.parse(json), [
    {
      category: "娱乐八卦",
      title: '助理"反水"爆料',
      source: "示例来源",
      publishedAt: "2026-08-05T01:00:00.000Z",
      url: "https://www.toutiao.com/article/1/",
      summary: "模型生成的可靠摘要。",
    },
  ]);
});

test("does not reuse a Toutiao result from an earlier user turn", () => {
  const result = {
    site: "今日头条",
    request: { mode: "topic", topics: ["娱乐"], channels: [], query: null },
    categories: [{ category: "娱乐", items: [] }],
  };
  const currentTurn = [
    { role: "user", content: "抓取今日头条娱乐新闻" },
    { type: "function_call", call_id: "call_1", name: "execute", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: JSON.stringify(result) },
  ];
  assert.deepEqual(toutiaoResultFromInput(currentTurn), result);

  const laterTurn = [
    ...currentTurn,
    { role: "assistant", content: "娱乐新闻摘要" },
    { role: "user", content: "帮我起草一份请假申请" },
  ];
  assert.equal(toutiaoResultFromInput(laterTurn), null);
  const chat = responsesToChat(
    {
      input: laterTurn,
      tools: [{ type: "function", name: "execute", parameters: { type: "object", properties: {} } }],
    },
    "glm-5.2",
  );
  assert.doesNotMatch(chat.messages[0].content, /结构化结果 JSON/);
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

test("turns streamed textual tool markup into a Responses function call", async (t) => {
  const upstream = createServer(async (req, res) => {
    for await (const _ of req) void 0;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      'data: {"choices":[{"delta":{"content":"准备执行。<function_calls><invoke name=\\"execute\\"><parameter name=\\"command\\">toutiao-fetch --topic 地缘政治</parameter></invoke></function_calls>"}}]}\n\n',
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
      stream: true,
      tools: [
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
    }),
  });
  const events = await response.text();
  assert.match(events, /response\.function_call_arguments\.done/);
  assert.match(events, /toutiao-fetch --topic/);
  assert.doesNotMatch(events, /response\.output_text\.delta/);
});
