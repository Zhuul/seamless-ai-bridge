const assert = require('assert');

const extensionModule = require('../extension');

const {
  normalizeAtom,
  tokenize,
  buildParticipantRecord,
  buildCommandCandidate,
  resolveCommandForParticipant,
  resolveParticipantByTarget,
} = extensionModule.__test;

function buildCopilotRegistry() {
  const defaultParticipant = buildParticipantRecord({
    id: 'github.copilot.default',
    name: 'GitHubCopilot',
    fullName: 'GitHub Copilot',
  }, 'GitHub.copilot-chat');

  const replayParticipant = buildParticipantRecord({
    id: 'github.copilot.chatReplay',
    name: 'chatReplay',
    fullName: 'GitHub Copilot Replay',
  }, 'GitHub.copilot-chat');

  return new Map([
    [replayParticipant.id, replayParticipant],
    [defaultParticipant.id, defaultParticipant],
  ]);
}

function buildDefaultCopilotParticipant(extra) {
  return buildParticipantRecord({
    id: 'github.copilot.default',
    name: 'GitHubCopilot',
    fullName: 'GitHub Copilot',
    ...extra,
  }, 'GitHub.copilot-chat');
}

suite('Command Resolver', () => {
  test('alias equivalence normalization', () => {
    const forms = [
      'GitHub Copilot',
      'github.copilot',
      'github-copilot',
      'github_copilot',
    ];

    const normalized = forms.map((value) => normalizeAtom(value));
    for (const atom of normalized) {
      assert.strictEqual(atom, 'githubcopilot');
    }
  });

  test('generic alias resolves to default participant', () => {
    const registry = buildCopilotRegistry();

    const byCopilot = resolveParticipantByTarget(registry, 'copilot');
    const byName = resolveParticipantByTarget(registry, 'GitHubCopilot');
    const byId = resolveParticipantByTarget(registry, 'github.copilot');

    assert.strictEqual(byCopilot.id, 'github.copilot.default');
    assert.strictEqual(byName.id, 'github.copilot.default');
    assert.strictEqual(byId.id, 'github.copilot.default');
  });

  test('explicit replay alias resolves to replay participant', () => {
    const registry = buildCopilotRegistry();

    const resolved = resolveParticipantByTarget(registry, 'replay');

    assert.strictEqual(resolved.id, 'github.copilot.chatReplay');
  });

  test('tie case chooses default for generic target', () => {
    const defaultParticipant = buildParticipantRecord({
      id: 'github.copilot.default',
      name: 'GitHubCopilot',
      fullName: 'GitHub Copilot',
    }, 'GitHub.copilot-chat');

    const replayParticipant = buildParticipantRecord({
      id: 'github.copilot.chatReplay',
      name: 'GitHubCopilot',
      fullName: 'GitHub Copilot',
    }, 'GitHub.copilot-chat');

    const registry = new Map([
      [replayParticipant.id, replayParticipant],
      [defaultParticipant.id, defaultParticipant],
    ]);

    const resolved = resolveParticipantByTarget(registry, 'copilot');

    assert.strictEqual(resolved.id, 'github.copilot.default');
  });

  test('deterministic sort stability across repeated runs', () => {
    const registry = buildCopilotRegistry();

    for (let i = 0; i < 50; i += 1) {
      const resolved = resolveParticipantByTarget(registry, 'github.copilot');
      assert.strictEqual(resolved.id, 'github.copilot.default');
    }
  });

  test('generic copilot prompt prefers ask over apply operational command', () => {
    const participant = buildDefaultCopilotParticipant();
    const candidates = [
      buildCommandCandidate('github.copilot.chat.applyCopilotCLIAgentSessionChanges', 'Apply CLI Agent Session Changes', 'Chat', 'contributed'),
      buildCommandCandidate('github.copilot.chat.ask', 'Ask', 'Chat', 'contributed'),
    ];

    for (let i = 0; i < 20; i += 1) {
      const resolved = resolveCommandForParticipant(participant, candidates, {
        resolutionContext: {
          targetMode: 'generic',
          routedPrompt: 'What is the current status of this project?',
        },
      });

      assert.strictEqual(resolved.linkReason, 'primary-preference');
      assert.strictEqual(resolved.linkedCommandId, 'github.copilot.chat.ask');
    }
  });

  test('emits command-selection-trace payload for generic copilot resolution', () => {
    const participant = buildDefaultCopilotParticipant();
    const candidates = [
      buildCommandCandidate('github.copilot.chat.applyCopilotCLIAgentSessionChanges', 'Apply CLI Agent Session Changes', 'Chat', 'contributed'),
      buildCommandCandidate('github.copilot.chat.ask', 'Ask', 'Chat', 'contributed'),
    ];

    const traces = [];
    const resolved = resolveCommandForParticipant(participant, candidates, {
      resolutionContext: {
        targetMode: 'generic',
        routedPrompt: 'Please plan a simple REST API for a blog with endpoints for users and posts.',
      },
      onDebug: (payload) => traces.push(payload),
    });

    assert.strictEqual(resolved.linkedCommandId, 'github.copilot.chat.ask');
    assert.strictEqual(traces.length, 1);

    const trace = traces[0];
    assert.strictEqual(trace.type, 'command-selection-trace');
    assert.strictEqual(trace.participantId, 'github.copilot.default');
    assert.strictEqual(trace.participantFamilyKey, 'github.copilot');
    assert.strictEqual(trace.targetMode, 'generic');
    assert.strictEqual(trace.promptIntent, 'general');
    assert.strictEqual(trace.preferredCommand, 'github.copilot.chat.ask');
    assert.deepStrictEqual(trace.availableCandidates, [
      'github.copilot.chat.applyCopilotCLIAgentSessionChanges',
      'github.copilot.chat.ask',
    ]);
    assert.strictEqual(trace.finalResolvedCommandId, 'github.copilot.chat.ask');
    assert.strictEqual(trace.resolutionReason, 'primary-preference');
  });

  test('explicit hint still overrides preferred command policy', () => {
    const participant = buildDefaultCopilotParticipant({
      command: 'github.copilot.chat.applyCopilotCLIAgentSessionChanges',
    });
    const candidates = [
      buildCommandCandidate('github.copilot.chat.applyCopilotCLIAgentSessionChanges', 'Apply CLI Agent Session Changes', 'Chat', 'contributed'),
      buildCommandCandidate('github.copilot.chat.ask', 'Ask', 'Chat', 'contributed'),
    ];

    const resolved = resolveCommandForParticipant(participant, candidates, {
      resolutionContext: {
        targetMode: 'generic',
        routedPrompt: 'What is the current status of this project?',
      },
    });

    assert.strictEqual(resolved.linkReason, 'hint');
    assert.strictEqual(resolved.linkedCommandId, 'github.copilot.chat.applyCopilotCLIAgentSessionChanges');
  });

  test('no configured family preference falls back to weighted lexical ordering', () => {
    const participant = buildParticipantRecord({
      id: 'vendor.foo',
      name: 'foo',
      fullName: 'Vendor Foo',
    }, 'vendor.extension');

    const candidates = [
      buildCommandCandidate('vendor.foo.chat.beta', 'Foo Chat', 'Chat', 'runtime'),
      buildCommandCandidate('vendor.foo.chat.alpha', 'Foo Chat', 'Chat', 'runtime'),
    ];

    const resolved = resolveCommandForParticipant(participant, candidates, {
      resolutionContext: {
        targetMode: 'generic',
        routedPrompt: 'general question',
      },
    });

    assert.strictEqual(resolved.linkReason, 'weighted');
    assert.strictEqual(resolved.linkedCommandId, 'vendor.foo.chat.alpha');
  });

  test('operational intent does not force ask for explicit route intent', () => {
    const participant = buildDefaultCopilotParticipant();
    const candidates = [
      buildCommandCandidate('github.copilot.chat.applyCopilotCLIAgentSessionChanges', 'Apply CLI Agent Session Changes', 'Chat', 'contributed'),
      buildCommandCandidate('github.copilot.chat.ask', 'Ask', 'Chat', 'contributed'),
    ];

    const resolved = resolveCommandForParticipant(participant, candidates, {
      resolutionContext: {
        targetMode: 'explicit',
        routedPrompt: 'apply replay session changes now',
      },
    });

    assert.strictEqual(resolved.linkReason, 'weighted');
    assert.strictEqual(resolved.linkedCommandId, 'github.copilot.chat.applyCopilotCLIAgentSessionChanges');
  });

  test('runtime-only command mapping success', () => {
    const participant = buildDefaultCopilotParticipant();

    const candidates = [
      buildCommandCandidate('github.copilot.chat.ask', '', '', 'runtime'),
      buildCommandCandidate('vendor.tools.search', '', '', 'runtime'),
    ];

    const resolved = resolveCommandForParticipant(participant, candidates);
    assert.strictEqual(resolved.linkReason, 'weighted');
    assert.strictEqual(resolved.linkedCommandId, 'github.copilot.chat.ask');
    assert.ok(resolved.linkScore >= 40);
  });

  test('weighted mapping success', () => {
    const participant = buildParticipantRecord({
      id: 'github.copilot.workspace',
      name: 'workspace',
      fullName: 'GitHub Copilot Workspace',
    }, 'GitHub.copilot-chat');

    const candidates = [
      buildCommandCandidate('github.copilot.chat.replay.enableWorkspaceEditTracing', 'Workspace Edit Tracing', 'Chat', 'contributed'),
      buildCommandCandidate('vendor.other.command', 'Other', 'Tools', 'contributed'),
    ];

    const resolved = resolveCommandForParticipant(participant, candidates);
    assert.strictEqual(resolved.linkedCommandId, 'github.copilot.chat.replay.enableWorkspaceEditTracing');
    assert.strictEqual(resolved.linkReason, 'weighted');
    assert.ok(resolved.linkScore >= 40);
  });

  test('threshold rejection below 40', () => {
    const participant = buildParticipantRecord({
      id: 'acme.router',
      name: 'router',
      fullName: 'Acme Router',
    }, 'acme.extension');

    const candidates = [
      buildCommandCandidate('debug.sample.command', 'Debug Sample', 'Internal', 'runtime'),
      buildCommandCandidate('tools.misc.inspect', 'Inspect', 'Tools', 'runtime'),
    ];

    const resolved = resolveCommandForParticipant(participant, candidates);
    assert.strictEqual(resolved.linkReason, 'none');
    assert.strictEqual(resolved.linkedCommandId, '');
  });

  test('tokenize splits punctuation and case boundaries', () => {
    const tokens = tokenize('GitHubCopilot.chatReplay_enableWorkspaceEditTracing');
    assert.ok(tokens.includes('git'));
    assert.ok(tokens.includes('hub'));
    assert.ok(tokens.includes('copilot'));
    assert.ok(tokens.includes('chat'));
    assert.ok(tokens.includes('workspace'));
  });
});
