import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { XjSkillRouter } from '../../src/xj/skill-router.js';

describe('XjSkillRouter', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'polarcop-xj-skills-'));
    const security = join(root, 'AI 破甲（道德经Max）');
    const night = join(root, '夜晚自动化挂机任务');
    const react = join(root, 'React／Next 最佳实践');
    mkdirSync(security, { recursive: true });
    mkdirSync(night, { recursive: true });
    mkdirSync(react, { recursive: true });
    writeFileSync(join(security, 'SKILL.md'), '---\nname: ai-armor-break\ndescription: 逆向 CTF 安全研究\n---\n# security');
    writeFileSync(join(night, 'SKILL.md'), '---\nname: afk-nightshift\ndescription: 挂机 overnight AFK 自动化长跑\n---\n# night');
    writeFileSync(join(react, 'SKILL.md'), '---\nname: react-best\ndescription: React Next 前端性能\n---\n# react');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('routes security and nightshift skills automatically from the message', () => {
    const router = new XjSkillRouter(root);
    const matched = router.match('今晚挂机做 APK 逆向和安全研究');

    expect(matched.map((skill) => skill.name)).toEqual(expect.arrayContaining(['ai-armor-break', 'afk-nightshift']));
    expect(matched.every((skill) => skill.path.startsWith(root))).toBe(true);
  });

  it('routes other matching catalog skills without manual selection', () => {
    const router = new XjSkillRouter(root);
    expect(router.match('优化 React 前端性能').map((skill) => skill.name)).toContain('react-best');
  });

  it('returns transparent, bounded application instructions instead of system-role impersonation', () => {
    const router = new XjSkillRouter(root);
    const prompt = router.buildApplicationInstructions(router.match('挂机做安全研究'));

    expect(prompt).toContain('应用级持续会话协议');
    expect(prompt).toContain('wait_message');
    expect(prompt).toContain('来源路径');
    expect(prompt).toContain('完整工作单');
    expect(prompt).toContain('不要用 reply_message 发送中途回执');
    expect(prompt).toContain('所有 TODO 清零');
    expect(prompt).not.toContain('伪装成系统');
    expect(prompt).not.toContain('绕过安全');
  });
});
