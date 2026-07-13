import { describe, it, expect } from 'vitest'
import { renderMarkdown, renderImageSentinels } from '../markdown'

describe('prompt 配图哨兵（@ppppolarrrrr:）', () => {
  it('全角括号包裹的绝对路径 → 内联 <img>，哨兵文本消失', () => {
    const html = renderMarkdown('看这张实拍（@ppppolarrrrr:~/shot.png）验收')
    expect(html).toContain('<img')
    expect(html).toContain('class="pc-inline-image"')
    expect(html).toContain(`src="/api/ui/local-image?path=${encodeURIComponent('~/shot.png')}"`)
    expect(html).not.toContain('@ppppolarrrrr')
    expect(html).toContain('看这张实拍')
    expect(html).toContain('验收')
  })

  it('半角括号与无括号裸形态均可解析', () => {
    expect(renderMarkdown('(@ppppolarrrrr:/tmp/a.webp)')).toContain('<img')
    expect(renderMarkdown('图 @ppppolarrrrr:/tmp/b.jpeg 后文')).toContain('<img')
  })

  it('路径含空格/中文（括号形态）正确编码', () => {
    const p = '~/我的 截图.png'
    const html = renderMarkdown(`（@ppppolarrrrr:${p}）`)
    expect(html).toContain(encodeURIComponent(p))
  })

  it('路径含下划线不被 markdown 斜体破坏', () => {
    const html = renderMarkdown('（@ppppolarrrrr:/tmp/a_b_c.png）')
    expect(html).toContain(encodeURIComponent('/tmp/a_b_c.png'))
    expect(html).toContain('<img')
  })

  it('非绝对路径 → 不解析，原样保留', () => {
    const html = renderMarkdown('（@ppppolarrrrr:relative/x.png）')
    expect(html).not.toContain('<img')
    expect(html).toContain('@ppppolarrrrr:relative/x.png')
  })

  it('非图片扩展名 → 不解析，原样保留', () => {
    const html = renderMarkdown('（@ppppolarrrrr:/etc/passwd）')
    expect(html).not.toContain('<img')
    expect(html).toContain('@ppppolarrrrr:/etc/passwd')
  })

  it('无扩展名 / 空路径 → 不解析不抛错', () => {
    expect(() => renderMarkdown('（@ppppolarrrrr:）')).not.toThrow()
    expect(renderMarkdown('（@ppppolarrrrr:/tmp/noext）')).not.toContain('<img')
  })

  it('注入企图（路径带引号）→ 拒绝解析为 img，onerror 只以惰性纯文本存在', () => {
    const html = renderMarkdown('（@ppppolarrrrr:/tmp/x.png" onerror="alert(1)）')
    expect(html).not.toContain('<img')
    expect(html).not.toMatch(/<[^>]*\sonerror=/)
  })

  it('renderImageSentinels 纯文本层替换（marked 之前）', () => {
    const out = renderImageSentinels('a（@ppppolarrrrr:/tmp/y.gif）b')
    expect(out).toContain('<img')
    expect(out.startsWith('a')).toBe(true)
    expect(out.endsWith('b')).toBe(true)
  })

  it('普通文本无哨兵 → 原样直通', () => {
    const text = '常规 **markdown** 内容'
    expect(renderImageSentinels(text)).toBe(text)
  })
})
