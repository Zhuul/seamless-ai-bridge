const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const readline = require('readline');

function runShell(command, cwd, token) {
  return new Promise((resolve) => {
    const child = cp.exec(command, { cwd, shell: true, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr });
    });

    if (token) {
      if (token.isCancellationRequested) {
        try { child.kill(); } catch {}
      }
      token.onCancellationRequested(() => {
        try { child.kill(); } catch {}
      });
    }
  });
}

function activate(extensionContext) {
  const output = vscode.window.createOutputChannel('Seamless AI Bridge');
  extensionContext.subscriptions.push(output);

  function log(message) {
    output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  function normalize(value) {
    return String(value || '').trim().toLowerCase();
  }

  function extractChunkText(chunk) {
    if (typeof chunk === 'string') return chunk;
    if (!chunk || typeof chunk !== 'object') return '';
    if (typeof chunk.value === 'string') return chunk.value;
    if (typeof chunk.text === 'string') return chunk.text;
    if (typeof chunk.markdown === 'string') return chunk.markdown;
    if (typeof chunk.content === 'string') return chunk.content;
    if (Array.isArray(chunk.content)) {
      return chunk.content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part.text === 'string') return part.text;
          if (part && typeof part.value === 'string') return part.value;
          return '';
        })
        .filter(Boolean)
        .join('');
    }
    return '';
  }

  function detectParticipants() {
    const found = [];

    for (const extension of vscode.extensions.all) {
      const contributed = extension
        && extension.packageJSON
        && extension.packageJSON.contributes
        && extension.packageJSON.contributes.chatParticipants;

      if (!Array.isArray(contributed)) continue;

      for (const participant of contributed) {
        if (!participant || typeof participant.id !== 'string') continue;

        found.push({
          id: participant.id,
          name: typeof participant.name === 'string' ? participant.name : '',
          fullName: typeof participant.fullName === 'string' ? participant.fullName : '',
          extensionId: extension.id,
        });
      }
    }

    return found;
  }

  let participantRegistry = new Map();

  function refreshParticipantRegistry() {
    participantRegistry = new Map();
    const discovered = detectParticipants();

    log(`Detected ${discovered.length} chat participant(s):`);
    for (const participant of discovered) {
      participantRegistry.set(participant.id, participant);
      const label = participant.name ? `@${participant.name}` : '(no mention name)';
      log(`- ${label} id=${participant.id} extension=${participant.extensionId}`);
    }

    if (discovered.length === 0) {
      log('- none');
    }
  }

  function findParticipantByNameOrId(rawName) {
    const needle = normalize(rawName);
    if (!needle) return undefined;

    for (const participant of participantRegistry.values()) {
      if (normalize(participant.name).includes(needle)) return participant;
      if (normalize(participant.id).includes(needle)) return participant;
      if (normalize(participant.fullName).includes(needle)) return participant;
    }

    return undefined;
  }

  function parseRoutePrompt(prompt) {
    const match = /^@([A-Za-z0-9._-]+)\s+([\s\S]+)$/.exec(prompt.trim());
    if (!match) return undefined;

    const targetName = match[1];
    const routedPrompt = match[2].trim();
    if (!routedPrompt) return undefined;

    return { targetName, routedPrompt };
  }

  async function streamForwardResult(result, stream) {
    let emitted = false;

    if (typeof result === 'string') {
      stream.markdown(result);
      return true;
    }

    if (!result) return false;

    if (typeof result.text === 'string' && result.text) {
      stream.markdown(result.text);
      emitted = true;
    }

    if (typeof result.markdown === 'string' && result.markdown) {
      stream.markdown(result.markdown);
      emitted = true;
    }

    const asyncStream = result.stream && typeof result.stream[Symbol.asyncIterator] === 'function'
      ? result.stream
      : (typeof result[Symbol.asyncIterator] === 'function' ? result : undefined);

    if (asyncStream) {
      for await (const chunk of asyncStream) {
        const text = extractChunkText(chunk);
        if (text) {
          stream.markdown(text);
          emitted = true;
        }
      }
    }

    return emitted;
  }

  async function tryForwardToParticipant(target, routedPrompt, stream, token) {
    const chatApi = vscode.chat;
    if (!chatApi || typeof chatApi !== 'object') {
      log('vscode.chat API is not available for forwarding.');
      return false;
    }

    const attempts = [
      {
        method: 'sendChatParticipantRequest',
        argSets: [
          [target.id, routedPrompt, token],
          [{ participant: target.id, prompt: routedPrompt }, token],
          [target.id, { prompt: routedPrompt }, token],
          [target.id, routedPrompt],
        ],
      },
      {
        method: 'requestChatParticipant',
        argSets: [
          [target.id, routedPrompt, token],
          [{ participant: target.id, prompt: routedPrompt }, token],
          [target.id, { prompt: routedPrompt }, token],
          [target.id, routedPrompt],
        ],
      },
      {
        method: 'sendRequest',
        argSets: [
          [target.id, routedPrompt, token],
          [{ participant: target.id, prompt: routedPrompt }, token],
          [target.id, { prompt: routedPrompt }, token],
          [target.id, routedPrompt],
        ],
      },
      {
        method: 'request',
        argSets: [
          [target.id, routedPrompt, token],
          [{ participant: target.id, prompt: routedPrompt }, token],
          [target.id, { prompt: routedPrompt }, token],
          [target.id, routedPrompt],
        ],
      },
    ];

    for (const attempt of attempts) {
      const fn = chatApi[attempt.method];
      if (typeof fn !== 'function') continue;

      for (const args of attempt.argSets) {
        try {
          log(`Attempting route via vscode.chat.${attempt.method} to id=${target.id}.`);
          const result = await fn.apply(chatApi, args);
          const emitted = await streamForwardResult(result, stream);
          log(`Routing succeeded via vscode.chat.${attempt.method} to id=${target.id}.`);
          if (!emitted) {
            stream.markdown(`Forwarded to @${target.name || target.id}.`);
          }
          return true;
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          log(`Routing attempt failed via ${attempt.method}: ${message}`);
          log(`Full error object: ${JSON.stringify(error)}`);
        }
      }
    }

    return false;
  }

  let bridgeInstance;

  function getBridge() {
    if (bridgeInstance) return bridgeInstance;

    const cfg = vscode.workspace.getConfiguration();
    const configuredPath = cfg.get('seamlessAiBridge.path');
    const envPath = process.env.SEAMLESS_AI_BRIDGE_PATH
      || process.env.SEAMLESS_AI_CLI_PATH
      || process.env.CODEX_BRIDGE_PATH
      || process.env.CODEX_CLI_PATH;
    const cliPath = configuredPath || envPath || path.join(extensionContext.extensionPath, 'bridge-echo.js');

    log(`Using local bridge path: ${cliPath}`);

    const isNodeScript = cliPath.endsWith('.js') || cliPath.endsWith('.mjs') || cliPath.endsWith('.cjs');
    const child = isNodeScript
      ? cp.spawn(process.execPath, [cliPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      : cp.spawn(cliPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const pending = new Map(); // id -> { stream, timeout, resolve, reject }

    function takePending(id) {
      const entry = pending.get(id);
      if (!entry) return null;
      clearTimeout(entry.timeout);
      pending.delete(id);
      return entry;
    }

    function failPending(id, message) {
      const entry = takePending(id);
      if (!entry) return;
      entry.reject(new Error(message));
    }

    function failAll(message) {
      for (const [id] of pending) {
        failPending(id, message);
      }
    }

    rl.on('line', (line) => {
      const raw = (line || '').trim();
      if (!raw) return;

      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        // Fallback for non-JSON bridge output: route to first pending request.
        const first = pending.entries().next();
        if (!first.done) {
          const [, entry] = first.value;
          entry.stream.markdown(raw);
        }
        return;
      }

      const id = payload && payload.id;
      if (!id || !pending.has(id)) return;

      const entry = pending.get(id);
      const kind = payload.type || 'codex_delta';
      const text = typeof payload.text === 'string' ? payload.text : '';

      if (kind === 'codex_delta') {
        if (text) entry.stream.markdown(text);
        return;
      }

      if (kind === 'codex_reply') {
        if (text) entry.stream.markdown(text);
        const done = takePending(id);
        if (done) done.resolve();
        return;
      }

      if (kind === 'error') {
        failPending(id, text || 'unknown error');
        return;
      }

      if (text) entry.stream.markdown(text);
    });

    child.on('error', (err) => {
      const message = err && err.message ? err.message : String(err);
      log(`Local bridge process error: ${message}`);
      failAll(message);
    });

    child.on('exit', (code, signal) => {
      const message = `local bridge exited (${signal || code})`;
      log(message);
      failAll(message);
    });

    function send(text, stream, token) {
      return new Promise((resolve, reject) => {
        const id = Math.random().toString(36).slice(2);
        const timeout = setTimeout(() => {
          const entry = takePending(id);
          if (!entry) return;
          entry.reject(new Error('Bridge timed out.'));
        }, 30000);

        pending.set(id, { stream, timeout, resolve, reject });

        const cancel = () => {
          const entry = takePending(id);
          if (!entry) return;
          entry.reject(new Error('Cancelled'));
        };

        if (token) {
          if (token.isCancellationRequested) {
            cancel();
            return;
          }
          token.onCancellationRequested(cancel);
        }

        try {
          child.stdin.write(`${JSON.stringify({ id, text })}\n`);
        } catch (err) {
          const entry = takePending(id);
          if (!entry) return;
          entry.reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    }

    function dispose() {
      failAll('bridge disposed');
      try { rl.close(); } catch {}
      try { child.kill(); } catch {}
    }

    bridgeInstance = { send, dispose };
    return bridgeInstance;
  }

  async function routeToLocalBridge(prompt, stream, token) {
    const bridge = getBridge();
    try {
      await bridge.send(prompt, stream, token);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (message === 'Cancelled') {
        stream.markdown('Cancelled');
      } else {
        stream.markdown(`Error: ${message}`);
      }
    }
  }

  log('Activating Seamless AI Bridge.');
  refreshParticipantRegistry();

  const participant = vscode.chat.createChatParticipant('seamless-ai-bridge', async (request, _chatContext, stream, token) => {
    const prompt = (request.prompt || '').trim();

    if (prompt.startsWith('/exec ')) {
      const cmd = prompt.slice(6).trim();
      const cwd = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.workspace.workspaceFolders[0].uri.fsPath
        : undefined;
      stream.markdown(`cwd: ${cwd || process.cwd()}`);
      stream.markdown(`$ ${cmd}`);
      const { code, stdout, stderr } = await runShell(cmd, cwd, token);
      if (stdout) stream.markdown(['```', stdout, '```'].join('\n'));
      if (stderr) stream.markdown(['stderr:', '```', stderr, '```'].join('\n'));
      if (code !== 0) stream.markdown(`Process exited with code ${code}`);
      return;
    }

    if (!prompt) {
      stream.markdown('Type a prompt for @bridge.');
      return;
    }

    const routed = parseRoutePrompt(prompt);
    if (routed) {
      const target = findParticipantByNameOrId(routed.targetName);

      if (target && target.id !== 'seamless-ai-bridge') {
        log(`Routing prompt to @${routed.targetName} (id=${target.id}).`);
        const forwarded = await tryForwardToParticipant(target, routed.routedPrompt, stream, token);
        if (forwarded) return;

        log(`Failed to forward to id=${target.id}. Falling back to local bridge.`);
        stream.markdown(`Unable to route to @${routed.targetName}. Routing to local bridge.`);
        await routeToLocalBridge(routed.routedPrompt, stream, token);
        return;
      }

      if (!target) {
        log(`Participant @${routed.targetName} was not found. Falling back to local bridge.`);
        stream.markdown(`Participant @${routed.targetName} not found. Routing to local bridge.`);
        await routeToLocalBridge(prompt, stream, token);
        return;
      }

      // Target was this bridge itself (for example: @bridge @bridge ...)
      log('Target participant is local bridge. Routing locally.');
      await routeToLocalBridge(routed.routedPrompt, stream, token);
      return;
    }

    log('No participant specified. Routing to local bridge.');
    await routeToLocalBridge(prompt, stream, token);
  });

  extensionContext.subscriptions.push(participant);
  extensionContext.subscriptions.push(new vscode.Disposable(() => {
    try { if (bridgeInstance) bridgeInstance.dispose(); } catch {}
  }));
}

module.exports = { activate };
