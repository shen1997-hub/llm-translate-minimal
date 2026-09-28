import { describe, it, expect } from 'vitest';
import {
  nextCatState, dockPoint, selectionAnchor, jumpKeyframes,
  snapDockPoint, toCatDock, resolveDockPoint,
} from '../lib/renderer/cat-state';

describe('nextCatState', () => {
  it('主路径 dock→alert→jump→beckon→happy→beckon', () => {
    let s = nextCatState('dock', 'select');
    expect(s).toBe('alert');
    s = nextCatState(s, 'alert-done');
    expect(s).toBe('jump');
    s = nextCatState(s, 'landed');
    expect(s).toBe('beckon');
    s = nextCatState(s, 'click');
    expect(s).toBe('happy');
    s = nextCatState(s, 'happy-done');
    expect(s).toBe('beckon');
  });

  it('return 路径：beckon/happy/jump 遇 clear 或 scroll-out 回 dock', () => {
    expect(nextCatState('beckon', 'clear')).toBe('return');
    expect(nextCatState('happy', 'panel-closed')).toBe('return');
    expect(nextCatState('jump', 'scroll-out')).toBe('return');
    expect(nextCatState('return', 'return-done')).toBe('dock');
  });

  it('sleep：idle-timeout 入睡，wake/select 唤醒', () => {
    expect(nextCatState('dock', 'idle-timeout')).toBe('sleep');
    expect(nextCatState('sleep', 'wake')).toBe('dock');
    expect(nextCatState('sleep', 'select')).toBe('alert');
  });

  it('未定义事件保持原态', () => {
    expect(nextCatState('dock', 'click')).toBe('dock');
    expect(nextCatState('beckon', 'wake')).toBe('beckon');
  });
});

describe('定位与关键帧', () => {
  it('dockPoint 停靠右缘底部', () => {
    expect(dockPoint(1280, 720)).toEqual({ x: 1254, y: 648 });
  });

  it('selectionAnchor 选区尾右下偏移 8px', () => {
    expect(selectionAnchor(300, 200)).toEqual({ x: 308, y: 208 });
  });

  it('jumpKeyframes 四帧：起、顶点拉伸、落地压扁、复原', () => {
    const kf = jumpKeyframes({ x: 100, y: 600 }, { x: 300, y: 200 });
    expect(kf).toHaveLength(4);
    expect(kf[0]!.transform).toContain('translate(100px, 600px)');
    expect(kf[1]!.offset).toBe(0.45);
    expect(kf[1]!.transform).toContain('scale(0.94, 1.08)');
    expect(kf[2]!.offset).toBe(0.85);
    expect(kf[2]!.transform).toContain('scale(1.06, 0.92)');
    expect(kf[3]!.transform).toContain('translate(300px, 200px) scale(1, 1)');
  });
});

describe('snapDockPoint', () => {
  it('左半屏松手贴左缘(-18),右半屏贴右缘(vw-26),y 保持', () => {
    expect(snapDockPoint(100, 300, 1280, 720)).toEqual({ side: 'left', x: -18, y: 300 });
    expect(snapDockPoint(1000, 300, 1280, 720)).toEqual({ side: 'right', x: 1254, y: 300 });
  });

  it('猫中心在中线判右;y 越界夹取到 [0, vh-44]', () => {
    expect(snapDockPoint(618, 300, 1280, 720).side).toBe('right'); // 618+22=640,不 < 640
    expect(snapDockPoint(617, 300, 1280, 720).side).toBe('left');
    expect(snapDockPoint(100, -50, 1280, 720).y).toBe(0);
    expect(snapDockPoint(100, 800, 1280, 720).y).toBe(676);
  });
});

describe('toCatDock / resolveDockPoint', () => {
  it('toCatDock 记 side 与垂直比例;vh 为 0 兜底 0', () => {
    expect(toCatDock('left', 360, 720)).toEqual({ side: 'left', yRatio: 0.5 });
    expect(toCatDock('right', 0, 0)).toEqual({ side: 'right', yRatio: 0 });
  });

  it('resolveDockPoint 无存档回退默认 dockPoint', () => {
    expect(resolveDockPoint(1280, 720, null)).toEqual(dockPoint(1280, 720));
    expect(resolveDockPoint(1280, 720)).toEqual(dockPoint(1280, 720));
  });

  it('resolveDockPoint 有存档按 side 贴缘(与视口宽无关)、y 按比例并夹取', () => {
    expect(resolveDockPoint(1280, 720, { side: 'left', yRatio: 0.5 })).toEqual({ x: -18, y: 360 });
    expect(resolveDockPoint(800, 600, { side: 'right', yRatio: 0.5 })).toEqual({ x: 774, y: 300 });
    expect(resolveDockPoint(800, 600, { side: 'right', yRatio: 2 })).toEqual({ x: 774, y: 556 });
  });

  it('往返一致:snap → toCatDock → resolveDockPoint', () => {
    const s = snapDockPoint(100, 300, 1280, 720);
    expect(resolveDockPoint(1280, 720, toCatDock(s.side, s.y, 720))).toEqual({ x: s.x, y: s.y });
  });
});
