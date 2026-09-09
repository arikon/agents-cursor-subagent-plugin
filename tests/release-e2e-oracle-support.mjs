function exactPermission(turn, markerPath, alreadyAllowed) {
  const pending = turn.pending || [];
  if (alreadyAllowed || pending.length !== 1 || pending[0].kind !== 'permission') throw new Error('unexpected pending request');
  const locations = pending[0].context?.locations || [];
  if (locations.length === 0 || locations.some((location) => location.path?.text !== markerPath)) throw new Error('permission location is outside the exact marker path');
  return pending[0];
}

function terminalAgentError(turn) {
  return /^\s*Error:/.test(turn?.result?.text || '');
}

function classifyLiveOutcome({ enabled, failure = null, closeSucceeded = false, markerMatches = false }) {
  if (!enabled) return { status: 'skipped' };
  if (failure) return { status: 'integration_failure', message: failure };
  if (!closeSucceeded) return { status: 'integration_failure', message: 'finally close failed' };
  return markerMatches ? { status: 'pass' } : { status: 'agent_behavior_mismatch' };
}


export { exactPermission, terminalAgentError, classifyLiveOutcome };
