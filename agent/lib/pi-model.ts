import type {
  LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content,
  LanguageModelV4FinishReason, LanguageModelV4GenerateResult, LanguageModelV4StreamPart,
  LanguageModelV4ToolResultOutput, SharedV4ProviderMetadata, SharedV4Warning,
} from '@ai-sdk/provider';
import type {
  AssistantMessage, AssistantMessageEvent, Context, Model, Models, OpenAICodexResponsesOptions,
  TextContent, ThinkingContent, ToolCall, ToolResultMessage, TSchema,
} from '@earendil-works/pi-ai';
import { createPi, providerId } from './pi.ts';
import { reasoningChoices, type ReasoningEffort } from './reasoning.ts';

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const unsupported = (feature: string): never => { throw new Error(`The Eve Pi prototype does not support ${feature}.`); };

function signature(options: SharedV4ProviderMetadata | undefined, key: string) {
  const value = options?.pi?.[key];
  return typeof value === 'string' ? value : undefined;
}

function metadata(block: TextContent | ThinkingContent | ToolCall): SharedV4ProviderMetadata | undefined {
  const data: Record<string, string> = {};
  if (block.type === 'text' && block.textSignature) data.textSignature = block.textSignature;
  if (block.type === 'thinking' && block.thinkingSignature) data.thinkingSignature = block.thinkingSignature;
  if (block.type === 'toolCall') {
    if (block.thoughtSignature) data.thoughtSignature = block.thoughtSignature;
    if (block.namespace) data.namespace = block.namespace;
  }
  return Object.keys(data).length ? { pi: data } : undefined;
}

function toolOutput(output: LanguageModelV4ToolResultOutput): Pick<ToolResultMessage, 'content' | 'isError'> {
  switch (output.type) {
    case 'text': case 'error-text':
      return { content: [{ type: 'text', text: output.value }], isError: output.type === 'error-text' };
    case 'json': case 'error-json':
      return { content: [{ type: 'text', text: JSON.stringify(output.value) }], isError: output.type === 'error-json' };
    case 'execution-denied':
      return { content: [{ type: 'text', text: output.reason ?? 'Tool execution denied.' }], isError: true };
    case 'content':
      return {
        content: output.value.map(part => {
          if(part.type==='file' && part.mediaType.startsWith('image/') && part.data.type==='data')return {type:'image' as const,data:typeof part.data.data==='string'?part.data.data:Buffer.from(part.data.data).toString('base64'),mimeType:part.mediaType};
          if (part.type !== 'text') return unsupported('non-text tool results');
          return { type: 'text' as const, text: part.text };
        }), isError: false,
      };
  }
}

