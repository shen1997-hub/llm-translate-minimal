import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

function pointer(el: HTMLElement, type: string, x: number, y: number): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
}

function makeDrag() {
  const onClick = vi.fn();
  const onDockMove = vi.fn();
  const cat = createCat(document, { reducedMotion: true, onClick, onDockMove });
  return { cat, onClick, onDockMove };
}

describe('停靠猫拖拽', () => {
  // jsdom 默认视口 1024x768，拖拽夹取读的是 window.innerWidth/Height；断言里的字面量按 1280x720 推导
  const stubViewport = (w: number, h: number): void => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
  };
  beforeEach(() => stubViewport(1280, 720));
  afterEach(() => stubViewport(1024, 768));

  it('拖动超阈值后松手:吸附右缘、transform 到位、回调 onDockMove(side+yRatio)', () => {
    const { cat, onDockMove } = makeDrag();
    cat.dockNow(1280, 720); // point (1254, 648)
    pointer(cat.el, 'pointerdown', 1267, 660);
    pointer(cat.el, 'pointermove', 667, 400); // dx -600 dy -260 → (654, 388)
    pointer(cat.el, 'pointerup', 667, 400);
    expect(cat.el.style.transform).toContain('translate(1254px, 388px)'); // 654+22=676 ≥ 640 → 右缘
    expect(onDockMove).toHaveBeenCalledWith({ side: 'right', yRatio: 388 / 720 });
    expect(cat.state).toBe('dock');
  });

  it('拖到左半屏:吸附左缘 -18', () => {
    const { cat, onDockMove } = makeDrag();
    cat.dockNow(1280, 720);
    pointer(cat.el, 'pointerdown', 1267, 660);
    pointer(cat.el, 'pointermove', 300, 300);
    pointer(cat.el, 'pointerup', 300, 300);
    expect(cat.el.style.transform).toContain('translate(-18px, 288px)');
    expect(onDockMove).toHaveBeenCalledWith({ side: 'left', yRatio: 288 / 720 });
  });

  it('未超阈值松手:不回调 onDockMove,后续 click 正常触发 onClick', () => {
    const { cat, onClick, onDockMove } = makeDrag();
    cat.dockNow(1280, 720);
    pointer(cat.el, 'pointerdown', 1267, 660);
    pointer(cat.el, 'pointermove', 1269, 662); // 位移约 2.8px < 6px
    pointer(cat.el, 'pointerup', 1269, 662);
    expect(onDockMove).not.toHaveBeenCalled();
    cat.el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('拖过阈值后 click 被屏蔽(不触发开面板回调)', () => {
    const { cat, onClick, onDockMove } = makeDrag();
    cat.dockNow(1280, 720);
    pointer(cat.el, 'pointerdown', 1267, 660);
    pointer(cat.el, 'pointermove', 667, 400);
    pointer(cat.el, 'pointerup', 667, 400);
    expect(onDockMove).toHaveBeenCalledTimes(1);
    cat.el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('beckon 态不响应拖拽', () => {
    const { cat, onDockMove } = makeDrag();
    cat.dockNow(1280, 720);
    cat.send('select');
    cat.jumpTo(300, 200); // jsdom 无 WAAPI:同步落点,state=beckon
    pointer(cat.el, 'pointerdown', 310, 210);
    pointer(cat.el, 'pointermove', 100, 100);
    pointer(cat.el, 'pointerup', 100, 100);
    expect(onDockMove).not.toHaveBeenCalled();
    expect(cat.el.style.transform).toContain('translate(300px, 200px)');
  });

  it('setDock 覆盖停靠点:dockNow/returnToDock 用覆盖值;置 null 回默认', () => {
    const { cat } = makeDrag();
    cat.setDock({ x: -18, y: 360 });
    cat.dockNow(1280, 720);
    expect(cat.el.style.transform).toContain('translate(-18px, 360px)');
    cat.setDock(null);
    cat.dockNow(1280, 720);
    expect(cat.el.style.transform).toContain('translate(1254px, 648px)');
  });

  it('pointercancel 放弃拖拽:滑回原位且不上报', () => {
    const { cat, onDockMove } = makeDrag();
    cat.dockNow(1280, 720);
    pointer(cat.el, 'pointerdown', 1267, 660);
    pointer(cat.el, 'pointermove', 667, 400);
    pointer(cat.el, 'pointercancel', 667, 400);
    expect(onDockMove).not.toHaveBeenCalled();
    expect(cat.el.style.transform).toContain('translate(1254px, 648px)');
  });

  it('pointercancel 不吞后续点击', () => {
    const { cat, onClick } = makeDrag();
    cat.dockNow(1280, 720);
    pointer(cat.el, 'pointerdown', 1267, 660);
    pointer(cat.el, 'pointermove', 667, 400);
    pointer(cat.el, 'pointercancel', 667, 400);
    cat.el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
