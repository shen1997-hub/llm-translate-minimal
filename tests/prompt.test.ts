import { describe, it, expect } from 'vitest';
import { buildMessages, parseJsonResponse, parsePlainResponse } from '../lib/translation/prompt';

describe('buildMessages', () => {
  it('json 模式要求 JSON 结构，plain 模式要求 [i] 编号', () => {
    const json = buildMessages(['Hello world here'], '中文', 'SYS', 'json');
    expect(json[0].role).toBe('system');
    expect(json[0].content).toContain('SYS');
    expect(json[0].content).toContain('中文');
    expect(json[0].content).toContain('"items"');
    expect(json[1].content).toBe('[0] Hello world here');
    const plain = buildMessages(['Hello world here'], '中文', 'SYS', 'plain');
    expect(plain[0].content).toContain('[0]');
    expect(plain[0].content).not.toContain('"items"');
  });
});

describe('parseJsonResponse', () => {
  it('正常解析并按 i 对齐（容忍乱序）', () => {
    const r = parseJsonResponse('{"items":[{"i":1,"t":"乙"},{"i":0,"t":"甲"}]}', 2);
    expect(r).toEqual(['甲', '乙']);
  });
  it('容忍 ```json 围栏', () => {
    const r = parseJsonResponse('```json\n{"items":[{"i":0,"t":"甲"}]}\n```', 1);
    expect(r).toEqual(['甲']);
  });
  it('缺项位置为 null', () => {
    const r = parseJsonResponse('{"items":[{"i":0,"t":"甲"}]}', 2);
    expect(r).toEqual(['甲', null]);
  });
  it('非 JSON 返回 null', () => {
    expect(parseJsonResponse('not json at all', 1)).toBeNull();
  });
  it('i 越界被忽略', () => {
    const r = parseJsonResponse('{"items":[{"i":5,"t":"越界"},{"i":0,"t":"甲"}]}', 1);
    expect(r).toEqual(['甲']);
  });
  it('非对象 JSON（null/数字/数组）返回 null 而非抛错', () => {
    expect(parseJsonResponse('null', 1)).toBeNull();
    expect(parseJsonResponse('42', 1)).toBeNull();
    expect(parseJsonResponse('[1,2]', 1)).toBeNull();
  });
});

describe('parsePlainResponse', () => {
  it('按 [i] 标记对齐，容忍多行译文', () => {
    const r = parsePlainResponse('[0] 第一行\n继续第一行\n[1] 第二段', 2);
    expect(r).toEqual(['第一行\n继续第一行', '第二段']);
  });
  it('缺项为 null', () => {
    expect(parsePlainResponse('[0] 只有零', 2)).toEqual(['只有零', null]);
  });
  it('完全无标记返回 null', () => {
    expect(parsePlainResponse('没有任何编号的回复', 1)).toBeNull();
  });
});
