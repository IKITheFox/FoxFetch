import { t as uiText } from '../shared/i18n';
import type { SourceCaptureStatus, SourceCaptureView } from '../shared/types';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';

export interface SourceCapturePanelProps {
  capture: SourceCaptureView;
  onReload: () => void;
  onDownload: () => void;
  onCancel: () => void;
  onRestart: () => void;
  busy?: boolean;
}

interface CaptureCopy {
  eyebrow: string;
  title: string;
  description: string;
  icon: IconName;
  tone: 'active' | 'success' | 'danger' | 'neutral';
}

const captureCopy: Record<SourceCaptureStatus, CaptureCopy> = {
  permission_required: {
    get eyebrow() {
      return uiText('E0060');
    },
    get title() {
      return uiText('E0061');
    },
    get description() {
      return uiText('E0062');
    },
    icon: 'shield',
    tone: 'neutral',
  },
  reload_required: {
    get eyebrow() {
      return uiText('E0063');
    },
    get title() {
      return uiText('E0064');
    },
    get description() {
      return uiText('E0065');
    },
    icon: 'refresh',
    tone: 'active',
  },
  waiting_for_playback: {
    get eyebrow() {
      return uiText('E0066');
    },
    get title() {
      return uiText('E0067');
    },
    get description() {
      return uiText('E0068');
    },
    icon: 'play',
    tone: 'active',
  },
  capturing: {
    get eyebrow() {
      return uiText('E0069');
    },
    get title() {
      return uiText('E0070');
    },
    get description() {
      return uiText('E0071');
    },
    icon: 'spinner',
    tone: 'active',
  },
  analyzing: {
    get eyebrow() {
      return uiText('E0072');
    },
    get title() {
      return uiText('E0073');
    },
    get description() {
      return uiText('E0074');
    },
    icon: 'spinner',
    tone: 'active',
  },
  resolved: {
    get eyebrow() {
      return uiText('E0075');
    },
    get title() {
      return uiText('E0076');
    },
    get description() {
      return uiText('E0077');
    },
    icon: 'check',
    tone: 'success',
  },
  failed: {
    get eyebrow() {
      return uiText('E0078');
    },
    get title() {
      return uiText('E0079');
    },
    get description() {
      return uiText('E0080');
    },
    icon: 'error',
    tone: 'danger',
  },
  cancelled: {
    get eyebrow() {
      return uiText('E0081');
    },
    get title() {
      return uiText('E0082');
    },
    get description() {
      return uiText('E0083');
    },
    icon: 'close',
    tone: 'neutral',
  },
};

function activeStep(status: SourceCaptureStatus): number {
  if (status === 'resolved') return 3;
  if (status === 'capturing' || status === 'analyzing') {
    return 2;
  }
  return 1;
}

function downloadLabel(capture: SourceCaptureView): string {
  if (capture.videoAssetId && capture.audioAssetId) return uiText('E0084');
  if (capture.directAssetId) return uiText('E0085');
  return uiText('E0086');
}

export function SourceCapturePanel({
  capture,
  onReload,
  onDownload,
  onCancel,
  onRestart,
  busy = false,
}: SourceCapturePanelProps) {
  const copy = captureCopy[capture.status];
  const step = activeStep(capture.status);
  const detail = capture.error || capture.message;

  return (
    <section
      className={`source-capture source-capture--${copy.tone}`}
      aria-labelledby={`source-capture-title-${capture.id}`}
    >
      <div className="source-capture__head">
        <span className="source-capture__icon" aria-hidden="true">
          <Icon
            name={copy.icon}
            size={19}
            className={copy.icon === 'spinner' ? 'spin' : undefined}
          />
        </span>
        <div className="source-capture__copy" aria-live="polite">
          <span className="source-capture__eyebrow">{copy.eyebrow}</span>
          <strong id={`source-capture-title-${capture.id}`}>{copy.title}</strong>
          <p>{detail || copy.description}</p>
        </div>
      </div>

      <ol className="source-capture__steps" aria-label={uiText('E0087')}>
        {[uiText('E0088'), uiText('E0089'), uiText('E0086')].map((label, index) => {
          const stepNumber = index + 1;
          const isComplete = stepNumber < step || capture.status === 'resolved';
          const isCurrent = stepNumber === step && capture.status !== 'cancelled';

          return (
            <li
              key={label}
              className={`${isComplete ? 'is-complete' : ''}${isCurrent ? ' is-current' : ''}`}
              aria-current={isCurrent ? 'step' : undefined}
            >
              <span>{isComplete ? <Icon name="check" size={11} /> : stepNumber}</span>
              {label}
            </li>
          );
        })}
      </ol>

      <div className="source-capture__stats" aria-label={uiText('E0090')}>
        <span>
          {' '}
          {uiText('E0091')} <strong>{capture.observationCount}</strong> {uiText('E0092')}{' '}
        </span>
        <span>
          {' '}
          {uiText('E0093')} <strong>{capture.candidateCount}</strong> {uiText('E0094')}{' '}
        </span>
        {capture.videoAssetId && capture.audioAssetId ? <em>{uiText('E0095')}</em> : null}
      </div>

      <div className="source-capture__actions">
        {capture.status === 'reload_required' ? (
          <Button icon="refresh" variant="primary" size="sm" loading={busy} onClick={onReload}>
            {' '}
            {uiText('E0096')}{' '}
          </Button>
        ) : null}
        {capture.status === 'resolved' ? (
          <Button icon="download" variant="primary" size="sm" loading={busy} onClick={onDownload}>
            {downloadLabel(capture)}
          </Button>
        ) : null}
        {capture.status === 'permission_required' ||
        capture.status === 'failed' ||
        capture.status === 'cancelled' ? (
          <Button icon="refresh" variant="primary" size="sm" loading={busy} onClick={onRestart}>
            {capture.status === 'permission_required' ? uiText('E0097') : uiText('E0098')}
          </Button>
        ) : null}
        {capture.status === 'waiting_for_playback' || capture.status === 'capturing' ? (
          <Button icon="refresh" variant="secondary" size="sm" disabled={busy} onClick={onReload}>
            {' '}
            {uiText('E0099')}{' '}
          </Button>
        ) : null}
        {capture.status !== 'cancelled' ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            {capture.status === 'resolved' ? uiText('E0100') : uiText('E0101')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
