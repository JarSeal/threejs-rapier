import * as THREE from 'three/webgpu';
import { CMP } from '../../utils/CMP';
import { IS_DEBUG_ENV } from '../Config';
import { createLines, writePolyline, type LineObject } from '../LineManager';
import { createDebuggerTab, updateDebuggerTab } from '../../debug/DebuggerGUI';
import { PercentagePieHtml } from '../../utils/UI/PercentagePieHtml';
import type { IntervalWindowSnapshot } from '../../utils/stats/IntervalCounterStats';
import { getRayCastStats, isRayCastStatsEnabled, setRayCastStatsEnabled } from '../Raycast';

const DEFAULT_HELPER_COLOR = '#ff0000';
const DEFAULT_MAX_HELPER_LENGTH = 1000;
const LS_KEY = 'debugRayCast';
const TAB_ID = 'rayCastControls';
/** One single-segment line per helper id, refilled on every draw. */
const rayHelpers = new Map<string, { line: LineObject; color: THREE.ColorRepresentation }>();
/** Helper ids drawn since the last cleanup; the rest are disposed by it. */
const drawnHelperIds = new Set<string>();
const rayEnd = new THREE.Vector3();
const rayPoints: THREE.Vector3Like[] = [rayEnd, rayEnd];
const rayCastState = {
  showAllRayDebugHelpers: false,
  enableRayStatistics: false,
};

export const _initRayCastingDebugger = () => {
  if (IS_DEBUG_ENV) {
    createDebugControls();
    // The persisted toggle is hydrated by createDebuggerTab
    setRayCastStatsEnabled(rayCastState.enableRayStatistics);
  }
};

export const _drawRayHelper = ({
  from,
  to,
  endLength,
  helperId,
  helperColor,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  endLength?: number;
  helperId?: string;
  helperColor?: THREE.ColorRepresentation;
}) => {
  if (!helperId || !rayCastState.showAllRayDebugHelpers) return;

  const color = helperColor || DEFAULT_HELPER_COLOR;
  let helper = rayHelpers.get(helperId);
  if (!helper) {
    helper = {
      line: createLines({
        name: `rayHelper_${helperId}`,
        capacity: 1,
        growth: 'FIXED',
        color,
        // This module disposes them (cleanup, deleteAllRayHelpers), not the scene switch
        persistent: true,
      }),
      color,
    };
    rayHelpers.set(helperId, helper);
  } else if (helper.color !== color) {
    helper.color = color;
    helper.line.setColor(color);
  }

  rayEnd
    .copy(to)
    .multiplyScalar(endLength || DEFAULT_MAX_HELPER_LENGTH)
    .add(from);
  rayPoints[0] = from;
  writePolyline(helper.line.beginWrite(), rayPoints);
  helper.line.endWrite();
  drawnHelperIds.add(helperId);
};

/** Once per rendered frame (Raycast.ts's LATE_MAIN frame end, after the stats frame has ended):
 * disposes the helpers of rays that weren't cast this frame, and refreshes the stats view. */
export const _onRayCastFrameEnd = () => {
  for (const [helperId, helper] of rayHelpers) {
    if (drawnHelperIds.has(helperId)) continue;
    helper.line.dispose();
    rayHelpers.delete(helperId);
  }
  drawnHelperIds.clear();
  // Only refreshes when it's the open tab
  if (isRayCastStatsEnabled()) updateDebuggerTab(TAB_ID);
};

export const _deleteAllRayHelpers = () => {
  for (const helper of rayHelpers.values()) helper.line.dispose();
  rayHelpers.clear();
  drawnHelperIds.clear();
};

export const _toggleAllRayDebugHelpers = (show?: boolean) => {
  rayCastState.showAllRayDebugHelpers = show ?? !rayCastState.showAllRayDebugHelpers;
  updateDebuggerTab(TAB_ID);
};

const createDebugControls = () => {
  createDebuggerTab({
    id: TAB_ID,
    title: 'Ray cast controls',
    icon: 'heartArrow',
    lsKey: LS_KEY,
    state: rayCastState,
    persistKeys: ['showAllRayDebugHelpers', 'enableRayStatistics'],
    content: () => [
      {
        pane: true,
        content: [
          { key: 'showAllRayDebugHelpers', label: 'Show ray cast helpers' },
          {
            key: 'enableRayStatistics',
            label: 'Enable ray cast statistics',
            onChange: () => {
              setRayCastStatsEnabled(rayCastState.enableRayStatistics);
              updateDebuggerTab(TAB_ID);
            },
          },
        ],
      },
      // Dynamic template: re-rendered on every tab refresh (each frame while statistics are on)
      CMP({ html: () => `<div class="rayCastStats">${getStatsHtml()}</div>` }),
    ],
  });
};

const intervalText = (win: IntervalWindowSnapshot) => `Last ${win.intervalMs / 1000}s`;

const pie = (win: IntervalWindowSnapshot) => PercentagePieHtml(Math.round(win.progress * 100));

const round2 = (n: number) => Math.round(n * 100) / 100;

const getStatsHtml = () => {
  const s = getRayCastStats();
  const isActive = isRayCastStatsEnabled();
  // Raycast.ts's window order: MIN_MAX 3s, MIN_MAX 10s, AVERAGE 3s, AVERAGE 20s
  const [minMax, minMaxLong, average, averageLong] = s.windows;
  return `<div>
  <h3>Stats:</h3>
  <ul class="${isActive ? 'active' : 'inactive'}">
    <li><span class="rayStatLabel">Current rays:</span> ${isActive ? s.lastFrame : '-'}</li>
    <li class="rayStatHeading">Average per frame</li>
    <li><span class="rayStatLabel">${intervalText(average)}: ${pie(average)}</span> ${round2(average.average)}</li>
    <li><span class="rayStatLabel">${intervalText(averageLong)}: ${pie(averageLong)}</span> ${round2(averageLong.average)}</li>
    <li class="rayStatHeading">Maximum per frame</li>
    <li><span class="rayStatLabel">Ever:</span> ${s.maxEver}</li>
    <li><span class="rayStatLabel">${intervalText(minMax)}: ${pie(minMax)}</span> ${minMax.max}</li>
    <li><span class="rayStatLabel">${intervalText(minMaxLong)}: ${pie(minMaxLong)}</span> ${minMaxLong.max}</li>
    <li class="rayStatHeading">Minimum per frame</li>
    <li><span class="rayStatLabel">${intervalText(minMax)}: ${pie(minMax)}</span> ${minMax.min}</li>
    <li><span class="rayStatLabel">${intervalText(minMaxLong)}: ${pie(minMaxLong)}</span> ${minMaxLong.min}</li>
  </ul>
</div>`;
};
