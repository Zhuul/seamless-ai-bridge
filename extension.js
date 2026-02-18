const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const readline = require('readline');
const plannerProvider = require('./plannerProvider');
const coderProvider = require('./coderProvider');

const BLACKLIST_TOKENS = new Set(['test', 'debug', 'internal', 'sample']);
const CORE_CHAT_TOKENS = new Set(['copilot', 'codex']);
const OPERATIONAL_INTENT_TOKENS = new Set(['apply', 'replay', 'session', 'enable', 'disable']);

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

function normalizeAtom(value) {
  const text = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  return text.replace(/[^a-z0-9]+/g, '');
}

function tokenize(value) {
  const input = String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase();

  const tokens = input.match(/[a-z0-9]+/g) || [];
  return tokens.filter((token) => token.length >= 2);
}

function unique(items) {
  return Array.from(new Set(items));
}

function tokenOverlapRatio(referenceTokens, candidateTokens) {
  const reference = unique(referenceTokens || []);
  const candidate = new Set(unique(candidateTokens || []));
  if (reference.length === 0) return 0;

  let overlap = 0;
  for (const token of reference) {
    if (candidate.has(token)) overlap += 1;
  }

  return overlap / reference.length;
}

function containsOrderedTokenSequence(haystackTokens, needleTokens) {
  const haystack = haystackTokens || [];
  const needle = needleTokens || [];
  if (needle.length === 0) return false;

  let position = 0;
  for (const token of haystack) {
    if (token === needle[position]) {
      position += 1;
      if (position === needle.length) return true;
    }
  }

  return false;
}

function toCommandId(entry) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return '';
  if (typeof entry.command === 'string') return entry.command;
  if (typeof entry.id === 'string') return entry.id;
  return '';
}

function getParticipantCommandHints(participantContribution) {
  const hints = new Set();
  const slashNames = [];

  const addHint = (value) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed) hints.add(trimmed);
  };

  const addSlashName = (value) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed) slashNames.push(trimmed);
  };

  addHint(participantContribution && participantContribution.command);
  addHint(participantContribution && participantContribution.defaultCommand);

  const inlineCommands = participantContribution && participantContribution.commands;
  if (Array.isArray(inlineCommands)) {
    for (const command of inlineCommands) {
      addHint(toCommandId(command));
      if (command && typeof command.name === 'string') {
        addSlashName(command.name);
      }
    }
  }

  const slashCommands = participantContribution && participantContribution.slashCommands;
  if (Array.isArray(slashCommands)) {
    for (const command of slashCommands) {
      addHint(toCommandId(command));
      if (typeof command === 'string') {
        addSlashName(command);
      } else if (command && typeof command.name === 'string') {
        addSlashName(command.name);
      }
    }
  }

  return {
    hints: Array.from(hints),
    slashNames: unique(slashNames),
  };
}

function buildAliasSet(participant) {
  const raw = new Set();
  const atoms = new Set();
  const tokens = new Set();

  function addAlias(value) {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed) return;

    raw.add(trimmed);

    const atom = normalizeAtom(trimmed);
    if (atom) {
      atoms.add(atom);
      raw.add(atom);
    }

    for (const token of tokenize(trimmed)) {
      tokens.add(token);
    }
  }

  addAlias(participant.id);
  addAlias(participant.name);
  addAlias(participant.fullName);

  const slashNames = Array.isArray(participant.slashCommandNames)
    ? participant.slashCommandNames
    : [];
  for (const slashName of slashNames) {
    addAlias(slashName);
  }

  const idSegments = String(participant.id || '')
    .split(/[.:/_-]+/)
    .filter(Boolean);

  for (const segment of idSegments) {
    addAlias(segment);
  }

  if (idSegments.length >= 2) {
    addAlias(`${idSegments[0]}.${idSegments[1]}`);
    addAlias(idSegments.slice(1).join('.'));
    addAlias(idSegments[1]);
  }

  if (idSegments.length >= 3) {
    addAlias(idSegments[2]);
  }

  const nameTokenJoin = tokenize(participant.name).join('');
  const fullNameTokenJoin = tokenize(participant.fullName).join('');
  if (nameTokenJoin) addAlias(nameTokenJoin);
  if (fullNameTokenJoin) addAlias(fullNameTokenJoin);

  if (tokens.has('github') && tokens.has('copilot')) {
    addAlias('copilot');
    addAlias('githubcopilot');
    addAlias('github.copilot');
  }

  return {
    raw: Array.from(raw).sort(),
    atoms: Array.from(atoms).sort(),
    tokens: Array.from(tokens).sort(),
  };
}

