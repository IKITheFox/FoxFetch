import { describe, expect, it } from 'vitest';

import { decideAgentDocumentAdmission } from '../../src/modules/detector/agent-document-admission';

describe('Agent document admission', () => {
  it('allows ordinary messages only from the registered active document', () => {
    expect(
      decideAgentDocumentAdmission({
        incomingDocumentId: 'document-live',
        currentDocumentId: 'document-live',
        lifecycle: 'active',
      }),
    ).toEqual({ accepted: true, replaceCurrent: false, restoreRetired: false });
    expect(
      decideAgentDocumentAdmission({
        incomingDocumentId: 'document-other',
        currentDocumentId: 'document-live',
        lifecycle: 'active',
      }),
    ).toEqual({ accepted: false, reason: 'unexpected_document' });
    expect(
      decideAgentDocumentAdmission({
        incomingDocumentId: 'document-unregistered',
        lifecycle: 'active',
      }),
    ).toEqual({ accepted: false, reason: 'unexpected_document' });
  });

  it('lets active AGENT_READY replace a frame but never lets the retired document return', () => {
    let currentDocumentId = 'document-before-reload';
    const retiredDocumentIds = new Set<string>();
    const ready = decideAgentDocumentAdmission({
      incomingDocumentId: 'document-after-reload',
      currentDocumentId,
      retiredDocumentIds,
      lifecycle: 'active',
      replacementProof: 'active_ready',
    });

    expect(ready).toEqual({ accepted: true, replaceCurrent: true, restoreRetired: false });
    if (ready.accepted && ready.replaceCurrent) {
      retiredDocumentIds.add(currentDocumentId);
      currentDocumentId = 'document-after-reload';
    }

    // Same URL is intentionally not part of the decision. Identity, not URL,
    // makes the delayed old-document message stale after a reload or A -> B -> A.
    expect(
      decideAgentDocumentAdmission({
        incomingDocumentId: 'document-before-reload',
        currentDocumentId,
        retiredDocumentIds,
        lifecycle: 'active',
      }),
    ).toEqual({ accepted: false, reason: 'retired_document' });
    expect(
      decideAgentDocumentAdmission({
        incomingDocumentId: 'document-before-reload',
        currentDocumentId,
        retiredDocumentIds,
        lifecycle: 'active',
        replacementProof: 'active_ready',
      }),
    ).toEqual({ accepted: false, reason: 'retired_document' });
  });

  it('rejects cached and pending-deletion senders even when their URL still matches', () => {
    for (const lifecycle of ['cached', 'pending_deletion', 'prerender'] as const) {
      expect(
        decideAgentDocumentAdmission({
          incomingDocumentId: 'document-old',
          currentDocumentId: 'document-old',
          lifecycle,
        }),
      ).toEqual({ accepted: false, reason: 'inactive_document' });
    }
  });

  it('requires Chrome active-lifecycle proof to replace from AGENT_READY', () => {
    expect(
      decideAgentDocumentAdmission({
        incomingDocumentId: 'document-new',
        currentDocumentId: 'document-old',
        replacementProof: 'active_ready',
      }),
    ).toEqual({ accepted: false, reason: 'unexpected_document' });
    expect(
      decideAgentDocumentAdmission({
        incomingDocumentId: 'document-new',
        currentDocumentId: 'document-old',
        replacementProof: 'current_injection',
      }),
    ).toEqual({ accepted: true, replaceCurrent: true, restoreRetired: false });
    expect(decideAgentDocumentAdmission({ replacementProof: 'current_injection' })).toEqual({
      accepted: true,
      replaceCurrent: false,
      restoreRetired: false,
    });
  });

  it('re-admits only the BFCache document proven current by executeScript', () => {
    const restoredDocumentId = 'document-restored-from-bfcache';
    const unrelatedRetiredDocumentId = 'document-from-an-older-navigation';
    const retiredDocumentIds = new Set([restoredDocumentId, unrelatedRetiredDocumentId]);
    let currentDocumentId = 'document-before-back';

    expect(
      decideAgentDocumentAdmission({
        incomingDocumentId: restoredDocumentId,
        currentDocumentId,
        retiredDocumentIds,
        lifecycle: 'cached',
        replacementProof: 'current_injection',
      }),
    ).toEqual({ accepted: false, reason: 'inactive_document' });
    expect(
      decideAgentDocumentAdmission({
        incomingDocumentId: restoredDocumentId,
        currentDocumentId,
        retiredDocumentIds,
        lifecycle: 'active',
        replacementProof: 'active_ready',
      }),
    ).toEqual({ accepted: false, reason: 'retired_document' });

    const injection = decideAgentDocumentAdmission({
      incomingDocumentId: restoredDocumentId,
      currentDocumentId,
      retiredDocumentIds,
      replacementProof: 'current_injection',
    });
    expect(injection).toEqual({
      accepted: true,
      replaceCurrent: true,
      restoreRetired: true,
    });
    if (injection.accepted) {
      currentDocumentId = restoredDocumentId;
      if (injection.restoreRetired) retiredDocumentIds.delete(restoredDocumentId);
    }

    expect(
      decideAgentDocumentAdmission({
        incomingDocumentId: restoredDocumentId,
        currentDocumentId,
        retiredDocumentIds,
        lifecycle: 'active',
      }),
    ).toEqual({ accepted: true, replaceCurrent: false, restoreRetired: false });
    expect(
      decideAgentDocumentAdmission({
        incomingDocumentId: unrelatedRetiredDocumentId,
        currentDocumentId,
        retiredDocumentIds,
        lifecycle: 'active',
      }),
    ).toEqual({ accepted: false, reason: 'retired_document' });
  });
});
