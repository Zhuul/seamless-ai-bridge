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

  function toCommandId(entry) {
    if (typeof entry === 'string') return entry;
    if (!entry || typeof entry !== 'object') return '';
    if (typeof entry.command === 'string') return entry.command;
    if (typeof entry.id === 'string') return entry.id;
    return '';
  }

  function getContributedCommandIds(extension) {
    const contributes = extension && extension.packageJSON && extension.packageJSON.contributes;
    const commands = contributes && contributes.commands;
    if (!Array.isArray(commands)) return [];

    const ids = [];
    for (const command of commands) {
      const id = toCommandId(command);
      if (id) ids.push(id);
    }
    return ids;
  }

  function getParticipantCommandHints(participantContribution) {
    const hints = new Set();
    const addHint = (value) => {
      if (typeof value !== 'string') return;
      const trimmed = value.trim();
      if (trimmed) hints.add(trimmed);
    };

    addHint(participantContribution && participantContribution.command);
    addHint(participantContribution && participantContribution.defaultCommand);

    const inlineCommands = participantContribution && participantContribution.commands;
    if (Array.isArray(inlineCommands)) {
      for (const command of inlineCommands) {
        addHint(toCommandId(command));
      }
    }

    const slashCommands = participantContribution && participantContribution.slashCommands;
    if (Array.isArray(slashCommands)) {
      for (const command of slashCommands) {
        addHint(toCommandId(command));
      }
    }

    return Array.from(hints);
  }

  function pickLinkedCommand(participantRecord, participantContribution, extensionCommandIds) {
    if (!Array.isArray(extensionCommandIds) || extensionCommandIds.length === 0) return '';

    const hinted = getParticipantCommandHints(participantContribution);
    for (const hint of hinted) {
      if (extensionCommandIds.includes(hint)) return hint;
    }

    const participantId = normalize(participantRecord.id);
    const shortIdRaw = String(participantRecord.id || '').split('.').pop() || '';
    const shortId = normalize(shortIdRaw);
    const participantName = normalize(participantRecord.name);
    const participantFullName = normalize(participantRecord.fullName);

    let bestCommand = '';
    let bestScore = 0;

    for (const commandId of extensionCommandIds) {
      const commandNorm = normalize(commandId);
      if (!commandNorm) continue;

      let score = 0;
      if (participantId && commandNorm === participantId) score += 100;
      if (participantId && commandNorm.includes(participantId)) score += 50;
      if (shortId && shortId.length >= 3 && commandNorm.includes(shortId)) score += 25;
      if (participantName && participantName.length >= 3 && commandNorm.includes(participantName)) score += 20;
      if (participantFullName && participantFullName.length >= 5 && commandNorm.includes(participantFullName)) score += 10;

      if (score > bestScore) {
        bestScore = score;
        bestCommand = commandId;
      }
    }

    return bestScore > 0 ? bestCommand : '';
  }

  function detectParticipantsAndCommands() {
    const participants = [];
    const participantCommands = new Map();

    for (const extension of vscode.extensions.all) {
      const contributes = extension
        && extension.packageJSON
        && extension.packageJSON.contributes;
      const contributedParticipants = contributes && contributes.chatParticipants;
      if (!Array.isArray(contributedParticipants)) continue;

      const extensionCommandIds = getContributedCommandIds(extension);

      for (const participant of contributedParticipants) {
        if (!participant || typeof participant.id !== 'string') continue;

        const record = {
          id: participant.id,
          name: typeof participant.name === 'string' ? participant.name : '',
          fullName: typeof participant.fullName === 'string' ? participant.fullName : '',
          extensionId: extension.id,
        };

        participants.push(record);

        const linkedCommand = pickLinkedCommand(record, participant, extensionCommandIds);
        if (linkedCommand) {
          participantCommands.set(record.id, linkedCommand);
        }
      }
    }

    return { participants, participantCommands };
  }

  let participantRegistry = new Map();
  let participantCommandRegistry = new Map();

  function refreshParticipantRegistry() {
    participantRegistry = new Map();
    participantCommandRegistry = new Map();

    const discovered = detectParticipantsAndCommands();

    log(`Detected ${discovered.participants.length} chat participant(s):`);
    for (const participant of discovered.participants) {
      participantRegistry.set(participant.id, participant);
      const label = participant.name ? `@${participant.name}` : '(no mention name)';
      log(`- ${label} id=${participant.id} extension=${participant.extensionId}`);

      const linkedCommand = discovered.participantCommands.get(participant.id);
      if (linkedCommand) {
        participantCommandRegistry.set(participant.id, linkedCommand);
        log(`  command=${linkedCommand}`);
      } else {
        log('  command=(not found)');
      }
    }

    if (discovered.participants.length === 0) {
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

  async function handleRequest(request, _chatContext, response, token) {
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

    if (!prompt) {
      response.markdown('Type a prompt for @bridge.');
      return;
    }

    const routed = parseRoutePrompt(prompt);
    if (routed) {
      const target = findParticipantByNameOrId(routed.targetName);

      if (target && target.id !== 'seamless-ai-bridge') {
        const forwardedPrompt = routed.routedPrompt || prompt;
        const commandId = participantCommandRegistry.get(target.id);

        if (!commandId) {
          log(`No command mapping found for participant id=${target.id}. Falling back to local bridge.`);
          response.markdown(`No command mapping found for @${routed.targetName}. Routing to local bridge.`);
          await routeToLocalBridge(forwardedPrompt, response, token);
          return;
        }

        log(`Routing prompt to @${routed.targetName} (id=${target.id}) via command ${commandId}.`);
        try {
          const result = await vscode.commands.executeCommand(commandId, {
            participant: target.id,
            prompt: forwardedPrompt,
            response,
            stream: response,
            token,
          });

          await streamForwardResult(result, response);
          return;
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          log(`Command routing failed for id=${target.id} command=${commandId}: ${message}`);
          log(`   - Error Name: ${error && error.name}`);
          log(`   - Error Message: ${error && error.message}`);
          log(`   - Error Stack: ${error && error.stack}`);
          response.markdown(`Unable to route to @${routed.targetName}. Routing to local bridge.`);
          await routeToLocalBridge(forwardedPrompt, response, token);
          return;
        }
      }

      if (!target) {
        log(`Participant @${routed.targetName} was not found. Falling back to local bridge.`);
        response.markdown(`Participant @${routed.targetName} not found. Routing to local bridge.`);
        await routeToLocalBridge(prompt, response, token);
        return;
      }

      // Target was this bridge itself (for example: @bridge @bridge ...)
      log('Target participant is local bridge. Routing locally.');
      await routeToLocalBridge(routed.routedPrompt, response, token);
      return;
    }

    log('No participant specified. Routing to local bridge.');
    await routeToLocalBridge(prompt, response, token);
  }

  const participant = vscode.chat.createChatParticipant('seamless-ai-bridge', handleRequest);

  extensionContext.subscriptions.push(participant);
  extensionContext.subscriptions.push(new vscode.Disposable(() => {
    try { if (bridgeInstance) bridgeInstance.dispose(); } catch {}
  }));
}

module.exports = { activate };
