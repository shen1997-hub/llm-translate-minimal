import { describe, it, expect, beforeEach } from 'vitest';
import { MOTION_CSS, createDots, setLoading, replayPop } from '../lib/renderer/motion';

beforeEach(() => { document.body.innerHTML = ''; });

describe('createDots', () => {
  it('生成 3 个 i（无文本，不污染 textContent）', () => {
    const dots = createDots(document);
    expect(dots.className).toBe('dots');
    expect(dots.querySelectorAll('i')).toHaveLength(3);
    expect(dots.textContent).toBe('');
  });
});

describe('setLoading', () => {
  it('写入文案并追加三点', () => {
    const body = document.createElement('div');
    setLoading(document, body);
    expect(body.textContent).toBe('翻译中…');
    expect(body.querySelectorAll('.dots i')).toHaveLength(3);
  });

  it('重复调用不叠加三点（textContent 先清空）', () => {
    const body = document.createElement('div');
    setLoading(document, body);
    setLoading(document, body);
    expect(body.querySelectorAll('.dots')).toHaveLength(1);
  });
});

describe('replayPop', () => {
  it('摘掉再加回 pop 类以重播动画', () => {
    const el = document.createElement('div');
    el.classList.add('pop');
    replayPop(el);
    expect(el.classList.contains('pop')).toBe(true);
  });
});

describe('MOTION_CSS', () => {
  it('含三点脉动 / 流式光标 / 入场关键帧与 reduced-motion 兜底', () => {
    expect(MOTION_CSS).toContain('@keyframes dots-pulse');
    expect(MOTION_CSS).toContain('@keyframes caret-blink');
    expect(MOTION_CSS).toContain('@keyframes pop-in');
    expect(MOTION_CSS).toContain('prefers-reduced-motion');
    // 三点错峰：2、3 号点有延迟
    expect(MOTION_CSS).toContain('animation-delay: 0.2s');
    expect(MOTION_CSS).toContain('animation-delay: 0.4s');
  });
});