const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');

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

    const running = new Set();

    function send(text, handler) {
      const input = String(text || '');
      const isNodeScript = cliPath.endsWith('.js') || cliPath.endsWith('.mjs') || cliPath.endsWith('.cjs');
      const child = isNodeScript
        ? cp.spawn(process.execPath, [cliPath, input], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        : cp.spawn(cliPath, [input], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

      running.add(child);

      (async () => {
        try {
          for await (const chunk of child.stdout) {
            handler({ type: 'codex_delta', text: chunk.toString() });
          }
        } catch (err) {
          handler({
            type: 'error',
            text: `bridge stdout error: ${err && err.message ? err.message : String(err)}`,
          });
        }
      })();

      let stderr = '';
      (async () => {
        try {
          for await (const chunk of child.stderr) {
            stderr += chunk.toString();
          }
        } catch (err) {
          handler({
            type: 'error',
            text: `bridge stderr error: ${err && err.message ? err.message : String(err)}`,
          });
        }
      })();

      child.on('error', (err) => {
        running.delete(child);
        handler({
          type: 'error',
          text: `bridge error: ${err && err.message ? err.message : String(err)}`,
        });
      });

      child.on('close', (code) => {
        running.delete(child);
        const errText = stderr.trim();
        if (code === 0) {
          if (errText) {
            handler({ type: 'codex_delta', text: errText });
          }
          handler({ type: 'codex_reply', text: '' });
          return;
        }
        handler({ type: 'error', text: errText || `bridge exited with code ${code}` });
      });

      return {
        cancel: () => {
          try { child.kill(); } catch {}
          running.delete(child);
        },
      };
    }

    function dispose() {
      for (const child of running) {
        try { child.kill(); } catch {}
      }
      running.clear();
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

    const isCodexPrefixed = prompt.startsWith('/codex ');
    const query = isCodexPrefixed ? prompt.slice(7).trim() : prompt;
    if (query) {
      response.markdown('Sending to bridge...');
      const bridge = getBridge();
      const requestHandle = bridge.send(request.prompt || '', (payload) => {
        const kind = (payload && payload.type) || 'message';
        const text = (payload && payload.text) || '';
        if (kind === 'codex_delta') {
          response.markdown(text);
          return false;
        }
        if (kind === 'codex_reply') {
          if (text) response.markdown(text);
          return true;
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

  extensionContext.subscriptions.push(participant);
  extensionContext.subscriptions.push(new vscode.Disposable(() => {
    try { if (bridgeInstance) bridgeInstance.dispose(); } catch {}
  }));
}

module.exports = { activate };
