import type { MergeDirectoryPickerOpened } from '../../shared/types';
import type {
  MergeDirectoryPickerPopupIdentity,
  MergeDirectoryPickerSession,
  MergeDirectoryPickerSessionBroker,
  MergeDirectoryPickerSessionOwner,
} from './directory-picker-session';

export interface MergeDirectoryPickerOpenServices {
  broker: Pick<
    MergeDirectoryPickerSessionBroker,
    'clearOtherOwners' | 'getOrIssue' | 'bindPopup' | 'remove'
  >;
  /** Re-read the persisted job fence and current source-document ownership. */
  assertCurrent(): Promise<void>;
  closeWindows(ids: number[]): Promise<void>;
  createPopup(): Promise<MergeDirectoryPickerPopupIdentity>;
  inspectPopup(popup: MergeDirectoryPickerPopupIdentity): Promise<void>;
  focusPopup(popup: MergeDirectoryPickerPopupIdentity): Promise<void>;
  navigatePopup(
    popup: MergeDirectoryPickerPopupIdentity,
    session: MergeDirectoryPickerSession,
  ): Promise<void>;
}

/** Every browser/storage await can lose ownership; never leave a late picker open. */
export async function openBoundMergeDirectoryPicker(
  owner: MergeDirectoryPickerSessionOwner,
  services: MergeDirectoryPickerOpenServices,
): Promise<MergeDirectoryPickerOpened> {
  let session: MergeDirectoryPickerSession | undefined;
  let popup: MergeDirectoryPickerPopupIdentity | undefined;
  try {
    await services.assertCurrent();
    await services.closeWindows(await services.broker.clearOtherOwners(owner));
    await services.assertCurrent();
    let issued = await services.broker.getOrIssue(owner);
    session = issued.session;
    await services.assertCurrent();
    if (issued.reused && session.popupWindowId != null && session.popupTabId != null) {
      popup = { popupWindowId: session.popupWindowId, popupTabId: session.popupTabId };
      try {
        await services.inspectPopup(popup);
        await services.assertCurrent();
        await services.focusPopup(popup);
        await services.assertCurrent();
        return { reused: true };
      } catch {
        // Cancellation/route changes are not a reason to open a replacement.
        await services.assertCurrent();
        await services.broker.remove(session.id);
        await services.closeWindows([popup.popupWindowId]);
        popup = undefined;
        await services.assertCurrent();
        issued = await services.broker.getOrIssue(owner);
        session = issued.session;
        await services.assertCurrent();
      }
    } else if (issued.reused) {
      return { reused: true };
    }
    popup = await services.createPopup();
    await services.assertCurrent();
    session = await services.broker.bindPopup(session.id, popup);
    await services.assertCurrent();
    await services.navigatePopup(popup, session);
    await services.assertCurrent();
    return { reused: false };
  } catch (error) {
    if (session) await services.broker.remove(session.id).catch(() => undefined);
    if (popup) await services.closeWindows([popup.popupWindowId]);
    throw error;
  }
}
