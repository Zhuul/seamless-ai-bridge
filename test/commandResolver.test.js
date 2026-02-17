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

    const participant = buildParticipantRecord({
      id: 'github.copilot.default',
      name: 'GitHubCopilot',
      fullName: 'GitHub Copilot',
    }, 'GitHub.copilot-chat');

    const registry = new Map([[participant.id, participant]]);

    const byCopilot = resolveParticipantByTarget(registry, 'copilot');
    const byName = resolveParticipantByTarget(registry, 'GitHubCopilot');
    const byId = resolveParticipantByTarget(registry, 'github.copilot');

    assert.strictEqual(byCopilot.id, 'github.copilot.default');
    assert.strictEqual(byName.id, 'github.copilot.default');
    assert.strictEqual(byId.id, 'github.copilot.default');
  });

  test('hint ID precedence', () => {
    const participant = buildParticipantRecord({
      id: 'github.copilot.default',
      name: 'GitHubCopilot',
      fullName: 'GitHub Copilot',
      command: 'vendor.hint.command',
    }, 'GitHub.copilot-chat');

    const candidates = [
      buildCommandCandidate('vendor.hint.command', 'Hint Command', 'Chat', 'runtime'),
      buildCommandCandidate('github.copilot.chat.ask', 'Ask', 'Chat', 'contributed'),
    ];

    const resolved = resolveCommandForParticipant(participant, candidates);
    assert.strictEqual(resolved.linkReason, 'hint');
    assert.strictEqual(resolved.linkedCommandId, 'vendor.hint.command');
  });

  test('runtime-only command mapping success', () => {
    const participant = buildParticipantRecord({
      id: 'github.copilot.default',
      name: 'GitHubCopilot',
      fullName: 'GitHub Copilot',
    }, 'GitHub.copilot-chat');

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

  test('deterministic tie-break by lexical command id', () => {
    const participant = buildParticipantRecord({
      id: 'vendor.foo',
      name: 'foo',
      fullName: 'Vendor Foo',
    }, 'vendor.extension');

    const candidates = [
      buildCommandCandidate('vendor.foo.chat.beta', 'Foo Chat', 'Chat', 'runtime'),
      buildCommandCandidate('vendor.foo.chat.alpha', 'Foo Chat', 'Chat', 'runtime'),
    ];

    const resolved = resolveCommandForParticipant(participant, candidates);
    assert.strictEqual(resolved.linkReason, 'weighted');
    assert.strictEqual(resolved.linkedCommandId, 'vendor.foo.chat.alpha');
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
