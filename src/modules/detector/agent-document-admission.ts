export type AgentDocumentLifecycle = 'prerender' | 'active' | 'cached' | 'pending_deletion';

export type AgentDocumentAdmission =
  | { accepted: true; replaceCurrent: boolean; restoreRetired: boolean }
  | {
      accepted: false;
      reason: 'inactive_document' | 'retired_document' | 'unexpected_document';
    };

export interface AgentDocumentAdmissionInput {
  incomingDocumentId?: string;
  currentDocumentId?: string;
  retiredDocumentIds?: ReadonlySet<string>;
  lifecycle?: AgentDocumentLifecycle;
  /**
   * Only a freshly injected/current document proof may replace a registered
   * frame. Ordinary Agent state and route events can never revive themselves.
   */
  replacementProof?: 'active_ready' | 'current_injection';
}

/**
 * Decide whether an Agent message belongs to the live frame document.
 *
 * A retired id remains unavailable to page-originated Agent messages. The one
 * exception is `current_injection`: executeScript has just returned that id as
 * the browser's current frame document, which is the proof needed to restore a
 * document revived from BFCache. Once the caller records that id as current,
 * ordinary messages from the same document are accepted again; every other
 * retired id remains rejected.
 */
export function decideAgentDocumentAdmission({
  incomingDocumentId,
  currentDocumentId,
  retiredDocumentIds,
  lifecycle,
  replacementProof,
}: AgentDocumentAdmissionInput): AgentDocumentAdmission {
  if (lifecycle != null && lifecycle !== 'active') {
    return { accepted: false, reason: 'inactive_document' };
  }
  if (!incomingDocumentId) {
    return replacementProof === 'current_injection'
      ? { accepted: true, replaceCurrent: false, restoreRetired: false }
      : { accepted: false, reason: 'unexpected_document' };
  }
  // A retired BFCache document reaches this branch only after a trusted
  // current_injection admission has made it the registered frame again.
  if (currentDocumentId === incomingDocumentId) {
    return {
      accepted: true,
      replaceCurrent: false,
      restoreRetired:
        replacementProof === 'current_injection' &&
        Boolean(retiredDocumentIds?.has(incomingDocumentId)),
    };
  }
  if (retiredDocumentIds?.has(incomingDocumentId)) {
    return replacementProof === 'current_injection'
      ? { accepted: true, replaceCurrent: currentDocumentId != null, restoreRetired: true }
      : { accepted: false, reason: 'retired_document' };
  }
  if (
    replacementProof === 'current_injection' ||
    (replacementProof === 'active_ready' && lifecycle === 'active')
  ) {
    return {
      accepted: true,
      replaceCurrent: currentDocumentId != null,
      restoreRetired: false,
    };
  }
  return { accepted: false, reason: 'unexpected_document' };
}
