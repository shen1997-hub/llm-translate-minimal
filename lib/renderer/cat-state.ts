import type { CatDock, DockSide } from '../settings';

export const CAT_SIZE = 44;
// 停靠 peek:水平只露 26px——右缘 x = vw - 26,左缘 x = -(44 - 26) = -18
export const DOCK_VISIBLE = 26;

export type CatState = 'dock' | 'sleep' | 'alert' | 'jump' | 'beckon' | 'happy' | 'return';

export type CatEvent =
  | 'select' | 'clear' | 'scroll-out' | 'alert-done' | 'landed'
  | 'click' | 'happy-done' | 'panel-closed' | 'return-done'
  | 'idle-timeout' | 'wake';

const TABLE: Record<CatState, Partial<Record<CatEvent, CatState>>> = {
  dock: { select: 'alert', 'idle-timeout': 'sleep' },
  sleep: { select: 'alert', wake: 'dock' },
  alert: { 'alert-done': 'jump', clear: 'dock', 'scroll-out': 'dock' },
  jump: { landed: 'beckon', clear: 'return', 'scroll-out': 'return' },
  beckon: { click: 'happy', clear: 'return', 'scroll-out': 'return' },
  happy: { 'happy-done': 'beckon', 'panel-closed': 'return', clear: 'return', 'scroll-out': 'return' },
  return: { 'return-done': 'dock', select: 'alert' },
};

export function nextCatState(state: CatState, event: CatEvent): CatState {
  return TABLE[state][event] ?? state;
}

// 停靠右缘：44px 宽的猫右移 18px 只露头（可见 26px），垂直贴近视口底部避免遮挡正文拖选
export function dockPoint(vw: number, vh: number): { x: number; y: number } {
  return { x: vw - DOCK_VISIBLE, y: vh - 72 };
}

export function selectionAnchor(endX: number, endY: number): { x: number; y: number } {
  return { x: endX + 8, y: endY + 8 };
}

// 抛物线近似：顶点抬高 60px；起跳拉伸、落地压扁（squash & stretch）
export function jumpKeyframes(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { transform: string; offset?: number }[] {
  const apexY = Math.min(from.y, to.y) - 60;
  return [
    { transform: `translate(${from.x}px, ${from.y}px) scale(1, 1)` },
    { transform: `translate(${Math.round((from.x + to.x) / 2)}px, ${apexY}px) scale(0.94, 1.08)`, offset: 0.45 },
    { transform: `translate(${to.x}px, ${to.y}px) scale(1.06, 0.92)`, offset: 0.85 },
    { transform: `translate(${to.x}px, ${to.y}px) scale(1, 1)` },
  ];
}

// 松手点吸附到最近的左/右缘(保持 peek 露头),y 夹取保证垂直方向完整可见
export function snapDockPoint(x: number, y: number, vw: number, vh: number): { x: number; y: number; side: DockSide } {
  const side: DockSide = x + CAT_SIZE / 2 < vw / 2 ? 'left' : 'right';
  return {
    side,
    x: side === 'left' ? -(CAT_SIZE - DOCK_VISIBLE) : vw - DOCK_VISIBLE,
    y: Math.max(0, Math.min(y, vh - CAT_SIZE)),
  };
}

// 吸附点 → 持久化形态:只记 side 与垂直比例,宽度变化时仍贴缘
export function toCatDock(side: DockSide, y: number, vh: number): CatDock {
  return { side, yRatio: vh > 0 ? y / vh : 0 };
}

// 有存档按 side 贴缘还原、y 按比例夹取;无存档回退默认右下角
export function resolveDockPoint(vw: number, vh: number, saved?: CatDock | null): { x: number; y: number } {
  if (!saved) return dockPoint(vw, vh);
  return {
    x: saved.side === 'left' ? -(CAT_SIZE - DOCK_VISIBLE) : vw - DOCK_VISIBLE,
    y: Math.max(0, Math.min(saved.yRatio * vh, vh - CAT_SIZE)),
  };
}
