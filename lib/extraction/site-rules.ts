export interface SiteRule {
  /** 命中时直接选作正文根容器（跳过评分） */
  rootSelector?: string;
  /** 追加的候选选择器（如 X 的推文正文 div） */
  extraCandidates?: string;
  /** 追加的排除祖先选择器 */
  extraExcludes?: string;
}

const X_RULE: SiteRule = {
  rootSelector: '[data-testid="primaryColumn"]',
  extraCandidates: '[data-testid="tweetText"]',
};

const RULES: Record<string, SiteRule> = {
  'x.com': X_RULE,
  'twitter.com': X_RULE,
};

/** 精确匹配或子域匹配（mobile.twitter.com → twitter.com），不匹配 x.com.evil.com 这类后缀伪装 */
export function siteRuleFor(hostname: string): SiteRule | undefined {
  for (const domain of Object.keys(RULES)) {
    if (hostname === domain || hostname.endsWith('.' + domain)) return RULES[domain];
  }
  return undefined;
}
