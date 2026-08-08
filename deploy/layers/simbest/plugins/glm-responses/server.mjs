import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const TOOL_PROTOCOL_INSTRUCTION =
  "Use the provided native function-calling interface whenever a tool is needed. Never write XML, pseudo tool calls, function-call markup, or examples such as <function_calls>, <invoke>, <function_exec>, or <execute> into assistant text. Call the function directly and wait for its result.";

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (["input_text", "output_text", "text"].includes(part.type))
        return typeof part.text === "string" ? part.text : "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function responseInputToMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  const messages = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: String(item.call_id ?? item.id ?? `call_${randomUUID()}`),
            type: "function",
            function: {
              name: String(item.name ?? ""),
              arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
            },
          },
        ],
      });
      continue;
    }
    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: String(item.call_id ?? ""),
        content: textOfContent(item.output) || JSON.stringify(item.output ?? ""),
      });
      continue;
    }
    if (item.type === "reasoning") continue;
    const role = item.role === "developer" ? "system" : item.role;
    if (!["system", "user", "assistant", "tool"].includes(role)) continue;
    const message = { role, content: textOfContent(item.content) };
    if (role === "tool" && item.call_id) message.tool_call_id = String(item.call_id);
    messages.push(message);
  }
  return messages;
}

function responsesToolsToChat(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (!tool || tool.type !== "function" || typeof tool.name !== "string") return [];
    return [
      {
        type: "function",
        function: {
          name: tool.name,
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          parameters:
            tool.parameters && typeof tool.parameters === "object"
              ? tool.parameters
              : { type: "object", properties: {} },
          ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
        },
      },
    ];
  });
}

