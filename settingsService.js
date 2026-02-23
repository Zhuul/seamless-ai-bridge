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

  getUserPersonasRaw() {
    const inspect = this.workspace.getConfiguration('seamlessAiBridge').inspect('personas');
    if (!inspect || !Array.isArray(inspect.globalValue)) {
      return [];
    }
    return inspect.globalValue;
  }

  getAgentSources() {
    const defaultCapabilities = this.getDefaultCapabilities();
    const workspaceAgentsMap = readConfiguredAgents(this.getWorkspaceScopedPersonasRaw(), { defaultCapabilities });
    const userAgentsMap = readConfiguredAgents(this.getUserPersonasRaw(), { defaultCapabilities });

    const legacyEntries = [];
    const legacyRootInspect = this.workspace.getConfiguration().inspect('seamless-ai-bridge.personas');
    if (legacyRootInspect && Array.isArray(legacyRootInspect.globalValue)) {
      legacyEntries.push(...legacyRootInspect.globalValue);
    }
    if (legacyRootInspect && Array.isArray(legacyRootInspect.workspaceValue)) {
      legacyEntries.push(...legacyRootInspect.workspaceValue);
    }

    for (const folder of this.workspace.workspaceFolders || []) {
      const legacyFolderInspect = this.workspace.getConfiguration(undefined, folder.uri).inspect('seamless-ai-bridge.personas');
      if (legacyFolderInspect && Array.isArray(legacyFolderInspect.workspaceFolderValue)) {
        legacyEntries.push(...legacyFolderInspect.workspaceFolderValue);
      }
    }

    const legacyAgentsMap = readConfiguredAgents(legacyEntries, { defaultCapabilities });

    const workspaceAgents = Array.from(workspaceAgentsMap.values())
      .sort((left, right) => left.alias.localeCompare(right.alias));
    const userAgents = Array.from(userAgentsMap.values())
      .sort((left, right) => left.alias.localeCompare(right.alias));
    const legacyAgents = Array.from(legacyAgentsMap.values())
      .sort((left, right) => left.alias.localeCompare(right.alias));

    const knownAliasSet = new Set();
    for (const agent of workspaceAgents) {
      knownAliasSet.add(normalizeAgentAlias(agent.alias));
    }
    for (const agent of userAgents) {
      knownAliasSet.add(normalizeAgentAlias(agent.alias));
    }
    for (const agent of legacyAgents) {
      knownAliasSet.add(normalizeAgentAlias(agent.alias));
    }

    return {
      workspaceAgents,
      userAgents,
      legacyAgents,
      knownAliases: Array.from(knownAliasSet).filter(Boolean).sort(),
    };
  }

  getConfiguredAgents() {
    const sources = this.getAgentSources();
    return new Map(sources.workspaceAgents.map((agent) => [normalizeAgentAlias(agent.alias), agent]));
  }

  getAgentsArray() {
    return this.getAgentSources().workspaceAgents;
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

    await this.workspace
      .getConfiguration()
      .update('seamless-ai-bridge.personas', undefined, vscode.ConfigurationTarget.Global);
  }

  async clearWorkspaceLevelAgents() {
    if (this.hasWorkspaceOpen()) {
      await this.workspace
        .getConfiguration('seamlessAiBridge')
        .update('personas', undefined, vscode.ConfigurationTarget.Workspace);

      await this.workspace
        .getConfiguration()
        .update('seamless-ai-bridge.personas', undefined, vscode.ConfigurationTarget.Workspace);

      for (const folder of this.workspace.workspaceFolders || []) {
        await this.workspace
          .getConfiguration('seamlessAiBridge', folder.uri)
          .update('personas', undefined, vscode.ConfigurationTarget.WorkspaceFolder);

        await this.workspace
          .getConfiguration(undefined, folder.uri)
          .update('seamless-ai-bridge.personas', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      }
    }
  }

  async wipeAllAgentsAndSettings() {
    await this.clearUserLevelAgents();
    await this.clearWorkspaceLevelAgents();
  }

  getKnownAliases() {
    return this.getAgentSources().knownAliases;
  }
}

module.exports = {
  SettingsService,
};
