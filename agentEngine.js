const AGENT_SESSION_STORAGE_KEY = 'seamlessAiBridge.agentSessions.v5';
const AGENT_MAX_TURNS = 40;

function normalizeAgentAlias(value) {
  return String(value || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
}

function normalizeCapabilities(value, defaultCapabilities) {
  if (value === 'default' || value === undefined || value === null) {
    return {
      mode: 'default',
      values: Array.isArray(defaultCapabilities) ? [...defaultCapabilities] : [],
    };
  }

  if (Array.isArray(value)) {
    const clean = Array.from(new Set(value
      .filter((entry) => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean)));

    return {
      mode: 'custom',
      values: clean,
    };
  }

  return {
    mode: 'default',
    values: Array.isArray(defaultCapabilities) ? [...defaultCapabilities] : [],
  };
}

function migrateModel(rawAgent) {
  if (typeof rawAgent.model === 'string' && rawAgent.model.trim()) {
    return rawAgent.model.trim();
  }

  if (typeof rawAgent.modelSelector === 'string' && rawAgent.modelSelector.trim()) {
    return rawAgent.modelSelector.trim();
  }

  if (rawAgent.modelSelector && typeof rawAgent.modelSelector === 'object') {
    if (typeof rawAgent.modelSelector.id === 'string' && rawAgent.modelSelector.id.trim()) {
      return rawAgent.modelSelector.id.trim();
    }
    if (typeof rawAgent.modelSelector.family === 'string' && rawAgent.modelSelector.family.trim()) {
      return rawAgent.modelSelector.family.trim();
    }
  }

  return '';
}

function readConfiguredAgents(rawAgents, options) {
  const defaultCapabilities = options && Array.isArray(options.defaultCapabilities)
    ? options.defaultCapabilities
    : [];

  const source = Array.isArray(rawAgents) ? rawAgents : [];
  const agents = new Map();

  for (const entry of source) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.enabled === false) continue;

    const alias = normalizeAgentAlias(entry.alias);
    if (!alias) continue;
    if (agents.has(alias)) continue;

    const provider = typeof entry.provider === 'string' && entry.provider.trim()
      ? entry.provider.trim().toLowerCase()
      : 'copilot';

    if (provider !== 'copilot' && provider !== 'codex') continue;

    const capabilities = normalizeCapabilities(entry.capabilities, defaultCapabilities);

    agents.set(alias, {
      alias,
      name: typeof entry.name === 'string' ? entry.name.trim() : '',
      provider,
      model: migrateModel(entry),
      capabilitiesMode: capabilities.mode,
      capabilities: capabilities.values,
      historyPersistence: entry.historyPersistence !== false,
      metadata: {},
    });
  }

  return agents;
}

function parseAgentPrompt(prompt, agents) {
  const text = String(prompt || '').trim();
  const match = /^@([A-Za-z0-9._-]+)\s*([\s\S]*)$/.exec(text);

  if (!match) {
    return {
      agent: undefined,
      routedPrompt: text,
      usedAgentPrefix: false,
    };
  }

  const alias = normalizeAgentAlias(match[1]);
  const agent = agents instanceof Map ? agents.get(alias) : undefined;
  if (!agent) {
    return {
      agent: undefined,
      routedPrompt: text,
      usedAgentPrefix: false,
    };
  }

  return {
    agent,
    routedPrompt: String(match[2] || '').trim(),
    usedAgentPrefix: true,
  };
}

function getDangerousCapabilities() {
  return new Set(['@terminal']);
}

function createSessionManager(extensionContext, workspaceKey) {
  const keyPrefix = String(workspaceKey || 'global');
  const rawState = extensionContext.globalState.get(AGENT_SESSION_STORAGE_KEY, {});
  const sessions = new Map();

  const normalizeTurns = (turns) => {
    if (!Array.isArray(turns)) return [];
    return turns
      .filter((turn) => turn && typeof turn === 'object')
      .map((turn) => ({
        role: turn.role === 'assistant' ? 'assistant' : 'user',
        content: typeof turn.content === 'string' ? turn.content : '',
      }))
      .filter((turn) => turn.content)
      .slice(-AGENT_MAX_TURNS);
  };

  if (rawState && typeof rawState === 'object') {
    for (const [storageKey, turns] of Object.entries(rawState)) {
      if (!storageKey.startsWith(`${keyPrefix}|`)) continue;
      sessions.set(storageKey, normalizeTurns(turns));
    }
  }

  const composeKey = (agent) => `${keyPrefix}|${normalizeAgentAlias(agent.alias)}|${agent.provider}|${agent.model || 'default'}`;

  const persist = async () => {
    const current = extensionContext.globalState.get(AGENT_SESSION_STORAGE_KEY, {});
    const merged = { ...(current && typeof current === 'object' ? current : {}) };

    for (const key of Object.keys(merged)) {
      if (key.startsWith(`${keyPrefix}|`)) {
        delete merged[key];
      }
    }

    for (const [storageKey, turns] of sessions.entries()) {
      merged[storageKey] = normalizeTurns(turns);
    }

    await extensionContext.globalState.update(AGENT_SESSION_STORAGE_KEY, merged);
  };

  const getHistory = (agent) => {
    const storageKey = composeKey(agent);
    return [...(sessions.get(storageKey) || [])];
  };

  const appendTurns = async (agent, turns) => {
    const storageKey = composeKey(agent);
    const previous = sessions.get(storageKey) || [];
    const next = normalizeTurns([...previous, ...(Array.isArray(turns) ? turns : [])]);
    sessions.set(storageKey, next);
    await persist();
  };

  const clearAgent = async (alias) => {
    const normalizedAlias = normalizeAgentAlias(alias);
    for (const storageKey of Array.from(sessions.keys())) {
      const parts = storageKey.split('|');
      if (parts.length < 4) continue;
      if (parts[1] === normalizedAlias) {
        sessions.delete(storageKey);
      }
    }
    await persist();
  };

  return {
    getHistory,
    appendTurns,
    clearAgent,
  };
}

module.exports = {
  AGENT_SESSION_STORAGE_KEY,
  normalizeAgentAlias,
  readConfiguredAgents,
  parseAgentPrompt,
  getDangerousCapabilities,
  createSessionManager,
};
