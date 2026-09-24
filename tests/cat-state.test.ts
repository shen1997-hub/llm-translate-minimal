import { describe, it, expect } from 'vitest';
import { nextCatState, dockPoint, selectionAnchor, jumpKeyframes } from '../lib/renderer/cat-state';

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
