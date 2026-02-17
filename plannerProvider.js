function serializePlan(plan) {
  return JSON.stringify(plan);
}

async function getPlan(userPrompt, context, options) {
  void context;

  const safePrompt = typeof userPrompt === 'string' ? userPrompt : '';
  const safeOptions = options || {};
  const helpers = safeOptions.helpers || {};

  const parseRoutePrompt = typeof helpers.parseRoutePrompt === 'function'
    ? helpers.parseRoutePrompt
    : (() => undefined);
  const findParticipantByNameOrId = typeof helpers.findParticipantByNameOrId === 'function'
    ? helpers.findParticipantByNameOrId
    : (() => undefined);
  const getParticipantCommandById = typeof helpers.getParticipantCommandById === 'function'
    ? helpers.getParticipantCommandById
    : (() => undefined);

  const bridgeParticipantId = helpers.bridgeParticipantId || 'seamless-ai-bridge';
  const isExperimentalMode = Boolean(safeOptions.isExperimentalMode);

  const routed = parseRoutePrompt(safePrompt);
  if (!routed) {
    return serializePlan({
      mode: 'stable',
      prompt: safePrompt,
      reason: 'no-target',
    });
  }

  const routedPrompt = typeof routed.routedPrompt === 'string' && routed.routedPrompt
    ? routed.routedPrompt
    : safePrompt;

  const target = findParticipantByNameOrId(routed.targetName);
  if (!target) {
    return serializePlan({
      mode: 'stable',
      prompt: safePrompt,
      reason: 'participant-not-found',
      targetName: routed.targetName,
    });
  }

  if (target.id === bridgeParticipantId) {
    return serializePlan({
      mode: 'stable',
      prompt: routedPrompt,
      reason: 'self-target',
      targetId: target.id,
      targetName: routed.targetName,
    });
  }

  const commandId = getParticipantCommandById(target.id);

  if (isExperimentalMode && commandId) {
    return serializePlan({
      mode: 'experimental',
      prompt: routedPrompt,
      targetId: target.id,
      targetName: routed.targetName,
      commandId,
    });
  }

  if (!commandId) {
    return serializePlan({
      mode: 'stable',
      prompt: routedPrompt,
      reason: 'no-command-mapping',
      targetId: target.id,
      targetName: routed.targetName,
    });
  }

  return serializePlan({
    mode: 'stable',
    prompt: routedPrompt,
    reason: 'experimental-disabled',
    targetId: target.id,
    targetName: routed.targetName,
    commandId,
  });
}

module.exports = {
  getPlan,
};