function deriveOrderedTokens(participant) {
  const idTokens = tokenize(participant.id);
  if (idTokens.length >= 2) return idTokens.slice(0, 3);

  const nameTokens = tokenize(participant.fullName || participant.name);
  if (nameTokens.length > 0) return nameTokens.slice(0, 3);

  return [];
}

function deriveScoringTokens(participant) {
  const idTokens = tokenize(participant.id);
  if (idTokens.length >= 2) return unique(idTokens.slice(0, 3));

  const nameTokens = tokenize(participant.name);
  if (nameTokens.length > 0) return unique(nameTokens.slice(0, 3));

  return [];
}

function buildParticipantRecord(participantContribution, extensionId) {
  const { hints, slashNames } = getParticipantCommandHints(participantContribution);

  const participant = {
    id: participantContribution.id,
    name: typeof participantContribution.name === 'string' ? participantContribution.name : '',
    fullName: typeof participantContribution.fullName === 'string' ? participantContribution.fullName : '',
    extensionId,
    commandHints: hints,
    slashCommandNames: slashNames,
    aliases: { raw: [], atoms: [], tokens: [] },
    orderedTokens: [],
    scoringTokens: [],
    coreToken: '',
    linkedCommandId: '',
    linkScore: 0,
    linkReason: 'none',
    linkCandidatesTop3: [],
  };

  participant.aliases = buildAliasSet(participant);
  participant.orderedTokens = deriveOrderedTokens(participant);
  participant.scoringTokens = deriveScoringTokens(participant);

  const aliasTokenSet = new Set(participant.aliases.tokens);
  for (const token of CORE_CHAT_TOKENS) {
    if (aliasTokenSet.has(token)) {
      participant.coreToken = token;
      break;
    }
  }

  return participant;
}

function buildCommandCandidate(commandId, title, category, source) {
  const id = String(commandId || '').trim();
  if (!id) return undefined;

  const titleText = typeof title === 'string' ? title : '';
  const categoryText = typeof category === 'string' ? category : '';

  const idTokens = tokenize(id);
  const titleTokens = tokenize(titleText);
  const categoryTokens = tokenize(categoryText);
  const tokens = unique([...idTokens, ...titleTokens, ...categoryTokens]);

  return {
    id,
    title: titleText,
    category: categoryText,
    tokens,
    idTokens,
    titleTokens,
    categoryTokens,
    normalizedIdAtom: normalizeAtom(id),
    source,
  };
}

function buildContributedCommandCatalog(extensions) {
  const catalog = new Map();

  for (const extension of extensions) {
    const contributes = extension && extension.packageJSON && extension.packageJSON.contributes;
    const commands = contributes && contributes.commands;
    if (!Array.isArray(commands)) continue;

    for (const command of commands) {
      const commandId = toCommandId(command);
      const candidate = buildCommandCandidate(
        commandId,
        command && typeof command.title === 'string' ? command.title : '',
        command && typeof command.category === 'string' ? command.category : '',
        'contributed',
      );

      if (!candidate) continue;

      if (!catalog.has(candidate.id)) {
        catalog.set(candidate.id, candidate);
        continue;
      }

      const existing = catalog.get(candidate.id);
      catalog.set(candidate.id, {
        ...existing,
        source: 'contributed',
        title: existing.title || candidate.title,
        category: existing.category || candidate.category,
        titleTokens: existing.titleTokens.length ? existing.titleTokens : candidate.titleTokens,
        categoryTokens: existing.categoryTokens.length ? existing.categoryTokens : candidate.categoryTokens,
        tokens: unique([...existing.tokens, ...candidate.tokens]),
      });
    }
  }

  return catalog;
}

function mergeRuntimeCommandCatalog(contributedCatalog, runtimeCommandIds) {
  const catalog = new Map(contributedCatalog);

  for (const commandId of runtimeCommandIds || []) {
    const id = String(commandId || '').trim();
    if (!id) continue;

    if (catalog.has(id)) continue;

    const runtimeCandidate = buildCommandCandidate(id, '', '', 'runtime');
    if (runtimeCandidate) {
      catalog.set(id, runtimeCandidate);
    }
  }

  return Array.from(catalog.values()).sort((left, right) => left.id.localeCompare(right.id));
}

