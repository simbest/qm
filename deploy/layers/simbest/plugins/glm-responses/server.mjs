import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const TOOL_PROTOCOL_INSTRUCTION =
  "Use the provided native function-calling interface whenever a tool is needed. Never write XML, pseudo tool calls, function-call markup, or examples such as <function_calls>, <invoke>, <function_exec>, or <execute> into assistant text. Call the function directly and wait for its result.";
const TOUTIAO_RESULT_INSTRUCTION =
  "For a Toutiao retrieval result, use only facts present in the tool output. Preserve the user's actual scope and never claim they requested or care about a topic that their latest message did not name. For every reported item include its title, a concise summary, source, publication time, and original URL; attribute rumors or commentary to the source. End with a 结构化结果 JSON code block containing an array of objects with exactly category, title, source, publishedAt, url, and summary. Do not invent missing data or offer scheduling, database, API, or other features that are not part of this MVP.";
const TOUTIAO_PLAN_INSTRUCTION =
  'Return only one JSON object matching {"mode":"top|topic|channel|search","topics":[],"channels":[],"query":null,"timeRange":"today|24h|3d|7d","sortBy":"importance|latest","limit":5}. Choose top for a broad site-wide request such as today\'s important or hot news with no subject. Choose topic for one or more themes, channel for explicitly named Toutiao sections, and search for a person, company, event, or free-form keyword. Supported channels are hot, world, finance, tech, and entertainment. Preserve the user\'s requested scope and do not add demonstration topics. Use today for 今天/今日, 3d for 最近几天, and 7d for 最近/近期 when no narrower period is stated.';
const TOUTIAO_MODES = new Set(["top", "topic", "channel", "search"]);
const TOUTIAO_TIME_RANGES = new Set(["today", "24h", "3d", "7d"]);
const TOUTIAO_SORTS = new Set(["importance", "latest"]);
const TOUTIAO_CHANNEL_ALIASES = new Map([
  ["hot", "hot"],
  ["热点", "hot"],
  ["热门", "hot"],
  ["world", "world"],
  ["国际", "world"],
  ["财经", "finance"],
  ["finance", "finance"],
  ["科技", "tech"],
  ["tech", "tech"],
  ["娱乐", "entertainment"],
  ["entertainment", "entertainment"],
]);

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

export function responsesToChat(body, upstreamModel) {
  const messages = responseInputToMessages(body.input);
  const tools = responsesToolsToChat(body.tools);
  const hasExecute = tools.some((tool) => tool.function?.name === "execute");
  const toutiaoResult = toutiaoResultFromInput(body.input);
  const instructions = [
    typeof body.instructions === "string" ? body.instructions.trim() : "",
    tools.length ? TOOL_PROTOCOL_INSTRUCTION : "",
    isExplicitToutiaoRequest(body.input) && (hasExecute || toutiaoResult)
      ? `${TOUTIAO_RESULT_INSTRUCTION}${toutiaoScopeInstruction(toutiaoResult)}`
      : "",
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
    stream: body.stream === true,
    ...(body.stream === true ? { stream_options: { include_usage: true } } : {}),
  };
}

