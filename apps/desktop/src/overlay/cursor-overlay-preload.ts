// Overlay preload. Main owns all coordinates and actions. Renderer may send only
// a fixed presentation-phase acknowledgement keyed by the action id.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cursorOverlay', {
  onMove: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('overlay:move', (_e, payload) => cb(payload));
  },
  onReset: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('overlay:reset', (_e, payload) => cb(payload));
  },
  onComplete: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('overlay:complete', (_e, payload) => cb(payload));
  },
  reportPresentationPhase: (
    actionId: string,
    phase: 'readyForInteraction' | 'finished',
  ): void => {
    if (typeof actionId !== 'string' || actionId.length === 0) return;
    if (phase !== 'readyForInteraction' && phase !== 'finished') return;
    ipcRenderer.send('overlay:presentation-phase', { actionId, phase });
  },
});
