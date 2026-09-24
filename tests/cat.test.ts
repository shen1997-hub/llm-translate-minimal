import { describe, it, expect, vi } from 'vitest';
import { createCat } from '../lib/renderer/cat';

function make() {
  const onClick = vi.fn();
  const cat = createCat(document, { reducedMotion: true, onClick });
  return { cat, onClick };
}

describe('createCat', () => {
  it('初始为 dock 态且带品牌围巾 SVG', () => {
    const { cat } = make();
    expect(cat.state).toBe('dock');
    expect(cat.el.tagName).toBe('BUTTON');
    expect(cat.el.dataset.state).toBe('dock');
    expect(cat.el.querySelector('svg .scarf')).not.toBeNull();
  });

  it('reducedMotion 下 jumpTo 同步落地为 beckon 且 transform 到位', () => {
    const { cat } = make();
    cat.dockNow(1280, 720);
    cat.send('select');
    expect(cat.state).toBe('alert');
    cat.jumpTo(300, 200);
    expect(cat.state).toBe('beckon');
    expect(cat.el.style.transform).toContain('translate(300px, 200px)');
  });

  it('click 事件经 onClick 回调且状态进 happy', () => {
    const { cat, onClick } = make();
    cat.send('select');
    cat.jumpTo(10, 10);
    cat.send('click');
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(cat.state).toBe('happy');
  });

  it('return 回 dock：reducedMotion 同步完成', () => {
    const { cat } = make();
    cat.send('select');
    cat.jumpTo(10, 10);
    cat.send('clear');
    expect(cat.state).toBe('return');
    cat.returnToDock(1280, 720);
    expect(cat.state).toBe('dock');
  });

  it('destroy 清理定时器且不再响应', () => {
    const { cat } = make();
    cat.destroy();
    expect(() => cat.send('select')).not.toThrow();
  });
});

describe('createCat reduced-motion 降级动画', () => {
  it('有 WAAPI 时 jumpTo 走 120ms 位移淡入并在结束后进入 beckon', () => {
    vi.useFakeTimers();
    const { cat } = make();
    const cancel = vi.fn();
    const animate = vi.fn((_keyframes: unknown, _options: unknown) => ({ cancel }));
    cat.el.animate = animate as unknown as typeof cat.el.animate;

    cat.dockNow(1280, 720);
    cat.send('select');
    cat.jumpTo(300, 200);

    expect(animate).toHaveBeenCalledTimes(1);
    const [keyframes, options] = animate.mock.calls[0] ?? [];
    expect(options).toMatchObject({ duration: 120, easing: 'ease' });
    expect(keyframes).toEqual([
      { transform: expect.stringContaining('translate('), opacity: 0.4 },
      { transform: 'translate(300px, 200px)', opacity: 1 },
    ]);
    expect(cat.el.style.transform).toContain('translate(300px, 200px)');
    // 120ms 内仍处于 jump，定时器到点后才派发 landed
    expect(cat.state).toBe('jump');
    vi.advanceTimersByTime(119);
    expect(cat.state).toBe('jump');
    vi.advanceTimersByTime(1);
    expect(cat.state).toBe('beckon');

    cat.destroy();
    expect(cancel).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('createCat 睡眠唤醒', () => {
  it('sleep 态下 pointerenter / click 均先 wake 回 dock', () => {
    vi.useFakeTimers();
    const { cat, onClick } = make();
    vi.advanceTimersByTime(20_000);
    expect(cat.state).toBe('sleep');

    cat.el.dispatchEvent(new Event('pointerenter'));
    expect(cat.state).toBe('dock');

    vi.advanceTimersByTime(20_000);
    expect(cat.state).toBe('sleep');

    cat.el.dispatchEvent(new Event('click'));
    expect(cat.state).toBe('dock');
    expect(onClick).toHaveBeenCalledTimes(1);

    cat.destroy();
    vi.useRealTimers();
  });
});