export function toPiContext(options: LanguageModelV4CallOptions, model: Model<'openai-codex-responses'>): Context {
  const context: Context = { messages: [], tools: [] };
  const instructions: string[] = [];
  for (const message of options.prompt) {
    if (message.role === 'system') { instructions.push(message.content); continue; }
    if (message.role === 'user') {
      context.messages.push({ role: 'user', timestamp: 0, content: message.content.map(part => {
        if(part.type==='file' && part.mediaType.startsWith('image/') && part.data.type==='data')return {type:'image' as const,data:typeof part.data.data==='string'?part.data.data:Buffer.from(part.data.data).toString('base64'),mimeType:part.mediaType};
        if (part.type !== 'text') return unsupported('file or image input');
        return { type: 'text' as const, text: part.text };
      }) });
    } else if (message.role === 'assistant') {
      const content: AssistantMessage['content'] = message.content.map(part => {
        switch (part.type) {
          case 'text': return { type: 'text', text: part.text, textSignature: signature(part.providerOptions, 'textSignature') };
          case 'reasoning': return { type: 'thinking', thinking: part.text, thinkingSignature: signature(part.providerOptions, 'thinkingSignature') };
          case 'tool-call': {
            if (part.providerExecuted) return unsupported('provider-executed tools');
            if (!part.input || typeof part.input !== 'object' || Array.isArray(part.input)) return unsupported('non-object tool arguments');
            return { type: 'toolCall', id: part.toolCallId, name: part.toolName, arguments: part.input as Record<string, unknown>,
              thoughtSignature: signature(part.providerOptions, 'thoughtSignature'), namespace: signature(part.providerOptions, 'namespace') };
          }
          default: return unsupported(`assistant content of type ${part.type}`);
        }
      });
      context.messages.push({ role: 'assistant', content, api: model.api, provider: providerId, model: model.id,
        usage: zeroUsage(), stopReason: content.some(b => b.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: 0 });
    } else {
      for (const part of message.content) {
        if (part.type !== 'tool-result') return unsupported('tool approval response parts');
        context.messages.push({ role: 'toolResult', toolCallId: part.toolCallId, toolName: part.toolName,
          timestamp: 0, ...toolOutput(part.output) });
      }
    }
  }
  context.systemPrompt = instructions.join('\n\n');
  context.tools = (options.tools ?? []).map(tool => {
    if (tool.type !== 'function') return unsupported('provider-managed tools');
    return { name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema as TSchema };
  });
  return context;
}

export function callSettings(options: LanguageModelV4CallOptions): { options: OpenAICodexResponsesOptions; warnings: SharedV4Warning[] } {
  const warnings: SharedV4Warning[] = [];
  for (const key of ['temperature', 'maxOutputTokens', 'topP', 'topK', 'presencePenalty', 'frequencyPenalty', 'seed', 'stopSequences'] as const) {
    if (options[key] !== undefined) warnings.push({ type: 'unsupported', feature: key });
  }
  if (options.responseFormat?.type === 'json') unsupported('structured JSON output');
  if (options.toolChoice?.type === 'tool') unsupported('forcing a specific tool');
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (/^(authorization|cookie|host|chatgpt-account-id)$/i.test(name)) unsupported('overriding subscription authentication headers');
    if (value !== undefined) headers[name] = value;
  }
  const piOptions = options.providerOptions?.pi;
  for (const [name, value] of Object.entries(options.providerOptions ?? {})) {
    if (name !== 'pi' && Object.keys(value).length) unsupported(`provider options for ${name}`);
  }
  if (piOptions && Object.keys(piOptions).some(k => !['sessionId', 'reasoningEffort'].includes(k))) unsupported('unknown Pi provider options');
  const effort = piOptions?.reasoningEffort;
  if (effort !== undefined && !Object.values(reasoningChoices).includes(effort as ReasoningEffort)) unsupported('this reasoning effort');
  return {
    warnings,
    options: {
      transport: 'sse', maxRetries: 0, signal: options.abortSignal,
      headers,
      reasoningEffort: effort as ReasoningEffort | undefined ?? (options.reasoning === 'provider-default' ? undefined : options.reasoning),
      toolChoice: options.toolChoice?.type === 'tool' ? undefined : options.toolChoice?.type,
      sessionId: typeof piOptions?.sessionId === 'string' ? piOptions.sessionId : undefined,
    },
  };
}

export function safeProviderError(error: unknown): Error {
  const text = error instanceof Error ? error.message : String(error);
  if (/abort|cancel/i.test(text)) return new DOMException('Model request cancelled.', 'AbortError');
  if (/401|403|oauth|credential|auth|token.*expired/i.test(text)) return new Error('ChatGPT authentication failed. Run npm run login and try again.');
  if (/429|rate.?limit|usage.?limit|quota/i.test(text)) return new Error('ChatGPT subscription limit reached. Wait for your allowance to reset and try again.');
  if (/model.*(not|unavailable|unsupported)|not.*model/i.test(text)) return new Error('This model is unavailable for your account. Choose another with npm run model -- <model-id>.');
  return new Error('The ChatGPT model request failed. Check your connection and try again.');
}

export function toSdkResult(message: AssistantMessage, warnings: SharedV4Warning[] = []): LanguageModelV4GenerateResult {
  if (message.stopReason === 'error' || message.stopReason === 'aborted') throw safeProviderError(message.errorMessage ?? message.stopReason);
  if (message.stopReason === 'deferred' || message.stopReason === 'pending') unsupported('deferred or unfinished responses');
  const content: LanguageModelV4Content[] = message.content.map(block => {
    const providerMetadata = metadata(block);
    if (block.type === 'text') return { type: 'text', text: block.text, providerMetadata };
    if (block.type === 'thinking') return { type: 'reasoning', text: block.thinking, providerMetadata };
    return { type: 'tool-call', toolCallId: block.id, toolName: block.name, input: JSON.stringify(block.arguments), providerMetadata };
  });
  const finishReason: LanguageModelV4FinishReason = {
    unified: message.stopReason === 'toolUse' ? 'tool-calls' : message.stopReason === 'length' ? 'length' : 'stop',
    raw: message.rawStopReason ?? message.stopReason,
  };
  const u = message.usage;
  return { content, finishReason, warnings,
    usage: {
      inputTokens: { total: u.input + u.cacheRead + u.cacheWrite, noCache: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite },
      outputTokens: { total: u.output, text: u.reasoning === undefined ? undefined : u.output - u.reasoning, reasoning: u.reasoning },
    },
    response: { id: message.responseId, modelId: message.responseModel ?? message.model, timestamp: new Date(message.timestamp) },
  };
}

