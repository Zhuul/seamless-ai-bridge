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

function activate(context) {
  // Lazy-start bridge process to simulate Codex backend
  let bridgeInstance;
  function getBridge() {
    if (bridgeInstance) return bridgeInstance;
    const cfg = vscode.workspace.getConfiguration();
    const configuredPath = cfg.get('seamlessAiBridge.path');
    const envPath = process.env.CODEX_BRIDGE_PATH || process.env.CODEX_CLI_PATH;
    const resolved = configuredPath || envPath || path.join(context.extensionUri.fsPath, 'bridge-echo.js');
    // Use fork for Node scripts, spawn otherwise
    const useFork = resolved.endsWith('.js') && !resolved.endsWith('.mjs');
    const child = useFork ? cp.fork(resolved, [], { silent: true }) : cp.spawn(resolved, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const pending = new Map(); // id -> { handler, timeout }

    function clearPending(id) {
      const entry = pending.get(id);
      if (!entry) return;
      clearTimeout(entry.timeout);
      pending.delete(id);
    }

    rl.on('line', (line) => {
      const raw = (line || '').trim();
      if (!raw) return;
      try {
        const payload = JSON.parse(raw);
        const id = payload && payload.id;
        if (id && pending.has(id)) {
          const { handler } = pending.get(id);
          try {
            const done = handler(payload) === true;
            if (done || payload.type === 'codex_reply') clearPending(id);
          } catch {
            clearPending(id);
          }
        }
      } catch {
        // ignore malformed lines
      }
    });

    child.on('error', (err) => {
      // Best-effort: fail any pending requests
      for (const [id, entry] of pending) {
        try { entry.handler({ type: 'error', text: `bridge error: ${err && err.message || String(err)}` }); } catch {}
        clearPending(id);
      }
    });

    child.on('exit', () => {
      for (const [id, entry] of pending) {
        try { entry.handler({ type: 'error', text: 'bridge exited' }); } catch {}
        clearPending(id);
      }
    });

    function send(text, handler) {
      const id = Math.random().toString(36).slice(2);
      let timeout;
      if (typeof handler === 'function') {
        timeout = setTimeout(() => {
          if (!pending.has(id)) return;
          const entry = pending.get(id);
          try { entry.handler({ type: 'timeout', text: 'No response from bridge' }); } catch {}
          clearPending(id);
        }, 30000);
        pending.set(id, { handler, timeout });
      }
      const payload = { id, text };
      try {
        child.stdin.write(JSON.stringify(payload) + '\n');
      } catch (e) {
        if (pending.has(id)) {
          const entry = pending.get(id);
          try { entry.handler({ type: 'error', text: String(e && e.message || e) }); } catch {}
          clearPending(id);
        }
      }
      return {
        id,
        cancel: () => clearPending(id),
      };
    }

    function dispose() {
      try { child.stdin.write('/exit\n'); } catch {}
      try { child.kill(); } catch {}
      try { rl.close(); } catch {}
      pending.clear();
    }

    bridgeInstance = { send, dispose };
    return bridgeInstance;
  }

  const participant = vscode.chat.createChatParticipant('seamless-ai-bridge', async (request, context, response, token) => {
    const prompt = (request.prompt || '').trim();

    if (prompt.startsWith('/exec ')) {
      const cmd = prompt.slice(6).trim();
      const cwd = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.workspace.workspaceFolders[0].uri.fsPath
        : undefined;
      response.markdown(`cwd: ${cwd || process.cwd()}`);
      response.markdown(`$ ${cmd}`);
      const { code, stdout, stderr } = await runShell(cmd, cwd, token);
      if (stdout) response.markdown(['```', stdout, '```'].join('\n'));
      if (stderr) response.markdown(['stderr:', '```', stderr, '```'].join('\n'));
      if (code !== 0) response.markdown(`Process exited with code ${code}`);
      return;
    }

    if (prompt.startsWith('/copilot ')) {
      const query = prompt.replace('/copilot ', '');
      const copilot = vscode.extensions.getExtension('GitHub.copilot-chat');
      if (copilot) {
        response.markdown(`Forwarding to Copilot (open its chat and send): ${query}`);
      } else {
        response.markdown('Copilot Chat extension not detected. Please enable it and try again.');
      }
      return;
    }

    // Default routing: anything not /exec or /copilot goes to the bridge.
    const isCodexPrefixed = prompt.startsWith('/codex ');
    const query = isCodexPrefixed ? prompt.slice(7).trim() : prompt;
    if (query) {
      response.markdown('Sending to Codex bridge…');
      const bridge = getBridge();
      const requestHandle = bridge.send(query, (payload) => {
        const kind = (payload && payload.type) || 'message';
        const text = (payload && payload.text) || '';
        if (kind === 'codex_delta') {
          response.markdown(text);
          return false; // keep streaming
        }
        if (kind === 'codex_reply') {
          response.markdown(text);
          return true; // done
        }
        if (kind === 'timeout') {
          response.markdown('Bridge timed out.');
          return true;
        }
        if (kind === 'error') {
          response.markdown(`Bridge error: ${text}`);
          return true;
        }
        response.markdown(`${kind}: ${text}`);
        return false;
      });
      if (token) {
        if (token.isCancellationRequested) {
          requestHandle.cancel();
          response.markdown('Cancelled');
          return;
        }
        token.onCancellationRequested(() => {
          requestHandle.cancel();
          response.markdown('Cancelled');
        });
      }
      return;
    }

    response.markdown('Use /exec to run shell commands, or just type to talk to the bridge. Use /copilot to route messages.');
  });

  context.subscriptions.push(participant);
  context.subscriptions.push(new vscode.Disposable(() => {
    try { if (bridgeInstance) bridgeInstance.dispose(); } catch {}
  }));
}

module.exports = { activate };
