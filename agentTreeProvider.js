const vscode = require('vscode');

class AgentTreeItem extends vscode.TreeItem {
  constructor(agent) {
    super(`@${agent.alias}`, vscode.TreeItemCollapsibleState.None);
    this.agent = agent;
    this.contextValue = 'seamlessAiBridge.agentItem';
    this.description = `${agent.provider}:${agent.model || 'auto'}${agent.historyPersistence ? '' : ' (stateless)'}`;
    this.tooltip = new vscode.MarkdownString([
      `**@${agent.alias}**`,
      `Provider: ${agent.provider}`,
      `Model: ${agent.model || 'auto'}`,
      `Capabilities: ${agent.capabilitiesMode === 'default' ? 'default' : (agent.capabilities || []).join(', ') || 'none'}`,
      `History Persistence: ${agent.historyPersistence ? 'on' : 'off'}`,
    ].join('\n\n'));
  }
}

class AgentMessageItem extends vscode.TreeItem {
  constructor(message) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'seamlessAiBridge.agentMessage';
  }
}

class AgentWarningItem extends vscode.TreeItem {
  constructor(aliases) {
    const list = Array.isArray(aliases) ? aliases.filter(Boolean) : [];
    const label = list.length === 1
      ? `⚠️ Global agent ignored: @${list[0]}`
      : `⚠️ Global agents ignored: ${list.map((alias) => `@${alias}`).join(', ')}`;

    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'seamlessAiBridge.agentWarning';
    this.tooltip = new vscode.MarkdownString([
      '**User-level agent settings are ignored.**',
      '',
      `Detected aliases: ${list.map((alias) => `@${alias}`).join(', ')}`,
      '',
      'Move these definitions into workspace `.vscode/settings.json`.',
    ].join('\n'));
  }
}

class AgentTreeProvider {
  constructor(options) {
    if (options && typeof options.getAgentDiagnostics === 'function') {
      this.getAgentDiagnostics = options.getAgentDiagnostics;
      this.hasWorkspaceOpen = typeof options.hasWorkspaceOpen === 'function'
        ? options.hasWorkspaceOpen
        : (() => true);
    } else {
      const settingsService = options;
      this.getAgentDiagnostics = () => settingsService.getAgentDiagnostics();
      this.hasWorkspaceOpen = () => settingsService.hasWorkspaceOpen();
    }
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element) {
    return element;
  }

  getChildren() {
    if (!this.hasWorkspaceOpen()) {
      return [new AgentMessageItem('No workspace open. Agents are configured per-workspace.')];
    }

    const diagnostics = this.getAgentDiagnostics();
    const agents = diagnostics.workspaceAgents;
    const rows = [];

    if (Array.isArray(diagnostics.globalOnlyAliases) && diagnostics.globalOnlyAliases.length > 0) {
      rows.push(new AgentWarningItem(diagnostics.globalOnlyAliases));
    }

    if (agents.length === 0) {
      rows.push(new AgentMessageItem('No agents configured in this workspace.'));
      return rows;
    }

    rows.push(...agents.map((agent) => new AgentTreeItem(agent)));
    return rows;
  }
}

module.exports = {
  AgentTreeProvider,
  AgentTreeItem,
  AgentMessageItem,
  AgentWarningItem,
};