function scoreCommandCandidate(participant, candidate) {
  const hintSet = new Set(participant.commandHints || []);
  const aliasAtomSet = new Set((participant.aliases && participant.aliases.atoms) || []);
  const aliasTokenSet = new Set((participant.aliases && participant.aliases.tokens) || []);

  let score = 0;

  if (hintSet.has(candidate.id)) score += 120;
  if (aliasAtomSet.has(candidate.normalizedIdAtom)) score += 90;

  if (containsOrderedTokenSequence(candidate.idTokens, participant.orderedTokens || [])) {
    score += 70;
  }

  if (tokenOverlapRatio(participant.scoringTokens || [], candidate.idTokens || []) >= 0.6) {
    score += 45;
  }

  if (tokenOverlapRatio(participant.scoringTokens || [], candidate.titleTokens || []) >= 0.6) {
    score += 30;
  }

  if (tokenOverlapRatio(participant.scoringTokens || [], candidate.categoryTokens || []) >= 0.6) {
    score += 20;
  }

  if (candidate.source === 'contributed') {
    score += 15;
  }

  let blacklistHit = false;
  for (const token of BLACKLIST_TOKENS) {
    if (candidate.tokens.includes(token) && !aliasTokenSet.has(token)) {
      blacklistHit = true;
      break;
    }
  }

  if (blacklistHit) {
    score -= 25;
  }

  if (participant.coreToken && candidate.idTokens.includes('chat') && candidate.idTokens.includes(participant.coreToken)) {
    score += 10;
  }

  return score;
}

function resolveCommandForParticipant(participant, commandCandidates, options) {
  const resolvedOptions = options || {};
  const resolutionContext = resolvedOptions.resolutionContext || {};
  const emitTrace = typeof resolvedOptions.onDebug === 'function'
    ? resolvedOptions.onDebug
    : undefined;

  const participantFamilyKey = getParticipantFamilyKey(participant && participant.id);
  const routedPrompt = typeof resolutionContext.routedPrompt === 'string'
    ? resolutionContext.routedPrompt
    : '';
  const promptIntent = typeof resolutionContext.promptIntent === 'string' && resolutionContext.promptIntent
    ? resolutionContext.promptIntent
    : classifyPromptIntent(routedPrompt);
  const preferredCommandId = getPrimaryCommandPreferences().get(participantFamilyKey) || '';
  const availableCandidates = (commandCandidates || []).map((candidate) => candidate.id);

  const scored = (commandCandidates || []).map((candidate) => ({
    candidate,
    score: scoreCommandCandidate(participant, candidate),
  }));

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.candidate.id.localeCompare(right.candidate.id);
  });

  const topCandidates = scored.slice(0, 3).map((entry) => ({
    id: entry.candidate.id,
    score: entry.score,
  }));

  const hintSet = new Set(participant.commandHints || []);
  const hintMatches = (commandCandidates || [])
    .filter((candidate) => hintSet.has(candidate.id))
    .sort((left, right) => left.id.localeCompare(right.id));

  let finalResolvedCommand;

  if (hintMatches.length > 0) {
    finalResolvedCommand = {
      linkedCommandId: hintMatches[0].id,
      linkScore: 120,
      linkReason: 'hint',
      linkCandidatesTop3: topCandidates,
    };
  } else {
    const aliasAtomSet = new Set((participant.aliases && participant.aliases.atoms) || []);
    const exactIdMatches = (commandCandidates || [])
      .filter((candidate) => aliasAtomSet.has(candidate.normalizedIdAtom))
      .sort((left, right) => left.id.localeCompare(right.id));

    if (exactIdMatches.length > 0) {
      finalResolvedCommand = {
        linkedCommandId: exactIdMatches[0].id,
        linkScore: 90,
        linkReason: 'exact-id',
        linkCandidatesTop3: topCandidates,
      };
    } else {
      const targetMode = typeof resolutionContext.targetMode === 'string' && resolutionContext.targetMode
        ? resolutionContext.targetMode
        : 'explicit';

      if (targetMode === 'generic' && promptIntent === 'general' && preferredCommandId) {
        const preferredCandidate = (commandCandidates || []).find((candidate) => candidate.id === preferredCommandId);
        if (preferredCandidate) {
          finalResolvedCommand = {
            linkedCommandId: preferredCandidate.id,
            linkScore: 85,
            linkReason: 'primary-preference',
            linkCandidatesTop3: topCandidates,
          };
        }
      }

      if (!finalResolvedCommand) {
        const weightedMatch = scored.find((entry) => entry.score >= 40);
        if (weightedMatch) {
          finalResolvedCommand = {
            linkedCommandId: weightedMatch.candidate.id,
            linkScore: weightedMatch.score,
            linkReason: 'weighted',
            linkCandidatesTop3: topCandidates,
          };
        }
      }
    }
  }

  if (!finalResolvedCommand) {
    finalResolvedCommand = {
      linkedCommandId: '',
      linkScore: 0,
      linkReason: 'none',
      linkCandidatesTop3: topCandidates,
    };
  }

  if (emitTrace) {
    emitTrace({
      type: 'command-selection-trace',
      participantId: participant && participant.id ? participant.id : '',
      participantFamilyKey,
      promptIntent,
      preferredCommand: preferredCommandId || 'none',
      availableCandidates,
      finalResolvedCommandId: finalResolvedCommand.linkedCommandId || 'none',
      resolutionReason: finalResolvedCommand.linkReason || 'fallback',
    });
  }

  return finalResolvedCommand;
}


