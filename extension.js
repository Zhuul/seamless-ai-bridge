const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const readline = require('readline');
const plannerProvider = require('./plannerProvider');
const coderProvider = require('./coderProvider');
const {
  readConfiguredAgents,
  parseAgentPrompt,
  normalizeAgentAlias,
  getDangerousCapabilities,
  createSessionManager: createAgentSessionManager,
} = require('./agentEngine');
const { CopilotProvider } = require('./providers/copilotProvider');
const { CodexProvider } = require('./providers/codexProvider');
const { AgentTreeProvider } = require('./agentTreeProvider');
const { AgentManagerViewProvider } = require('./agentManagerViewProvider');
const { SettingsService } = require('./settingsService');

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

function normalizePersonaAlias(value) {
  return String(value || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
}

function sanitizeModelSelector(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return {
      vendor: 'copilot',
      family: trimmed,
    };
  }

  if (!value || typeof value !== 'object') return undefined;

  const selector = {};
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const family = typeof value.family === 'string' ? value.family.trim() : '';
  const version = typeof value.version === 'string' ? value.version.trim() : '';
  const vendor = typeof value.vendor === 'string' ? value.vendor.trim().toLowerCase() : '';

  selector.vendor = 'copilot';
  if (id) selector.id = id;
  if (family) selector.family = family;
  if (version) selector.version = version;

  if (vendor && vendor !== 'copilot') return undefined;
  return selector;
}

function readConfiguredPersonas(rawPersonas) {
  const personas = new Map();
  const source = Array.isArray(rawPersonas) ? rawPersonas : [];

  for (const entry of source) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.enabled === false) continue;

    const alias = normalizePersonaAlias(entry.alias);
    if (!alias) continue;

    const provider = typeof entry.provider === 'string' && entry.provider.trim()
      ? entry.provider.trim().toLowerCase()
      : 'copilot';
    if (provider !== 'copilot') continue;

    personas.set(alias, {
      alias,
      name: typeof entry.name === 'string' ? entry.name.trim() : '',
      provider,
      modelSelector: sanitizeModelSelector(entry.modelSelector),
      metadata: {},
    });
  }

  return personas;
}

function parsePersonaPrompt(prompt, personas) {
  const text = String(prompt || '').trim();
  const map = personas instanceof Map ? personas : new Map();
  const routeMatch = /^@([A-Za-z0-9._-]+)\s*([\s\S]*)$/.exec(text);

  if (!routeMatch) {
    return {
      persona: undefined,
      routedPrompt: text,
      usedPersonaPrefix: false,
    };
  }

  const alias = normalizePersonaAlias(routeMatch[1]);
  const persona = map.get(alias);
  if (!persona) {
    return {
      persona: undefined,
      routedPrompt: text,
      usedPersonaPrefix: false,
    };
  }

  const routedPrompt = String(routeMatch[2] || '').trim();
  return {
    persona,
    routedPrompt,
    usedPersonaPrefix: true,
  };
}

function toLanguageModelMessages(historyTurns, currentPrompt) {
  const messages = [];

  for (const turn of historyTurns || []) {
    if (!turn || typeof turn !== 'object' || typeof turn.content !== 'string' || !turn.content) continue;
    if (turn.role === 'assistant') {
      messages.push(vscode.LanguageModelChatMessage.Assistant(turn.content));
    } else {
      messages.push(vscode.LanguageModelChatMessage.User(turn.content));
    }
  }

  messages.push(vscode.LanguageModelChatMessage.User(currentPrompt));
  return messages;
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
  const targetMode = typeof resolutionContext.targetMode === 'string' && resolutionContext.targetMode
    ? resolutionContext.targetMode
    : 'explicit';
  const preferredCommandId = getPreferredCommandForFamily(participantFamilyKey, commandCandidates);
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
      targetMode,
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
    ['github.copilot', [
      'github.copilot.chat.submit',
      'github.copilot.chat.ask',
      'github.copilot.chat.open',
      'github.copilot.chat.send',
      'github.copilot.chat.new',
    ]],
  ]);
}

