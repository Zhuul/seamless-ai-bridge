class AgentManagerViewProvider {
  constructor(options) {
    this.options = options;
    this.view = undefined;
  }

  notifyStateChanged() {
    if (!this.view) return;
    this.view.webview.postMessage({
      type: 'state',
      agents: this.options.getAgents(),
      defaultCapabilities: this.options.getDefaultCapabilities(),
    });
  }

  async resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };
    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      const type = message && message.type;
      if (!type) return;

      if (type === 'ready') {
        this.notifyStateChanged();
        return;
      }

      if (type === 'requestModels') {
        const provider = typeof message.provider === 'string' ? message.provider : 'copilot';
        const models = await this.options.listModels(provider);
        webviewView.webview.postMessage({
          type: 'models',
          provider,
          models,
        });
        return;
      }

      if (type === 'saveAgent') {
        await this.options.saveAgent(message.agent);
        this.notifyStateChanged();
        return;
      }

      if (type === 'deleteAgent') {
        await this.options.deleteAgent(message.alias);
        this.notifyStateChanged();
        return;
      }

      if (type === 'resetAgentHistory') {
        await this.options.resetAgentHistory(message.alias);
        this.notifyStateChanged();
      }
    });
  }

  getHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 10px; }
    .row { margin-bottom: 8px; }
    label { display: block; margin-bottom: 4px; }
    input, select { width: 100%; box-sizing: border-box; }
    .caps { border: 1px solid var(--vscode-panel-border); padding: 8px; border-radius: 4px; }
    .warn { color: var(--vscode-editorWarning-foreground); font-size: 12px; margin-top: 6px; display: none; }
    .agent-list { margin-bottom: 12px; }
    .agent-btn { width: 100%; text-align: left; margin-bottom: 4px; }
    .actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="agent-list" id="agentList"></div>

  <div class="row">
    <label>Alias</label>
    <input id="alias" placeholder="planner" />
  </div>
  <div class="row">
    <label>Provider</label>
    <select id="provider">
      <option value="copilot">Copilot</option>
      <option value="codex">Codex</option>
    </select>
  </div>
  <div class="row">
    <label>Model</label>
    <select id="model"></select>
  </div>
  <div class="row">
    <label>Capabilities</label>
    <select id="capMode">
      <option value="default">Use Default</option>
      <option value="custom">Customize</option>
    </select>
    <div class="caps" id="capPanel" style="display:none;">
      <label><input type="checkbox" value="@workspace" /> @workspace</label>
      <label><input type="checkbox" value="@terminal" /> @terminal</label>
      <label><input type="checkbox" value="@vscode" /> @vscode</label>
      <div class="warn" id="terminalWarn">Warning: @terminal allows command execution and is considered dangerous.</div>
    </div>
  </div>
  <div class="row">
    <label><input id="historyPersistence" type="checkbox" checked /> History Persistence</label>
  </div>
  <div class="actions">
    <button id="newBtn">New</button>
    <button id="saveBtn">Save</button>
    <button id="deleteBtn">Delete</button>
    <button id="resetBtn">Reset History</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let state = { agents: [], defaultCapabilities: [] };
    let currentAlias = '';

    const alias = document.getElementById('alias');
    const provider = document.getElementById('provider');
    const model = document.getElementById('model');
    const capMode = document.getElementById('capMode');
    const capPanel = document.getElementById('capPanel');
    const historyPersistence = document.getElementById('historyPersistence');
    const terminalWarn = document.getElementById('terminalWarn');

    function selectedCapabilities() {
      return Array.from(capPanel.querySelectorAll('input[type="checkbox"]'))
        .filter((entry) => entry.checked)
        .map((entry) => entry.value);
    }

    function renderAgents() {
      const container = document.getElementById('agentList');
      container.innerHTML = '';
      for (const agent of state.agents) {
        const btn = document.createElement('button');
        btn.className = 'agent-btn';
        btn.textContent = '@' + agent.alias + ' (' + agent.provider + ':' + (agent.model || 'auto') + ')';
        btn.onclick = () => selectAgent(agent.alias);
        container.appendChild(btn);
      }
    }

    function refreshTerminalWarning() {
      terminalWarn.style.display = selectedCapabilities().includes('@terminal') ? 'block' : 'none';
    }

    function setModelOptions(models, selectedModel) {
      model.innerHTML = '';
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = 'auto';
      model.appendChild(blank);

      for (const entry of models || []) {
        const opt = document.createElement('option');
        opt.value = entry.id;
        opt.textContent = entry.label || entry.id;
        model.appendChild(opt);
      }

      model.value = selectedModel || '';
    }

    function selectAgent(aliasValue) {
      const found = state.agents.find((entry) => entry.alias === aliasValue);
      if (!found) return;
      currentAlias = found.alias;
      alias.value = found.alias;
      provider.value = found.provider || 'copilot';
      capMode.value = found.capabilitiesMode || 'default';
      historyPersistence.checked = found.historyPersistence !== false;
      capPanel.style.display = capMode.value === 'custom' ? 'block' : 'none';

      for (const checkbox of capPanel.querySelectorAll('input[type="checkbox"]')) {
        checkbox.checked = (found.capabilities || []).includes(checkbox.value);
      }
      refreshTerminalWarning();

      vscode.postMessage({ type: 'requestModels', provider: provider.value, selectedModel: found.model || '' });
      model.dataset.pendingModel = found.model || '';
    }

    provider.onchange = () => {
      vscode.postMessage({ type: 'requestModels', provider: provider.value });
    };

    capMode.onchange = () => {
      capPanel.style.display = capMode.value === 'custom' ? 'block' : 'none';
      refreshTerminalWarning();
    };

    for (const checkbox of capPanel.querySelectorAll('input[type="checkbox"]')) {
      checkbox.onchange = refreshTerminalWarning;
    }

    document.getElementById('newBtn').onclick = () => {
      currentAlias = '';
      alias.value = '';
      provider.value = 'copilot';
      model.value = '';
      capMode.value = 'default';
      capPanel.style.display = 'none';
      historyPersistence.checked = true;
      for (const checkbox of capPanel.querySelectorAll('input[type="checkbox"]')) {
        checkbox.checked = false;
      }
      refreshTerminalWarning();
      vscode.postMessage({ type: 'requestModels', provider: provider.value });
    };

    document.getElementById('saveBtn').onclick = () => {
      const nextAlias = String(alias.value || '').trim();
      if (!nextAlias) {
        return;
      }

      const capValue = capMode.value === 'custom' ? selectedCapabilities() : 'default';
      vscode.postMessage({
        type: 'saveAgent',
        agent: {
          alias: nextAlias,
          provider: provider.value,
          model: model.value,
          capabilities: capValue,
          historyPersistence: historyPersistence.checked,
        },
      });
    };

    document.getElementById('deleteBtn').onclick = () => {
      const target = String(alias.value || currentAlias || '').trim();
      if (!target) return;
      vscode.postMessage({ type: 'deleteAgent', alias: target });
    };

    document.getElementById('resetBtn').onclick = () => {
      const target = String(alias.value || currentAlias || '').trim();
      if (!target) return;
      vscode.postMessage({ type: 'resetAgentHistory', alias: target });
    };

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'state') {
        state = {
          agents: Array.isArray(message.agents) ? message.agents : [],
          defaultCapabilities: Array.isArray(message.defaultCapabilities) ? message.defaultCapabilities : [],
        };
        renderAgents();
        if (currentAlias) {
          selectAgent(currentAlias);
        }
      }

      if (message.type === 'models') {
        const pendingModel = model.dataset.pendingModel || '';
        setModelOptions(message.models, pendingModel);
        model.dataset.pendingModel = '';
      }
    });

    vscode.postMessage({ type: 'ready' });
    vscode.postMessage({ type: 'requestModels', provider: provider.value });
  </script>
</body>
</html>`;
  }
}

module.exports = {
  AgentManagerViewProvider,
};
