const vscode = require('vscode');
const { ProviderInterface } = require('./providerInterface');

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
    return false;
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
    const messages = toLanguageModelMessages(request.history, request.prompt);
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
