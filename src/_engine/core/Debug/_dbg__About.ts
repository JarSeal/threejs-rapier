import * as THREE from 'three/webgpu';
import { CMP, type TCMP } from '../../utils/CMP';
import { CUR_ENV, IS_PROD_TEST_MODE, PROJECT_METADATA } from '../Config';
import { getRenderer, isWebGPURenderer } from '../Renderer';
import { ComponentType } from '../ECS/ECSCoreComponents';
import { getECSWorld } from '../ECS';
import { getPhysicsState, getResolvedTransportMode, isPhysicsWorldEnabled } from '../PhysicsAPI';
import { ENGINES } from '../Physics/ENGINES';
import { openDialog } from '../UI/DialogWindow';
import { closeDraggableWindow } from '../UI/DraggableWindow';
import { getSvgIcon } from '../UI/icons/SvgIcon';
import styles from './About.module.scss';

const DIALOG_ID = 'aekAboutDialog';

type InfoRow = { label: string; value: string };
type InfoSection = { title: string; rows: InfoRow[] };

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A "git+https://…/repo.git" package.json repository as a browsable https URL ('' if it isn't one). */
const getRepoUrl = () => {
  const url = PROJECT_METADATA.engine.repoUrl.replace(/^git\+/, '').replace(/\.git$/, '');
  return url.startsWith('https://') ? url : '';
};

const getVersionText = (version: string, codename: string) =>
  codename ? `${version} (${codename})` : version;

// The WebGPU device and the WebGL context of three's backends (not in three's types)
type BackendInternals = {
  device?: { adapterInfo?: { vendor?: string; architecture?: string; description?: string } };
  compatibilityMode?: boolean;
  gl?: WebGL2RenderingContext;
};

const getRendererText = () => {
  const renderer = getRenderer();
  if (!renderer) return 'Not created';
  if (!isWebGPURenderer()) return 'WebGL 2 (fallback)';
  const backend = renderer.backend as unknown as BackendInternals;
  return backend.compatibilityMode ? 'WebGPU (compatibility mode)' : 'WebGPU';
};

const getGPUText = () => {
  const backend = getRenderer()?.backend as unknown as BackendInternals | undefined;
  if (!backend) return 'Unknown';
  const info = backend.device?.adapterInfo;
  if (info) {
    const text = [info.vendor, info.architecture, info.description].filter(Boolean).join(' · ');
    if (text) return text;
  }
  const gl = backend.gl;
  if (gl) {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  }
  return 'Not reported by the browser';
};

const countEntitiesWith = (type: ComponentType) => {
  let count = 0;
  const ids = getECSWorld().getEntitiesWith(type);
  while (!ids.next().done) count++;
  return count;
};

const formatNumber = (n: number) => String(+n.toFixed(3));

const PAUSE_REASONS = {
  BACKGROUND_BEHAVIOR: 'the window is hidden',
  SCENE_LOAD: 'a scene is loading',
};

const getPhysicsRows = (): InfoRow[] => {
  const physics = getPhysicsState();
  const { packages } = PROJECT_METADATA;
  const engineRows = Object.entries(ENGINES).map(([key, engine]) => ({
    label: engine.name,
    value: `${engine.packageName} ${packages[engine.packageName] || '(version unknown)'}${
      physics.enabled && key === physics.physicsEngine ? ', in use' : ''
    }`,
  }));

  // SharedArrayBuffer needs a cross-origin isolated page (the COOP / COEP headers)
  const isSABAvailable = typeof SharedArrayBuffer !== 'undefined' && window.crossOriginIsolated;
  const sabRow = {
    label: 'SharedArrayBuffer',
    value: isSABAvailable
      ? `Available${physics.useSAB ? '' : ', turned off (useSAB: false)'}`
      : 'Not available: the page is not cross-origin isolated (COOP / COEP headers)',
  };
  if (!physics.enabled) return [...engineRows, { label: 'Status', value: 'Off' }, sabRow];

  const isWorker = physics.workerTarget === 'WORKER_THREAD';
  const transport = getResolvedTransportMode();
  const transportText = !isWorker
    ? 'Direct (main thread)'
    : transport === 'SHARED_MEMORY'
      ? 'SharedArrayBuffer (triple buffer)'
      : transport === 'MESSAGE_BATCH'
        ? 'Message batch (one message per frame)'
        : 'Not resolved yet';
  const statusText = !isPhysicsWorldEnabled()
    ? 'No world'
    : physics.isPaused
      ? `Paused${physics.pauseReason ? ` (${PAUSE_REASONS[physics.pauseReason]})` : ''}`
      : 'Running';
  const staticCount = countEntitiesWith(ComponentType.BODY_STATIC);
  const visualCount = countEntitiesWith(ComponentType.BODY_DYNAMIC_VISUAL);
  const headlessCount = countEntitiesWith(ComponentType.BODY_DYNAMIC_HEADLESS);
  const { x, y, z } = physics.gravity;

  return [
    ...engineRows,
    { label: 'Status', value: statusText },
    { label: 'Thread', value: isWorker ? 'Worker thread' : 'Main thread' },
    { label: 'Transform transport', value: transportText },
    sabRow,
    {
      label: 'Timestep',
      value: `${physics.timestep} Hz (${formatNumber(physics.timestepRatio * 1000)} ms), at most ${physics.maxSubSteps} sub-steps per frame`,
    },
    {
      label: 'Solver',
      value: `${physics.solverIterations} iterations, ${physics.internalPgsIterations} internal PGS iterations`,
    },
    { label: 'Gravity', value: `${formatNumber(x)}, ${formatNumber(y)}, ${formatNumber(z)}` },
    { label: 'Interpolation', value: physics.interpolationMode },
    { label: 'In the background', value: physics.backgroundBehavior },
    {
      label: 'Bodies',
      value: `${staticCount} static, ${visualCount + headlessCount} dynamic (${headlessCount} headless)${
        isWorker ? `, transform buffer capacity ${physics.maxBodies}` : ''
      }`,
    },
  ];
};

const getBuildText = () => {
  const { commit, hasLocalChanges, time } = PROJECT_METADATA.build;
  const date = new Date(time);
  const timeText = Number.isNaN(date.getTime()) ? time : date.toLocaleString();
  if (!commit) return timeText;
  return `${commit}${hasLocalChanges ? ' + local changes' : ''}, ${timeText}`;
};

const getSections = (): InfoSection[] => {
  const { engine, toolkit, app, packages, buildTools, versionChecksum } = PROJECT_METADATA;
  return [
    {
      title: 'Versions',
      rows: [
        {
          label: `${engine.name || 'Ækasha'} engine`,
          value: getVersionText(engine.version, engine.codename),
        },
        {
          label: toolkit.name || 'Toolkit',
          value: getVersionText(toolkit.version, toolkit.codename),
        },
        { label: app.name || 'App', value: getVersionText(app.version, app.codename) },
        { label: 'Version checksum', value: versionChecksum },
        { label: 'Build', value: getBuildText() },
      ],
    },
    {
      title: 'Packages',
      rows: [
        ...Object.entries(packages).map(([name, version]) => ({
          label: name,
          value: name === 'three' ? `${version} (r${THREE.REVISION})` : version,
        })),
        ...Object.entries(buildTools).map(([name, version]) => ({
          label: name,
          value: `${version} (build)`,
        })),
      ],
    },
    {
      title: 'Runtime',
      rows: [
        {
          label: 'Environment',
          value: `${CUR_ENV}, ${IS_PROD_TEST_MODE ? 'production test mode' : 'debug mode'}`,
        },
        { label: 'Renderer', value: getRendererText() },
        { label: 'GPU', value: getGPUText() },
        {
          label: 'Viewport',
          value: `${window.innerWidth} × ${window.innerHeight} px, pixel ratio ${window.devicePixelRatio}`,
        },
        { label: 'Browser', value: navigator.userAgent },
      ],
    },
    { title: 'Physics', rows: getPhysicsRows() },
  ];
};

/** The dialog's information as plain text, for a bug report. */
const getInfoText = (sections: InfoSection[]) => {
  const { engine } = PROJECT_METADATA;
  const lines = [engine.fullName || engine.name];
  for (const section of sections) {
    lines.push('', `${section.title}:`);
    for (const row of section.rows) lines.push(`  ${row.label}: ${row.value}`);
  }
  return lines.join('\n');
};

const getHeaderHtml = () => {
  const { engine, license } = PROJECT_METADATA;
  const repoUrl = getRepoUrl();
  const links = [
    repoUrl && `<a href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener">Repository</a>`,
    repoUrl &&
      `<a href="${escapeHtml(repoUrl)}/blob/main/CHANGELOG.md" target="_blank" rel="noopener">Changelog</a>`,
    engine.url && `<a href="${escapeHtml(engine.url)}" target="_blank" rel="noopener">Website</a>`,
  ].filter(Boolean);
  const credits = [license && `${license} license`, engine.author && `by ${engine.author}`]
    .filter(Boolean)
    .join(' · ');
  return `<header class="${styles.header}">
  <div class="${styles.symbol}">${getSvgIcon('aekasha')}</div>
  <div>
    <h3 class="${styles.name}">${escapeHtml(engine.fullName || engine.name)}</h3>
    <div class="${styles.version}">Version ${escapeHtml(getVersionText(engine.version, engine.codename))}</div>
    ${engine.description ? `<p class="${styles.description}">${escapeHtml(engine.description)}</p>` : ''}
    ${credits ? `<div class="${styles.credits}">${escapeHtml(credits)}</div>` : ''}
    ${links.length ? `<div class="${styles.links}">${links.join('')}</div>` : ''}
  </div>
</header>`;
};

const getSectionsHtml = (sections: InfoSection[]) =>
  sections
    .map(
      (section) => `<section class="${styles.section}">
  <h4>${escapeHtml(section.title)}</h4>
  <dl class="${styles.rows}">${section.rows
    .map((row) => `<dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd>`)
    .join('')}</dl>
</section>`
    )
    .join('');

const createDialogContent = (): TCMP => {
  // Read on every open: the renderer, physics state and viewport can change
  const sections = getSections();
  const root = CMP({ class: styles.dialogContent });
  root.add({
    class: styles.panel,
    html: () => `<div>${getHeaderHtml()}${getSectionsHtml(sections)}</div>`,
  });

  const footer = root.add({ class: styles.footer });
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  const copyBtn = footer.add({
    tag: 'button',
    text: 'Copy info',
    class: 'debuggerClearLSDialogButton',
    attr: { type: 'button', title: 'Copy this information as text, eg. for a bug report' },
    onClick: () => {
      const showResult = (text: string) => {
        copyBtn.updateText(text);
        if (copiedTimer) clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => copyBtn.updateText('Copy info'), 2000);
      };
      navigator.clipboard
        ?.writeText(getInfoText(sections))
        .then(() => showResult('Copied'))
        .catch(() => showResult('Copy failed'));
    },
  });
  footer.add({
    tag: 'button',
    text: 'Close',
    class: 'debuggerClearLSDialogButton',
    attr: { type: 'button' },
    onClick: () => closeDraggableWindow(DIALOG_ID),
  });

  return root;
};

/** Opens the About Ækasha dialog: the engine, toolkit and app versions, the package versions, the
 * runtime (renderer, GPU, browser) and physics (backends, thread, transport, SharedArrayBuffer,
 * stepping, bodies), with a button that copies it all as text. */
export const openAboutDialog = () => {
  openDialog({
    id: DIALOG_ID,
    title: 'About Ækasha',
    icon: 'aekasha',
    size: { w: 560, h: 680 },
    isDebugWindow: true,
    backDropClickClosesWindow: true,
    closeOnEscape: true,
    // Built fresh on every open (the runtime rows can change)
    removeOnClose: true,
    content: createDialogContent,
  });
};
