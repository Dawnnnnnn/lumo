import { describe, it, expect } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type {
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { tool } from 'ai';
import { z } from 'zod';
import type { ModelMessage } from 'ai';
import type { ChatMessagePart } from '@/types';
import {
  runAgentLoop,
  resumeFingerprint,
  type AgentLoopCheckpoint,
} from '@/lib/ai';
import { STEPS_NEVER } from '@/lib/max-steps';
import type { ProviderConfig, ModelConfig } from '@/types';

/** Wraps provider stream parts into the shape `doStream` must return. */
function stream(parts: LanguageModelV4StreamPart[]) {
  return {
    stream: simulateReadableStream({
      chunks: parts,
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} satisfies LanguageModelV4Usage;

const FINISH = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'stop' } as const,
  usage: USAGE,
} satisfies LanguageModelV4StreamPart;

const TOOL_FINISH = {
  type: 'finish',
  finishReason: { unified: 'tool-calls', raw: 'tool_calls' } as const,
  usage: USAGE,
} satisfies LanguageModelV4StreamPart;

/** A step that emits one text chunk and stops. */
function textStep(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: text },
    { type: 'text-end', id: '0' },
    FINISH,
  ];
}

/** A step that calls `echo` once, which keeps the agent loop going. */
function toolStep(callId: string, value: string): LanguageModelV4StreamPart[] {
  return [
    {
      type: 'tool-call',
      toolCallId: callId,
      toolName: 'echo',
      input: JSON.stringify({ value }),
    },
    TOOL_FINISH,
  ];
}

const echoTool = tool({
  description: 'Echoes its input back.',
  inputSchema: z.object({ value: z.string() }),
  execute: async ({ value }) => ({ echoed: value }),
});

const SHOT_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * A screenshot-shaped tool: its output carries an image, which the agent loop
 * strips from the tool result and re-injects as a synthetic user message.
 */
const shotTool = tool({
  description: 'Captures a screenshot.',
  inputSchema: z.object({}),
  execute: async () => ({
    content: [
      { type: 'image', data: SHOT_PNG, mimeType: 'image/png' },
      { type: 'text', text: 'Screenshot captured (png)' },
    ],
    isError: false,
  }),
});

function shotStep(callId: string): LanguageModelV4StreamPart[] {
  return [
    {
      type: 'tool-call',
      toolCallId: callId,
      toolName: 'shot',
      input: JSON.stringify({}),
    },
    TOOL_FINISH,
  ];
}

/**
 * Builds a model whose steps are served in order, so the Nth `doStream` call
 * returns `steps[N]`. `steps` entries may throw to simulate a failure.
 */
function scriptedModel(steps: Array<LanguageModelV4StreamPart[] | 'error'>) {
  const prompts: ModelMessage[][] = [];
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(options.prompt as unknown as ModelMessage[]);
      const step = steps[call++];
      if (step === 'error' || step === undefined) {
        throw new Error('simulated upstream failure');
      }
      return stream(step);
    },
  });
  return { model, prompts, callCount: () => call };
}

/**
 * A model that never stops calling tools, so only the step cap can end the loop.
 * Each call gets its own tool call id, which makes the resulting part list a
 * record of exactly how many steps ran.
 */
function loopingModel() {
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => stream(toolStep(`call_${call++}`, 'again')),
  });
  return { model, callCount: () => call };
}

