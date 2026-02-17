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
  test('planner selects provider path by experimental flag', async () => {
    const baseHelpers = {
      parseRoutePrompt: () => ({ targetName: 'copilot', routedPrompt: 'hello world' }),
      findParticipantByNameOrId: () => ({ id: 'github.copilot.default', name: 'copilot' }),
      getParticipantCommandById: () => 'github.copilot.chat.ask',
      bridgeParticipantId: 'seamless-ai-bridge',
    };

    const stablePlanText = await plannerProvider.getPlan('ignored', {}, {
      isExperimentalMode: false,
      response: { markdown() {} },
      token: undefined,
      helpers: baseHelpers,
    });

    const stablePlan = JSON.parse(stablePlanText);
    assert.strictEqual(stablePlan.mode, 'stable');
    assert.strictEqual(stablePlan.reason, 'experimental-disabled');

    const experimentalPlanText = await plannerProvider.getPlan('ignored', {}, {
      isExperimentalMode: true,
      response: { markdown() {} },
      token: undefined,
      helpers: baseHelpers,
    });

    const experimentalPlan = JSON.parse(experimentalPlanText);
    assert.strictEqual(experimentalPlan.mode, 'experimental');
    assert.strictEqual(experimentalPlan.commandId, 'github.copilot.chat.ask');
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
