const { ProviderInterface } = require('./providerInterface');

class CodexProvider extends ProviderInterface {
  constructor(options) {
    super('codex');
    const resolvedOptions = options || {};
    this.sendToBridge = typeof resolvedOptions.sendToBridge === 'function'
      ? resolvedOptions.sendToBridge
      : undefined;
  }

  supportsCapabilities() {
    return false;
  }

  async listModels() {
    return [
      { id: 'codex-default', label: 'codex-default' },
      { id: 'gpt-5.2-codex', label: 'gpt-5.2-codex' },
    ];
  }

  async send(request, callbacks) {
    if (!this.sendToBridge) {
      throw new Error('Codex provider bridge is not configured.');
    }

    const history = Array.isArray(request.history) ? request.history : [];
    const historyText = history
      .map((turn) => `${turn.role === 'assistant' ? 'assistant' : 'user'}: ${turn.content || ''}`)
      .join('\n');

    const prompt = [
      request.model ? `model: ${request.model}` : '',
      historyText ? `history:\n${historyText}` : '',
      `prompt: ${request.prompt}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const text = await this.sendToBridge(prompt, callbacks);
    return {
      text,
      metadata: {
        provider: 'codex',
        model: request.model || '',
      },
    };
  }
}

module.exports = {
  CodexProvider,
};