function textOf(parts: ChatMessagePart[]): string {
  return parts
    .filter((p): p is Extract<ChatMessagePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function toolCallIds(parts: ChatMessagePart[]): string[] {
  return parts
    .filter((p): p is Extract<ChatMessagePart, { toolCallId: string }> => 'toolCallId' in p)
    .map((p) => p.toolCallId);
}

/** Reads `list[index]`, failing the test rather than yielding `undefined`. */
function at<T>(list: T[], index: number): T {
  const value = list[index];
  expect(value, `expected an entry at index ${index}`).toBeDefined();
  return value as T;
}

describe('runAgentLoop checkpoints', () => {
  it('emits no checkpoint for a single-step run', async () => {
    const { model } = scriptedModel([textStep('done')]);
    const checkpoints: AgentLoopCheckpoint[] = [];

    const { parts } = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      onStepComplete: (c) => checkpoints.push(c),
    });

    expect(textOf(parts)).toBe('done');
    // Nothing was left unfinished, so there is nothing to resume into.
    expect(checkpoints).toHaveLength(0);
  });

  it('emits one checkpoint per continued step, carrying the next prompt', async () => {
    const { model } = scriptedModel([
      toolStep('call_1', 'a'),
      toolStep('call_2', 'b'),
      textStep('final'),
    ]);
    const checkpoints: AgentLoopCheckpoint[] = [];

    const { parts } = await runAgentLoop({
      model,
      tools: { echo: echoTool },
      messages: [{ role: 'user', content: 'go' }],
      onStepComplete: (c) => checkpoints.push(c),
    });

    // Two tool steps continued the loop; the final text step ended it.
    expect(checkpoints).toHaveLength(2);
    expect(toolCallIds(parts)).toEqual(['call_1', 'call_2']);
    expect(textOf(parts)).toBe('final');

    // Each checkpoint grows: it is the prompt the *next* step will send.
    expect(at(checkpoints,0).modelMessages.length).toBeGreaterThan(1);
    expect(at(checkpoints,1).modelMessages.length).toBeGreaterThan(
      at(checkpoints,0).modelMessages.length,
    );
    // And it already contains the completed tool result.
    expect(JSON.stringify(at(checkpoints,0).modelMessages)).toContain('call_1');
    expect(at(checkpoints,0).parts.map((p) => p.type)).toContain('tool-echo');
  });

  it('checkpoint prompts are snapshots, not live references', async () => {
    const { model } = scriptedModel([
      toolStep('call_1', 'a'),
      toolStep('call_2', 'b'),
      textStep('final'),
    ]);
    const checkpoints: AgentLoopCheckpoint[] = [];

    await runAgentLoop({
      model,
      tools: { echo: echoTool },
      messages: [{ role: 'user', content: 'go' }],
      onStepComplete: (c) => checkpoints.push(c),
    });

    const first = at(checkpoints, 0);
    // Later mutation of the loop's own array must not have leaked in.
    expect(JSON.stringify(first.modelMessages)).not.toContain('call_2');
    expect(toolCallIds(first.parts)).toEqual(['call_1']);
  });
});

describe('runAgentLoop step cap', () => {
  it('reports a natural finish as finished, not as a cap hit', async () => {
    const { model } = scriptedModel([textStep('done')]);

    const { stoppedReason } = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(stoppedReason).toBe('finished');
  });

  it('runs uncapped by default rather than reading the sentinel as zero steps', async () => {
    // 25 tool steps is past every cap this project has ever shipped, including
    // the hardcoded 20 this setting replaced.
    const steps = Array.from({ length: 25 }, (_, i) => toolStep(`call_${i}`, 'x'));
    const { model, callCount } = scriptedModel([...steps, textStep('final')]);

    const { parts, stoppedReason } = await runAgentLoop({
      model,
      tools: { echo: echoTool },
      messages: [{ role: 'user', content: 'go' }],
      maxSteps: STEPS_NEVER,
    });

    expect(callCount()).toBe(26);
    expect(stoppedReason).toBe('finished');
    expect(textOf(parts)).toBe('final');
  });

  it('stops at the cap and says the cap is why', async () => {
    // The loop honours the number it is given; clamping to `MIN_MAX_STEPS` is the
    // settings boundary's job, which is why 3 is usable here.
    const { model, callCount } = loopingModel();

    const { parts, stoppedReason } = await runAgentLoop({
      model,
      tools: { echo: echoTool },
      messages: [{ role: 'user', content: 'go' }],
      maxSteps: 3,
    });

    expect(callCount()).toBe(3);
    // The regression this guards: a cap hit used to leave the loop through the
    // same `return` as a natural finish, so a turn abandoned mid-task was
    // reported — saved, rendered, persisted — as a complete answer.
    expect(stoppedReason).toBe('step-limit');
    expect(toolCallIds(parts)).toEqual(['call_0', 'call_1', 'call_2']);
  });

  it('leaves a resumable checkpoint when the cap cuts the run short', async () => {
    const { model } = loopingModel();
    const checkpoints: AgentLoopCheckpoint[] = [];

    const { stoppedReason } = await runAgentLoop({
      model,
      tools: { echo: echoTool },
      messages: [{ role: 'user', content: 'go' }],
      maxSteps: 3,
      onStepComplete: (c) => checkpoints.push(c),
    });

    expect(stoppedReason).toBe('step-limit');
    // Every step continued the loop, including the one the cap cut off after, so
    // the last checkpoint is the prompt the next step would have sent. Without it
    // there is nothing for "continue" to resume from but the raw history.
    expect(checkpoints).toHaveLength(3);
    expect(toolCallIds(at(checkpoints, 2).parts)).toEqual(['call_0', 'call_1', 'call_2']);

    // And it is genuinely resumable: picking it up runs no completed step again.
    const resumed = scriptedModel([textStep('continued')]);
    const { parts } = await runAgentLoop({
      model: resumed.model,
      tools: { echo: echoTool },
      messages: at(checkpoints, 2).modelMessages,
      initialParts: at(checkpoints, 2).parts,
    });

    expect(resumed.callCount()).toBe(1);
    expect(toolCallIds(parts)).toEqual(['call_0', 'call_1', 'call_2']);
    expect(textOf(parts)).toBe('continued');
  });

  it('a stream error outranks the cap as the reported reason', async () => {
    const { model } = scriptedModel([toolStep('call_1', 'a'), 'error']);

    const { stoppedReason } = await runAgentLoop({
      model,
      tools: { echo: echoTool },
      messages: [{ role: 'user', content: 'go' }],
      maxSteps: 2,
      onError: () => {},
    });

    // The second step failed rather than being cut off, and a turn that failed
    // must not be blamed on the user's step setting.
    expect(stoppedReason).toBe('error');
  });
});

