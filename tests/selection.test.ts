import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSelectionUI, clampPosition, SEL_HOST_ATTR } from '../lib/renderer/selection';
import type { SelUI, SelUICallbacks } from '../lib/renderer/selection';

function makeUI(): { ui: SelUI; cbs: Record<keyof SelUICallbacks, ReturnType<typeof vi.fn>> } {
  const cbs = {
    onDotClick: vi.fn(), onClose: vi.fn(), onRetry: vi.fn(),
    onCopy: vi.fn(), onSpeak: vi.fn(), onCatDockMove: vi.fn(),
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

  it('catMode：showDot 由猫履行，圆钮保持隐藏', () => {
    const { ui, cbs } = makeUI();
    void cbs;
    ui.setCatMode(true);
    ui.showDot(120, 80);
    const cat = ui.host.shadowRoot!.querySelector<HTMLElement>('.cat')!;
    const dot = ui.host.shadowRoot!.querySelector<HTMLElement>('.dot')!;
    expect(cat.hidden).toBe(false);
    expect(dot.hidden).toBe(true);
    expect(ui.isDotVisible()).toBe(true);
    expect(cat.dataset.state).not.toBe('dock');
  });

  it('catMode：hideDot 让猫回停靠且 isDotVisible 为 false', () => {
    const { ui } = makeUI();
    ui.setCatMode(true);
    ui.showDot(120, 80);
    ui.hideDot();
    expect(ui.isDotVisible()).toBe(false);
  });

  it('catMode：点击猫触发 onDotClick', () => {
    const { ui, cbs } = makeUI();
    ui.setCatMode(true);
    ui.showDot(120, 80);
    const cat = ui.host.shadowRoot!.querySelector<HTMLElement>('.cat')!;
    cat.click();
    expect(cbs.onDotClick).toHaveBeenCalled();
  });

  it('catMode：选区滚出视口后 scroll 触发猫回停靠（文档坐标锚点判定）', () => {
    const { ui } = makeUI();
    ui.setCatMode(true);
    ui.showDot(120, 80);
    expect(ui.isDotVisible()).toBe(true);
    Object.defineProperty(window, 'scrollY', { value: 600, configurable: true });
    try {
      document.dispatchEvent(new Event('scroll'));
      expect(ui.isDotVisible()).toBe(false); // 猫已回停靠
    } finally {
      Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    }
  });

  it('catMode：点猫后开面板不启动 return 动画，猫打上 perch 标记', () => {
    const { ui } = makeUI();
    ui.setCatMode(true);
    ui.showDot(120, 80);
    const cat = ui.host.shadowRoot!.querySelector<HTMLElement>('.cat')!;
    const animate = vi.fn(() => ({ cancel: vi.fn() }));
    (cat as unknown as { animate: unknown }).animate = animate;
    cat.click();
    ui.hideDot(); // 真实链路：content 在 onDotClick 后同步调 hideDot
    const callsBeforePanel = animate.mock.calls.length;
    ui.showPanel(100, 100, 'm');
    expect(cat.dataset.perch).toBe('1');
    expect(callsBeforePanel).toBe(0); // 点猫后的 hideDot 未启动 return 动画
    expect(animate.mock.calls.length).toBeLessThanOrEqual(callsBeforePanel);
  });

  it('catMode：hidePanel 只在猫外出/趴面板时归位，停靠猫不原地蹦', () => {
    const { ui } = makeUI();
    ui.setCatMode(true);
    const cat = ui.host.shadowRoot!.querySelector<HTMLElement>('.cat')!;
    // 桩住 WAAPI 才能观测 return：jsdom 无 animate 时 returnToDock 同步落成 dock，掩盖问题
    const animate = vi.fn(() => ({ cancel: vi.fn() }));
    (cat as unknown as { animate: unknown }).animate = animate;
    // 停靠静止（从未 showDot）：hidePanel 不应启动 return——真实环境 360ms 内 state!=='dock' 会拒拖拽
    const dockTransform = cat.style.transform;
    ui.hidePanel();
    expect(animate).not.toHaveBeenCalled();
    expect(cat.dataset.state).toBe('dock');
    expect(cat.style.transform).toBe(dockTransform);
    // 趴面板（perch 标记）：hidePanel 仍应归位
    ui.showDot(120, 80);
    ui.showPanel(100, 100, 'm');
    expect(cat.dataset.perch).toBe('1');
    const callsBeforeHide = animate.mock.calls.length;
    ui.hidePanel();
    expect(animate.mock.calls.length).toBeGreaterThan(callsBeforeHide); // return 动画启动
    expect(cat.dataset.perch).toBeUndefined();
  });

  it('catMode：停靠态点猫的残留标记不吞掉下次划词后的 return', () => {
    const { ui } = makeUI();
    ui.setCatMode(true);
    const cat = ui.host.shadowRoot!.querySelector<HTMLElement>('.cat')!;
    cat.click(); // 无选区点停靠猫：onClick 置 catClicked 但 catOut===false
    ui.hideDot(); // 真实链路：onSelDotClick 同步调 hideDot（选区为空，不发请求）
    ui.showDot(120, 80);
    const anchorTransform = cat.style.transform; // jsdom 无 WAAPI，jumpTo 同步落锚点
    ui.hideDot(); // 划词后点页面清空：残留标记若未消费会跳过 catReturn，猫冻结在锚点
    expect(cat.style.transform).toContain('translate(998px, 696px)'); // 回了停靠
    expect(cat.style.transform).not.toBe(anchorTransform);
  });

  it('catMode=false：回圆钮路径', () => {
    const { ui } = makeUI();
    ui.setCatMode(false);
    ui.showDot(120, 80);
    const dot = ui.host.shadowRoot!.querySelector<HTMLElement>('.dot')!;
    const cat = ui.host.shadowRoot!.querySelector<HTMLElement>('.cat')!;
    expect(dot.hidden).toBe(false);
    expect(cat.hidden).toBe(true);
  });
});