function isGenericCoreTarget(target) {
  const cleanTarget = String(target || '').replace(/^@/, '').trim();
  if (!cleanTarget) return false;

  const atom = normalizeAtom(cleanTarget);
  if (atom === 'copilot' || atom === 'githubcopilot') return true;

  const tokens = tokenize(cleanTarget);
  if (tokens.length === 0) return false;

  const tokenSet = new Set(tokens);
  if (tokens.length === 1 && tokenSet.has('copilot')) return true;
  if (tokens.length <= 2 && tokenSet.has('github') && tokenSet.has('copilot')) return true;
  return false;
}

function getParticipantFamilyKey(participantId) {
  const segments = String(participantId || '')
    .split(/[.:/_-]+/)
    .filter(Boolean);

  if (segments.length === 0) return '';
  if (segments.length === 1) return segments[0];
  return `${segments[0]}.${segments[1]}`;
}

function getPrimaryVariantRank(participantId) {
  return String(participantId || '').endsWith('.default') ? 0 : 1;
}
function getPrimaryCommandPreferences() {
  return new Map([
    ['github.copilot', 'github.copilot.chat.ask'],
  ]);
}

function classifyPromptIntent(promptText) {
  const tokens = tokenize(promptText);
  if (tokens.some((token) => OPERATIONAL_INTENT_TOKENS.has(token))) {
    return 'operational';
  }

  return 'general';
}


function resolveParticipantByTarget(participantRegistry, rawTarget, options) {
  const target = String(rawTarget || '').replace(/^@/, '').trim();
  if (!target) return undefined;

  const resolvedOptions = options || {};

  const targetAtom = normalizeAtom(target);
  const targetTokens = tokenize(target);
  const targetFamilyKey = getParticipantFamilyKey(target);
  const genericCoreTarget = isGenericCoreTarget(target);

  const candidates = [];

  for (const participant of participantRegistry.values()) {
    const aliasAtoms = participant.aliases && Array.isArray(participant.aliases.atoms)
      ? participant.aliases.atoms
      : [];
    const aliasTokens = participant.aliases && Array.isArray(participant.aliases.tokens)
      ? participant.aliases.tokens
      : [];

    const atomMatch = Boolean(targetAtom) && aliasAtoms.includes(targetAtom);
    const overlapRatio = tokenOverlapRatio(targetTokens, aliasTokens);
    const tokenMatch = overlapRatio >= 0.6 || targetTokens.some((token) => aliasTokens.includes(token));

    if (!atomMatch && !tokenMatch) continue;

    let score = 0;
    if (atomMatch) score += 100;
    if (tokenMatch) score += 60;
    if (targetTokens.length > 0 && targetTokens.every((token) => aliasTokens.includes(token))) score += 30;

    candidates.push({
      participant,
      score,
      familyKey: getParticipantFamilyKey(participant.id),
      variantRank: getPrimaryVariantRank(participant.id),
    });
  }

  if (genericCoreTarget) {
    candidates.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;

      const leftRank = left.variantRank;
      const rightRank = right.variantRank;
      if (leftRank !== rightRank) return leftRank - rightRank;

      const leftLength = String(left.participant.id || '').length;
      const rightLength = String(right.participant.id || '').length;
      if (leftLength !== rightLength) return leftLength - rightLength;

      return left.participant.id.localeCompare(right.participant.id);
    });
  } else {
    candidates.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.participant.id.localeCompare(right.participant.id);
    });
  }

  const debugCandidates = candidates.map((entry) => ({
    id: entry.participant.id,
    score: entry.score,
    rank: entry.variantRank,
    idLength: String(entry.participant.id || '').length,
  }));

  if (candidates.length === 0) {
    if (typeof resolvedOptions.onDebug === 'function') {
      resolvedOptions.onDebug({
        targetText: target,
        targetMode: genericCoreTarget ? 'generic' : 'explicit',
        candidates: debugCandidates,
        selectedParticipantId: '',
      });
    }

    return undefined;
  }

  let selected = candidates[0].participant;

  if (genericCoreTarget && selected && !String(selected.id || '').endsWith('.default')) {
    const selectedFamily = getParticipantFamilyKey(selected.id);
    const preferredFamily = selectedFamily || targetFamilyKey;

    const familyDefault = candidates.find((entry) => {
      if (!String(entry.participant.id || '').endsWith('.default')) return false;
      if (!preferredFamily) return true;
      return entry.familyKey === preferredFamily;
    });

    if (familyDefault) {
      selected = familyDefault.participant;
    }
  }

  if (typeof resolvedOptions.onDebug === 'function') {
    resolvedOptions.onDebug({
      targetText: target,
      targetMode: genericCoreTarget ? 'generic' : 'explicit',
      candidates: debugCandidates,
      selectedParticipantId: selected ? selected.id : '',
    });
  }

  return selected;
}

