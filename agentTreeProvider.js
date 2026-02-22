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

class AgentTreeProvider {
  constructor(getAgents) {
    this.getAgents = getAgents;
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
    const agents = this.getAgents();
    return agents.map((agent) => new AgentTreeItem(agent));
  }
}

module.exports = {
  AgentTreeProvider,
  AgentTreeItem,
};
