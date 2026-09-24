export interface SiteRule {
  /** 命中时直接选作正文根容器（跳过评分） */
  rootSelector?: string;
  /** 追加的候选选择器（如 X 的推文正文 div） */
  extraCandidates?: string;
  /** 追加的排除祖先选择器 */
  extraExcludes?: string;
  /** 命中的祖先视为正文区域，覆盖通用排除祖先（如 GitHub 侧栏中的 About） */
  extraIncludes?: string;
}

const X_RULE: SiteRule = {
  rootSelector: '[data-testid="primaryColumn"]',
  extraCandidates: '[data-testid="tweetText"]',
};

const GITHUB_RULE: SiteRule = {
  rootSelector: 'main, [role="main"]',
  // GitHub 的屏幕阅读器专用副本（clip 裁剪隐藏，display 非 none），其文本与可见副本重复；
  // 文件树的 commit message 列属于元信息，不翻译
  extraExcludes: '.sr-only, .visually-hidden, .react-directory-row-commit-cell, .commit-tease, [data-testid="latest-commit"], [class*="commit-message"], [class*="react-code-"], [class*="blob-code"], .highlight',
  // About 等仓库信息位于 .Layout-sidebar，可能被 aside/sidebar 通用规则排除，这里显式保留
  extraIncludes: '.Layout-sidebar',
};

const RULES: Record<string, SiteRule> = {
  'x.com': X_RULE,
  'twitter.com': X_RULE,
  'github.com': GITHUB_RULE,
};

/** 精确匹配或子域匹配（mobile.twitter.com → twitter.com），不匹配 x.com.evil.com 这类后缀伪装 */
export function siteRuleFor(hostname: string): SiteRule | undefined {
  for (const domain of Object.keys(RULES)) {
    if (hostname === domain || hostname.endsWith('.' + domain)) return RULES[domain];
  }
  return undefined;
}
