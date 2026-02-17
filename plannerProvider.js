function serializePlan(plan) {
  return JSON.stringify(plan);
}

function compactDiagnostics(diagnostics, targetName) {
  const source = diagnostics && typeof diagnostics === 'object' ? diagnostics : {};
  const aliasAtoms = Array.isArray(source.aliasAtoms) ? source.aliasAtoms : [];
  const topCandidates = Array.isArray(source.topCandidates) ? source.topCandidates : [];

  return {
    target: targetName,
    aliasAtoms: aliasAtoms.slice(0, 8),
    candidateCount: typeof source.candidateCount === 'number' ? source.candidateCount : 0,
    topCandidates: topCandidates.slice(0, 3).map((entry) => ({
      id: entry && typeof entry.id === 'string' ? entry.id : '',
      score: entry && typeof entry.score === 'number' ? entry.score : 0,
    })),
  };
}

function fallbackResolveRouteTarget(targetName, options) {
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
    : (() => '');

  const dummyPrompt = `@${targetName} __probe__`;
  const parsed = parseRoutePrompt(dummyPrompt);
  const resolvedTarget = parsed && parsed.targetName ? parsed.targetName : targetName;

  const participant = findParticipantByNameOrId(resolvedTarget);
  if (!participant) {
    return {
      participant: undefined,
      commandId: '',
      linkScore: 0,
      linkReason: 'none',
      diagnostics: {
        target: resolvedTarget,
        aliasAtoms: [],
        candidateCount: 0,
        topCandidates: [],
      },
      retried: false,
    };
  }

  const commandId = getParticipantCommandById(participant.id);
  return {
    participant,
    commandId,
    linkScore: 0,
    linkReason: commandId ? 'legacy' : 'none',
    diagnostics: {
      target: resolvedTarget,
      aliasAtoms: [],
      candidateCount: 0,
      topCandidates: [],
    },
    retried: false,
  };
}

async function getPlan(userPrompt, context, options) {
  void context;

  const safePrompt = typeof userPrompt === 'string' ? userPrompt : '';
  const safeOptions = options || {};
  const helpers = safeOptions.helpers || {};

  const parseRoutePrompt = typeof helpers.parseRoutePrompt === 'function'
    ? helpers.parseRoutePrompt
    : (() => undefined);
  const resolveRouteTarget = typeof helpers.resolveRouteTarget === 'function'
    ? helpers.resolveRouteTarget
    : async (targetName, resolverOptions) => fallbackResolveRouteTarget(targetName, {
      helpers,
      resolverOptions,
    });

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

  const resolved = await resolveRouteTarget(routed.targetName, { retryOnMiss: true });
  const participant = resolved && resolved.participant;
  const diagnostics = compactDiagnostics(resolved && resolved.diagnostics, routed.targetName);

  if (!participant) {
    return serializePlan({
      mode: 'stable',
      prompt: safePrompt,
      reason: 'participant-not-found',
      targetName: routed.targetName,
      retryAttempted: Boolean(resolved && resolved.retried),
      diagnostics,
    });
  }

  if (participant.id === bridgeParticipantId) {
    return serializePlan({
      mode: 'stable',
      prompt: routedPrompt,
      reason: 'self-target',
      targetId: participant.id,
      targetName: routed.targetName,
      retryAttempted: Boolean(resolved && resolved.retried),
      diagnostics,
    });
  }

  if (isExperimentalMode && resolved.commandId) {
    return serializePlan({
      mode: 'experimental',
      prompt: routedPrompt,
      targetId: participant.id,
      targetName: routed.targetName,
      commandId: resolved.commandId,
      linkScore: resolved.linkScore || 0,
      linkReason: resolved.linkReason || 'none',
      retryAttempted: Boolean(resolved.retried),
    });
  }

  if (!resolved.commandId) {
    return serializePlan({
      mode: 'stable',
      prompt: routedPrompt,
      reason: 'no-command-mapping',
      targetId: participant.id,
      targetName: routed.targetName,
      retryAttempted: Boolean(resolved.retried),
      diagnostics,
    });
  }

  return serializePlan({
    mode: 'stable',
    prompt: routedPrompt,
    reason: 'experimental-disabled',
    targetId: participant.id,
    targetName: routed.targetName,
    commandId: resolved.commandId,
    retryAttempted: Boolean(resolved.retried),
  });
}

module.exports = {
  getPlan,
};
