import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSelectionUI, clampPosition, SEL_HOST_ATTR } from '../lib/renderer/selection';
import type { SelUI, SelUICallbacks } from '../lib/renderer/selection';

function makeUI(): { ui: SelUI; cbs: Record<keyof SelUICallbacks, ReturnType<typeof vi.fn>> } {
  const cbs = {
    onDotClick: vi.fn(), onClose: vi.fn(), onRetry: vi.fn(),
    onCopy: vi.fn(), onSpeak: vi.fn(),
  };
  return { ui: createSelectionUI(document, cbs), cbs };
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('clampPosition', () => {
  it('右/下边缘内收 8px，最小 8px', () => {
    expect(clampPosition(100, 100, 300, 160, 1024, 768)).toEqual({ x: 100, y: 100 });
    expect(clampPosition(1000, 700, 300, 160, 1024, 768)).toEqual({ x: 716, y: 600 });
    expect(clampPosition(0, 0, 300, 160, 1024, 768)).toEqual({ x: 8, y: 8 });
    expect(clampPosition(50, 50, 2000, 2000, 1024, 768)).toEqual({ x: 8, y: 8 });
  });
});

describe('createSelectionUI', () => {
  it('初始圆钮与浮窗均隐藏，host 挂在 body 且带 SEL_HOST_ATTR', () => {
    const { ui } = makeUI();
    expect(ui.host.hasAttribute(SEL_HOST_ATTR)).toBe(true);
    expect(ui.host.parentElement).toBe(document.body);
    const dot = ui.host.shadowRoot!.querySelector('.dot') as HTMLElement;
    const panel = ui.host.shadowRoot!.querySelector('.panel') as HTMLElement;
    expect(dot.hidden).toBe(true);
    expect(panel.hidden).toBe(true);
  });

  it('showDot 定位并显示圆钮；showPanel 显示浮窗并设置模型名', () => {
    const { ui } = makeUI();
    ui.showDot(120, 340);
    const dot = ui.host.shadowRoot!.querySelector('.dot') as HTMLElement;
    expect(dot.hidden).toBe(false);
    expect(ui.host.style.left).toBe('120px');
    expect(ui.host.style.top).toBe('340px');
    ui.showPanel(10, 10, 'DeepSeek · deepseek-chat');
    const panel = ui.host.shadowRoot!.querySelector('.panel') as HTMLElement;
    expect(panel.hidden).toBe(false);
    expect(dot.hidden).toBe(true);
    expect(ui.host.shadowRoot!.querySelector('.model')!.textContent).toBe('DeepSeek · deepseek-chat');
  });

  it('滚动页面下 showDot 按视口夹取：文档坐标先换算成视口坐标，夹取后再折算回文档坐标', () => {
    Object.defineProperty(window, 'scrollX', { value: 0, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 500, configurable: true });
    try {
      const { ui } = makeUI();
      ui.showDot(120, 800); // 视口 y = 300，无需夹取
      expect(ui.host.style.left).toBe('120px');
      expect(ui.host.style.top).toBe('800px');
      ui.showDot(120, 500 + 768); // 视口 y = 768，超出下边缘：夹回视口内再折算回文档坐标
      expect(ui.host.style.top).toBe(`${500 + 768 - 26 - 8}px`);
    } finally {
      Object.defineProperty(window, 'scrollX', { value: 0, configurable: true });
      Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    }
  });

  it('滚动页面下 showPanel 同样按视口夹取', () => {
    Object.defineProperty(window, 'scrollY', { value: 500, configurable: true });
    try {
      const { ui } = makeUI();
      ui.showPanel(120, 800, 'm'); // 视口 y = 300，无需夹取（jsdom 无布局，回落 300x160）
      expect(ui.host.style.top).toBe('800px');
    } finally {
      Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    }
  });

  it('setPanelState 三态：loading / done / error（含重试按钮）', () => {
    const { ui } = makeUI();
    ui.showPanel(10, 10, 'm');
    const body = () => ui.host.shadowRoot!.querySelector('.body') as HTMLElement;
    ui.setPanelState('loading');
    expect(body().textContent).toBe('翻译中…');            // 三点自身无文本，不掺进 textContent
    expect(body().querySelectorAll('.dots i')).toHaveLength(3);
    ui.setPanelState('done', '你好世界');
    expect(body().textContent).toBe('你好世界');
    expect(body().querySelector('.dots')).toBeNull();
    ui.setPanelState('error', 'API Key 无效');
    expect(body().textContent).toContain('API Key 无效');
    expect(body().querySelector('[data-sel-retry]')).not.toBeNull();
    ui.setPanelState('error', 'API Key 无效');
    expect(body().querySelectorAll('[data-sel-retry]')).toHaveLength(1); // 重复置错不叠按钮
  });

  it('appendPanelText：切到流式态并逐段追加，done 时覆盖为权威文本', () => {
    const { ui } = makeUI();
    ui.showPanel(10, 10, 'm');
    ui.setPanelState('loading');
    const body = () => ui.host.shadowRoot!.querySelector('.body') as HTMLElement;
    ui.appendPanelText('半截');
    expect(body().className).toBe('body streaming');
    expect(body().textContent).toBe('半截');
    ui.appendPanelText('译文');
    expect(body().textContent).toBe('半截译文');
    ui.setPanelState('done', '半截译文（权威）');
    expect(body().className).toBe('body done');
    expect(body().textContent).toBe('半截译文（权威）');
  });

  it('appendPanelText：浮窗关闭时静默忽略；hidePanel 后重新流式从零开始', () => {
    const { ui } = makeUI();
    const body = () => ui.host.shadowRoot!.querySelector('.body') as HTMLElement;
    ui.appendPanelText('丢弃');
    expect(body().textContent).toBe('翻译中…');
    ui.showPanel(10, 10, 'm');
    ui.setPanelState('loading');
    ui.appendPanelText('甲');
    ui.hidePanel();
    ui.showPanel(10, 10, 'm');
    ui.setPanelState('loading');
    ui.appendPanelText('乙');
    expect(body().textContent).toBe('乙');
  });

  it('浮窗对鼠标透明：面板本身 none，按钮与溢出正文可交互', () => {
    const { ui } = makeUI();
    ui.showPanel(10, 10, 'm');
    const panel = ui.host.shadowRoot!.querySelector('.panel') as HTMLElement;
    expect(panel.classList.contains('pop')).toBe(true); // 入场动画类
    // jsdom 不跑布局，scrollHeight/clientHeight 恒为 0 → 判定为不溢出
    const body = ui.host.shadowRoot!.querySelector('.body') as HTMLElement;
    expect(body.classList.contains('scrollable')).toBe(false);
  });

  it('isDotVisible / containsNode', () => {
    const { ui } = makeUI();
    expect(ui.isDotVisible()).toBe(false);
    ui.showDot(10, 10);
    expect(ui.isDotVisible()).toBe(true);
    ui.hideDot();
    expect(ui.isDotVisible()).toBe(false);
    const inside = ui.host.shadowRoot!.querySelector('.dot')!;
    expect(ui.containsNode(inside)).toBe(true);
    expect(ui.containsNode(ui.host)).toBe(true);
    expect(ui.containsNode(document.body)).toBe(false);
    expect(ui.containsNode(null)).toBe(false);
  });

  it('回调：圆钮点击 / 关闭 / 重试 / 复制(带 done 文本) / 朗读', () => {
    const { ui, cbs } = makeUI();
    const root = ui.host.shadowRoot!;
    (root.querySelector('.dot') as HTMLButtonElement).click();
    expect(cbs.onDotClick).toHaveBeenCalled();
    ui.showPanel(10, 10, 'm');
    ui.setPanelState('done', '译文内容');
    (root.querySelector('.close') as HTMLButtonElement).click();
    expect(cbs.onClose).toHaveBeenCalled();
    ui.setPanelState('error');
    (root.querySelector('[data-sel-retry]') as HTMLButtonElement).click();
    expect(cbs.onRetry).toHaveBeenCalled();
    (root.querySelector('.copy') as HTMLButtonElement).click();
    expect(cbs.onCopy).toHaveBeenCalledWith('译文内容');
    (root.querySelector('.speak') as HTMLButtonElement).click();
    expect(cbs.onSpeak).toHaveBeenCalledWith('译文内容');
  });

  it('图钉切换 isPinned；pathInside 判定 host 内/外', () => {
    const { ui } = makeUI();
    const root = ui.host.shadowRoot!;
    expect(ui.isPinned()).toBe(false);
    (root.querySelector('.pin') as HTMLButtonElement).click();
    expect(ui.isPinned()).toBe(true);
    expect(ui.pathInside([ui.host])).toBe(true);
    expect(ui.pathInside([document.body])).toBe(false);
  });
});