export async function* toSdkStream(events: AsyncIterable<AssistantMessageEvent>, warnings: SharedV4Warning[]): AsyncGenerator<LanguageModelV4StreamPart> {
  yield { type: 'stream-start', warnings };
  const toolIds = new Map<number, string>();
  let finished = false;
  for await (const event of events) {
    const id = 'contentIndex' in event ? String(event.contentIndex) : '';
    switch (event.type) {
      case 'start': break;
      case 'text_start': yield { type: 'text-start', id }; break;
      case 'text_delta': yield { type: 'text-delta', id, delta: event.delta }; break;
      case 'text_end': yield { type: 'text-end', id, providerMetadata: metadata(event.partial.content[event.contentIndex]) }; break;
      case 'thinking_start': yield { type: 'reasoning-start', id }; break;
      case 'thinking_delta': yield { type: 'reasoning-delta', id, delta: event.delta }; break;
      case 'thinking_end': yield { type: 'reasoning-end', id, providerMetadata: metadata(event.partial.content[event.contentIndex]) }; break;
      case 'toolcall_start': {
        const block = event.partial.content[event.contentIndex];
        if (block.type !== 'toolCall') throw new Error('Pi emitted an invalid tool start.');
        toolIds.set(event.contentIndex, block.id);
        yield { type: 'tool-input-start', id: block.id, toolName: block.name }; break;
      }
      case 'toolcall_delta': {
        const toolId = toolIds.get(event.contentIndex);
        if (!toolId) throw new Error('Pi emitted tool arguments without a tool start.');
        yield { type: 'tool-input-delta', id: toolId, delta: event.delta }; break;
      }
      case 'toolcall_end': {
        const block = event.toolCall;
        yield { type: 'tool-input-end', id: toolIds.get(event.contentIndex) ?? block.id };
        yield { type: 'tool-call', toolCallId: block.id, toolName: block.name, input: JSON.stringify(block.arguments), providerMetadata: metadata(block) };
        break;
      }
      case 'done': {
        const result = toSdkResult(event.message, warnings);
        yield { type: 'response-metadata', ...result.response };
        yield { type: 'finish', usage: result.usage, finishReason: result.finishReason };
        finished = true; break;
      }
      case 'error': throw safeProviderError(event.error.errorMessage ?? event.reason);
    }
  }
  if (!finished) throw new Error('ChatGPT stream ended before completing the response.');
}

export function createPiModel(modelId: string, models: Models = createPi()): LanguageModelV4 {
  const selected = models.getModel(providerId, modelId);
  if (!selected || selected.api !== 'openai-codex-responses') throw new Error('Unknown Pi Codex model. Run npm run models.');
  const model = selected as Model<'openai-codex-responses'>;
  async function prepare(options: LanguageModelV4CallOptions) {
    options.abortSignal?.throwIfAborted();
    const context = toPiContext(options, model);
    const settings = callSettings(options);
    if (!(await models.checkAuth(providerId, { signal: options.abortSignal }))) throw new Error('Not signed in. Run npm run login.');
    return { context, ...settings };
  }
  return {
    specificationVersion: 'v4', provider: 'pi.openai-codex', modelId, supportedUrls: {},
    async doGenerate(options) {
      const request = await prepare(options);
      let response: AssistantMessage;
      try { response = await models.complete(model, request.context, request.options); }
      catch (error) { throw safeProviderError(error); }
      return toSdkResult(response, request.warnings);
    },
    async doStream(options) {
      const controller = new AbortController();
      const signal = options.abortSignal ? AbortSignal.any([options.abortSignal, controller.signal]) : controller.signal;
      const request = await prepare({ ...options, abortSignal: signal });
      const events = toSdkStream(models.stream(model, request.context, request.options), request.warnings);
      return { stream: new ReadableStream<LanguageModelV4StreamPart>({
        async pull(stream) {
          try {
            const next = await events.next();
            if (next.done) stream.close(); else stream.enqueue(next.value);
          } catch (error) { stream.error(error); }
        },
        async cancel() { controller.abort(); await events.return(undefined); },
      }) };
    },
  };
}
