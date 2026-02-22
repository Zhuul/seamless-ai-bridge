class ProviderInterface {
  constructor(id) {
    this.id = id;
  }

  supportsCapabilities() {
    return false;
  }

  async listModels(_context, _token) {
    return [];
  }

  async send(_request, _callbacks) {
    throw new Error(`Provider ${this.id} does not implement send`);
  }
}

module.exports = {
  ProviderInterface,
};