describe('setCatDock', () => {
  it('dock 态可见时立即重定位到存档点(jsdom 视口 1024x768)', () => {
    const { ui } = makeUI();
    ui.setCatMode(true);
    const cat = ui.host.shadowRoot!.querySelector<HTMLElement>('.cat')!;
    expect(cat.style.transform).toContain('translate(998px, 696px)'); // 默认右下
    ui.setCatDock({ side: 'left', yRatio: 0.5 });
    expect(cat.style.transform).toContain('translate(-18px, 384px)');
  });

  it('null 恢复默认右下角', () => {
    const { ui } = makeUI();
    ui.setCatMode(true);
    ui.setCatDock({ side: 'left', yRatio: 0.5 });
    ui.setCatDock(null);
    const cat = ui.host.shadowRoot!.querySelector<HTMLElement>('.cat')!;
    expect(cat.style.transform).toContain('translate(998px, 696px)');
  });

  it('猫外出时不重定位,回停靠后落存档点', () => {
    const { ui } = makeUI();
    ui.setCatMode(true);
    ui.showDot(120, 80);
    const cat = ui.host.shadowRoot!.querySelector<HTMLElement>('.cat')!;
    ui.setCatDock({ side: 'left', yRatio: 0.5 });
    expect(cat.dataset.state).not.toBe('dock'); // 外出期间不搬
    ui.hideDot(); // clear → return,jsdom 无 WAAPI 同步落点
    expect(cat.style.transform).toContain('translate(-18px, 384px)');
  });

  it('猫拖拽回调透传 onCatDockMove', () => {
    const { ui, cbs } = makeUI();
    ui.setCatMode(true);
    const cat = ui.host.shadowRoot!.querySelector<HTMLElement>('.cat')!;
    // dock (998,696);按下 (1010,710),拖到 (500,400) → point (488,386),中心 510 < 512 → 左缘
    const pointer = (type: string, x: number, y: number) =>
      cat.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
    pointer('pointerdown', 1010, 710);
    pointer('pointermove', 500, 400);
    pointer('pointerup', 500, 400);
    expect(cbs.onCatDockMove).toHaveBeenCalledWith({ side: 'left', yRatio: 386 / 768 });
  });
});

describe('滚动条遮挡', () => {
  it('停靠用 clientWidth(排除滚动条):dockNow 右缘 x = clientWidth - 26', () => {
    Object.defineProperty(document.documentElement, 'clientWidth', { value: 1265, configurable: true });
    try {
      const { ui } = makeUI();
      ui.setCatMode(true);
      const cat = ui.host.shadowRoot!.querySelector<HTMLElement>('.cat')!;
      expect(cat.style.transform).toContain('translate(1239px, 696px)'); // dockPoint(1265, 768)
    } finally {
      Object.defineProperty(document.documentElement, 'clientWidth', { value: 0, configurable: true });
    }
  });
});
