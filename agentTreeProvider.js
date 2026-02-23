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

class AgentTreeProvider {
  constructor(settingsService) {
    this.settingsService = settingsService;
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
    if (!this.settingsService || !this.settingsService.hasWorkspaceOpen()) {
      return [new AgentMessageItem('No workspace open. Agents are configured per-workspace.')];
    }

    const agents = this.settingsService.getAgentsArray();
    if (agents.length === 0) {
      return [new AgentMessageItem('No agents configured in this workspace.')];
    }

    return agents.map((agent) => new AgentTreeItem(agent));
  }
}

module.exports = {
  AgentTreeProvider,
  AgentTreeItem,
  AgentMessageItem,
};