describe('runAgentLoop resume', () => {
  it('resumes from a checkpoint without replaying completed tool calls', async () => {
    // First run: one tool step succeeds, the following step fails.
    const first = scriptedModel([toolStep('call_1', 'a'), 'error']);
    const checkpoints: AgentLoopCheckpoint[] = [];
    const errors: unknown[] = [];

    const { parts: partialParts } = await runAgentLoop({
      model: first.model,
      tools: { echo: echoTool },
      messages: [{ role: 'user', content: 'go' }],
      onStepComplete: (c) => checkpoints.push(c),
      onError: (e) => errors.push(e),
    });

    expect(errors).toHaveLength(1);
    expect(checkpoints).toHaveLength(1);
    expect(toolCallIds(partialParts)).toEqual(['call_1']);

    // Second run: resume from the checkpoint instead of the original history.
    const resumed = scriptedModel([textStep('continued')]);
    const checkpoint = at(checkpoints, 0);

    const { parts: finalParts } = await runAgentLoop({
      model: resumed.model,
      tools: { echo: echoTool },
      messages: checkpoint.modelMessages,
      initialParts: checkpoint.parts,
    });

    // The resumed model was called exactly once: the finished tool step was
    // not re-executed.
    expect(resumed.callCount()).toBe(1);

    // The prompt it received already contained the earlier tool result.
    expect(JSON.stringify(at(resumed.prompts, 0))).toContain('call_1');

    // Parts are continuous across the two runs, not restarted.
    expect(toolCallIds(finalParts)).toEqual(['call_1']);
    expect(textOf(finalParts)).toBe('continued');
  });

  it('keeps earlier parts visible in onUpdate while resuming', async () => {
    const first = scriptedModel([toolStep('call_1', 'a'), 'error']);
    const checkpoints: AgentLoopCheckpoint[] = [];

    await runAgentLoop({
      model: first.model,
      tools: { echo: echoTool },
      messages: [{ role: 'user', content: 'go' }],
      onStepComplete: (c) => checkpoints.push(c),
      onError: () => {},
    });

    const resumed = scriptedModel([textStep('more')]);
    const updates: ChatMessagePart[][] = [];

    await runAgentLoop({
      model: resumed.model,
      tools: { echo: echoTool },
      messages: at(checkpoints, 0).modelMessages,
      initialParts: at(checkpoints, 0).parts,
      onUpdate: (parts) => updates.push(parts),
    });

    expect(updates.length).toBeGreaterThan(0);
    // Every update still includes the tool call from before the failure, so the
    // transcript never visibly rewinds.
    for (const update of updates) {
      expect(toolCallIds(update)).toEqual(['call_1']);
    }
  });

  it('a resumed run can itself be checkpointed again', async () => {
    const first = scriptedModel([toolStep('call_1', 'a'), 'error']);
    const firstCheckpoints: AgentLoopCheckpoint[] = [];
    await runAgentLoop({
      model: first.model,
      tools: { echo: echoTool },
      messages: [{ role: 'user', content: 'go' }],
      onStepComplete: (c) => firstCheckpoints.push(c),
      onError: () => {},
    });

    // Resume, do one more tool step, then fail again.
    const second = scriptedModel([toolStep('call_2', 'b'), 'error']);
    const secondCheckpoints: AgentLoopCheckpoint[] = [];
    await runAgentLoop({
      model: second.model,
      tools: { echo: echoTool },
      messages: at(firstCheckpoints, 0).modelMessages,
      initialParts: at(firstCheckpoints, 0).parts,
      onStepComplete: (c) => secondCheckpoints.push(c),
      onError: () => {},
    });

    expect(secondCheckpoints).toHaveLength(1);
    // Progress accumulates across attempts rather than resetting.
    expect(toolCallIds(at(secondCheckpoints, 0).parts)).toEqual(['call_1', 'call_2']);
  });

  it('carries tool-produced images into the resumed prompt', async () => {
    // A screenshot step succeeds, then the next step fails. The image only
    // reaches the model through the synthetic user message the loop injects
    // *after* sanitizing the tool result, so the checkpoint must be taken after
    // that injection or the resumed model goes blind.
    const first = scriptedModel([shotStep('shot_1'), 'error']);
    const checkpoints: AgentLoopCheckpoint[] = [];

    await runAgentLoop({
      model: first.model,
      tools: { shot: shotTool },
      messages: [{ role: 'user', content: 'look' }],
      onStepComplete: (c) => checkpoints.push(c),
      onError: () => {},
    });

    expect(checkpoints).toHaveLength(1);

    const resumed = scriptedModel([textStep('I see it')]);
    await runAgentLoop({
      model: resumed.model,
      tools: { shot: shotTool },
      messages: at(checkpoints, 0).modelMessages,
      initialParts: at(checkpoints, 0).parts,
    });

    const resumedPrompt = JSON.stringify(at(resumed.prompts, 0));
    // The screenshot survives into the resumed request...
    expect(resumedPrompt).toContain(SHOT_PNG);
    // ...while the tool result itself stays stripped of the blob, exactly as in
    // a non-resumed run.
    const toolMessages = at(resumed.prompts, 0).filter((m) => m.role === 'tool');
    expect(toolMessages.length).toBeGreaterThan(0);
    expect(JSON.stringify(toolMessages)).not.toContain(SHOT_PNG);
  });
});

