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
      failAll(err && err.message ? err.message : String(err));
    });

    child.on('exit', (code, signal) => {
      failAll(`bridge exited (${signal || code})`);
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

    stream.markdown('Sending to bridge...');
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
  });

  extensionContext.subscriptions.push(participant);
  extensionContext.subscriptions.push(new vscode.Disposable(() => {
    try { if (bridgeInstance) bridgeInstance.dispose(); } catch {}
  }));
}

module.exports = { activate };
