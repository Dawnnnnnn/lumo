/**
 * Mid-turn delivery: a message the user composes while the model is working is
 * folded into the prompt at the end of a step's tool calls, and everything
 * streamed before that point belongs to a segment that is closed.
 *
 * The wire assertions matter more than the bookkeeping here: the whole feature
 * exists so the message lands *after* the tool results the user was reacting to
 * and *before* the continuation — the same place an interrupt-and-resend would
 * have put it, without throwing away the step.
 */
import { describe, it, expect } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import { tool } from 'ai';
import { z } from 'zod';
import type { ModelMessage } from 'ai';
import { runAgentLoop, type AgentLoopCheckpoint } from '@/lib/ai';
import type { ChatMessagePart, QueuedUserInput } from '@/types';

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

function textStep(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: text },
    { type: 'text-end', id: '0' },
    FINISH,
  ];
}

function toolStep(callId: string, value: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'tool-call', toolCallId: callId, toolName: 'echo', input: JSON.stringify({ value }) },
    TOOL_FINISH,
  ];
}

const echoTool = tool({
  description: 'Echoes its input back.',
  inputSchema: z.object({ value: z.string() }),
  execute: async ({ value }) => ({ echoed: value }),
});

function scriptedModel(steps: LanguageModelV4StreamPart[][]) {
  const prompts: ModelMessage[][] = [];
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(options.prompt as unknown as ModelMessage[]);
      const step = steps[call++];
      if (!step) throw new Error('scripted model ran out of steps');
      return stream(step);
    },
  });
  return { model, prompts };
}

function queued(id: string, text: string): QueuedUserInput {
  return { id, text, images: [], textAttachments: [], timestamp: 1 };
}

function textOf(parts: ChatMessagePart[]): string {
  return parts
    .filter((p): p is Extract<ChatMessagePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/** Number of tool parts in a list — used to prove a segment was left behind. */
function toolParts(parts: ChatMessagePart[]): number {
  return parts.filter((p) => 'toolCallId' in p).length;
}

describe('runAgentLoop mid-turn delivery', () => {
  it('delivers a queued message after the tool results, before the next request', async () => {
    const { model, prompts } = scriptedModel([toolStep('call_1', 'a'), textStep('final')]);
    let queue: QueuedUserInput[] = [queued('steer-1', 'also check the header')];
    const injected: string[] = [];
    const checkpoints: AgentLoopCheckpoint[] = [];

    const { parts, stoppedReason } = await runAgentLoop({
      model,
      tools: { echo: echoTool },
      messages: [{ role: 'user', content: 'go' }],
      pullQueuedInput: () => {
        const taken = queue;
        queue = [];
        return taken;
      },
      onInputInjected: (input) => {
        injected.push(input.id);
      },
      onStepComplete: (checkpoint) => checkpoints.push(checkpoint),
    });

    expect(stoppedReason).toBe('finished');
    expect(injected).toEqual(['steer-1']);

    // The continuation's prompt ends with the user's message: after the tool
    // result, before anything the model says next.
    const second = prompts[1]!;
    const last = second[second.length - 1]!;
    expect(last.role).toBe('user');
    expect(JSON.stringify(last.content)).toContain('also check the header');
    expect(JSON.stringify(second)).toContain('call_1');

    // The returned parts are the segment that is still open. Everything before
    // the delivery was closed into a message of its own.
    expect(toolParts(parts)).toBe(0);
    expect(textOf(parts)).toBe('final');

    // The checkpoint taken at the boundary is the post-delivery prompt (what the
    // next step sends) with an empty live segment.
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.parts).toHaveLength(0);
    expect(JSON.stringify(checkpoints[0]!.modelMessages)).toContain('also check the header');
  });

  it('reports stream updates relative to the open segment', async () => {
    const { model } = scriptedModel([toolStep('call_1', 'a'), textStep('final')]);
    let queue: QueuedUserInput[] = [queued('steer-1', 'go on')];
    const updates: ChatMessagePart[][] = [];

    await runAgentLoop({
      model,
      tools: { echo: echoTool },
      messages: [{ role: 'user', content: 'go' }],
      pullQueuedInput: () => {
        const taken = queue;
        queue = [];
        return taken;
      },
      onUpdate: (parts) => updates.push(parts),
    });

    // The first step's tool call was reported while it streamed...
    expect(updates.some((parts) => toolParts(parts) === 1)).toBe(true);
    // ...and after the delivery the same tool call can no longer appear, or the
    // UI would render it twice (once as the closed message, once live).
    const last = updates[updates.length - 1]!;
    expect(toolParts(last)).toBe(0);
    expect(textOf(last)).toBe('final');
  });

  it('does not pull once the model stops calling tools', async () => {
    const { model } = scriptedModel([textStep('done')]);
    let pulls = 0;

    const { stoppedReason } = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'go' }],
      pullQueuedInput: () => {
        pulls++;
        return [];
      },
    });

    // The turn is over: a message queued behind it is the sender's problem, not
    // the loop's — it becomes its own turn.
    expect(stoppedReason).toBe('finished');
    expect(pulls).toBe(0);
  });

  it('does not pull on the last allowed step', async () => {
    const { model, prompts } = scriptedModel([toolStep('call_1', 'a')]);
    let pulls = 0;

    const { stoppedReason } = await runAgentLoop({
      model,
      tools: { echo: echoTool },
      messages: [{ role: 'user', content: 'go' }],
      maxSteps: 1,
      pullQueuedInput: () => {
        pulls++;
        return [queued('steer-1', 'too late')];
      },
    });

    // Delivering here would record a message that nothing answers.
    expect(stoppedReason).toBe('step-limit');
    expect(pulls).toBe(0);
    expect(prompts).toHaveLength(1);
  });

  it('delivers several queued messages in order at one boundary', async () => {
    const { model, prompts } = scriptedModel([toolStep('call_1', 'a'), textStep('final')]);
    let queue: QueuedUserInput[] = [queued('steer-1', 'first'), queued('steer-2', 'second')];

    await runAgentLoop({
      model,
      tools: { echo: echoTool },
      messages: [{ role: 'user', content: 'go' }],
      pullQueuedInput: () => {
        const taken = queue;
        queue = [];
        return taken;
      },
    });

    const second = prompts[1]!;
    const tail = second.slice(-2);
    expect(tail.map((m) => m.role)).toEqual(['user', 'user']);
    expect(JSON.stringify(tail[0]!.content)).toContain('first');
    expect(JSON.stringify(tail[1]!.content)).toContain('second');
  });

  it('carries image attachments into the wire prompt as file parts', async () => {
    const { model, prompts } = scriptedModel([toolStep('call_1', 'a'), textStep('final')]);
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    let queue: QueuedUserInput[] = [
      { id: 'steer-1', text: 'what is this', images: [png], textAttachments: [], timestamp: 1 },
    ];

    await runAgentLoop({
      model,
      tools: { echo: echoTool },
      messages: [{ role: 'user', content: 'go' }],
      pullQueuedInput: () => {
        const taken = queue;
        queue = [];
        return taken;
      },
    });

    const last = prompts[1]![prompts[1]!.length - 1]!;
    expect(JSON.stringify(last.content)).toContain('image/png');
    expect(JSON.stringify(last.content)).toContain('what is this');
  });
});
