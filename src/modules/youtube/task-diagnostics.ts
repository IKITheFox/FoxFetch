import { t as uiText } from '../../shared/i18n';
import type { YouTubeTaskSnapshot } from './background-task';
import { youtubePreparationStages } from './preparation-stage';
import { safeNetworkEvents } from './sources/sabr-transport';

/** Deliberate allowlist: never serialize the full task or private execution request. */
export function formatYouTubeTaskDiagnostics(snapshot: YouTubeTaskSnapshot): string {
  const safeId = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(snapshot.jobId)
    ? snapshot.jobId
    : uiText('E0624');
  const videoId = /^[\w-]{11}$/u.test(snapshot.videoId) ? snapshot.videoId : uiText('E0624');
  const number = (value: number | undefined) =>
    Number.isSafeInteger(value) && value! >= 0 ? String(value) : uiText('E0624');
  const states = {
    get resolving() {
      return uiText('E1658');
    },
    get preparing() {
      return uiText('E1659');
    },
    get saving() {
      return uiText('E1660');
    },
    get canceling() {
      return uiText('E1251');
    },
    get canceled() {
      return uiText('E1661');
    },
    get complete() {
      return uiText('E1662');
    },
    get failed() {
      return uiText('E1179');
    },
  };
  const kinds = {
    get merged() {
      return uiText('E0040');
    },
    get video() {
      return uiText('E0021');
    },
    get audio() {
      return uiText('E0022');
    },
  };
  const fileStates = {
    get saving() {
      return uiText('E1660');
    },
    get complete() {
      return uiText('E1663');
    },
    get interrupted() {
      return uiText('E1664');
    },
  };
  return [
    uiText('E1665'),
    ...(snapshot.formatAttempts ?? []).slice(0, 3).filter(a => /^[A-Z_0-9]{1,80}$/.test(a.error)).map((a,i)=>`${uiText('download.attempt',{current:i+1,total:snapshot.formatTotal ?? 3})}: ${a.error}`),
    ...(snapshot.bufferPeaks
      ? [
          uiText('download.bufferPeaks', {
            response: number(snapshot.bufferPeaks.RESPONSE_BYTES),
            retained: number(snapshot.bufferPeaks.RETAINED_BYTES),
            writing: number(snapshot.bufferPeaks.WRITING_BYTES),
          }),
        ]
      : []),
    uiText('E1666', { p1: safeId }),
    uiText('E1667', { p1: videoId }),
    uiText('E1668', { p1: states[snapshot.state] ?? uiText('E0624') }),
    ...(snapshot.preparationStage &&
    Object.hasOwn(youtubePreparationStages, snapshot.preparationStage)
      ? [uiText('E1669', { p1: youtubePreparationStages[snapshot.preparationStage] })]
      : []),
    uiText('E1670', { p1: number(snapshot.saveAttempt ?? 0) }),
    uiText('E1671', { p1: number(snapshot.readBytes) }),
    ...safeNetworkEvents(snapshot.network).map((event) =>
      uiText('E1672', {
        p1: event.request,
        p2: event.attempt,
        p3: event.phase,
        p4: event.elapsedMs,
        p5: event.status ?? uiText('E0624'),
        p6: event.permission ?? uiText('E0624'),
        p7: event.code ?? uiText('E1673'),
      }),
    ),
    ...(snapshot.primaryError && /^[A-Z][A-Z_0-9]{1,80}$/u.test(snapshot.primaryError)
      ? [uiText('E1674', { p1: snapshot.primaryError })]
      : []),
    uiText('E1675', { p1: snapshot.cleanupPending === true ? uiText('E1318') : uiText('E1319') }),
    uiText('E1676', { p1: snapshot.retryAvailable === true ? uiText('E1318') : uiText('E1319') }),
    ...(snapshot.error
      ? [
          uiText('E1677', {
            p1: /^[A-Z][A-Z_0-9]{1,80}$/u.test(snapshot.error) ? snapshot.error : uiText('E1678'),
          }),
        ]
      : []),
    ...snapshot.files.slice(0, 2).map((file) =>
      uiText('E1679', {
        p1: kinds[file.kind] ?? uiText('E1680'),
        p2: fileStates[file.state] ?? uiText('E0624'),
        p3: number(file.savedBytes),
        p4: number(file.size),
      }),
    ),
    uiText('E1681'),
  ].join('\n');
}