function getPreferredCommandForFamily(familyKey, commandCandidates) {
  const preferenceMap = getPrimaryCommandPreferences();
  const preferredIds = preferenceMap.get(familyKey);
  const availableById = new Set((commandCandidates || []).map((candidate) => candidate.id));

  if (Array.isArray(preferredIds)) {
    for (const id of preferredIds) {
      if (typeof id !== 'string' || !id) continue;
      if (availableById.has(id)) return id;
    }
  } else if (typeof preferredIds === 'string' && preferredIds) {
    if (availableById.has(preferredIds)) return preferredIds;
  }

  const familyPrefix = `${String(familyKey || '').trim()}.`;
  if (!familyPrefix || familyPrefix === '.') return '';

  const familyCandidates = (commandCandidates || []).filter((candidate) => String(candidate.id || '').startsWith(familyPrefix));
  if (familyCandidates.length === 0) return '';

  const ranked = familyCandidates
    .map((candidate) => {
      const idTokens = Array.isArray(candidate.idTokens) ? candidate.idTokens : tokenize(candidate.id);
      const hasOperationalToken = idTokens.some((token) => OPERATIONAL_INTENT_TOKENS.has(token));
      const hasCloudSessionToken = idTokens.some((token) => (
        token === 'cloud'
        || token === 'sessions'
        || token === 'repository'
        || token === 'codespaces'
      ));

      let score = 0;
      if (idTokens.includes('chat')) score += 60;
      if (idTokens.includes('ask')) score += 120;
      if (idTokens.includes('submit')) score += 110;
      if (idTokens.includes('open')) score += 50;
      if (idTokens.includes('send')) score += 45;
      if (idTokens.includes('new')) score += 35;
      if (hasOperationalToken) score -= 80;
      if (hasCloudSessionToken) score -= 120;

      return {
        id: candidate.id,
        score,
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.id.localeCompare(right.id);
    });

  return ranked[0] ? ranked[0].id : '';
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

  function debugLog(payload) {
    const debugEnabled = Boolean(vscode.workspace.getConfiguration('seamlessAiBridge').get('debug.enabled', false));
    if (!debugEnabled) return;
    if (typeof payload === 'string') {
      log(`[debug] ${payload}`);
      return;
    }
    log(`[debug] ${JSON.stringify(payload)}`);
  }

  const settingsService = new SettingsService(vscode.workspace);

  function serializeError(error) {
    if (!error || typeof error !== 'object') {
      return {
        name: 'Error',
        message: String(error),
        stack: '',
      };
    }

    const err = error;
    const details = {
      name: typeof err.name === 'string' && err.name ? err.name : 'Error',
      message: typeof err.message === 'string' && err.message ? err.message : String(err),
      stack: typeof err.stack === 'string' ? err.stack : '',
    };

    const enumerable = {};
    for (const key of Object.keys(err)) {
      if (key === 'name' || key === 'message' || key === 'stack') continue;
      const value = err[key];
      if (value === undefined) continue;
      if (typeof value === 'function') continue;
      try {
        enumerable[key] = value;
      } catch {
        enumerable[key] = '[unserializable]';
      }
    }

    if (Object.keys(enumerable).length > 0) {
      details.details = enumerable;
    }

    return details;
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

  function setAgentAuthorPresentation(participant, alias) {
    if (!participant) return () => {};

    const normalizedAlias = normalizeAgentAlias(alias);
    const authorLabel = normalizedAlias ? `@${normalizedAlias}` : String(alias || '').trim();
    if (!authorLabel) return () => {};

    const previousName = participant.name;
    const previousFullName = participant.fullName;

    try {
      participant.name = authorLabel;
      participant.fullName = authorLabel;
    } catch {
      return () => {};
    }

    return () => {
      try {
        participant.name = previousName;
        participant.fullName = previousFullName;
      } catch {}
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
  const workspaceKey = (vscode.workspace.workspaceFolders || [])
    .map((folder) => folder.uri.toString())
    .join(';') || 'global';
  const agentSessionManager = createAgentSessionManager(extensionContext, workspaceKey);
  const dangerousCapabilities = getDangerousCapabilities();
  let providerRegistry = new Map();
  let agentTreeProvider;
  let agentManagerViewProvider;
  let refreshInFlight;
  let registryReady = false;
  let lastExperimentalMode;
  let cachedAgentState = {
    workspaceAgents: [],
    userAgents: [],
    knownAliases: [],
  };

  function recomputeAgentState(reason) {
    cachedAgentState = settingsService.getAgentSources();
    debugLog({
      type: 'agent-state-refresh',
      reason,
      workspaceAgents: cachedAgentState.workspaceAgents.map((agent) => agent.alias),
      userAgents: cachedAgentState.userAgents.map((agent) => agent.alias),
      knownAliases: cachedAgentState.knownAliases,
    });
    return cachedAgentState;
  }

  function getCachedAgentState() {
    return cachedAgentState;
  }

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

        const sortedRuntimeCommandIds = [...runtimeCommandIds]
          .map((commandId) => String(commandId || '').trim())
          .filter(Boolean)
          .sort((left, right) => left.localeCompare(right));

        const copilotRuntimeCommandIds = sortedRuntimeCommandIds
          .filter((commandId) => commandId.startsWith('github.copilot.'));

        debugLog({
          type: 'runtime-command-enumeration',
          reason,
          commandCount: sortedRuntimeCommandIds.length,
          commands: sortedRuntimeCommandIds,
        });

        debugLog({
          type: 'runtime-command-enumeration-copilot',
          reason,
          commandCount: copilotRuntimeCommandIds.length,
          commands: copilotRuntimeCommandIds,
        });

        log(`[debug] runtime-command-enumeration count=${sortedRuntimeCommandIds.length}`);
        log(`[debug] runtime-command-enumeration-copilot count=${copilotRuntimeCommandIds.length}`);
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

  function getDefaultCapabilities() {
    return settingsService.getDefaultCapabilities();
  }

  function getAgentsMap() {
    return new Map((cachedAgentState.workspaceAgents || []).map((agent) => [normalizeAgentAlias(agent.alias), agent]));
  }

  function getAgentsArray() {
    return cachedAgentState.workspaceAgents || [];
  }

  async function saveAgent(agentInput) {
    await settingsService.upsertAgent(agentInput);
  }

  async function deleteAgent(alias) {
    await settingsService.removeAgent(alias);
  }

  async function resetAgentHistory(alias) {
    const targetAlias = normalizeAgentAlias(alias);
    if (!targetAlias) return;
    await agentSessionManager.clearAgent(targetAlias);
  }

  async function listProviderModels(providerId, token) {
    const provider = providerRegistry.get(providerId);
    if (!provider) return [];
    return provider.listModels({}, token);
  }

  function refreshAgentViews() {
    if (agentTreeProvider) {
      agentTreeProvider.refresh();
    }
    if (agentManagerViewProvider) {
      agentManagerViewProvider.notifyStateChanged();
    }
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

  async function sendToBridgeText(prompt, callbacks) {
    const bridge = getBridge();
    const onToken = callbacks && typeof callbacks.onToken === 'function' ? callbacks.onToken : () => {};
    const token = callbacks ? callbacks.token : undefined;
    let text = '';

    await bridge.send(prompt, {
      markdown(value) {
        const chunk = String(value || '');
        if (!chunk) return;
        text += chunk;
        onToken(chunk);
      },
    }, token);

    return text;
  }

  providerRegistry = new Map([
    ['copilot', new CopilotProvider()],
    ['codex', new CodexProvider({ sendToBridge: sendToBridgeText })],
  ]);

  log('Activating Seamless AI Bridge.');
  recomputeAgentState('activate');
  refreshParticipantRegistry('activate').catch((error) => {
    const message = error && error.message ? error.message : String(error);
    log(`Initial participant refresh failed: ${message}`);
  });

  agentTreeProvider = new AgentTreeProvider({
    hasWorkspaceOpen: () => settingsService.hasWorkspaceOpen(),
    getAgents: () => getAgentsArray(),
  });
  extensionContext.subscriptions.push(
    vscode.window.registerTreeDataProvider('seamlessAiBridge.agentsView', agentTreeProvider),
  );

  agentManagerViewProvider = new AgentManagerViewProvider({
    getAgents: () => getAgentsArray(),
    getDefaultCapabilities: () => getDefaultCapabilities(),
    listModels: (providerId, token) => listProviderModels(providerId, token),
    saveAgent: async (agent) => {
      await saveAgent(agent);
      recomputeAgentState('save-agent');
      refreshAgentViews();
    },
    deleteAgent: async (alias) => {
      await deleteAgent(alias);
      recomputeAgentState('delete-agent');
      refreshAgentViews();
    },
    resetAgentHistory: async (alias) => {
      await resetAgentHistory(alias);
      refreshAgentViews();
    },
  });

  extensionContext.subscriptions.push(
    vscode.window.registerWebviewViewProvider('seamlessAiBridge.agentManagerView', agentManagerViewProvider),
  );

  async function pickAgentAlias(placeHolder) {
    if (!settingsService.hasWorkspaceOpen()) {
      vscode.window.showInformationMessage('No workspace open. Agents are configured per-workspace.');
      return '';
    }

    const agents = getAgentsArray();
    if (agents.length === 0) {
      vscode.window.showInformationMessage('No agents configured.');
      return '';
    }

    const choice = await vscode.window.showQuickPick(
      agents.map((agent) => ({
        label: `@${agent.alias}`,
        description: `${agent.provider}:${agent.model || 'auto'}`,
        agent,
      })),
      { placeHolder },
    );

    return choice ? choice.agent.alias : '';
  }

  async function promptAgentFields(existing) {
    const current = existing || {};
    const alias = normalizeAgentAlias(await vscode.window.showInputBox({
      prompt: 'Agent alias',
      value: current.alias || '',
      validateInput: (value) => (normalizeAgentAlias(value) ? undefined : 'Alias is required.'),
    }));
    if (!alias) return undefined;

    const providerPick = await vscode.window.showQuickPick([
      { label: 'copilot', description: 'Use VS Code Copilot language model provider' },
      { label: 'codex', description: 'Use local Codex bridge provider' },
    ], {
      placeHolder: 'Select provider',
    });
    if (!providerPick) return undefined;

    const model = await vscode.window.showInputBox({
      prompt: 'Model (optional, leave empty for auto)',
      value: current.model || '',
    });
    if (model === undefined) return undefined;

    const historyPick = await vscode.window.showQuickPick([
      { label: 'Persistent history', value: true },
      { label: 'Stateless', value: false },
    ], {
      placeHolder: 'History mode',
    });
    if (!historyPick) return undefined;

    const capabilityMode = await vscode.window.showQuickPick([
      { label: 'default', description: 'Use global defaultCapabilities' },
      { label: 'custom', description: 'Specify per-agent capabilities' },
    ], {
      placeHolder: 'Capability mode',
    });
    if (!capabilityMode) return undefined;

    let capabilities = 'default';
    if (capabilityMode.label === 'custom') {
      const selected = await vscode.window.showQuickPick([
        { label: '@workspace' },
        { label: '@vscode' },
        { label: '@terminal' },
      ], {
        canPickMany: true,
        placeHolder: 'Select allowed capabilities',
      });

      if (!selected) return undefined;
      capabilities = selected.map((item) => item.label);
    }

    return {
      alias,
      provider: providerPick.label,
      model: String(model || '').trim(),
      historyPersistence: historyPick.value,
      capabilities,
    };
  }

  async function runWipeCommand(response) {
    const enableWipe = Boolean(vscode.workspace.getConfiguration('seamlessAiBridge').get('developer.enableWipeCommand', false));
    if (!enableWipe) {
      response.markdown('`@bridge /wipe` is disabled. Enable `seamlessAiBridge.developer.enableWipeCommand` to use it.');
      return;
    }

    const stateBefore = getCachedAgentState();
    const aliasesToClear = Array.isArray(stateBefore.knownAliases)
      ? stateBefore.knownAliases
      : settingsService.getKnownAliases();

    for (const alias of aliasesToClear) {
      await agentSessionManager.clearAgent(alias);
    }

    await settingsService.wipeAllAgentsAndSettings();
    const stateAfter = recomputeAgentState('wipe-command');
    refreshAgentViews();

    response.markdown('Wipe complete.');
    response.markdown(`Cleared aliases: ${aliasesToClear.length}`);
    response.markdown(`Workspace agents remaining: ${stateAfter.workspaceAgents.length}`);
    response.markdown(`User agents remaining: ${stateAfter.userAgents.length}`);
  }

  extensionContext.subscriptions.push(
    vscode.commands.registerCommand('seamlessAiBridge.refreshAgents', () => {
      refreshAgentViews();
    }),
    vscode.commands.registerCommand('seamlessAiBridge.addAgent', async () => {
      if (!settingsService.hasWorkspaceOpen()) {
        vscode.window.showInformationMessage('No workspace open. Agents are configured per-workspace.');
        return;
      }
      const next = await promptAgentFields();
      if (!next) return;
      await saveAgent(next);
      recomputeAgentState('add-agent-command');
      refreshAgentViews();
    }),
    vscode.commands.registerCommand('seamlessAiBridge.editAgent', async (item) => {
      const existingAlias = item && item.agent ? normalizeAgentAlias(item.agent.alias) : '';
      const alias = existingAlias || await pickAgentAlias('Select an agent to edit');
      if (!alias) return;

      const existing = getAgentsMap().get(alias);
      if (!existing) return;

      const next = await promptAgentFields(existing);
      if (!next) return;

      if (next.alias !== alias) {
        await deleteAgent(alias);
      }
      await saveAgent(next);
      recomputeAgentState('edit-agent-command');
      refreshAgentViews();
    }),
    vscode.commands.registerCommand('seamlessAiBridge.removeAgent', async (item) => {
      const existingAlias = item && item.agent ? normalizeAgentAlias(item.agent.alias) : '';
      const alias = existingAlias || await pickAgentAlias('Select an agent to remove');
      if (!alias) return;
      await deleteAgent(alias);
      await resetAgentHistory(alias);
      recomputeAgentState('remove-agent-command');
      refreshAgentViews();
    }),
    vscode.commands.registerCommand('seamlessAiBridge.resetAgentHistory', async (item) => {
      const existingAlias = item && item.agent ? normalizeAgentAlias(item.agent.alias) : '';
      const alias = existingAlias || await pickAgentAlias('Select an agent history to reset');
      if (!alias) return;
      await resetAgentHistory(alias);
      refreshAgentViews();
      vscode.window.showInformationMessage(`Reset history for @${alias}.`);
    }),
  );

  extensionContext.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration('seamlessAiBridge.personas')
      || event.affectsConfiguration('seamlessAiBridge.defaultCapabilities')
      || event.affectsConfiguration('seamlessAiBridge.developer.enableWipeCommand')
    ) {
      recomputeAgentState('configuration-change');
      refreshAgentViews();
    }
  }));

  extensionContext.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    recomputeAgentState('workspace-folders-change');
    refreshAgentViews();
  }));

  async function handleRequest(request, _chatContext, response, token) {
    const requestId = Math.random().toString(36).slice(2);
    const prompt = (request && typeof request.prompt === 'string' ? request.prompt : '').trim();
    let phase = 'entered';

    debugLog({
      type: 'provide-response-trace',
      requestId,
      phase,
      promptLength: prompt.length,
      cancelled: Boolean(token && token.isCancellationRequested),
    });

    try {
      phase = 'prompt-check';

      if (prompt.startsWith('/exec ')) {
        phase = 'exec-command';
        const cmd = prompt.slice(6).trim();
        const cwd = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
          ? vscode.workspace.workspaceFolders[0].uri.fsPath
          : undefined;

        debugLog({
          type: 'provide-response-trace',
          requestId,
          phase,
          commandLength: cmd.length,
          hasWorkspaceCwd: Boolean(cwd),
        });

        response.markdown(`cwd: ${cwd || process.cwd()}`);
        response.markdown(`$ ${cmd}`);
        const { code, stdout, stderr } = await runShell(cmd, cwd, token);
        if (stdout) response.markdown(['```', stdout, '```'].join('\n'));
        if (stderr) response.markdown(['stderr:', '```', stderr, '```'].join('\n'));
        if (code !== 0) response.markdown(`Process exited with code ${code}`);

        debugLog({
          type: 'provide-response-trace',
          requestId,
          phase: 'exec-complete',
          code,
        });
        return;
      }

      if (!prompt) {
        debugLog({
          type: 'provide-response-trace',
          requestId,
          phase: 'empty-prompt',
        });
        response.markdown('Type a prompt for @bridge.');
        return;
      }

      if (prompt === '/wipe') {
        phase = 'wipe-command';
        await runWipeCommand(response);
        return;
      }

      phase = 'load-config';
      const bridgeConfig = vscode.workspace.getConfiguration('seamlessAiBridge');
      const isExperimentalMode = Boolean(bridgeConfig.get('experimental.enableCrossParticipantChat', false));
      const defaultCapabilities = getDefaultCapabilities();
      const configuredAgents = getAgentsMap();
      const agentRoute = parseAgentPrompt(prompt, configuredAgents);

      debugLog({
        type: 'provide-response-trace',
        requestId,
        phase,
        isExperimentalMode,
        registryReady,
        configuredAgents: configuredAgents.size,
        agentAlias: agentRoute.agent ? agentRoute.agent.alias : '',
      });

      if (agentRoute.agent) {
        const agent = agentRoute.agent;
        const agentPrompt = agentRoute.routedPrompt;
        const allowedCapabilities = new Set(Array.isArray(agent.capabilities) ? agent.capabilities : defaultCapabilities);

        phase = 'agent-route';
        debugLog({
          type: 'provide-response-trace',
          requestId,
          phase,
          alias: agent.alias,
          promptLength: agentPrompt.length,
          provider: agent.provider,
          model: agent.model || '',
          historyPersistence: Boolean(agent.historyPersistence),
          capabilities: Array.from(allowedCapabilities),
        });

        if (!agentPrompt) {
          response.markdown(`Agent @${agent.alias} needs a prompt. Use \`@${agent.alias} <message>\`.`);
          return;
        }

        if (agentPrompt === '/reset') {
          const allowLegacyReset = Boolean(bridgeConfig.get('allowLegacyResetCommand', false));
          if (!allowLegacyReset) {
            response.markdown('Legacy in-chat reset is disabled. Use Agent Manager or `Seamless AI Bridge: Reset Agent History`.');
            return;
          }

          phase = 'agent-reset';
          await agentSessionManager.clearAgent(agent.alias);
          debugLog({
            type: 'agent-session-reset',
            requestId,
            alias: agent.alias,
          });
          response.markdown(`Reset conversation history for @${agent.alias}.`);
          return;
        }

        if (dangerousCapabilities.has('@terminal') && agentPrompt.includes('@terminal') && !allowedCapabilities.has('@terminal')) {
          phase = 'agent-capability-block';
          response.markdown(`@${agent.alias} is not allowed to use @terminal. Enable it in Agent Manager capabilities.`);
          debugLog({
            type: 'agent-capability-block',
            requestId,
            alias: agent.alias,
            capability: '@terminal',
          });
          return;
        }

        phase = 'agent-provider-request';
        const restoreAuthorPresentation = setAgentAuthorPresentation(participant, agent.alias);
        const provider = providerRegistry.get(agent.provider) || providerRegistry.get('copilot');
        const historyBefore = agent.historyPersistence ? agentSessionManager.getHistory(agent) : [];

        let assistantText = '';
        try {
          const result = await provider.send({
            prompt: agentPrompt,
            history: historyBefore,
            model: agent.model,
            requestModel: request.model,
            capabilities: Array.from(allowedCapabilities),
            agentAlias: agent.alias,
          }, {
            onToken: (text) => response.markdown(text),
            onDebug: debugLog,
            token,
          });

          assistantText = result && typeof result.text === 'string' ? result.text : '';
          if (agent.historyPersistence) {
            await agentSessionManager.appendTurns(agent, [
              { role: 'user', content: agentPrompt },
              { role: 'assistant', content: assistantText },
            ]);
          }
        } finally {
          restoreAuthorPresentation();
        }

        const historyAfter = agent.historyPersistence ? agentSessionManager.getHistory(agent) : [];
        debugLog({
          type: 'agent-session-update',
          requestId,
          alias: agent.alias,
          provider: agent.provider,
          model: agent.model || '',
          historyPersistence: Boolean(agent.historyPersistence),
          turnsBefore: historyBefore.length,
          turnsAfter: historyAfter.length,
          promptLength: agentPrompt.length,
          responseLength: assistantText.length,
          capabilities: Array.from(allowedCapabilities),
        });
        return;
      }

      if (!registryReady) {
        phase = 'refresh-first-request';
        debugLog({ type: 'provide-response-trace', requestId, phase, started: true });
        await refreshParticipantRegistry('first-request');
        debugLog({ type: 'provide-response-trace', requestId, phase, started: false, completed: true });
      }

      if (lastExperimentalMode !== isExperimentalMode) {
        phase = 'refresh-experimental-flag-change';
        debugLog({ type: 'provide-response-trace', requestId, phase, started: true });
        await refreshParticipantRegistry('experimental-flag-change');
        lastExperimentalMode = isExperimentalMode;
        debugLog({ type: 'provide-response-trace', requestId, phase, started: false, completed: true });
      }

      phase = 'provider-setup';
      const tracked = createTrackedResponse(response);
      const providerContext = {
        userPrompt: prompt,
        personaAlias: '',
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

      debugLog({
        type: 'provide-response-trace',
        requestId,
        phase,
        routed: Boolean(parseRoutePrompt(prompt)),
      });

      try {
        phase = 'planner-get-plan';
        debugLog({ type: 'provide-response-trace', requestId, phase, started: true });
        const planText = await plannerProvider.getPlan(prompt, providerContext, providerOptions);

        debugLog({
          type: 'provide-response-trace',
          requestId,
          phase,
          started: false,
          completed: true,
          planTextLength: typeof planText === 'string' ? planText.length : 0,
        });

        phase = 'coder-get-code';
        debugLog({ type: 'provide-response-trace', requestId, phase, started: true });
        await coderProvider.getCode(planText, providerContext, providerOptions);
        debugLog({ type: 'provide-response-trace', requestId, phase, started: false, completed: true });
      } catch (error) {
        const errorInfo = serializeError(error);
        debugLog({
          type: 'provide-response-error',
          requestId,
          phase,
          scope: 'provider-orchestration',
          error: errorInfo,
        });

        if (errorInfo.message === 'Cancelled') {
          response.markdown('Cancelled');
          return;
        }

        log(`Provider orchestration failed at ${phase}: ${errorInfo.message}`);
        if (errorInfo.stack) {
          log(`Provider orchestration stack (${requestId}): ${errorInfo.stack}`);
        }

        response.markdown('Routing to local bridge due to provider error.');
        debugLog({
          type: 'provide-response-trace',
          requestId,
          phase: 'provider-fallback-local-bridge',
          started: true,
        });
        await routeToLocalBridge(prompt, response, token);
      }
    } catch (error) {
      const errorInfo = serializeError(error);
      debugLog({
        type: 'provide-response-error',
        requestId,
        phase,
        scope: 'handle-request',
        error: errorInfo,
      });

      if (errorInfo.message === 'Cancelled') {
        response.markdown('Cancelled');
        return;
      }

      log(`Request handling failed at ${phase}: ${errorInfo.message}`);
      if (errorInfo.stack) {
        log(`Request handling stack (${requestId}): ${errorInfo.stack}`);
      }

      response.markdown('Routing to local bridge due to handler error.');
      await routeToLocalBridge(prompt, response, token);
    } finally {
      debugLog({
        type: 'provide-response-trace',
        requestId,
        phase: 'exit',
      });
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
    normalizePersonaAlias,
    readConfiguredPersonas,
    parsePersonaPrompt,
    toLanguageModelMessages,
  },
};
