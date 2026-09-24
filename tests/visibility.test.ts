import { describe, it, expect, afterEach } from 'vitest';
import { browserIsVisible } from '../lib/extraction/paragraphs';

// jsdom 中 offsetParent 恒为 null，只能断言隐藏分支返回 false、fixed 特判返回 true
function styled(style: string): HTMLElement {
  const el = document.createElement('p');
  el.setAttribute('style', style);
  el.textContent = 'Some sufficiently long English text for visibility testing.';
  document.body.appendChild(el);
  return el;
}

afterEach(() => { document.body.innerHTML = ''; });

describe('browserIsVisible：CSS 隐藏判定', () => {
  it('display:none / visibility:hidden / collapse', () => {
    expect(browserIsVisible(styled('display:none'))).toBe(false);
    expect(browserIsVisible(styled('visibility:hidden'))).toBe(false);
    expect(browserIsVisible(styled('visibility:collapse'))).toBe(false);
  });

  it('opacity:0', () => {
    expect(browserIsVisible(styled('opacity:0'))).toBe(false);
  });

  it('font-size:0', () => {
    expect(browserIsVisible(styled('font-size:0'))).toBe(false);
  });

  it('clip: rect(0,0,0,0) 裁剪隐藏', () => {
    expect(browserIsVisible(styled('clip:rect(0, 0, 0, 0)'))).toBe(false);
    expect(browserIsVisible(styled('clip: rect(0px,0px,0px,0px)'))).toBe(false);
  });

  it('clip-path: inset(...) 裁剪隐藏', () => {
    expect(browserIsVisible(styled('clip-path:inset(50%)'))).toBe(false);
    expect(browserIsVisible(styled('clip-path:inset(100%)'))).toBe(false);
  });

  it('sr-only 惯用法：absolute + overflow:hidden + 1px 尺寸', () => {
    const srOnly = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;white-space:nowrap;border:0';
    expect(browserIsVisible(styled(srOnly))).toBe(false);
    expect(browserIsVisible(styled('position:absolute;overflow:hidden;height:1px'))).toBe(false);
  });

  it('fixed 定位特判为可见', () => {
    expect(browserIsVisible(styled('position:fixed'))).toBe(true);
  });
});