describe('resumeFingerprint', () => {
  const provider: ProviderConfig = {
    id: 'p1',
    name: 'P',
    type: 'openai-chat',
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    models: [],
  };
  const model: ModelConfig = {
    id: 'm1',
    modelId: 'gpt-x',
    displayName: 'GPT X',
    isVision: false,
  };
  const base = { conversationId: 'c1', provider, model, messageCount: 2 };

  it('is stable for identical inputs', () => {
    expect(resumeFingerprint(base)).toBe(resumeFingerprint({ ...base }));
  });

  it('changes when the tool surface changes mode', () => {
    expect(resumeFingerprint({ ...base, programmaticTools: true })).not.toBe(
      resumeFingerprint(base),
    );
  });

  it('changes when the model changes', () => {
    expect(resumeFingerprint({ ...base, model: { ...model, modelId: 'gpt-y' } })).not.toBe(
      resumeFingerprint(base),
    );
  });

  it('changes when the provider identity or endpoint changes', () => {
    expect(resumeFingerprint({ ...base, provider: { ...provider, id: 'p2' } })).not.toBe(
      resumeFingerprint(base),
    );
    expect(
      resumeFingerprint({ ...base, provider: { ...provider, type: 'anthropic' } }),
    ).not.toBe(resumeFingerprint(base));
    expect(
      resumeFingerprint({
        ...base,
        provider: { ...provider, baseUrl: 'https://other.test/v1' },
      }),
    ).not.toBe(resumeFingerprint(base));
  });

  it('changes when the conversation or its length changes', () => {
    expect(resumeFingerprint({ ...base, conversationId: 'c2' })).not.toBe(
      resumeFingerprint(base),
    );
    expect(resumeFingerprint({ ...base, messageCount: 3 })).not.toBe(
      resumeFingerprint(base),
    );
  });

  it('changes when OCR availability changes', () => {
    // OCR decides whether image-producing tools are in the tool set, so a
    // checkpoint taken under one OCR state must not be replayed under another.
    expect(resumeFingerprint({ ...base, ocrAvailable: true })).not.toBe(
      resumeFingerprint(base),
    );
  });
});
