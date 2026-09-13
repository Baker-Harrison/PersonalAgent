import test from 'node:test';
import assert from 'node:assert/strict';
import { generateText, streamText, stepCountIs, tool, jsonSchema } from 'ai';
import { createModels, InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage, type Models, type Context, type AssistantMessageEvent } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { callSettings, createPiModel, safeProviderError, toPiContext, toSdkResult, toSdkStream } from '../agent/lib/pi-model.ts';
import { parseReasoning, reasoningChoices, reasoningForModel } from '../agent/lib/reasoning.ts';

const model = openaiCodexProvider().getModels().find(m => m.id === 'gpt-5.6-luna')!;
function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return { role: 'assistant', content, api: 'openai-codex-responses', provider: 'openai-codex', model: model.id,
    usage: { input: 10, output: 8, cacheRead: 2, cacheWrite: 0, reasoning: 3, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: 1000 };
}

function fakeModels(onCall: (context: Context) => AssistantMessage): Models {
  return {
    ...createModels(),
    getModel: () => model,
    checkAuth: async () => ({ type: 'oauth', source: 'OAuth' }),
    complete: async (_model, context) => onCall(context),
    stream: (_model, context, options) => {
      const output = onCall(context);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: output });
      output.content.forEach((block, contentIndex) => {
        if (block.type === 'text') {
          stream.push({ type: 'text_start', contentIndex, partial: output });
          stream.push({ type: 'text_delta', contentIndex, delta: block.text, partial: output });
          stream.push({ type: 'text_end', contentIndex, content: block.text, partial: output });
        } else if (block.type === 'thinking') {
          stream.push({ type: 'thinking_start', contentIndex, partial: output });
          stream.push({ type: 'thinking_delta', contentIndex, delta: block.thinking, partial: output });
          stream.push({ type: 'thinking_end', contentIndex, content: block.thinking, partial: output });
        } else {
          stream.push({ type: 'toolcall_start', contentIndex, partial: output });
          stream.push({ type: 'toolcall_delta', contentIndex, delta: JSON.stringify(block.arguments), partial: output });
          stream.push({ type: 'toolcall_end', contentIndex, toolCall: block, partial: output });
        }
      });
      stream.push({ type: 'done', reason: output.stopReason as 'stop' | 'toolUse', message: output });
      return stream;
    },
  };
}

test('all five reasoning labels preserve their exact native value, including Max', () => {
  for (const [label, expected] of Object.entries(reasoningChoices)) {
    const effort = reasoningForModel(model, parseReasoning(label));
    assert.equal(effort, expected);
    assert.equal(callSettings({ prompt: [], reasoning: 'low', providerOptions: { pi: { reasoningEffort: effort } } }).options.reasoningEffort, expected);
  }
  assert.throws(() => parseReasoning('ultra'), /Choose Light/);
  assert.throws(() => reasoningForModel({ ...model, thinkingLevelMap: { max: null } }, 'Max'), /does not support Max/);
});

test('Pi builds each native Codex request with the exact reasoning effort and store:false', async () => {
  const credentials = new InMemoryCredentialStore();
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-test-account' } })).toString('base64');
  await credentials.modify('openai-codex', async () => ({ type: 'oauth', access: `fixture.${payload}.fixture`, refresh: 'fixture', expires: Date.now() + 3_600_000 }));
  const models = createModels({ credentials });
  models.setProvider(openaiCodexProvider());
  for (const [label, expected] of Object.entries(reasoningChoices)) {
    let captured: unknown;
    const settings = callSettings({ prompt: [], temperature: 0, providerOptions: { pi: { reasoningEffort: reasoningForModel(model, parseReasoning(label)) } } });
    assert.ok(settings.warnings.some(w => w.type === 'unsupported' && w.feature === 'temperature'));
    await models.complete(model, { messages: [{ role: 'user', content: 'Synthetic test', timestamp: 0 }] }, {
      ...settings.options,
      onPayload(body) { captured = body; throw new Error('Stop before sending any network request'); },
      fetch: async () => { throw new Error('Network must not be reached'); },
    });
    assert.ok(captured);
    const request = captured as { reasoning: { effort: string }; store: boolean; model: string };
    assert.equal(request.reasoning.effort, expected);
    assert.equal(request.store, false);
    assert.equal(request.model, model.id);
    assert.equal('temperature' in request, false);
  }
});