function responseToolChoiceToChat(choice) {
  if (choice === undefined || choice === null) return undefined;
  if (["auto", "none", "required"].includes(choice)) return choice;
  if (typeof choice === "object" && choice.type === "function" && typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

// Map OpenAI Responses `reasoning.effort` (pi 传来的思考档位) to GLM's `thinking` param.
// ⚠️ 实测 pi 默认(auto)发 effort="medium"(pi-ai 在 thinkingLevel 未明确时的 fallback, 带
// summary:"auto")—— 故 medium 必须归 disabled, 否则默认就开思考(首字 20s+)。只有用户在 UI
// 🧠 菜单显式选 High/XHigh/Max (pi 发 high/xhigh/max) 才开深度思考。GLM thinking 仅二档。
function mapThinkingFromEffort(effort) {
  const e = typeof effort === "string" ? effort.toLowerCase() : "";
  return { type: ["high", "xhigh", "max"].includes(e) ? "enabled" : "disabled" };
}

export function responsesToChat(body, upstreamModel) {
  const messages = responseInputToMessages(body.input);
  const tools = responsesToolsToChat(body.tools);
  const instructions = [
    typeof body.instructions === "string" ? body.instructions.trim() : "",
    tools.length ? TOOL_PROTOCOL_INSTRUCTION : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (instructions) messages.unshift({ role: "system", content: instructions });
  const toolChoice = responseToolChoiceToChat(body.tool_choice);
  return {
    model: upstreamModel,
    messages,
    ...(tools.length ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(typeof body.parallel_tool_calls === "boolean" ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
    ...(Number.isFinite(body.max_output_tokens) ? { max_tokens: body.max_output_tokens } : {}),
    // effort 映射: pi 把思考档位放进 body.reasoning.effort (见 mapThinkingFromEffort)。
    // GLM-5.2 默认深度思考首字 20s+; 默认 auto→"none"→disabled (首字~0.7s 逐字流);
    // UI 选 Medium+ → enabled (深思). 原生 function calling 不受影响 (已验证)。
    thinking: mapThinkingFromEffort(body.reasoning?.effort),
    stream: body.stream === true,
    ...(body.stream === true ? { stream_options: { include_usage: true } } : {}),
  };
}

function decodeXml(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function toolDefinitions(tools) {
  return new Map(
    (Array.isArray(tools) ? tools : [])
      .filter((tool) => tool && tool.type === "function" && typeof tool.name === "string")
      .map((tool) => [tool.name, tool]),
  );
}

function parsedParameters(body) {
  const parameters = {};
  const pattern = /<parameter\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>/gi;
  for (const match of body.matchAll(pattern)) parameters[match[1]] = decodeXml(match[2].trim());
  return parameters;
}

function completeRequiredArguments(name, args, tool) {
  const required = Array.isArray(tool?.parameters?.required) ? tool.parameters.required : [];
  if (name === "execute" && required.includes("purpose") && !args.purpose) {
    args.purpose = "Complete the user's requested task with the configured tool.";
  }
  return args;
}

export function parseTextToolCall(text, tools) {
  if (typeof text !== "string" || !text) return null;
  const definitions = toolDefinitions(tools);
  if (!definitions.size) return null;
  const starts = [text.lastIndexOf("<function_calls>"), text.lastIndexOf("<function_exec>")];
  const start = Math.max(...starts);
  const candidate = start >= 0 ? text.slice(start) : text;
  const matches = [];
  for (const match of candidate.matchAll(/<invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/invoke>/gi)) {
    matches.push({ name: match[1], body: match[2] });
  }
  for (const match of candidate.matchAll(
    /<(?!invoke|parameter|function_calls|function_exec)([a-zA-Z][\w-]*)\s*>([\s\S]*?)<\/\1>/gi,
  )) {
    matches.push({ name: match[1], body: match[2] });
  }
  for (let index = matches.length - 1; index >= 0; index--) {
    const match = matches[index];
    const tool = definitions.get(match.name);
    if (!tool) continue;
    const args = completeRequiredArguments(match.name, parsedParameters(match.body), tool);
    return { name: match.name, arguments: JSON.stringify(args) };
  }
  return null;
}

function usageFromChat(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = Number(usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? 0);
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: Number(usage.prompt_tokens_details?.cached_tokens ?? 0) },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: Number(usage.completion_tokens_details?.reasoning_tokens ?? 0) },
    total_tokens: Number(usage.total_tokens ?? inputTokens + outputTokens),
  };
}

function responseEnvelope({ id, model, status, output, usage, error = null }) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    error,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage,
    metadata: {},
  };
}

export function chatToResponse(chat, requestedModel, tools = []) {
  const choice = chat?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const output = [];
  const nativeCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const content = typeof message.content === "string" ? message.content : "";
  const textCall = nativeCalls.length ? null : parseTextToolCall(content, tools);
  if (content && !textCall) {
    output.push({
      id: `msg_${randomUUID()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: content, annotations: [] }],
    });
  }
  for (const call of nativeCalls) {
    output.push({
      id: `fc_${randomUUID()}`,
      call_id: String(call.id ?? `call_${randomUUID()}`),
      type: "function_call",
      name: String(call.function?.name ?? ""),
      arguments: String(call.function?.arguments ?? "{}"),
      status: "completed",
    });
  }
  if (textCall) {
    output.push({
      id: `fc_${randomUUID()}`,
      call_id: `call_${randomUUID()}`,
      type: "function_call",
      name: textCall.name,
      arguments: textCall.arguments,
      status: "completed",
    });
  }
  return responseEnvelope({
    id: String(chat?.id ? `resp_${chat.id}` : `resp_${randomUUID()}`),
    model: requestedModel,
    status: "completed",
    output,
    usage: usageFromChat(chat?.usage),
  });
}

function writeSse(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function streamState(requestedModel, tools) {
  return {
    responseId: `resp_${randomUUID()}`,
    requestedModel,
    textItem: null,
    text: "",
    calls: new Map(),
    callOrder: [],
    usage: null,
    bufferedText: "",
    tools,
  };
}

function startedEnvelope(state) {
  return responseEnvelope({
    id: state.responseId,
    model: state.requestedModel,
    status: "in_progress",
    output: [],
    usage: null,
  });
}

function emitTextDelta(res, state, delta) {
  if (!delta) return;
  if (!state.textItem) {
    state.textItem = `msg_${randomUUID()}`;
    writeSse(res, {
      type: "response.output_item.added",
      output_index: state.callOrder.length,
      item: { id: state.textItem, type: "message", status: "in_progress", role: "assistant", content: [] },
    });
    writeSse(res, {
      type: "response.content_part.added",
      item_id: state.textItem,
      output_index: state.callOrder.length,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  }
  state.text += delta;
  writeSse(res, {
    type: "response.output_text.delta",
    item_id: state.textItem,
    output_index: state.callOrder.length,
    content_index: 0,
    delta,
  });
}

function callAt(state, index) {
  if (!state.calls.has(index)) {
    const call = {
      itemId: `fc_${randomUUID()}`,
      callId: `call_${randomUUID()}`,
      name: "",
      arguments: "",
      emitted: false,
    };
    state.calls.set(index, call);
    state.callOrder.push(index);
  }
  return state.calls.get(index);
}

function emitToolDelta(res, state, delta) {
  const index = Number.isInteger(delta.index) ? delta.index : 0;
  const call = callAt(state, index);
  if (delta.id) call.callId = String(delta.id);
  if (delta.function?.name) call.name += String(delta.function.name);
  if (!call.emitted && call.name) {
    call.emitted = true;
    writeSse(res, {
      type: "response.output_item.added",
      output_index: state.callOrder.indexOf(index),
      item: {
        id: call.itemId,
        call_id: call.callId,
        type: "function_call",
        name: call.name,
        arguments: "",
        status: "in_progress",
      },
    });
  }
  const args = typeof delta.function?.arguments === "string" ? delta.function.arguments : "";
  if (args) {
    call.arguments += args;
    writeSse(res, {
      type: "response.function_call_arguments.delta",
      item_id: call.itemId,
      output_index: state.callOrder.indexOf(index),
      delta: args,
    });
  }
}

function finishStream(res, state) {
  if (!state.callOrder.length && state.bufferedText) {
    const parsed = parseTextToolCall(state.bufferedText, state.tools);
    if (parsed) {
      const call = callAt(state, 0);
      call.name = parsed.name;
      call.arguments = parsed.arguments;
    } else {
      emitTextDelta(res, state, state.bufferedText);
    }
  } else if (state.bufferedText) {
    emitTextDelta(res, state, state.bufferedText);
  }
  const output = [];
  for (const index of state.callOrder) {
    const call = state.calls.get(index);
    if (!call.emitted) {
      call.emitted = true;
      writeSse(res, {
        type: "response.output_item.added",
        output_index: output.length,
        item: {
          id: call.itemId,
          call_id: call.callId,
          type: "function_call",
          name: call.name,
          arguments: "",
          status: "in_progress",
        },
      });
    }
    writeSse(res, {
      type: "response.function_call_arguments.done",
      item_id: call.itemId,
      output_index: output.length,
      arguments: call.arguments,
    });
    const item = {
      id: call.itemId,
      call_id: call.callId,
      type: "function_call",
      name: call.name,
      arguments: call.arguments,
      status: "completed",
    };
    writeSse(res, { type: "response.output_item.done", output_index: output.length, item });
    output.push(item);
  }
  if (state.textItem) {
    const outputIndex = output.length;
    writeSse(res, {
      type: "response.output_text.done",
      item_id: state.textItem,
      output_index: outputIndex,
      content_index: 0,
      text: state.text,
    });
    const part = { type: "output_text", text: state.text, annotations: [] };
    writeSse(res, {
      type: "response.content_part.done",
      item_id: state.textItem,
      output_index: outputIndex,
      content_index: 0,
      part,
    });
    const item = { id: state.textItem, type: "message", status: "completed", role: "assistant", content: [part] };
    writeSse(res, { type: "response.output_item.done", output_index: outputIndex, item });
    output.push(item);
  }
  writeSse(res, {
    type: "response.completed",
    response: responseEnvelope({
      id: state.responseId,
      model: state.requestedModel,
      status: "completed",
      output,
      usage: state.usage,
    }),
  });
  res.end();
}

async function relayChatStream(upstream, res, requestedModel, tools) {
  const state = streamState(requestedModel, tools);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  writeSse(res, { type: "response.created", response: startedEnvelope(state) });
  writeSse(res, { type: "response.in_progress", response: startedEnvelope(state) });
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, "");
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end === -1) break;
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      const chunkBody = JSON.parse(data);
      if (chunkBody.usage) state.usage = usageFromChat(chunkBody.usage);
      const delta = chunkBody.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string") {
        // 始终逐字流式透传。旧逻辑在有 tools 时把 content 攒进 bufferedText、
        // 直到结束才一次性吐,导致 stream_ms≈0、UI 无法逐字展示。
        // GLM 原生 function calling 正常,不再需要缓冲后再解析文本伪 tool call。
        emitTextDelta(res, state, delta.content);
      }
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) emitToolDelta(res, state, call);
    }
  }
  finishStream(res, state);
}

async function readJson(req, maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw Object.assign(new Error("request body too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON body"), { statusCode: 400 });
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function configFromEnv(env = process.env) {
  const upstreamBaseUrl = (env.UPSTREAM_BASE_URL ?? "https://open.bigmodel.cn/api/coding/paas/v4").replace(/\/$/, "");
  const upstreamModel = env.UPSTREAM_MODEL ?? "glm-5.2";
  const apiKey = env.OPENAI_API_KEY;
  const timeoutMs = Number(env.UPSTREAM_TIMEOUT_MS ?? 240000);
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error("UPSTREAM_TIMEOUT_MS must be at least 1000");
  return {
    upstreamBaseUrl,
    upstreamModel,
    apiKey,
    timeoutMs,
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
  };
}

export function createGatewayServer(config) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") return sendJson(res, 200, { ok: true });
    if (req.method === "GET" && ["/models", "/v1/models"].includes(url.pathname)) {
      return sendJson(res, 200, {
        object: "list",
        data: [{ id: config.upstreamModel, object: "model", owned_by: "glm" }],
      });
    }
    if (req.method !== "POST" || !["/responses", "/v1/responses"].includes(url.pathname)) {
      return sendJson(res, 404, { error: { type: "not_found", message: "not found" } });
    }
    try {
      const body = await readJson(req, config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      const requestedModel = String(body.model ?? config.upstreamModel);
      const chatBody = responsesToChat(body, config.upstreamModel);
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(new Error("upstream timeout")), config.timeoutMs);
      timeout.unref?.();
      res.on("close", () => {
        if (!res.writableEnded) abort.abort(new Error("client disconnected"));
      });
      const upstream = await fetch(`${config.upstreamBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(chatBody),
        signal: abort.signal,
      });
      clearTimeout(timeout);
      if (!upstream.ok) {
        const detail = await upstream.text();
        return sendJson(res, upstream.status, {
          error: {
            type: "upstream_error",
            message: detail.slice(0, 4000) || `upstream returned HTTP ${upstream.status}`,
          },
        });
      }
      if (body.stream === true) {
        return await relayChatStream(upstream, res, requestedModel, body.tools ?? []);
      }
      const chat = await upstream.json();
      return sendJson(res, 200, chatToResponse(chat, requestedModel, body.tools ?? []));
    } catch (error) {
      if (res.headersSent) {
        writeSse(res, {
          type: "error",
          error: { type: "gateway_error", message: error instanceof Error ? error.message : String(error) },
        });
        return res.end();
      }
      const status = Number(error?.statusCode ?? 502);
      return sendJson(res, status, {
        error: {
          type: status < 500 ? "invalid_request_error" : "gateway_error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = configFromEnv();
  const port = Number(process.env.PORT ?? 8080);
  createGatewayServer(config).listen(port, "0.0.0.0", () => {
    process.stdout.write(`glm-responses listening on :${port}\n`);
  });
}
