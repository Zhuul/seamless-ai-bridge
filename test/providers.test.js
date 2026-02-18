const assert = require('assert');

const plannerProvider = require('../plannerProvider');
const coderProvider = require('../coderProvider');

function createCancellationTokenSource() {
  let cancelled = false;
  const listeners = new Set();

  return {
    token: {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested(listener) {
        listeners.add(listener);
        return {
          dispose() {
            listeners.delete(listener);
          },
        };
      },
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const listener of Array.from(listeners)) {
        listener();
      }
    },
  };
}

suite('Provider Layer', () => {
  test('planner refresh-on-miss then success', async () => {
    const calls = [];

    const planText = await plannerProvider.getPlan('@copilot create a rest api', {}, {
      isExperimentalMode: true,
      response: { markdown() {} },
      token: undefined,
      helpers: {
        parseRoutePrompt: (prompt) => {
          const match = /^@([^\s]+)\s+([\s\S]+)$/.exec(prompt.trim());
          if (!match) return undefined;
          return { targetName: match[1], routedPrompt: match[2].trim() };
        },
        resolveRouteTarget: async (targetName, options) => {
          calls.push({ targetName, options });
          return {
            participant: { id: 'github.copilot.default', name: 'GitHubCopilot' },
            commandId: 'github.copilot.chat.ask',
            linkScore: 88,
            linkReason: 'weighted',
            retried: true,
            diagnostics: {
              target: 'copilot',
              aliasAtoms: ['copilot', 'githubcopilot'],
              candidateCount: 24,
              topCandidates: [{ id: 'github.copilot.chat.ask', score: 88 }],
            },
          };
        },
        bridgeParticipantId: 'seamless-ai-bridge',
      },
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].targetName, 'copilot');
    assert.strictEqual(calls[0].options.retryOnMiss, true);
    assert.strictEqual(calls[0].options.resolutionContext.routedPrompt, 'create a rest api');
    assert.strictEqual(calls[0].options.resolutionContext.targetMode, 'generic');

    const plan = JSON.parse(planText);
    assert.strictEqual(plan.mode, 'experimental');
    assert.strictEqual(plan.commandId, 'github.copilot.chat.ask');
    assert.strictEqual(plan.retryAttempted, true);
  });

  test('planner passes explicit target mode context for non-generic targets', async () => {
    const calls = [];

    const planText = await plannerProvider.getPlan('@workspace summarize current repo', {}, {
      isExperimentalMode: true,
      response: { markdown() {} },
      token: undefined,
      helpers: {
        parseRoutePrompt: (prompt) => {
          const match = /^@([^\s]+)\s+([\s\S]+)$/.exec(prompt.trim());
          if (!match) return undefined;
          return { targetName: match[1], routedPrompt: match[2].trim() };
        },
        resolveRouteTarget: async (targetName, options) => {
          calls.push({ targetName, options });
          return {
            participant: { id: 'github.copilot.workspace', name: 'workspace' },
            commandId: 'github.copilot.chat.replay.enableWorkspaceEditTracing',
            linkScore: 92,
            linkReason: 'weighted',
            retried: false,
            diagnostics: {
              target: 'workspace',
              aliasAtoms: ['workspace'],
              candidateCount: 24,
              topCandidates: [{ id: 'github.copilot.chat.replay.enableWorkspaceEditTracing', score: 92 }],
            },
          };
        },
        bridgeParticipantId: 'seamless-ai-bridge',
      },
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].targetName, 'workspace');
    assert.strictEqual(calls[0].options.resolutionContext.routedPrompt, 'summarize current repo');
    assert.strictEqual(calls[0].options.resolutionContext.targetMode, 'explicit');

    const plan = JSON.parse(planText);
    assert.strictEqual(plan.mode, 'experimental');
    assert.strictEqual(plan.targetId, 'github.copilot.workspace');
  });

  test('planner refresh-on-miss then fallback with diagnostics', async () => {
    const planText = await plannerProvider.getPlan('@copilot explain this project', {}, {
      isExperimentalMode: true,
      response: { markdown() {} },
      token: undefined,
      helpers: {
        parseRoutePrompt: (prompt) => {
          const match = /^@([^\s]+)\s+([\s\S]+)$/.exec(prompt.trim());
          if (!match) return undefined;
          return { targetName: match[1], routedPrompt: match[2].trim() };
        },
        resolveRouteTarget: async () => ({
          participant: { id: 'github.copilot.default', name: 'GitHubCopilot' },
          commandId: '',
          linkScore: 0,
          linkReason: 'none',
          retried: true,
          diagnostics: {
            target: 'copilot',
            aliasAtoms: ['copilot', 'githubcopilot'],
            candidateCount: 31,
            topCandidates: [
              { id: 'github.copilot.chat.foo', score: 38 },
              { id: 'github.copilot.chat.bar', score: 34 },
              { id: 'github.copilot.debug.sample', score: 12 },
            ],
          },
        }),
        bridgeParticipantId: 'seamless-ai-bridge',
      },
    });

    const plan = JSON.parse(planText);
    assert.strictEqual(plan.mode, 'stable');
    assert.strictEqual(plan.reason, 'no-command-mapping');
    assert.strictEqual(plan.retryAttempted, true);
    assert.strictEqual(plan.diagnostics.target, 'copilot');
    assert.deepStrictEqual(plan.diagnostics.aliasAtoms, ['copilot', 'githubcopilot']);
    assert.strictEqual(plan.diagnostics.candidateCount, 31);
    assert.strictEqual(plan.diagnostics.topCandidates.length, 3);
  });

  test('coder falls back to stable provider when experimental command fails', async () => {
    const routeCalls = [];
    const writes = [];

    const result = await coderProvider.getCode(JSON.stringify({
      mode: 'experimental',
      prompt: 'list files',
      targetId: 'github.copilot.terminal',
      targetName: 'terminal',
      commandId: 'github.copilot.terminal.explainTerminalLastCommand',
    }), {
      userPrompt: 'list files',
    }, {
      isExperimentalMode: true,
      response: {
        markdown(text) {
          writes.push(text);
        },
      },
      token: {
        isCancellationRequested: false,
        onCancellationRequested() {
          return { dispose() {} };
        },
      },
      helpers: {
        log() {},
        debugLog() {},
        getResponseCount: () => writes.length,
        executeCommand: async () => {
          throw new Error('command failed');
        },
        streamForwardResult: async () => false,
        routeToLocalBridge: async (prompt) => {
          routeCalls.push(prompt);
        },
      },
    });

    assert.strictEqual(result.source, 'stable-fallback');
    assert.deepStrictEqual(routeCalls, ['list files']);
    assert.ok(writes.some((line) => line.includes('Unable to route to @terminal')));
  });

  test('coder propagates cancellation through orchestration path', async () => {
    const cts = createCancellationTokenSource();
    const routeCalls = [];

    const promise = coderProvider.getCode(JSON.stringify({
      mode: 'experimental',
      prompt: 'long task',
      targetId: 'github.copilot.default',
      targetName: 'copilot',
      commandId: 'github.copilot.chat.ask',
    }), {
      userPrompt: 'long task',
    }, {
      isExperimentalMode: true,
      response: {
        markdown() {},
      },
      token: cts.token,
      experimentalTimeoutMs: 5000,
      helpers: {
        log() {},
        debugLog() {},
        getResponseCount: () => 0,
        executeCommand: () => new Promise(() => {}),
        streamForwardResult: async () => false,
        routeToLocalBridge: async (prompt) => {
          routeCalls.push(prompt);
        },
      },
    });

    setTimeout(() => cts.cancel(), 10);

    await assert.rejects(promise, /Cancelled/);
    assert.deepStrictEqual(routeCalls, []);
  });
});