test('AI SDK generation preserves usage, instructions, reasoning signatures, and text phase', async () => {
  const signature = JSON.stringify({ id: 'rs_test', type: 'reasoning', encrypted_content: 'synthetic' });
  let sent: Context | undefined;
  const adapter = createPiModel(model.id, fakeModels(context => {
    sent = context;
    return assistant([{ type: 'thinking', thinking: 'A summary.', thinkingSignature: signature }, { type: 'text', text: 'Hello', textSignature: 'msg_test' }]);
  }));
  const result = await generateText({ model: adapter, system: 'Be concise', prompt: 'Hello', maxRetries: 0 });
  assert.equal(result.text, 'Hello');
  assert.equal(result.usage.inputTokens, 12);
  assert.equal(result.usage.outputTokens, 8);
  assert.equal(sent?.systemPrompt, 'Be concise');
  await generateText({ model: adapter, messages: [...result.response.messages, { role: 'user', content: 'Continue' }], maxRetries: 0 });
  const prior = sent!.messages.find(m => m.role === 'assistant')!;
  assert.equal(prior.role, 'assistant');
  assert.deepEqual(prior.content[0], { type: 'thinking', thinking: 'A summary.', thinkingSignature: signature });
  assert.deepEqual(prior.content[1], { type: 'text', text: 'Hello', textSignature: 'msg_test' });
});

test('AI SDK streaming executes a host tool and replays its result with matching IDs', async () => {
  let executions = 0;
  let requests = 0;
  const adapter = createPiModel(model.id, fakeModels(context => {
    requests++;
    if (requests === 1) return assistant([{ type: 'toolCall', id: 'call_clock|fc_clock', name: 'clock', arguments: {} }], 'toolUse');
    const result = context.messages.find(m => m.role === 'toolResult');
    assert.ok(result && result.role === 'toolResult');
    assert.equal(result.toolCallId, 'call_clock|fc_clock');
    assert.deepEqual(result.content, [{ type: 'text', text: '{"timestamp":"2026-09-12T12:00:00Z"}' }]);
    return assistant([{ type: 'text', text: 'The time is noon UTC.' }]);
  }));
  const result = streamText({ model: adapter, prompt: 'Get the time', stopWhen: stepCountIs(3), maxRetries: 0,
    tools: { clock: tool({ inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }), execute: async () => { executions++; return { timestamp: '2026-09-12T12:00:00Z' }; } }) } });
  const text: string[] = [];
  for await (const chunk of result.textStream) text.push(chunk);
  assert.equal(text.join(''), 'The time is noon UTC.');
  assert.equal(executions, 1);
  assert.equal(requests, 2);
});

test('streamed reasoning metadata survives AI SDK message round trip', async () => {
  const signature = '{"type":"reasoning","encrypted_content":"fixture"}';
  let received: Context | undefined;
  const adapter = createPiModel(model.id, fakeModels(context => {
    received = context;
    return assistant([{ type: 'thinking', thinking: 'Summary', thinkingSignature: signature }, { type: 'text', text: 'Done', textSignature: 'msg_done' }]);
  }));
  const first = streamText({ model: adapter, prompt: 'Hello', maxRetries: 0 });
  await first.consumeStream();
  const response = await first.response;
  const second = streamText({ model: adapter, messages: [...response.messages, { role: 'user', content: 'Next' }], maxRetries: 0 });
  await second.consumeStream();
  const previous = received!.messages[0];
  assert.equal(previous.role, 'assistant');
  if (previous.role !== 'assistant') throw new Error('Missing assistant');
  assert.equal(previous.content[0].type, 'thinking');
  if (previous.content[0].type === 'thinking') assert.equal(previous.content[0].thinkingSignature, signature);
});

