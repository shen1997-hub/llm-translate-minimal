import { describe, it, expect } from 'vitest';
import { siteRuleFor } from '../lib/extraction/site-rules';

describe('siteRuleFor', () => {
  it('x.com 命中规则：主栏根容器 + 推文候选', () => {
    const rule = siteRuleFor('x.com');
    expect(rule?.rootSelector).toBe('[data-testid="primaryColumn"]');
    expect(rule?.extraCandidates).toContain('tweetText');
  });

  it('twitter.com 及其子域命中同一规则', () => {
    expect(siteRuleFor('twitter.com')?.rootSelector).toBe('[data-testid="primaryColumn"]');
    expect(siteRuleFor('mobile.twitter.com')?.rootSelector).toBe('[data-testid="primaryColumn"]');
  });

  it('未知站点返回 undefined', () => {
    expect(siteRuleFor('example.com')).toBeUndefined();
    expect(siteRuleFor('x.com.evil-phish.com')).toBeUndefined();
  });

  it('github.com 及其子域命中规则：排除 commit 列、保留 About 侧栏', () => {
    const rule = siteRuleFor('github.com');
    expect(rule?.rootSelector).toContain('main');
    expect(rule?.extraExcludes).toContain('.sr-only');
    expect(rule?.extraExcludes).toContain('react-directory-row-commit-cell');
    expect(rule?.extraIncludes).toContain('Layout-sidebar');
    expect(siteRuleFor('gist.github.com')?.extraExcludes).toContain('.visually-hidden');
  });
});
