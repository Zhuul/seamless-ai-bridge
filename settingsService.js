const vscode = require('vscode');
const {
  readConfiguredAgents,
  normalizeAgentAlias,
} = require('./agentEngine');

class SettingsService {
  constructor(workspace = vscode.workspace) {
    this.workspace = workspace;
  }

  hasWorkspaceOpen() {
    return Boolean(this.workspace.workspaceFolders && this.workspace.workspaceFolders.length > 0);
  }

  getDefaultCapabilities() {
    const bridgeConfig = this.workspace.getConfiguration('seamlessAiBridge');
    const configured = bridgeConfig.get('defaultCapabilities', ['@workspace']);
    return Array.isArray(configured)
      ? configured
        .filter((entry) => typeof entry === 'string' && entry.trim())
        .map((entry) => entry.trim())
      : ['@workspace'];
  }

  getWorkspaceScopedPersonasRaw() {
    if (!this.hasWorkspaceOpen()) {
      return [];
    }

    const workspaceFolders = this.workspace.workspaceFolders || [];
    const fromFolders = [];

    for (const folder of workspaceFolders) {
      const inspect = this.workspace
        .getConfiguration('seamlessAiBridge', folder.uri)
        .inspect('personas');

      const folderValue = inspect && Array.isArray(inspect.workspaceFolderValue)
        ? inspect.workspaceFolderValue
        : [];

      if (folderValue.length > 0) {
        fromFolders.push(...folderValue);
      }
    }

    const rootInspect = this.workspace.getConfiguration('seamlessAiBridge').inspect('personas');
    const workspaceValue = rootInspect && Array.isArray(rootInspect.workspaceValue)
      ? rootInspect.workspaceValue
      : [];

    return [...fromFolders, ...workspaceValue];
  }

  getGlobalPersonasRaw() {
    const inspect = this.workspace.getConfiguration('seamlessAiBridge').inspect('personas');
    if (!inspect || !Array.isArray(inspect.globalValue)) {
      return [];
    }
    return inspect.globalValue;
  }

  getLegacyGlobalPersonasRaw() {
    const inspect = this.workspace.getConfiguration('seamless-ai-bridge').inspect('personas');
    if (!inspect || !Array.isArray(inspect.globalValue)) {
      return [];
    }
    return inspect.globalValue;
  }

  getAgentDiagnostics() {
    const defaultCapabilities = this.getDefaultCapabilities();
    const workspaceAgentsMap = readConfiguredAgents(this.getWorkspaceScopedPersonasRaw(), { defaultCapabilities });
    const globalAgentsMap = readConfiguredAgents(this.getGlobalPersonasRaw(), { defaultCapabilities });
    const legacyGlobalAgentsMap = readConfiguredAgents(this.getLegacyGlobalPersonasRaw(), { defaultCapabilities });

    const workspaceAgents = Array.from(workspaceAgentsMap.values())
      .sort((left, right) => left.alias.localeCompare(right.alias));
    const globalAgents = Array.from(globalAgentsMap.values())
      .sort((left, right) => left.alias.localeCompare(right.alias));
    const legacyGlobalAgents = Array.from(legacyGlobalAgentsMap.values())
      .sort((left, right) => left.alias.localeCompare(right.alias));

    const workspaceAliasSet = new Set(workspaceAgents.map((agent) => normalizeAgentAlias(agent.alias)));
    const globalOnlyAliases = globalAgents
      .map((agent) => normalizeAgentAlias(agent.alias))
      .filter((alias) => alias && !workspaceAliasSet.has(alias))
      .sort();

    return {
      workspaceAgents,
      globalAgents,
      globalOnlyAliases,
      legacyGlobalAgents,
    };
  }

  getConfiguredAgents() {
    const diagnostics = this.getAgentDiagnostics();
    return new Map(diagnostics.workspaceAgents.map((agent) => [normalizeAgentAlias(agent.alias), agent]));
  }

  getAgentsArray() {
    return this.getAgentDiagnostics().workspaceAgents;
  }

  async updateWorkspacePersonas(rawPersonas) {
    if (!this.hasWorkspaceOpen()) {
      throw new Error('No workspace open. Agents are configured per-workspace.');
    }

    const bridgeConfig = this.workspace.getConfiguration('seamlessAiBridge');
    const next = Array.isArray(rawPersonas) ? rawPersonas : [];
    await bridgeConfig.update('personas', next, vscode.ConfigurationTarget.Workspace);
  }

  async upsertAgent(agentInput) {
    if (!this.hasWorkspaceOpen()) {
      throw new Error('No workspace open. Agents are configured per-workspace.');
    }

    const personas = [...this.getWorkspaceScopedPersonasRaw()];
    const alias = normalizeAgentAlias(agentInput && agentInput.alias);
    if (!alias) {
      throw new Error('Agent alias is required.');
    }

    const provider = typeof (agentInput && agentInput.provider) === 'string' && agentInput.provider.trim()
      ? agentInput.provider.trim().toLowerCase()
      : 'copilot';
    const model = typeof (agentInput && agentInput.model) === 'string' ? agentInput.model.trim() : '';
    const historyPersistence = Boolean(agentInput ? agentInput.historyPersistence !== false : true);
    const capabilities = Array.isArray(agentInput && agentInput.capabilities)
      ? Array.from(new Set(agentInput.capabilities
        .filter((entry) => typeof entry === 'string' && entry.trim())
        .map((entry) => entry.trim())))
      : 'default';

    const nextAgent = {
      alias,
      provider,
      historyPersistence,
      capabilities,
      enabled: true,
    };

    if (model) {
      nextAgent.model = model;
    }

    const index = personas.findIndex((entry) => normalizeAgentAlias(entry && entry.alias) === alias);
    if (index >= 0) {
      personas[index] = {
        ...personas[index],
        ...nextAgent,
      };
    } else {
      personas.push(nextAgent);
    }

    await this.updateWorkspacePersonas(personas);
  }

  async removeAgent(alias) {
    if (!this.hasWorkspaceOpen()) {
      return;
    }

    const targetAlias = normalizeAgentAlias(alias);
    if (!targetAlias) return;

    const personas = this.getWorkspaceScopedPersonasRaw();
    const next = personas.filter((entry) => normalizeAgentAlias(entry && entry.alias) !== targetAlias);
    await this.updateWorkspacePersonas(next);
  }

  async clearUserLevelAgents() {
    const primaryConfig = this.workspace.getConfiguration('seamlessAiBridge');
    await primaryConfig.update('personas', undefined, vscode.ConfigurationTarget.Global);

    const legacyConfig = this.workspace.getConfiguration('seamless-ai-bridge');
    await legacyConfig.update('personas', undefined, vscode.ConfigurationTarget.Global);
  }
}

module.exports = {
  SettingsService,
};
