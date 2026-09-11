import type { MediaDockProductQualityView } from '../../shared/types';
import { compactQualityLabel } from '../../shared/quality-label';
import {
  mediaPlatformView,
  type MediaPlatformKind,
  type MediaPlatformView,
} from '../../shared/platform-display';

export type FloatingMediaPlatform = MediaPlatformKind;

export type FloatingMediaPlatformView = MediaPlatformView;

export interface FloatingDockQualityChoice {
  quality: MediaDockProductQualityView;
  codecLabel: string;
  hasExplicitCodec: boolean;
}

export interface FloatingDockQualityGroup {
  key: string;
  label: string;
  choices: FloatingDockQualityChoice[];
}

function normalizedCodecLabel(value: string): string | undefined {
  const label = value.trim().toUpperCase().replace(/\s+/gu, ' ');
  if (/^(?:AV1|AV01(?:\..*)?)$/u.test(label)) return 'AV1';
  if (/^(?:AVC(?:\s*\/\s*H\.?264)?|H\.?264|AVC1(?:\..*)?)$/u.test(label)) return 'AVC';
  if (/^(?:HEVC(?:\s*\/\s*H\.?265)?|H\.?265|HVC1(?:\..*)?|HEV1(?:\..*)?)$/u.test(label)) {
    return 'HEVC';
  }
  if (/^(?:VP9|VP09(?:\..*)?)$/u.test(label)) return 'VP9';
  return undefined;
}

/**
 * Turns the current combined quality labels (for example `1080P · AVC`) into
 * two UI dimensions without changing or deriving the background-issued token.
 */
export function groupFloatingDockQualities(
  qualities: readonly MediaDockProductQualityView[],
  retainedSelection?: MediaDockProductQualityView,
): FloatingDockQualityGroup[] {
  const groups = new Map<string, FloatingDockQualityGroup>();
  const displayed = retainedSelection
    ? [retainedSelection, ...qualities.filter((quality) => quality.id !== retainedSelection.id)]
    : qualities;
  for (const quality of displayed) {
    // A quality with no video action must not be offered as a new choice.
    // An explicit retained selection may show temporary absence or a fresh
    // fidelity rejection, with both choices and download actions disabled.
    if (!quality.completeAvailable && !quality.videoOnlyAvailable && quality !== retainedSelection)
      continue;
    const parts = quality.label
      .split(/\s*·\s*/u)
      .map((part) => part.trim())
      .filter(Boolean);
    let codecLabel: string | undefined;
    const qualityParts: string[] = [];
    for (const part of parts) {
      const codec = normalizedCodecLabel(part);
      if (!codecLabel && codec) codecLabel = codec;
      else qualityParts.push(part);
    }
    const resolutionLabel =
      compactQualityLabel(...qualityParts) || quality.label.trim() || '默认清晰度';
    const existing = groups.get(resolutionLabel);
    const choice: FloatingDockQualityChoice = {
      quality,
      codecLabel: codecLabel ?? '默认编码',
      hasExplicitCodec: codecLabel != null,
    };
    if (existing) existing.choices.push(choice);
    else {
      groups.set(resolutionLabel, {
        key: resolutionLabel,
        label: resolutionLabel,
        choices: [choice],
      });
    }
  }
  return [...groups.values()];
}

export function floatingMediaPlatform(domain: string): FloatingMediaPlatformView {
  return mediaPlatformView(domain);
}
