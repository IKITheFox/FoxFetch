import { t as uiText } from '../shared/i18n';
export interface PlaybackRateSliderProps {
  id: string;
  value: number;
  onChange: (value: number) => void;
}

/** The rail expresses speed, not progress. Keep historical values until user input. */
export function PlaybackRateSlider({ id, value, onChange }: PlaybackRateSliderProps) {
  return (
    <span className="playback-rate-slider">
      <output htmlFor={id} aria-live="polite">
        {value}×
      </output>
      <input
        id={id}
        type="range"
        min="0.1"
        max="16"
        step="0.05"
        value={Math.min(16, Math.max(0.1, value))}
        aria-valuetext={uiText('E0059', { p1: value })}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </span>
  );
}