function toutiaoScopeInstruction(result) {
  const request = result?.request;
  if (!request || typeof request !== "object") return "";
  if (request.mode === "top") {
    return " This was a broad top-news request with no requested topic. Organize the answer by the evidence returned, but do not attribute any specific topic preference to the user.";
  }
  if (request.mode === "topic") {
    return ` The requested topics were exactly ${JSON.stringify(request.topics ?? [])}; do not add others.`;
  }
  if (request.mode === "channel") {
    return ` The requested channels were exactly ${JSON.stringify(request.channels ?? [])}; do not add others.`;
  }
  if (request.mode === "search") {
    return ` The requested search query was exactly ${JSON.stringify(request.query ?? "")}; do not broaden it.`;
  }
  return "";
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

function latestUserText(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  for (let index = input.length - 1; index >= 0; index--) {
    const item = input[index];
    if (item?.role === "user") return textOfContent(item.content);
  }
  return "";
}

function isExplicitToutiaoRequest(input) {
  const text = latestUserText(input);
  return (
    /(今日头条|头条)/.test(text) &&
    /(抓取|获取|爬取|采集|搜索|搜集|总结|摘要|读取|查看|看看|新闻|热点|重要|有什么)/.test(text)
  );
}

function requestedTimeRange(text) {
  const scopeText = text.replaceAll("今日头条", "");
  if (/(三天|3天|最近几天|近几天)/.test(scopeText)) return "3d";
  if (/(24小时|一天内|过去一天)/.test(scopeText)) return "24h";
  if (/(今天|今日|当天)/.test(scopeText)) return "today";
  if (/(一周|7天|最近|近期|近来)/.test(scopeText)) return "7d";
  return null;
}

function requestedLimit(text) {
  const match = text.match(/(?:前|最多|给我|列出|总结)?\s*(10|[1-9])\s*(?:条|篇|个)/);
  return match ? Number(match[1]) : null;
}

function requestedSortBy(text) {
  if (/(最新|刚刚|按时间|时间倒序)/.test(text)) return "latest";
  if (/(重要|热点|摘要|总结|概览)/.test(text)) return "importance";
  return null;
}

function requestedChannels(text) {
  const matches = [];
  for (const [alias, channel] of TOUTIAO_CHANNEL_ALIASES) {
    const index = text.toLowerCase().indexOf(alias.toLowerCase());
    if (index >= 0 && !matches.some((match) => match.channel === channel)) matches.push({ channel, index });
  }
  return matches.sort((a, b) => a.index - b.index).map((match) => match.channel);
}

function requestedTopics(text) {
  const matches = [];
  const families = [
    [/(地缘|外交|战争|中东|俄乌)/, "地缘政治"],
    [/(国际新闻|国际局势)/, "国际"],
    [/(娱乐|八卦|明星|影视|电影|综艺)/, "娱乐八卦"],
    [/(财经|金融|股市|经济|商业)/, "财经"],
    [/(科技|人工智能|AI|芯片|互联网)/i, "科技"],
  ];
  for (const [pattern, topic] of families) {
    const match = text.match(pattern);
    if (match) matches.push({ topic, index: match.index });
  }
  return matches.sort((a, b) => a.index - b.index).map((match) => match.topic);
}

function inferredQuery(text) {
  const about = text.match(
    /(?:关于|有关|围绕)\s*([^，。！？、,.!?;；:：]{1,80}?)(?:的)?(?:近期|最近|相关)?(?:报道|新闻|消息|资讯|内容|情况)(?:给我|一下|有哪些|有什么|吗|呢)?(?:[，。！？、,.!?;；:：]|$)/u,
  )?.[1];
  const cleaned = (about ?? text)
    .replace(/(帮我|请|麻烦|一下|读取|查看|看看|抓取|获取|搜索|搜集|采集|爬取|总结|摘要)/g, " ")
    .replace(/(今日头条|头条|新闻|消息|资讯|原文|内容)/g, " ")
    .replace(/(今天|今日|当天|最近|近期|近来|过去一天|24小时|一周|七天|7天|三天|3天)/g, " ")
    .replace(/(都有什么|有哪些|有什么|给我|重要|热点|最新|相关|关于|有关|围绕|报道|情况)/g, " ")
    .replace(/(^|\s)(中|的|里|内|上|下)(?=\s|$)/g, " ")
    .replace(/[，。！？、,.!?;；:："'“”‘’（）()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned;
}

export function inferToutiaoPlan(text) {
  const channels = requestedChannels(text);
  const topics = requestedTopics(text);
  const timeRange = requestedTimeRange(text) ?? "24h";
  const sortBy = /(最新|刚刚|按时间)/.test(text) ? "latest" : "importance";
  const limit = requestedLimit(text) ?? (/(重要|热点|大事|概览|都有什么)/.test(text) ? 8 : 5);
  const explicitlyNamesChannel = /(频道|版块|板块|栏目)/.test(text) && channels.length > 0;
  const broadTopRequest =
    /(重要新闻|热点新闻|今日热点|今天.*(?:新闻|大事)|今日.*(?:新闻|大事)|都有什么)/.test(text) &&
    !/(关于|有关|围绕|搜索|搜一下|查一下)/.test(text) &&
    topics.length === 0 &&
    !explicitlyNamesChannel;
  if (broadTopRequest) {
    return { mode: "top", topics: [], channels: [], query: null, timeRange, sortBy, limit };
  }
  if (explicitlyNamesChannel) {
    return { mode: "channel", topics: [], channels, query: null, timeRange, sortBy, limit };
  }
  if (topics.length > 0) {
    return { mode: "topic", topics, channels: [], query: null, timeRange, sortBy, limit };
  }
  const query = inferredQuery(text);
  if (query) return { mode: "search", topics: [], channels: [], query, timeRange, sortBy, limit };
  return { mode: "top", topics: [], channels: [], query: null, timeRange, sortBy, limit };
}

function normalizedStringList(value, maxItems) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim().slice(0, 80))
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index)
    .slice(0, maxItems);
}