test('tool errors and denied execution remain explicit', () => {
  const context = toPiContext({ prompt: [{ role: 'tool', content: [
    { type: 'tool-result', toolCallId: 'a', toolName: 'clock', output: { type: 'error-text', value: 'Invalid timezone' } },
    { type: 'tool-result', toolCallId: 'b', toolName: 'clock', output: { type: 'execution-denied' } },
  ] }] }, model);
  assert.ok(context.messages.every(m => m.role === 'toolResult' && m.isError));
});

test('subscription failures are actionable and omit upstream credential text', () => {
  assert.match(safeProviderError('401 access=secret').message, /npm run login/);
  assert.match(safeProviderError('429 quota exceeded').message, /subscription limit/);
  assert.doesNotMatch(safeProviderError('network: Bearer secret').message, /secret/);
  assert.throws(() => toSdkResult({ ...assistant([]), stopReason: 'error', errorMessage: '401 secret' }), /npm run login/);
});

test('unsupported inputs fail explicitly and SDK tracing headers are accepted', () => {
  assert.throws(() => callSettings({ prompt: [], responseFormat: { type: 'json' } }), /structured JSON/);
  assert.throws(() => callSettings({ prompt: [], headers: { Authorization: 'secret' } }), /authentication headers/);
  assert.equal(callSettings({ prompt: [], headers: { 'user-agent': 'ai-sdk' } }).options.headers?.['user-agent'], 'ai-sdk');
});

test('canceling the SDK reader aborts the Pi request', async () => {
  let signal: AbortSignal | undefined;
  const models = fakeModels(() => assistant([]));
  models.stream = (_model, _context, options) => {
    signal = options?.signal;
    const stream = createAssistantMessageEventStream();
    signal?.addEventListener('abort', () => stream.push({ type: 'error', reason: 'aborted', error: { ...assistant([]), stopReason: 'aborted' } }));
    return stream;
  };
  const result = await createPiModel(model.id, models).doStream({ prompt: [] });
  const reader = result.stream.getReader();
  await reader.read(); // stream-start
  // Cancel without waiting for a pending provider event.
  const cancellation = reader.cancel();
  assert.equal(signal?.aborted, true);
  await cancellation;
});

test('an incomplete upstream stream fails instead of reporting success', async () => {
  async function* incomplete(): AsyncGenerator<AssistantMessageEvent> { yield { type: 'start', partial: assistant([]) }; }
  await assert.rejects(async () => { for await (const _ of toSdkStream(incomplete(), [])) { /* drain */ } }, /ended before/);
});

test('Pi receives image attachments and browser screenshot tool output as images', async()=>{
 let seen=false;
 const adapter=createPiModel(model.id,fakeModels(context=>{seen=true;const user=context.messages.find(m=>m.role==='user')!;assert.ok(Array.isArray(user.content)&&user.content.some(p=>p.type==='image'));return assistant([{type:'text',text:'Image received'}]);}));
 await generateText({model:adapter,messages:[{role:'user',content:[{type:'text',text:'Inspect this image'},{type:'image',image:Buffer.from('fixture').toString('base64'),mediaType:'image/png'}]}]});assert.ok(seen);
 const context=toPiContext({prompt:[{role:'tool',content:[{type:'tool-result',toolCallId:'shot',toolName:'browser',output:{type:'content',value:[{type:'file',mediaType:'image/png',data:{type:'data',data:'Zml4dHVyZQ=='}}]}}]}]},model as any);
 const content=context.messages[0].content;assert.ok(Array.isArray(content));assert.equal(content[0].type,'image');
});
