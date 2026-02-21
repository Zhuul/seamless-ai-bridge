const assert = require('assert');

const extensionModule = require('../extension');

const {
  normalizePersonaAlias,
  readConfiguredPersonas,
  parsePersonaPrompt,
} = extensionModule.__test;

suite('Persona Engine', () => {
  test('normalizes persona aliases', () => {
    assert.strictEqual(normalizePersonaAlias('@Planner'), 'planner');
    assert.strictEqual(normalizePersonaAlias(' coder '), 'coder');
    assert.strictEqual(normalizePersonaAlias(''), '');
  });

  test('reads and filters configured personas', () => {
    const personas = readConfiguredPersonas([
      {
        alias: 'planner',
        name: 'Planner',
        modelSelector: {
          family: 'gpt-4o',
        },
      },
      {
        alias: 'disabled',
        enabled: false,
      },
      {
        alias: 'other-provider',
        provider: 'qwen',
      },
    ]);

    assert.strictEqual(personas.size, 1);
    assert.ok(personas.has('planner'));
    assert.strictEqual(personas.get('planner').provider, 'copilot');
    assert.strictEqual(personas.get('planner').modelSelector.vendor, 'copilot');
    assert.strictEqual(personas.get('planner').modelSelector.family, 'gpt-4o');
  });

  test('uses hybrid persona parsing behavior', () => {
    const personas = readConfiguredPersonas([
      { alias: 'planner' },
    ]);

    const known = parsePersonaPrompt('@planner build a plan', personas);
    assert.strictEqual(known.persona.alias, 'planner');
    assert.strictEqual(known.routedPrompt, 'build a plan');
    assert.strictEqual(known.usedPersonaPrefix, true);

    const unknown = parsePersonaPrompt('@copilot plan this', personas);
    assert.strictEqual(unknown.persona, undefined);
    assert.strictEqual(unknown.routedPrompt, '@copilot plan this');
    assert.strictEqual(unknown.usedPersonaPrefix, false);
  });
});