export function normalizeToutiaoPlan(candidate, text) {
  const fallback = inferToutiaoPlan(text);
  if (!candidate || typeof candidate !== "object") return fallback;
  let mode = TOUTIAO_MODES.has(candidate.mode) ? candidate.mode : fallback.mode;
  const topics = normalizedStringList(candidate.topics, 4);
  const channels = normalizedStringList(candidate.channels, 5)
    .map((item) => TOUTIAO_CHANNEL_ALIASES.get(item.toLowerCase()) ?? TOUTIAO_CHANNEL_ALIASES.get(item))
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index);
  const query = typeof candidate.query === "string" ? candidate.query.trim().slice(0, 80) : "";
  const explicitChannels = requestedChannels(text);
  const explicitTopics = requestedTopics(text);
  if (fallback.mode === "top") mode = "top";
  else if (explicitChannels.length && /(频道|版块|板块|栏目)/.test(text)) mode = "channel";
  else if (explicitTopics.length > 1) mode = "topic";
  const timeRange =
    requestedTimeRange(text) ??
    (TOUTIAO_TIME_RANGES.has(candidate.timeRange) ? candidate.timeRange : fallback.timeRange);
  const sortBy = requestedSortBy(text) ?? (TOUTIAO_SORTS.has(candidate.sortBy) ? candidate.sortBy : fallback.sortBy);
  const limit = requestedLimit(text) ?? fallback.limit;
  if (mode === "topic") {
    const selected = explicitTopics.length ? explicitTopics : topics.length ? topics : fallback.topics;
    if (selected.length) return { mode, topics: selected, channels: [], query: null, timeRange, sortBy, limit };
    mode = query ? "search" : "top";
  }
  if (mode === "channel") {
    const selected = explicitChannels.length ? explicitChannels : channels.length ? channels : fallback.channels;
    if (selected.length) return { mode, topics: [], channels: selected, query: null, timeRange, sortBy, limit };
    mode = "top";
  }
  if (mode === "search") {
    const selected = query || fallback.query || inferredQuery(text);
    if (selected) return { mode, topics: [], channels: [], query: selected, timeRange, sortBy, limit };
    mode = "top";
  }
  return { mode: "top", topics: [], channels: [], query: null, timeRange, sortBy, limit };
}

