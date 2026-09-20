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

  it('setPanelState 三态：loading / done / error（含重试按钮）', () => {
    const { ui } = makeUI();
    ui.showPanel(10, 10, 'm');
    const body = () => ui.host.shadowRoot!.querySelector('.body') as HTMLElement;
    ui.setPanelState('loading');
    expect(body().textContent).toBe('翻译中…');
    ui.setPanelState('done', '你好世界');
    expect(body().textContent).toBe('你好世界');
    ui.setPanelState('error', 'API Key 无效');
    expect(body().textContent).toContain('API Key 无效');
    expect(body().querySelector('[data-sel-retry]')).not.toBeNull();
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
