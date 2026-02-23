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
  constructor(options) {
    if (options && typeof options.getAgents === 'function') {
      this.getAgents = options.getAgents;
      this.hasWorkspaceOpen = typeof options.hasWorkspaceOpen === 'function'
        ? options.hasWorkspaceOpen
        : (() => true);
    } else {
      const settingsService = options;
      this.getAgents = () => settingsService.getAgentsArray();
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

    const agents = this.getAgents();

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
