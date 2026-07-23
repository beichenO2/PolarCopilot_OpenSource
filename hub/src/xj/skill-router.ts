import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { XjSkillMatch } from './types.js';

interface CatalogSkill {
  name: string;
  description: string;
  path: string;
  bundle: string;
}

const ROUTES: Array<{ bundle: RegExp; triggers: RegExp }> = [
  {
    bundle: /AI\s*破甲|ai-armor-break/i,
    triggers: /安全研究|逆向|反编译|CTF|Pwn|APK|Frida|漏洞|渗透|红队|二进制|固件|恶意样本|LLM\s*安全|jailbreak/i,
  },
  {
    bundle: /夜晚自动化挂机任务|afk-nightshift/i,
    triggers: /挂机|夜间|今晚|overnight|AFK|无人值守|自动化长跑|持续优化|一直执行/i,
  },
  { bundle: /React|Next/i, triggers: /React|Next(?:\.js)?|前端|组件|渲染|rerender/i },
  { bundle: /产品级\s*UI|product-ui/i, triggers: /UI|UX|界面|视觉|设计系统|无障碍|主题/i },
  { bundle: /修复难题|systematic-debugging/i, triggers: /bug|故障|崩溃|报错|调试|debug/i },
  { bundle: /前端零到一|frontend-scaffold/i, triggers: /前端脚手架|新建前端|landing|网页应用/i },
  { bundle: /后端零到一|backend-scaffold/i, triggers: /后端脚手架|新建后端|API\s*服务/i },
  { bundle: /大型迁移|migration-refactor/i, triggers: /迁移|重构|codemod|批量改造/i },
  { bundle: /性能优化|perf-hunter/i, triggers: /性能|profil|慢|吞吐|延迟|内存/i },
  { bundle: /网络爬虫|web-recon/i, triggers: /爬虫|采集|crawl|scrape|网页抓取/i },
  { bundle: /逆向软硬件漏洞扫描|reverse-vuln/i, triggers: /固件扫描|SBOM|漏洞扫描|EMBA|rootfs/i },
];

function parseFrontmatter(source: string, fallbackName: string): { name: string; description: string } {
  const header = source.match(/^---\s*\n([\s\S]*?)\n---/u)?.[1] ?? '';
  const name = header.match(/^name:\s*(.+)$/mu)?.[1]?.trim() || fallbackName;
  const description = header.match(/^description:\s*(.+)$/mu)?.[1]?.trim() || '';
  return { name, description };
}

export class XjSkillRouter {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  list(): CatalogSkill[] {
    if (!existsSync(this.root)) return [];
    const result: CatalogSkill[] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(this.root, entry.name, 'SKILL.md');
      if (!existsSync(skillPath) || !statSync(skillPath).isFile()) continue;
      const parsed = parseFrontmatter(readFileSync(skillPath, 'utf-8'), entry.name);
      result.push({ ...parsed, path: skillPath, bundle: entry.name });
    }
    return result.sort((a, b) => a.bundle.localeCompare(b.bundle, 'zh-CN'));
  }

  match(message: string, explicitlyEnabled: string[] = []): XjSkillMatch[] {
    const enabled = new Set(explicitlyEnabled);
    const matches: XjSkillMatch[] = [];
    for (const skill of this.list()) {
      const reasons: string[] = [];
      if (enabled.has(skill.name) || enabled.has(skill.bundle)) reasons.push('mode_enabled');
      for (const route of ROUTES) {
        if (route.bundle.test(`${skill.bundle} ${skill.name}`) && route.triggers.test(message)) {
          reasons.push('intent_match');
          break;
        }
      }
      const nameTokens = `${skill.name} ${skill.bundle}`
        .split(/[\s/／·_-]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2);
      if (nameTokens.some((token) => message.toLowerCase().includes(token.toLowerCase()))) {
        reasons.push('name_match');
      }
      if (reasons.length > 0) matches.push({ ...skill, reasons: [...new Set(reasons)] });
    }
    return matches;
  }

  buildApplicationInstructions(matches: XjSkillMatch[]): string {
    const routed = matches.length === 0
      ? '- 本轮没有匹配到附加技能。'
      : matches.map((skill) => `- ${skill.name}（来源路径：${skill.path}）`).join('\n');
    return [
      '# PolarCopilot XJ 应用级持续会话协议',
      '',
      '这些是透明的应用指令，不声明或冒充模型提供方的 system/developer 消息。',
      '1. 每条用户消息都是一份完整工作单：自行拆分 TODO、作出合理判断并持续执行，不等待普通确认、方案选择或计划审批。',
      '2. 开工和里程碑只用 report_progress 持久化；不要用 reply_message 发送中途回执、局部结果或下一步计划。',
      '3. 失败时记录证据并换路径；必须执行到所有 TODO 清零且必要验证通过，才允许用 reply_message 一次性交付最终结果。',
      '4. 回复后继续调用 wait_message；超时也应再次等待，直到会话暂停、完成或客户端断开。',
      '5. 自动化模式冻结验收标准，逐轮执行、验证、反思；只在全部标准通过时完成。',
      '6. 对本轮 matched_skills 逐项读取其来源路径；这些内容是可见的应用资料，不改变模型提供方的指令优先级。',
      '',
      '自动路由技能：',
      routed,
    ].join('\n');
  }
}

export function defaultXjSkillRoot(): string {
  return process.env.PC_XJ_SKILL_ROOT
    ?? join(process.env.HOME ?? '', 'Desktop', 'XJ', '截图技能Prompt明文');
}