function activate(extensionContext) {
  const output = vscode.window.createOutputChannel('Seamless AI Bridge');
  extensionContext.subscriptions.push(output);

  function log(message) {
    output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  const debugEnabled = process.env.SEAMLESS_AI_BRIDGE_DEBUG === '1';

  function debugLog(payload) {
    if (!debugEnabled) return;
    if (typeof payload === 'string') {
      log(`[debug] ${payload}`);
      return;
    }
    log(`[debug] ${JSON.stringify(payload)}`);
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

  function parseRoutePrompt(prompt) {
    const match = /^@([A-Za-z0-9._-]+)\s+([\s\S]+)$/.exec(prompt.trim());
    if (!match) return undefined;

    const targetName = match[1];
    const routedPrompt = match[2].trim();
    if (!routedPrompt) return undefined;

    return { targetName, routedPrompt };
  }

  function createTrackedResponse(response) {
    let markdownCount = 0;

    const proxy = Object.create(response);
    if (typeof response.markdown === 'function') {
      const originalMarkdown = response.markdown.bind(response);
      proxy.markdown = (...args) => {
        markdownCount += 1;
        return originalMarkdown(...args);
      };
    }

    return {
      response: proxy,
      getCount: () => markdownCount,
    };
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

  function detectParticipantsFromExtensions() {
    const found = [];

    for (const extension of vscode.extensions.all) {
      const contributions = extension
        && extension.packageJSON
        && extension.packageJSON.contributes
        && extension.packageJSON.contributes.chatParticipants;

      if (!Array.isArray(contributions)) continue;

      for (const participantContribution of contributions) {
        if (!participantContribution || typeof participantContribution.id !== 'string') continue;
        found.push(buildParticipantRecord(participantContribution, extension.id));
      }
    }

    found.sort((left, right) => left.id.localeCompare(right.id));
    return found;
  }

  let participantRegistry = new Map();
  let commandCatalog = [];
  let refreshInFlight;
  let registryReady = false;
  let lastExperimentalMode;

  async function refreshParticipantRegistry(reason) {
    if (refreshInFlight) {
      await refreshInFlight;
      return;
    }

    refreshInFlight = (async () => {
      const participants = detectParticipantsFromExtensions();
      const contributedCatalog = buildContributedCommandCatalog(vscode.extensions.all);

      let runtimeCommandIds = [];
      try {
        runtimeCommandIds = await vscode.commands.getCommands(true);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        log(`Unable to read runtime command catalog: ${message}`);
      }

      commandCatalog = mergeRuntimeCommandCatalog(contributedCatalog, runtimeCommandIds);

      const nextRegistry = new Map();
      for (const participant of participants) {
        const link = resolveCommandForParticipant(participant, commandCatalog, {
          onDebug: (payload) => debugLog(payload),
        });
        const enriched = {
          ...participant,
          linkedCommandId: link.linkedCommandId,
          linkScore: link.linkScore,
          linkReason: link.linkReason,
          linkCandidatesTop3: link.linkCandidatesTop3,
        };

        nextRegistry.set(enriched.id, enriched);

        debugLog({
          reason,
          participantId: enriched.id,
          participantName: enriched.name || enriched.fullName,
          aliases: enriched.aliases,
          chosen: {
            commandId: enriched.linkedCommandId,
            score: enriched.linkScore,
            reason: enriched.linkReason,
          },
          topCandidates: enriched.linkCandidatesTop3,
        });
      }

      participantRegistry = nextRegistry;
      registryReady = true;

      debugLog({
        reason,
        participants: participants.length,
        commands: commandCatalog.length,
      });
    })();

    try {
      await refreshInFlight;
    } finally {
      refreshInFlight = undefined;
    }
  }

  function getParticipantCommandById(participantId) {
    const participant = participantRegistry.get(participantId);
    return participant && participant.linkedCommandId ? participant.linkedCommandId : '';
  }

  async function resolveRouteTarget(targetName, options) {
    const resolvedOptions = options || {};
    const retryOnMiss = Boolean(resolvedOptions.retryOnMiss);
    const resolutionContext = resolvedOptions.resolutionContext || {};

    const cleanTarget = String(targetName || '').replace(/^@/, '').trim();
    const queryAtom = normalizeAtom(cleanTarget);
    const targetMode = typeof resolutionContext.targetMode === 'string' && resolutionContext.targetMode
      ? resolutionContext.targetMode
      : (isGenericCoreTarget(cleanTarget) ? 'generic' : 'explicit');
    const routedPrompt = typeof resolutionContext.routedPrompt === 'string'
      ? resolutionContext.routedPrompt
      : '';
    const promptIntent = classifyPromptIntent(routedPrompt);

    const resolveCommandLink = (participant) => resolveCommandForParticipant(participant, commandCatalog, {
      resolutionContext: {
        ...resolutionContext,
        targetMode,
        routedPrompt,
        promptIntent,
      },
      onDebug: (payload) => debugLog(payload),
    });

    const emptyCommandLink = {
      linkedCommandId: '',
      linkScore: 0,
      linkReason: 'none',
      linkCandidatesTop3: [],
    };

    const buildMissDiagnostics = (participant, topCandidates) => ({
      target: cleanTarget,
      aliasAtoms: participant && participant.aliases && Array.isArray(participant.aliases.atoms)
        ? participant.aliases.atoms
        : (queryAtom ? [queryAtom] : []),
      candidateCount: commandCatalog.length,
      topCandidates: Array.isArray(topCandidates) ? topCandidates.slice(0, 3) : [],
    });

    let participant = resolveParticipantByTarget(participantRegistry, cleanTarget, {
      onDebug: (payload) => debugLog({
        type: 'participant-selection',
        phase: 'initial',
        ...payload,
      }),
    });
    let commandLink = participant ? resolveCommandLink(participant) : emptyCommandLink;
    let retried = false;

    if (participant && !commandLink.linkedCommandId && retryOnMiss) {
      retried = true;
      await refreshParticipantRegistry('miss-retry');
      participant = resolveParticipantByTarget(participantRegistry, cleanTarget, {
        onDebug: (payload) => debugLog({
          type: 'participant-selection',
          phase: 'retry',
          ...payload,
        }),
      });
      commandLink = participant ? resolveCommandLink(participant) : emptyCommandLink;
    }

    if (!participant) {
      const diagnostics = buildMissDiagnostics(undefined, []);
      debugLog({
        target: cleanTarget,
        resolved: false,
        resolutionContext: {
          targetMode,
          promptIntent,
        },
        diagnostics,
      });

      return {
        participant: undefined,
        commandId: '',
        linkScore: 0,
        linkReason: 'none',
        diagnostics,
        retried,
      };
    }

    const diagnostics = buildMissDiagnostics(participant, commandLink.linkCandidatesTop3);
    debugLog({
      target: cleanTarget,
      participantId: participant.id,
      participantName: participant.name || participant.fullName,
      aliases: participant.aliases,
      resolutionContext: {
        targetMode,
        promptIntent,
      },
      chosen: {
        commandId: commandLink.linkedCommandId,
        score: commandLink.linkScore,
        reason: commandLink.linkReason,
      },
      topCandidates: commandLink.linkCandidatesTop3,
      retried,
    });

    return {
      participant,
      commandId: commandLink.linkedCommandId || '',
      linkScore: commandLink.linkScore || 0,
      linkReason: commandLink.linkReason || 'none',
      diagnostics,
      retried,
    };
  }


  let bridgeInstance;

  function getBridge() {
    if (bridgeInstance) return bridgeInstance;

    const bridgeConfig = vscode.workspace.getConfiguration('seamlessAiBridge');
    const configuredPath = bridgeConfig.get('path');
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
    const pending = new Map(); // id -> { stream, timeout, resolve, reject, cancelDisposable }

    function takePending(id) {
      const entry = pending.get(id);
      if (!entry) return null;
      clearTimeout(entry.timeout);
      if (entry.cancelDisposable && typeof entry.cancelDisposable.dispose === 'function') {
        entry.cancelDisposable.dispose();
      }
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

        pending.set(id, {
          stream,
          timeout,
          resolve,
          reject,
          cancelDisposable: undefined,
        });

        if (token) {
          if (token.isCancellationRequested) {
            const entry = takePending(id);
            if (entry) entry.reject(new Error('Cancelled'));
            return;
          }

          const cancelDisposable = token.onCancellationRequested(() => {
            const entry = takePending(id);
            if (entry) entry.reject(new Error('Cancelled'));
          });

          const entry = pending.get(id);
          if (entry) {
            entry.cancelDisposable = cancelDisposable;
          } else if (cancelDisposable && typeof cancelDisposable.dispose === 'function') {
            cancelDisposable.dispose();
          }
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
  refreshParticipantRegistry('activate').catch((error) => {
    const message = error && error.message ? error.message : String(error);
    log(`Initial participant refresh failed: ${message}`);
  });

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

    const bridgeConfig = vscode.workspace.getConfiguration('seamlessAiBridge');
    const isExperimentalMode = Boolean(bridgeConfig.get('experimental.enableCrossParticipantChat', false));

    if (!registryReady) {
      await refreshParticipantRegistry('first-request');
    }

    if (lastExperimentalMode !== isExperimentalMode) {
      await refreshParticipantRegistry('experimental-flag-change');
      lastExperimentalMode = isExperimentalMode;
    }

    const tracked = createTrackedResponse(response);
    const providerContext = {
      userPrompt: prompt,
    };

    const providerOptions = {
      isExperimentalMode,
      response: tracked.response,
      token,
      experimentalTimeoutMs: 12000,
      helpers: {
        log,
        debugLog,
        parseRoutePrompt,
        resolveRouteTarget,
        getParticipantCommandById,
        routeToLocalBridge,
        streamForwardResult,
        executeCommand: (commandId, args) => vscode.commands.executeCommand(commandId, args),
        getResponseCount: tracked.getCount,
        bridgeParticipantId: 'seamless-ai-bridge',
      },
    };

    try {
      const planText = await plannerProvider.getPlan(prompt, providerContext, providerOptions);
      await coderProvider.getCode(planText, providerContext, providerOptions);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (message === 'Cancelled') {
        response.markdown('Cancelled');
        return;
      }

      log(`Provider orchestration failed: ${message}`);
      response.markdown('Routing to local bridge due to provider error.');
      await routeToLocalBridge(prompt, response, token);
    }
  }

  const participant = vscode.chat.createChatParticipant('seamless-ai-bridge', handleRequest);

  extensionContext.subscriptions.push(participant);
  extensionContext.subscriptions.push(new vscode.Disposable(() => {
    try { if (bridgeInstance) bridgeInstance.dispose(); } catch {}
  }));
}

module.exports = {
  activate,
  __test: {
    normalizeAtom,
    tokenize,
    buildAliasSet,
    buildParticipantRecord,
    buildCommandCandidate,
    scoreCommandCandidate,
    resolveCommandForParticipant,
    resolveParticipantByTarget,
    getParticipantFamilyKey,
    getPrimaryCommandPreferences,
    classifyPromptIntent,
    tokenOverlapRatio,
    containsOrderedTokenSequence,
    buildContributedCommandCatalog,
    mergeRuntimeCommandCatalog,
  },
};