function plannerJson(text) {
  if (typeof text !== "string") return null;
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function planToutiaoRequest(config, text) {
  const fallback = inferToutiaoPlan(text);
  try {
    const plannerTimeoutMs = config.plannerTimeoutMs ?? 30_000;
    const timeoutMs = config.timeoutMs ?? plannerTimeoutMs;
    const response = await fetch(`${config.upstreamBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.upstreamModel,
        messages: [
          { role: "system", content: TOUTIAO_PLAN_INSTRUCTION },
          { role: "user", content: text },
        ],
        temperature: 0,
        max_tokens: 400,
        stream: false,
      }),
      signal: AbortSignal.timeout(Math.min(plannerTimeoutMs, timeoutMs)),
    });
    if (!response.ok) return fallback;
    const chat = await response.json();
    return normalizeToutiaoPlan(plannerJson(chat?.choices?.[0]?.message?.content), text);
  } catch {
    return fallback;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function toutiaoCommandFromPlan(plan) {
  const parts = ["toutiao-fetch", "--mode", plan.mode];
  for (const topic of plan.topics) parts.push("--topic", shellQuote(topic));
  for (const channel of plan.channels) parts.push("--channel", channel);
  if (plan.query) parts.push("--query", shellQuote(plan.query));
  parts.push("--time-range", plan.timeRange, "--sort-by", plan.sortBy, "--limit", String(plan.limit));
  return parts.join(" ");
}

function routableToutiaoText(body) {
  const instructions = typeof body.instructions === "string" ? body.instructions : "";
  if (/short title for a chat conversation|output only the title|会话.{0,8}标题|对话.{0,8}标题/i.test(instructions)) {
    return null;
  }
  if (
    Array.isArray(body.input) &&
    body.input.some((item) => item?.type === "function_call_output" || item?.role === "tool")
  ) {
    return null;
  }
  if (!toolDefinitions(body.tools).has("execute")) return null;
  const text = latestUserText(body.input);
  if (!isExplicitToutiaoRequest(body.input)) return null;
  return text;
}

export function routedToutiaoCall(body, candidatePlan) {
  const text = routableToutiaoText(body);
  if (!text) return null;
  const plan = normalizeToutiaoPlan(candidatePlan ?? inferToutiaoPlan(text), text);
  return {
    name: "execute",
    arguments: JSON.stringify({
      command: toutiaoCommandFromPlan(plan),
      purpose: `Fetch current public Toutiao news using a validated ${plan.mode} retrieval plan.`,
      timeout_seconds: 240,
    }),
  };
}

export function toutiaoResultFromInput(input) {
  if (!Array.isArray(input)) return null;
  let latestUserIndex = -1;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (input[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  for (let index = input.length - 1; index > latestUserIndex; index -= 1) {
    const item = input[index];
    if (!item || (item.type !== "function_call_output" && item.role !== "tool")) continue;
    const text = item.type === "function_call_output" ? textOfContent(item.output) : textOfContent(item.content);
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed?.site === "今日头条" && Array.isArray(parsed.categories)) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

function summaryFromProse(prose, item) {
  const titleAt = prose.indexOf(item.title);
  const urlAt = titleAt >= 0 ? prose.indexOf(item.url, titleAt) : -1;
  if (titleAt >= 0 && urlAt > titleAt) {
    const block = prose.slice(titleAt, urlAt);
    const match = block.match(
      /(?:-\s*)?(?:\*\*摘要\*\*|摘要)[：:]\s*([\s\S]*?)(?=\n\s*(?:-\s*)?(?:\*\*来源\*\*|来源)[：:]|$)/u,
    );
    if (match?.[1]?.trim()) return match[1].replace(/\s+/g, " ").trim();
  }
  const excerpt = String(item.contentExcerpt ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!excerpt) return String(item.title ?? "");
  return excerpt.length > 220 ? `${excerpt.slice(0, 220)}…` : excerpt;
}

export function normalizeToutiaoResponse(text, result) {
  if (typeof text !== "string" || !result || !Array.isArray(result.categories)) return text;
  const marker = text.search(/^#{1,6}\s*结构化结果\s*$/mu);
  let prose = (marker >= 0 ? text.slice(0, marker) : text).trim();
  prose = prose
    .replace(/\n*(?:---\s*\n*)?```json[\s\S]*?```\s*/gu, "\n\n")
    .replace(/\n+(?:---\s*\n+)?[^\n]*(?:定时|每天|每周)[^\n]*(?:推送|摘要)[\s\S]*$/u, "")
    .trim();
  const structured = result.categories.flatMap((category) =>
    (Array.isArray(category.items) ? category.items : []).map((item) => ({
      category: String(item.category ?? category.category ?? ""),
      title: String(item.title ?? ""),
      source: item.source == null ? null : String(item.source),
      publishedAt: item.publishedAt == null ? null : String(item.publishedAt),
      url: String(item.url ?? ""),
      summary: summaryFromProse(prose, item),
    })),
  );
  const block = `### 结构化结果\n\n\`\`\`json\n${JSON.stringify(structured, null, 2)}\n\`\`\``;
  return prose ? `${prose}\n\n${block}` : block;
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

export function chatToResponse(chat, requestedModel, tools = [], toutiaoResult = null) {
  const choice = chat?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const output = [];
  const nativeCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const content = normalizeToutiaoResponse(message.content, toutiaoResult);
  const textCall = nativeCalls.length || toutiaoResult ? null : parseTextToolCall(content, tools);
  if (typeof content === "string" && content && !textCall) {
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

function sendToolCallResponse(res, requestedModel, call, stream) {
  if (!stream) {
    return sendJson(
      res,
      200,
      responseEnvelope({
        id: `resp_${randomUUID()}`,
        model: requestedModel,
        status: "completed",
        output: [
          {
            id: `fc_${randomUUID()}`,
            call_id: `call_${randomUUID()}`,
            type: "function_call",
            name: call.name,
            arguments: call.arguments,
            status: "completed",
          },
        ],
        usage: null,
      }),
    );
  }
  const state = streamState(requestedModel, []);
  const toolCall = callAt(state, 0);
  toolCall.name = call.name;
  toolCall.arguments = call.arguments;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  writeSse(res, { type: "response.created", response: startedEnvelope(state) });
  writeSse(res, { type: "response.in_progress", response: startedEnvelope(state) });
  finishStream(res, state);
}

function streamState(requestedModel, tools, toutiaoResult = null) {
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
    toutiaoResult,
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
    const normalizedText = normalizeToutiaoResponse(state.bufferedText, state.toutiaoResult);
    const parsed = state.toutiaoResult ? null : parseTextToolCall(normalizedText, state.tools);
    if (parsed) {
      const call = callAt(state, 0);
      call.name = parsed.name;
      call.arguments = parsed.arguments;
    } else {
      emitTextDelta(res, state, normalizedText);
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

async function relayChatStream(upstream, res, requestedModel, tools, toutiaoResult) {
  const state = streamState(requestedModel, tools, toutiaoResult);
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
        if (state.tools.length || state.toutiaoResult) state.bufferedText += delta.content;
        else emitTextDelta(res, state, delta.content);
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
  const plannerTimeoutMs = Number(env.PLANNER_TIMEOUT_MS ?? 30000);
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error("UPSTREAM_TIMEOUT_MS must be at least 1000");
  if (!Number.isFinite(plannerTimeoutMs) || plannerTimeoutMs < 1000) {
    throw new Error("PLANNER_TIMEOUT_MS must be at least 1000");
  }
  return {
    upstreamBaseUrl,
    upstreamModel,
    apiKey,
    timeoutMs,
    plannerTimeoutMs,
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
      const toutiaoResult = toutiaoResultFromInput(body.input);
      const chatBody = responsesToChat(body, config.upstreamModel);
      const toutiaoText = routableToutiaoText(body);
      if (toutiaoText) {
        const plan = await planToutiaoRequest(config, toutiaoText);
        const routedCall = routedToutiaoCall(body, plan);
        if (routedCall) return sendToolCallResponse(res, requestedModel, routedCall, body.stream === true);
      }
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
        return await relayChatStream(upstream, res, requestedModel, body.tools ?? [], toutiaoResult);
      }
      const chat = await upstream.json();
      return sendJson(res, 200, chatToResponse(chat, requestedModel, body.tools ?? [], toutiaoResult));
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
