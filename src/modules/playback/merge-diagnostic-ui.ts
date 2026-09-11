import { t as uiText } from '../../shared/i18n';
import { messageText } from '../../shared/i18n/legacy-message';
import type { MergeDockView } from '../../shared/types';
import { sanitizeMergeDiagnosticText } from '../../shared/merge-diagnostic-text';
import { publicSourceTimelineDiagnostic } from '../jobs/public-diagnostics';

function seconds(value: number | undefined): string | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(9).replace(/\.?0+$/u, '') || '0'} s`
    : undefined;
}

/** Whitelist each displayed field; never stringify a worker/runtime object. */
export function mergeDiagnosticLines(
  diagnostics: MergeDockView['diagnostics'],
  failure: string | undefined,
  formatBytes: (bytes: number) => string,
): string[] {
  const lines: string[] = [];
  const reason = sanitizeMergeDiagnosticText(diagnostics?.reason)?.trim();
  const safeFailure = sanitizeMergeDiagnosticText(failure)?.trim();
  const equivalentText = (value: string) =>
    value
      .normalize('NFKC')
      .replace(/[\s\p{P}]+/gu, '')
      .toLocaleLowerCase();
  const add = (label: string, value: string | undefined) => {
    if (value) lines.push(`${label}：${value}`);
  };
  const code = (value?: string) => (value && /^[A-Z0-9_]{1,80}$/u.test(value) ? value : undefined);
  const choice = (values: Record<string, string>, key: string) =>
    Object.hasOwn(values, key) ? values[key] : undefined;
  const bytes = (value: number) =>
    Number.isFinite(value) && value >= 0 ? formatBytes(value) : uiText('E0624');
  add(uiText('E1264'), messageText(sanitizeMergeDiagnosticText(diagnostics?.stage) ?? ''));
  if (diagnostics)
    add(
      uiText('E1265'),
      `${bytes(diagnostics.readBytes)}${diagnostics.totalBytes == null ? '' : ` / ${bytes(diagnostics.totalBytes)}`}`,
    );
  add(uiText('E1266'), code(diagnostics?.errorCode));
  add(uiText('E1267'), code(diagnostics?.reasonCode));
  if (diagnostics?.taskReference && /^[\w-]{1,96}$/u.test(diagnostics.taskReference))
    add(uiText('E1268'), diagnostics.taskReference);
  if (reason) lines.push(messageText(reason));
  // The outer message often repeats CODE: reason. Preserve the precise public
  // reason once, retaining an independent transport error only when different.
  if (
    safeFailure &&
    (!reason ||
      (!equivalentText(reason).includes(equivalentText(safeFailure)) &&
        !equivalentText(safeFailure).includes(equivalentText(reason))))
  )
    lines.push(messageText(safeFailure));

  const network = diagnostics?.network;
  if (network) {
    add(
      uiText('E1269'),
      choice(
        {
          get range() {
            return uiText('E1270');
          },
          get sequential() {
            return uiText('E1271');
          },
          get local() {
            return uiText('E1272');
          },
        },
        network.readMode,
      ),
    );
    if (network.fallback === 'range-unavailable') add(uiText('E1273'), uiText('E1274'));
    if (
      Number.isInteger(network.responseStatus) &&
      network.responseStatus! >= 100 &&
      network.responseStatus! <= 599
    )
      add(uiText('E1275'), String(network.responseStatus));
  }
  const timeline = diagnostics?.timeline;
  if (timeline && (timeline.track === 'video' || timeline.track === 'audio')) {
    add(uiText('E1276'), timeline.track === 'video' ? uiText('E0021') : uiText('E0022'));
    if (Number.isSafeInteger(timeline.packetIndex) && timeline.packetIndex >= 0)
      add(uiText('E1277'), String(timeline.packetIndex));
    add(
      uiText('E1278'),
      choice(
        {
          get timestamp() {
            return uiText('E1279');
          },
          get duration() {
            return uiText('E1280');
          },
          get 'non-finite'() {
            return uiText('E1281');
          },
          get timebase() {
            return uiText('E1282');
          },
        },
        timeline.mismatch,
      ),
    );
    add(uiText('E1283'), seconds(timeline.originSeconds));
    add(uiText('E1284'), seconds(timeline.sourceTimestampSeconds));
    add(uiText('E1285'), seconds(timeline.normalizedSourceTimestampSeconds));
    add(uiText('E1286'), seconds(timeline.outputTimestampSeconds));
    add(uiText('E1287'), seconds(timeline.timestampDeltaSeconds));
    add(uiText('E1288'), seconds(timeline.timestampToleranceSeconds));
    add(uiText('E1289'), seconds(timeline.sourceDurationSeconds));
    add(uiText('E1290'), seconds(timeline.outputDurationSeconds));
    add(uiText('E1291'), seconds(timeline.durationDeltaSeconds));
    add(uiText('E1292'), seconds(timeline.durationToleranceSeconds));
    for (const [label, scale] of [
      [uiText('E1293'), timeline.sourceTimescale],
      [uiText('E1294'), timeline.outputTimescale],
    ] as const) {
      if (scale != null && Number.isSafeInteger(scale) && scale > 0) add(label, `1/${scale}`);
    }
  }
  const sourceTimeline = publicSourceTimelineDiagnostic(diagnostics?.sourceTimeline);
  if (sourceTimeline) {
    add(
      uiText('E1295'),
      sourceTimeline.sourceKind === 'video'
        ? uiText('E0021')
        : sourceTimeline.sourceKind === 'audio'
          ? uiText('E0022')
          : undefined,
    );
    add(uiText('E1296'), sourceTimeline.box);
    add(
      uiText('E1297'),
      choice(
        {
          get 'invalid-box'() {
            return uiText('E1298');
          },
          get 'metadata-limit'() {
            return uiText('E1299');
          },
          get 'unsupported-version'() {
            return uiText('E1300');
          },
          get 'invalid-timebase'() {
            return uiText('E1301');
          },
          get 'duplicate-metadata'() {
            return uiText('E1302');
          },
          get 'invalid-track'() {
            return uiText('E1303');
          },
          get 'malformed-edit-list'() {
            return uiText('E1304');
          },
          get 'edit-rate'() {
            return uiText('E1305');
          },
          get 'negative-media-time'() {
            return uiText('E1306');
          },
          get 'open-ended-offset'() {
            return uiText('E1307');
          },
          get 'multiple-edits'() {
            return uiText('E1308');
          },
          get 'empty-edit-list'() {
            return uiText('E1309');
          },
        },
        sourceTimeline.issue,
      ),
    );
    for (const [key, label] of [
      ['version', uiText('E1310')],
      ['entryCount', uiText('E1311')],
      ['entryIndex', uiText('E1312')],
      ['movieTimescale', uiText('E1313')],
      ['mediaTimescale', uiText('E1314')],
      ['duration', uiText('E1315')],
      ['mediaTime', uiText('E1316')],
      ['rate', uiText('E1317')],
    ] as const) {
      if (sourceTimeline[key] != null) add(label, String(sourceTimeline[key]));
    }
  }
  const configuration = diagnostics?.configuration;
  if (configuration) {
    const integer = (value: number | undefined, min = 0, max = 255) =>
      value != null && Number.isSafeInteger(value) && value >= min && value <= max
        ? String(value)
        : uiText('E0624');
    const flag = (value: boolean | undefined) =>
      value === true ? uiText('E1318') : value === false ? uiText('E1319') : uiText('E0624');
    for (const [label, config] of [
      [uiText('E1320'), configuration.source],
      [uiText('E1321'), configuration.output],
    ] as const) {
      if (!config) {
        add(uiText('E1322', { p1: label }), uiText('E0624'));
        continue;
      }
      const entry =
        config.sampleEntryType &&
        ['dvh1', 'dvhe', 'hvc1', 'hev1', 'avc1', 'avc3'].includes(config.sampleEntryType)
          ? config.sampleEntryType
          : uiText('E0624');
      add(
        uiText('E1323', { p1: label }),
        uiText('E1324', {
          p1: entry,
          p2: integer(config.bitDepthLuma, 8, 16),
          p3: integer(config.bitDepthChroma, 8, 16),
          p4: integer(config.chromaFormatIdc, 0, 3),
        }),
      );
      add(
        uiText('E1325', { p1: label }),
        `Profile ${integer(config.profile, 0, 127)} · Level ${integer(config.level, 0, 63)} · RPU ${flag(config.rpuPresent)} · BL ${flag(config.baseLayerPresent)} · EL ${flag(config.enhancementLayerPresent)}`,
      );
      add(
        uiText('E1326', { p1: label }),
        uiText('E1327', {
          p1: flag(config.parameterSetsComplete),
          p2: flag(config.parameterSetsConflict),
        }),
      );
      const colourSource =
        config.colourSource && ['colr', 'sps-vui', 'colr+sps-vui'].includes(config.colourSource)
          ? config.colourSource
          : uiText('E0624');
      add(
        uiText('E1328', { p1: label }),
        uiText('E1329', {
          p1: colourSource,
          p2: integer(config.colourPrimaries),
          p3: integer(config.transferCharacteristics),
          p4: integer(config.matrixCoefficients),
          p5: flag(config.fullRange),
          p6: flag(config.colourConflict),
        }),
      );
    }
  }
  return [...new Set(lines.map((line) => sanitizeMergeDiagnosticText(line) ?? '').filter(Boolean))];
}
