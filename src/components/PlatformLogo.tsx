import { t as uiText } from '../shared/i18n';
import { Icon } from './Icon';
import {
  mediaPlatformFromSource,
  mediaPlatformLabel,
  type MediaPlatformKind,
} from '../shared/platform-display';

export type MediaPlatform = MediaPlatformKind;

export function platformFromSource(source?: string): MediaPlatform {
  return mediaPlatformFromSource(source);
}

export function platformLabel(platform: MediaPlatform): string {
  return mediaPlatformLabel(platform);
}

export interface PlatformLogoProps {
  platform?: MediaPlatform | string | undefined;
  source?: string | undefined;
  size?: 'sm' | 'md';
}

export function PlatformLogo({ platform, source, size = 'md' }: PlatformLogoProps) {
  const resolved = platform ? platformFromSource(platform) : platformFromSource(source);
  const label = platformLabel(resolved);
  return (
    <span
      className={`platform-logo platform-logo--${resolved} platform-logo--${size}`}
      role="img"
      aria-label={uiText('E0058', { p1: label })}
    >
      {resolved === 'bilibili' ? (
        <svg viewBox="0 0 28 24" aria-hidden="true">
          <path d="m8 4-3-3m15 3 3-3M4 7.5h20v14H4z" />
          <path d="m10 12 2 2 2-2 2 2 2-2" />
        </svg>
      ) : resolved === 'youtube' ? (
        <svg viewBox="0 0 28 20" aria-hidden="true">
          <path d="M26 3.2C25.7 1.8 24.6.7 23.2.4 21.1 0 17.2 0 14 0S6.9 0 4.8.4C3.4.7 2.3 1.8 2 3.2 1.6 5.1 1.6 8 1.6 10s0 4.9.4 6.8c.3 1.4 1.4 2.5 2.8 2.8 2.1.4 6 .4 9.2.4s7.1 0 9.2-.4c1.4-.3 2.5-1.4 2.8-2.8.4-1.9.4-4.8.4-6.8S26.4 5.1 26 3.2Z" />
          <path d="m11.5 14.2 6-4.2-6-4.2Z" className="platform-logo__play" />
        </svg>
      ) : (
        <Icon name="video" size={size === 'sm' ? 17 : 21} />
      )}
    </span>
  );
}
