function parsePlan(planText, fallbackPrompt) {
  if (planText && typeof planText === 'object') {
    return planText;
  }

  if (typeof planText === 'string') {
    try {
      const parsed = JSON.parse(planText);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {
      // Fallback to stable execution below.
    }
  }

  return {
    mode: 'stable',
    prompt: fallbackPrompt,
    reason: 'invalid-plan',
  };
}

function isCancelledError(error) {
  if (!error) return false;
  const message = error && error.message ? error.message : String(error);
  return message === 'Cancelled';
}

function executeWithGuards(executor, token, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutHandle;
    let cancelDisposable;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      if (cancelDisposable && typeof cancelDisposable.dispose === 'function') {
        cancelDisposable.dispose();
      }

      fn(value);
    };

    if (token && token.isCancellationRequested) {
      finish(reject, new Error('Cancelled'));
      return;
    }

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        finish(reject, new Error(`Experimental provider timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    }

    if (token && typeof token.onCancellationRequested === 'function') {
      cancelDisposable = token.onCancellationRequested(() => {
        finish(reject, new Error('Cancelled'));
      });
    }

    Promise.resolve()
      .then(() => executor())
      .then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
  });
}

function writeMarkdown(response, text) {
  if (!response || typeof response.markdown !== 'function' || !text) return;
  response.markdown(text);
}

function safeLog(log, message) {
  if (typeof log === 'function') {
    log(message);
  }
}

function shortFallbackMessage(plan) {
  if (!plan || typeof plan !== 'object') return '';

  if (plan.reason === 'participant-not-found' && plan.targetName) {
    return `Participant @${plan.targetName} not found. Routing to local bridge.`;
  }

  if (plan.reason === 'no-command-mapping' && plan.targetName) {
    return `No command mapping found for @${plan.targetName}. Routing to local bridge.`;
  }

  if (plan.reason === 'experimental-disabled') {
    return '';
  }

  return '';
}

async function getCode(planText, context, options) {
  const safeContext = context || {};
  const safeOptions = options || {};
  const helpers = safeOptions.helpers || {};

  const response = safeOptions.response;
  const token = safeOptions.token;
  const isExperimentalMode = Boolean(safeOptions.isExperimentalMode);
  const timeoutMs = typeof safeOptions.experimentalTimeoutMs === 'number'
    ? safeOptions.experimentalTimeoutMs
    : 12000;

  const fallbackPrompt = typeof safeContext.userPrompt === 'string' ? safeContext.userPrompt : '';
  const plan = parsePlan(planText, fallbackPrompt);
  const prompt = typeof plan.prompt === 'string' ? plan.prompt : fallbackPrompt;

  const routeToLocalBridge = helpers.routeToLocalBridge;
  const executeCommand = helpers.executeCommand;
  const streamForwardResult = typeof helpers.streamForwardResult === 'function'
    ? helpers.streamForwardResult
    : (async () => false);
  const getResponseCount = typeof helpers.getResponseCount === 'function'
    ? helpers.getResponseCount
    : (() => 0);
  const log = helpers.log;
  const debugLog = typeof helpers.debugLog === 'function' ? helpers.debugLog : undefined;

  if (token && token.isCancellationRequested) {
    throw new Error('Cancelled');
  }

  if (typeof routeToLocalBridge !== 'function') {
    throw new Error('routeToLocalBridge helper is required.');
  }

  if (!isExperimentalMode || plan.mode !== 'experimental') {
    const message = shortFallbackMessage(plan);
    if (message) {
      writeMarkdown(response, message);
    }

    if (plan.reason === 'no-command-mapping' && plan.diagnostics) {
      if (debugLog) {
        debugLog({
          type: 'no-command-mapping',
          diagnostics: plan.diagnostics,
        });
      }
    }

    await routeToLocalBridge(prompt, response, token);
    return { source: 'stable', plan };
  }

  if (!plan.commandId || !plan.targetId || typeof executeCommand !== 'function') {
    safeLog(log, 'Experimental plan is missing command metadata. Falling back to stable provider.');
    await routeToLocalBridge(prompt, response, token);
    return { source: 'stable-fallback', reason: 'invalid-experimental-plan', plan };
  }

  try {
    const beforeCount = getResponseCount();
    const result = await executeWithGuards(
      () => executeCommand(plan.commandId, {
        participant: plan.targetId,
        prompt,
        response,
        stream: response,
        token,
      }),
      token,
      timeoutMs,
    );

    const emitted = await streamForwardResult(result, response);
    const afterCount = getResponseCount();

    if (!emitted && afterCount === beforeCount) {
      throw new Error('Experimental command result was unusable.');
    }

    return { source: 'experimental', plan };
  } catch (error) {
    if (isCancelledError(error)) {
      throw error;
    }

    const message = error && error.message ? error.message : String(error);
    safeLog(log, `Experimental provider failed for id=${plan.targetId} command=${plan.commandId}: ${message}`);

    if (plan.targetName) {
      writeMarkdown(response, `Unable to route to @${plan.targetName}. Routing to local bridge.`);
    }

    await routeToLocalBridge(prompt, response, token);
    return { source: 'stable-fallback', reason: message, plan };
  }
}

module.exports = {
  getCode,
};
