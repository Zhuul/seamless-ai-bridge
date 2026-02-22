const vscode = require('vscode');
const { ProviderInterface } = require('./providerInterface');

const MAX_WORKSPACE_CONTEXT_ENTRIES = 1200;
const MAX_WORKSPACE_CONTEXT_DEPTH = 8;
const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.next',
  '.nuxt',
  'dist',
  'build',
  '.turbo',
]);

function toPosixRelative(basePath, name) {
  if (!basePath) return name;
  return `${basePath}/${name}`;
}

async function collectWorkspaceEntries(token) {
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  const entries = [];
  let truncated = false;

  if (workspaceFolders.length === 0) {
    return { entries, truncated };
  }

  const walk = async (uri, relativePath, depth) => {
    if (truncated || (token && token.isCancellationRequested)) return;
    if (depth > MAX_WORKSPACE_CONTEXT_DEPTH) return;

    let directoryEntries;
    try {
      directoryEntries = await vscode.workspace.fs.readDirectory(uri);
    } catch {
      return;
    }

    directoryEntries.sort((left, right) => left[0].localeCompare(right[0]));

    for (const [name, fileType] of directoryEntries) {
      if (truncated || (token && token.isCancellationRequested)) return;

      const nextPath = toPosixRelative(relativePath, name);
      const isDirectory = Boolean(fileType & vscode.FileType.Directory);

      if (entries.length >= MAX_WORKSPACE_CONTEXT_ENTRIES) {
        truncated = true;
        return;
      }

      if (isDirectory) {
        entries.push(`${nextPath}/`);
        if (IGNORED_DIRECTORIES.has(name)) continue;
        await walk(vscode.Uri.joinPath(uri, name), nextPath, depth + 1);
      } else {
        entries.push(nextPath);
      }
    }
  };

  for (const folder of workspaceFolders) {
    if (truncated || (token && token.isCancellationRequested)) break;
    const rootName = folder.name || folder.uri.path.split('/').pop() || 'workspace';
    entries.push(`${rootName}/`);
    await walk(folder.uri, rootName, 0);
  }

  if (entries.length > MAX_WORKSPACE_CONTEXT_ENTRIES) {
    entries.length = MAX_WORKSPACE_CONTEXT_ENTRIES;
    truncated = true;
  }

  return { entries, truncated };
}

function withWorkspaceContext(prompt, workspaceContext) {
  if (!workspaceContext || !Array.isArray(workspaceContext.entries) || workspaceContext.entries.length === 0) {
    return prompt;
  }

  const suffix = workspaceContext.truncated
    ? '\n- ... (truncated)'
    : '';

  const contextBlock = [
    'Workspace index (paths relative to workspace root):',
    ...workspaceContext.entries.map((entry) => `- ${entry}`),
    suffix,
  ]
    .filter(Boolean)
    .join('\n');

  return [
    prompt,
    '',
    '[Additional context for this request]',
    contextBlock,
    '[/Additional context]',
  ].join('\n');
}

function toLanguageModelMessages(historyTurns, prompt) {
  const messages = [];

  for (const turn of historyTurns || []) {
    if (!turn || typeof turn !== 'object') continue;
    const content = typeof turn.content === 'string' ? turn.content : '';
    if (!content) continue;

    if (turn.role === 'assistant') {
      messages.push(vscode.LanguageModelChatMessage.Assistant(content));
    } else {
      messages.push(vscode.LanguageModelChatMessage.User(content));
    }
  }

  messages.push(vscode.LanguageModelChatMessage.User(prompt));
  return messages;
}

class CopilotProvider extends ProviderInterface {
  constructor() {
    super('copilot');
  }

  supportsCapabilities() {
    return true;
  }

  async buildCapabilityPrompt(prompt, capabilities, onDebug, token) {
    const capabilitySet = new Set(Array.isArray(capabilities) ? capabilities : []);
    if (!capabilitySet.has('@workspace')) {
      return prompt;
    }

    const workspaceContext = await collectWorkspaceEntries(token);
    if (typeof onDebug === 'function') {
      onDebug({
        type: 'provider-workspace-context',
        provider: 'copilot',
        entryCount: workspaceContext.entries.length,
        truncated: workspaceContext.truncated,
      });
    }

    return withWorkspaceContext(prompt, workspaceContext);
  }

  async listModels(_context, token) {
    try {
      const models = await vscode.lm.selectChatModels({ vendor: 'copilot' }, token);
      return (models || []).map((model, index) => {
        const id = typeof model.id === 'string' && model.id
          ? model.id
          : (typeof model.name === 'string' && model.name
            ? model.name
            : `copilot-model-${index + 1}`);

        return {
          id,
          label: id,
        };
      });
    } catch {
      return [];
    }
  }

  async resolveModel(modelId, requestModel, onDebug, token) {
    if (!modelId) return requestModel;

    const selectors = [
      { vendor: 'copilot', id: modelId },
      { vendor: 'copilot', family: modelId },
    ];

    for (const selector of selectors) {
      try {
        const candidates = await vscode.lm.selectChatModels(selector, token);
        if (Array.isArray(candidates) && candidates.length > 0) {
          return candidates[0];
        }
      } catch (error) {
        if (typeof onDebug === 'function') {
          onDebug({
            type: 'provider-model-resolution',
            provider: 'copilot',
            modelId,
            selector,
            message: error && error.message ? error.message : String(error),
          });
        }
      }
    }

    return requestModel;
  }

  async send(request, callbacks) {
    const onToken = callbacks && typeof callbacks.onToken === 'function' ? callbacks.onToken : () => {};
    const onDebug = callbacks && typeof callbacks.onDebug === 'function' ? callbacks.onDebug : undefined;
    const token = callbacks ? callbacks.token : undefined;

    const model = await this.resolveModel(request.model, request.requestModel, onDebug, token);
    const enrichedPrompt = await this.buildCapabilityPrompt(
      request.prompt,
      request.capabilities,
      onDebug,
      token,
    );
    const messages = toLanguageModelMessages(request.history, enrichedPrompt);
    const response = await model.sendRequest(messages, {}, token);

    let text = '';
    for await (const fragment of response.text) {
      const value = typeof fragment === 'string' ? fragment : '';
      if (!value) continue;
      text += value;
      onToken(value);
    }

    return {
      text,
      metadata: {
        provider: 'copilot',
        model: request.model || '',
      },
    };
  }
}

module.exports = {
  CopilotProvider,
};
